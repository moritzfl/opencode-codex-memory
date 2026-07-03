import fs from "fs"
import path from "path"
import { memoryRoot } from "./paths.js"
import * as isogit from "isomorphic-git"

const AUTHOR = { name: "opencode-memex", email: "memex@opencode.local" }

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
    await addAndCommit(memoryRoot(), "memex baseline")
    return true
  } catch (err) {
    console.error("[opencode-memex] ensureBaseline error:", err)
    return false
  }
}

export async function captureWorkspaceDiff(): Promise<string> {
  try {
    const dir = memoryRoot()
    await ensureInit(dir)
    const matrix = await isogit.statusMatrix({ fs, dir })
    return matrix
      .filter(([filepath, head, workdir]) => head !== workdir && filepath !== "phase2_workspace_diff.md")
      .map(([filepath, head, workdir]) => {
        if (head === 0) return `A ${filepath}`
        if (workdir === 0) return `D ${filepath}`
        return `M ${filepath}`
      })
      .join("\n")
  } catch (err) {
    console.error("[opencode-memex] captureWorkspaceDiff error:", err)
    return ""
  }
}

export async function resetBaseline(): Promise<boolean> {
  try {
    await addAndCommit(memoryRoot(), "memex consolidated")
    return true
  } catch (err) {
    console.error("[opencode-memex] resetBaseline error:", err)
    return false
  }
}
