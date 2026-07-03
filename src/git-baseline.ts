import fs from "fs"
import path from "path"
import { memoryRoot } from "./paths.js"
import * as isogit from "isomorphic-git"
import { createPatch } from "diff"

const AUTHOR = { name: "opencode-memex", email: "memex@opencode.local" }

// Generated prompt artifact; removed before diffing and before baseline
// commits (mirrors codex's remove_workspace_diff) so it never enters the
// baseline history or shows up as memory content.
export const DIFF_ARTIFACT = "phase2_workspace_diff.md"
const PER_FILE_DIFF_MAX_BYTES = 64 * 1024

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

async function addAndCommit(dir: string, message: string): Promise<string | null> {
  await ensureInit(dir)
  const changes = await stageAll(dir)
  if (changes === 0) return null
  return isogit.commit({ fs, dir, message, author: AUTHOR })
}

export async function ensureBaseline(): Promise<boolean> {
  try {
    const dir = memoryRoot()
    removeDiffArtifact(dir)
    await addAndCommit(dir, "memex baseline")
    return true
  } catch (err) {
    console.error("[opencode-memex] ensureBaseline error:", err)
    return false
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

export async function captureWorkspaceDiff(): Promise<WorkspaceDiff> {
  try {
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
      const patch = createPatch(filepath, oldText, newText)
      patches.push(
        patch.length > PER_FILE_DIFF_MAX_BYTES
          ? `Index: ${filepath}\n[diff omitted: ${patch.length} bytes]\n`
          : patch,
      )
    }
    return { changes, unifiedDiff: patches.join("\n") }
  } catch (err) {
    console.error("[opencode-memex] captureWorkspaceDiff error:", err)
    return { changes: [], unifiedDiff: "" }
  }
}

export async function resetBaseline(): Promise<boolean> {
  try {
    const dir = memoryRoot()
    removeDiffArtifact(dir)
    await addAndCommit(dir, "memex consolidated")
    return true
  } catch (err) {
    console.error("[opencode-memex] resetBaseline error:", err)
    return false
  }
}
