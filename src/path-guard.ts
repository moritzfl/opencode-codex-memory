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
export function safeResolveMemoryPath(rel: string): string {
  const root = memoryRoot()
  if (path.isAbsolute(rel)) {
    throw new Error(`path escapes memory root: ${rel}`)
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
