import fs from "fs"
import path from "path"
import { memoryRoot } from "./paths.js"
import * as isogit from "isomorphic-git"

const AUTHOR = { name: "opencode-memex", email: "memex@opencode.local" }

let isogitAvailable = false

export function isGitAvailable(): boolean {
  return isogitAvailable
}

async function ensureInit(dir: string): Promise<void> {
  const gitDir = path.join(dir, ".git")
  if (!fs.existsSync(gitDir)) {
    await isogit.init({ fs, dir })
  }
  isogitAvailable = true
}

async function addAndCommit(dir: string, message: string): Promise<string | null> {
  await ensureInit(dir)
  const matrix = await isogit.statusMatrix({ fs, dir })
  for (const [filepath, , ,] of matrix) {
    await isogit.add({ fs, dir, filepath })
  }
  const files = (await isogit.statusMatrix({ fs, dir })).filter(([, , , staged]) => staged !== 0)
  if (files.length === 0) return null
  const sha = await isogit.commit({ fs, dir, message, author: AUTHOR })
  return sha
}

export async function ensureBaseline(): Promise<boolean> {
  try {
    const dir = memoryRoot()
    await ensureInit(dir)
    const matrix = await isogit.statusMatrix({ fs, dir })
    const hasUncommitted = matrix.some(([, head, workdir, staged]) => head !== workdir || staged !== workdir)
    if (hasUncommitted) {
      const sha = await addAndCommit(dir, "memex baseline")
      return sha !== null
    }
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
    const changed = matrix
      .filter(([, head, workdir, staged]) => head !== workdir || head !== staged)
      .map(([filepath, head, workdir]) => {
        if (head === 1 && workdir === 2) return `M ${filepath}`
        if (head === 0 && workdir === 2) return `A ${filepath}`
        if (head === 1 && workdir === 0) return `D ${filepath}`
        return `? ${filepath}`
      })
    for (const [filepath] of matrix) {
      await isogit.add({ fs, dir, filepath })
    }
    return changed.join("\n")
  } catch (err) {
    console.error("[opencode-memex] captureWorkspaceDiff error:", err)
    return ""
  }
}

export async function resetBaseline(): Promise<boolean> {
  try {
    const dir = memoryRoot()
    const sha = await addAndCommit(dir, "memex consolidated")
    return true
  } catch (err) {
    console.error("[opencode-memex] resetBaseline error:", err)
    return false
  }
}