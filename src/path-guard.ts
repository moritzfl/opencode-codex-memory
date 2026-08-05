import fs from "fs"
import path from "path"
import { memoryRoot } from "./paths.js"

/**
 * Safe path resolution that cannot escape the memory root, mirroring codex
 * ext/memories/src/local/path.rs + local.rs resolve_scoped_path:
 * - absolute paths and `..` components are rejected lexically
 * - hidden (dot) components are invisible (reported as not found), so .git
 *   and other dotfiles are unreachable through the tools
 * - every existing component is lstat-checked: symlinks are rejected, so a
 *   link placed inside the workspace cannot lead reads outside it
 */
/**
 * The memory root itself must not be a symlink: every scoped resolution and
 * every workspace walk starts there, so a symlinked root would redirect ALL
 * memory reads/writes elsewhere on disk. codex rejects a symlinked root when
 * clearing (control.rs clear_memory_root_contents); the model-facing tools
 * here extend that check to every memory operation. Returns the root path.
 * A missing root is fine — callers create it as a real directory.
 */
export function assertMemoryRootSafe(): string {
  const root = memoryRoot()
  let st: fs.Stats | null = null
  try {
    st = fs.lstatSync(root)
  } catch {
    return root
  }
  if (st.isSymbolicLink()) {
    throw new Error(`memory root is a symlink; refusing memory operations: ${root}`)
  }
  return root
}

export function safeResolveMemoryPath(rel: string): string {
  const root = assertMemoryRootSafe()
  return safeResolveUnderRoot(root, rel)
}

/** Resolve a relative path under an arbitrary trusted root without following symlinks. */
export function safeResolveUnderRoot(root: string, rel: string): string {
  if (path.isAbsolute(rel)) {
    throw new Error(`path escapes memory root: ${rel}`)
  }
  try {
    const rootStat = fs.lstatSync(root)
    if (rootStat.isSymbolicLink()) {
      throw new Error(`root is a symlink; refusing write: ${root}`)
    }
    if (!rootStat.isDirectory()) {
      throw new Error(`root is not a directory: ${root}`)
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
  }
  const parts = rel.split(/[\\/]+/).filter((p) => p.length > 0 && p !== ".")
  let current = root
  for (const part of parts) {
    if (part === "..") {
      throw new Error(`path escapes memory root: ${rel}`)
    }
    if (part.startsWith(".")) {
      throw new Error(`not found: ${rel}`)
    }
    current = path.join(current, part)
    let st: fs.Stats | null = null
    try {
      st = fs.lstatSync(current)
    } catch {
      // Component doesn't exist (yet): keep validating the rest lexically;
      // the caller reports not-found / creates it under the checked prefix.
    }
    if (st?.isSymbolicLink()) {
      throw new Error(`symlinks are not allowed in the memory workspace: ${rel}`)
    }
  }
  if (current !== root && !current.startsWith(root + path.sep)) {
    throw new Error(`path escapes memory root: ${rel}`)
  }
  return current
}

function sameFile(a: fs.Stats, b: fs.Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

/**
 * Opens a regular file without following its final path component. The lstat
 * after open is a fallback for platforms without O_NOFOLLOW and also verifies
 * that a path-swap race did not give us a different inode.
 */
export function withRegularFileNoFollow<T>(
  file: string,
  flags: number,
  fn: (fd: number, stat: fs.Stats) => T,
): T {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0
  const nonBlock = fs.constants.O_NONBLOCK ?? 0
  let fd: number
  try {
    fd = fs.openSync(file, flags | noFollow | nonBlock)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error(`symlinks are not allowed in the memory workspace: ${file}`)
    }
    throw err
  }
  try {
    const opened = fs.fstatSync(fd)
    const current = fs.lstatSync(file)
    if (current.isSymbolicLink() || !current.isFile() || !opened.isFile() || !sameFile(opened, current)) {
      throw new Error(`refusing non-regular or replaced file: ${file}`)
    }
    return fn(fd, opened)
  } finally {
    fs.closeSync(fd)
  }
}

export function readRegularFileNoFollow(file: string): { content: Buffer; stat: fs.Stats } {
  return withRegularFileNoFollow(file, fs.constants.O_RDONLY, (fd, stat) => ({
    content: fs.readFileSync(fd),
    stat,
  }))
}

/** Overwrite or exclusively create a regular file without following symlinks. */
export function writeRegularFileNoFollow(
  file: string,
  content: string | Uint8Array,
  options: { exclusive?: boolean } = {},
): void {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0
  const create = () => {
    const fd = fs.openSync(
      file,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o666,
    )
    try {
      const opened = fs.fstatSync(fd)
      const current = fs.lstatSync(file)
      if (!opened.isFile() || !current.isFile() || !sameFile(opened, current)) {
        throw new Error(`refusing non-regular or replaced file: ${file}`)
      }
      fs.writeFileSync(fd, content)
    } finally {
      fs.closeSync(fd)
    }
  }

  if (options.exclusive) {
    create()
    return
  }

  let current: fs.Stats
  try {
    current = fs.lstatSync(file)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      create()
      return
    }
    throw err
  }
  if (current.isSymbolicLink() || !current.isFile()) {
    throw new Error(`refusing to overwrite non-regular file: ${file}`)
  }
  withRegularFileNoFollow(file, fs.constants.O_WRONLY, (fd) => {
    // Do not truncate until the descriptor and current path are verified.
    fs.ftruncateSync(fd, 0)
    fs.writeFileSync(fd, content)
  })
}
