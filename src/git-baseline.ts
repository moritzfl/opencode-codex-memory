import fs from "fs"
import path from "path"
import { memoryRoot } from "./paths.js"
import * as isogit from "isomorphic-git"
import { createPatch } from "diff"

const AUTHOR = { name: "opencode-codex-memory", email: "memory@opencode.local" }

// Generated prompt artifact; removed before diffing and before baseline
// commits (mirrors codex's remove_workspace_diff) so it never enters the
// baseline history or shows up as memory content.
export const DIFF_ARTIFACT = "phase2_workspace_diff.md"

export interface WorkspaceChange {
  status: "A" | "M" | "D"
  path: string
}

export interface WorkspaceDiff {
  changes: WorkspaceChange[]
  unifiedDiff: string
}

function removeDiffArtifact(dir: string): void {
  try {
    fs.unlinkSync(path.join(dir, DIFF_ARTIFACT))
  } catch {
  }
}

async function ensureInit(dir: string): Promise<void> {
  const gitDir = path.join(dir, ".git")
  if (!fs.existsSync(gitDir)) {
    await isogit.init({ fs, dir })
  }
}

// statusMatrix rows are [filepath, head, workdir, stage]; head !== workdir
// means the working tree differs from HEAD (added, modified, or deleted).
async function stageAll(dir: string): Promise<number> {
  const matrix = await isogit.statusMatrix({ fs, dir })
  let changes = 0
  for (const [filepath, head, workdir, stage] of matrix) {
    if (head === 1 && workdir === 1 && stage === 1) continue
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

async function hasHeadCommit(dir: string): Promise<boolean> {
  try {
    await isogit.resolveRef({ fs, dir, ref: "HEAD" })
    return true
  } catch {
    return false
  }
}

async function commitBaseline(dir: string): Promise<string> {
  await stageAll(dir)
  return isogit.commit({ fs, dir, message: "memory baseline", author: AUTHOR })
}

/**
 * Mirrors codex prepare_memory_workspace: an existing baseline is preserved
 * untouched so the phase-2 diff spans last-successful-run -> now — including
 * manual user edits and newly added ad-hoc notes. Committing here would
 * swallow those changes and consolidation would never see them. Only a root
 * without any commit gets a fresh baseline.
 */
export async function ensureBaseline(): Promise<boolean> {
  const dir = memoryRoot()
  try {
    removeDiffArtifact(dir)
    await ensureInit(dir)
    if (!(await hasHeadCommit(dir))) {
      await commitBaseline(dir)
    }
    return true
  } catch (err) {
    // codex ensure_git_baseline_repository: unusable/corrupt git metadata is
    // recovered by a destructive fresh re-init (reset_git_repository_sync)
    // instead of failing the job forever.
    console.error("[opencode-codex-memory] ensureBaseline error, re-initializing baseline:", err)
    try {
      fs.rmSync(path.join(dir, ".git"), { recursive: true, force: true })
      await isogit.init({ fs, dir })
      await commitBaseline(dir)
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
  try {
    return fs.readFileSync(path.join(dir, filepath), "utf8")
  } catch {
    return ""
  }
}

// Throws on failure: codex fails the phase-2 job on workspace-status errors
// (failed_workspace_status). Swallowing the error here would make an errored
// diff indistinguishable from "no changes" and falsely mark the job succeeded.
export async function captureWorkspaceDiff(): Promise<WorkspaceDiff> {
  const dir = memoryRoot()
  await ensureInit(dir)
  removeDiffArtifact(dir)
  const matrix = await isogit.statusMatrix({ fs, dir })
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
    // No per-file cap: codex renders every file's patch in full and relies
    // on the global 4 MiB truncation in writeWorkspaceDiff.
    patches.push(createPatch(filepath, oldText, newText))
  }
  return { changes, unifiedDiff: patches.join("\n") }
}

/**
 * Mirrors codex reset_git_repository: delete .git and re-create a fresh
 * single-commit baseline so deleted/redacted memory content is not retained
 * in unreachable git objects (history is intentionally dropped).
 */
export async function resetBaseline(): Promise<boolean> {
  try {
    const dir = memoryRoot()
    removeDiffArtifact(dir)
    fs.rmSync(path.join(dir, ".git"), { recursive: true, force: true })
    await isogit.init({ fs, dir })
    await commitBaseline(dir)
    return true
  } catch (err) {
    console.error("[opencode-codex-memory] resetBaseline error:", err)
    return false
  }
}
