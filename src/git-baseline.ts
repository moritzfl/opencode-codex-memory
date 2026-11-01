import { createHash } from "crypto"
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
   * Content hash of every `extensions/` file at capture time. Notes written
   * while the consolidator runs are not in this diff; resetBaseline keeps
   * them out of the new baseline so the next run still sees them.
   */
  extensionSnapshot?: ReadonlyMap<string, string>
}

const EXTENSIONS_PREFIX = "extensions/"

function workdirHash(dir: string, filepath: string): string | null {
  try {
    const file = safeResolveUnderRoot(dir, filepath)
    if (fs.lstatSync(file).size > MAX_BASELINE_FILE_BYTES) return null
    const content = readRegularFileNoFollow(file).content
    return createHash("sha1").update(content).digest("hex")
  } catch {
    return null
  }
}

function removeDiffArtifact(dir: string): void {
  try {
    fs.unlinkSync(path.join(dir, DIFF_ARTIFACT))
  } catch {
  }
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

function statusMatrix(dir: string) {
  return isogit.statusMatrix({
    fs,
    dir,
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

// statusMatrix rows are [filepath, head, workdir, stage]; head !== workdir
// means the working tree differs from HEAD (added, modified, or deleted).
async function stageAll(dir: string, skip?: (filepath: string) => boolean): Promise<number> {
  const matrix = await statusMatrix(dir)
  let changes = 0
  for (const [filepath, head, workdir, stage] of matrix) {
    if (head === 1 && workdir === 1 && stage === 1) continue
    if (workdir !== 0 && skip?.(filepath)) continue
    if (workdir === 0) {
      // isogit.add throws on deleted files; they must be staged via remove
      await isogit.remove({ fs, dir, filepath })
    } else {
      await isogit.add({ fs, dir, filepath })
    }
    if (head !== workdir) changes++
  }
  return changes
}

async function commitBaseline(dir: string, skip?: (filepath: string) => boolean): Promise<string> {
  await stageAll(dir, skip)
  const oid = await isogit.commit({ fs, dir, message: "memory baseline", author: AUTHOR })
  fs.writeFileSync(baselineVersionPath(dir), BASELINE_VERSION)
  return oid
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

function readWorkdirText(dir: string, filepath: string): string {
  const file = safeResolveUnderRoot(dir, filepath)
  if (fs.lstatSync(file).size > MAX_BASELINE_FILE_BYTES) {
    throw new Error(`file grew beyond the snapshot file limit during diff: ${filepath}`)
  }
  return readRegularFileNoFollow(file).content.toString("utf8")
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
        } catch {
        }
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
  const changedRows = matrix.filter(
    ([filepath, head, workdir]) => head !== workdir && filepath !== DIFF_ARTIFACT,
  )
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
  for (const [filepath, head, workdir] of changedRows) {
    const oldText = head === 1 && headOid ? await readBaselineText(dir, headOid, filepath) : ""
    const newText = workdir === 0 ? "" : readWorkdirText(dir, filepath)
    // Per-file patches render in full; only the global 4 MiB truncation in
    // writeWorkspaceDiff caps the rendered diff. Files above the baseline
    // snapshot limit never reach this loop.
    patches.push(createPatch(filepath, oldText, newText))
  }
  const extensionSnapshot = new Map<string, string>()
  for (const [filepath, , workdir] of matrix) {
    if (workdir === 0 || !filepath.startsWith(EXTENSIONS_PREFIX)) continue
    const hash = workdirHash(dir, filepath)
    if (hash) extensionSnapshot.set(filepath, hash)
  }
  return { changes, unifiedDiff: patches.join("\n"), extensionSnapshot }
}

/**
 * Mirrors codex reset_git_repository: delete .git and re-create a fresh
 * single-commit baseline so deleted/redacted memory content is not retained
 * in unreachable git objects (history is intentionally dropped).
 *
 * Divergence: `extensions/` files added or edited after `captured` (e.g. a
 * memory_add_note during the consolidator turn) stay out of the baseline, so
 * they appear as added in the next diff instead of never being consolidated.
 */
export async function resetBaseline(captured?: ReadonlyMap<string, string>): Promise<boolean> {
  try {
    const dir = memoryRoot()
    removeDiffArtifact(dir)
    fs.rmSync(path.join(dir, ".git"), { recursive: true, force: true })
    await isogit.init({ fs, dir })
    const skip = captured
      ? (filepath: string) => {
          if (!filepath.startsWith(EXTENSIONS_PREFIX)) return false
          const hash = workdirHash(dir, filepath)
          return hash !== null && captured.get(filepath) !== hash
        }
      : undefined
    await commitBaseline(dir, skip)
    return true
  } catch (err) {
    console.error("[opencode-codex-memory] resetBaseline error:", err)
    return false
  }
}
