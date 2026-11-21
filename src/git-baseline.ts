import fs from "fs"
import path from "path"
import { memoryRoot } from "./paths.js"
import * as isogit from "isomorphic-git"
import { createPatch } from "diff"
import { readRegularFileNoFollow, safeResolveUnderRoot } from "./path-guard.js"

const AUTHOR = { name: "opencode-codex-memory", email: "memory@opencode.local" }

// Generated prompt artifact; removed before diffing and before baseline
// commits (mirrors codex's remove_workspace_diff) so it never enters the
// baseline history or shows up as memory content.
export const DIFF_ARTIFACT = "phase2_workspace_diff.md"

// codex baseline.rs: a baseline is derived data, so snapshots skip files above
// the automatic ghost-snapshot limit instead of reading unbounded content.
const MAX_BASELINE_FILE_BYTES = 10 * 1024 * 1024
const BASELINE_VERSION_FILE = "codex-baseline-version"
const BASELINE_VERSION = "1\n"

/**
 * Hidden path components are invisible to tools/path-guard (`not found`).
 * Codex's gix walker includes them and reads bytes directly; isomorphic-git
 * plus path-guard would fail the whole phase-2 job on Finder `.DS_Store`.
 * Skip them from staging and diffs — they are not consolidator-visible.
 */
function isHiddenBaselinePath(filepath: string): boolean {
  return filepath.split("/").some((part) => part.startsWith("."))
}

export interface WorkspaceChange {
  status: "A" | "M" | "D"
  path: string
}

export interface WorkspaceDiff {
  changes: WorkspaceChange[]
  unifiedDiff: string
  /**
   * Git blob for each extension input seen by the consolidator. The new
   * baseline stages these exact bytes even if a file has since disappeared.
   */
  extensionSnapshot?: ReadonlyMap<string, string>
}

const EXTENSIONS_PREFIX = "extensions/"

function removeDiffArtifact(dir: string): void {
  try {
    fs.unlinkSync(path.join(dir, DIFF_ARTIFACT))
  } catch {}
}

function baselineVersionPath(dir: string): string {
  return path.join(dir, ".git", BASELINE_VERSION_FILE)
}

/**
 * Only the `.git` entry itself. A recursive walk of git objects hangs on
 * Windows junctions / symlink cycles and is not needed: we only refuse a
 * `.git` that is a symlink, a non-directory (gitfile), or a linked worktree.
 */
function gitMetadataUnusable(gitDir: string): boolean {
  const st = fs.lstatSync(gitDir)
  if (st.isSymbolicLink() || !st.isDirectory()) return true
  // codex requires common_dir == git_dir; a commondir file marks a linked worktree.
  return fs.existsSync(path.join(gitDir, "commondir"))
}

function isOversizedFile(dir: string, filepath: string): boolean {
  try {
    const st = fs.lstatSync(path.join(dir, filepath))
    return st.isFile() && st.size > MAX_BASELINE_FILE_BYTES
  } catch {
    return false
  }
}

function statusMatrix(dir: string, gitdir?: string) {
  return isogit.statusMatrix({
    fs,
    dir,
    gitdir,
    filter: (filepath) => !isHiddenBaselinePath(filepath) && !isOversizedFile(dir, filepath),
  })
}

async function hasVersionedBaseline(dir: string): Promise<boolean> {
  try {
    if (gitMetadataUnusable(path.join(dir, ".git"))) return false
    if (fs.readFileSync(baselineVersionPath(dir), "utf8") !== BASELINE_VERSION) return false
    await isogit.resolveRef({ fs, dir, ref: "HEAD" })
    return true
  } catch {
    return false
  }
}

/**
 * codex ensure_git_baseline_repository: missing, outdated, or unusable
 * metadata is replaced with an EMPTY baseline, so every eligible working file
 * stays visible to the next consolidation as an addition. The version marker
 * is written last; an interrupted reset therefore never looks trusted.
 */
async function initEmptyBaseline(dir: string): Promise<void> {
  fs.rmSync(path.join(dir, ".git"), { recursive: true, force: true })
  await isogit.init({ fs, dir })
  const tree = await isogit.writeTree({ fs, dir, tree: [] })
  await isogit.commit({ fs, dir, message: "memory baseline", author: AUTHOR, tree, parent: [] })
  fs.writeFileSync(baselineVersionPath(dir), BASELINE_VERSION)
}

async function ensureVersionedBaseline(dir: string): Promise<void> {
  if (!(await hasVersionedBaseline(dir))) await initEmptyBaseline(dir)
}

/**
 * Mirrors codex prepare_memory_workspace: a current-version baseline is
 * preserved untouched so the phase-2 diff spans last-successful-run -> now —
 * including manual user edits and newly added ad-hoc notes. Committing here
 * would swallow those changes and consolidation would never see them. Missing,
 * outdated, or unusable metadata gets an empty baseline (codex keeps existing
 * memory files visible as additions).
 */
export async function ensureBaseline(): Promise<boolean> {
  const dir = memoryRoot()
  try {
    removeDiffArtifact(dir)
    await ensureVersionedBaseline(dir)
    return true
  } catch (err) {
    // codex ensure_git_baseline_repository: unusable/corrupt git metadata is
    // recovered by a destructive fresh empty re-init instead of failing the
    // job forever.
    console.error("[opencode-codex-memory] ensureBaseline error, re-initializing baseline:", err)
    try {
      await initEmptyBaseline(dir)
      return true
    } catch (err2) {
      console.error("[opencode-codex-memory] baseline re-init failed:", err2)
      return false
    }
  }
}

async function readBaselineText(dir: string, headOid: string, filepath: string): Promise<string> {
  try {
    const { blob } = await isogit.readBlob({ fs, dir, oid: headOid, filepath })
    return new TextDecoder().decode(blob)
  } catch {
    return ""
  }
}

function readWorkingFile(dir: string, filepath: string): Buffer {
  const file = safeResolveUnderRoot(dir, filepath)
  if (fs.lstatSync(file).size > MAX_BASELINE_FILE_BYTES) {
    throw new Error(`file grew beyond the snapshot file limit during diff: ${filepath}`)
  }
  return readRegularFileNoFollow(file).content
}

/**
 * Every non-hidden regular file above the snapshot limit. Used to invalidate a
 * baseline whose tracked inputs grew after preparation (codex
 * diff_since_latest_init).
 */
function collectOversizedPaths(dir: string): string[] {
  const out: string[] = []
  const walk = (current: string, prefix: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === ".git") continue
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (isHiddenBaselinePath(rel)) continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full, rel)
      } else if (entry.isFile()) {
        try {
          if (fs.lstatSync(full).size > MAX_BASELINE_FILE_BYTES) out.push(rel)
        } catch {}
      }
    }
  }
  walk(dir, "")
  return out
}

async function hasTrackedOversizedFile(dir: string): Promise<boolean> {
  const oversized = collectOversizedPaths(dir)
  if (oversized.length === 0) return false
  let tracked: string[]
  try {
    tracked = await isogit.listFiles({ fs, dir, ref: "HEAD" })
  } catch {
    return false
  }
  const trackedSet = new Set(tracked)
  return oversized.some((filepath) => trackedSet.has(filepath))
}

// Throws on failure: codex fails the phase-2 job on workspace-status errors
// (failed_workspace_status). Swallowing the error here would make an errored
// diff indistinguishable from "no changes" and falsely mark the job succeeded.
export async function captureWorkspaceDiff(): Promise<WorkspaceDiff> {
  const dir = memoryRoot()
  await ensureVersionedBaseline(dir)
  removeDiffArtifact(dir)
  let matrix = await statusMatrix(dir)
  // Inputs may grow during synchronization, after the initial baseline was
  // prepared. Rebuild empty so the remaining files stay visible as additions.
  if (await hasTrackedOversizedFile(dir)) {
    await initEmptyBaseline(dir)
    matrix = await statusMatrix(dir)
  }
  const changedRows = matrix.filter(([filepath, head, workdir]) => head !== workdir && filepath !== DIFF_ARTIFACT)
  const changes: WorkspaceChange[] = changedRows.map(([filepath, head, workdir]) => {
    if (head === 0) return { status: "A", path: filepath }
    if (workdir === 0) return { status: "D", path: filepath }
    return { status: "M", path: filepath }
  })

  let headOid: string | null = null
  try {
    headOid = await isogit.resolveRef({ fs, dir, ref: "HEAD" })
  } catch {
    // no commits yet — every file diffs against empty
  }
  const patches: string[] = []
  const extensionSnapshot = new Map<string, string>()
  for (const [filepath, head, workdir] of changedRows) {
    const oldText = head === 1 && headOid ? await readBaselineText(dir, headOid, filepath) : ""
    const content = workdir === 0 ? null : readWorkingFile(dir, filepath)
    const newText = content?.toString("utf8") ?? ""
    if (content && filepath.startsWith(EXTENSIONS_PREFIX))
      extensionSnapshot.set(filepath, await isogit.writeBlob({ fs, dir, blob: content }))
    // Per-file patches render in full; only the global 4 MiB truncation in
    // writeWorkspaceDiff caps the rendered diff. Files above the baseline
    // snapshot limit never reach this loop.
    patches.push(createPatch(filepath, oldText, newText))
  }
  for (const [filepath, , workdir] of matrix) {
    if (workdir === 1 && filepath.startsWith(EXTENSIONS_PREFIX) && headOid) {
      // Unchanged at status capture: use HEAD, not a second live read.
      extensionSnapshot.set(filepath, (await isogit.readBlob({ fs, dir, oid: headOid, filepath })).oid)
    }
  }
  return { changes, unifiedDiff: patches.join("\n"), extensionSnapshot }
}

/**
 * Mirrors codex reset_git_repository: delete .git and re-create a fresh
 * single-commit baseline so deleted/redacted memory content is not retained
 * in unreachable git objects (history is intentionally dropped).
 *
 * Stage captured extension blobs alongside live consolidator outputs. This
 * preserves concurrent additions, edits AND deletions for the next diff.
 */
export async function resetBaseline(captured?: ReadonlyMap<string, string>): Promise<boolean> {
  try {
    const dir = memoryRoot()
    removeDiffArtifact(dir)
    await ensureVersionedBaseline(dir)
    const old = path.join(dir, ".git")
    // Inside plugin-owned metadata: a crash while building leaves the old
    // baseline valid, and the next attempt discards the unfinished staging dir.
    const gitdir = path.join(old, "codex-next")
    fs.rmSync(gitdir, { recursive: true, force: true })
    await isogit.init({ fs, dir, gitdir })
    for (const [filepath, , workdir] of await statusMatrix(dir, gitdir)) {
      if (workdir !== 0 && !(captured && filepath.startsWith(EXTENSIONS_PREFIX))) {
        await isogit.add({ fs, dir, gitdir, filepath })
      }
    }
    for (const [filepath, oid] of captured ?? []) {
      const { blob } = await isogit.readBlob({ fs, dir, oid })
      await isogit.writeBlob({ fs, dir, gitdir, blob })
      await isogit.updateIndex({ fs, dir, gitdir, filepath, oid, mode: 0o100644, add: true })
    }
    await isogit.commit({ fs, dir, gitdir, message: "memory baseline", author: AUTHOR })
    // The version marker brackets promotion: interrupted promotions recover
    // as an empty baseline instead of trusting a partial repository.
    fs.unlinkSync(baselineVersionPath(dir))
    for (const name of fs.readdirSync(old)) {
      if (name !== "codex-next") fs.rmSync(path.join(old, name), { recursive: true, force: true })
    }
    for (const name of fs.readdirSync(gitdir)) fs.renameSync(path.join(gitdir, name), path.join(old, name))
    fs.rmdirSync(gitdir)
    fs.writeFileSync(baselineVersionPath(dir), BASELINE_VERSION)
    return true
  } catch (err) {
    console.error("[opencode-codex-memory] resetBaseline error:", err)
    return false
  }
}
