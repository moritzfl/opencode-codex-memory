import fs from "fs"
import path from "path"
import { memoryRoot } from "./paths.js"

const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "opencode-memex", GIT_AUTHOR_EMAIL: "memex@opencode.local", GIT_COMMITTER_NAME: "opencode-memex", GIT_COMMITTER_EMAIL: "memex@opencode.local" }

let gitChecked = false
let gitAvailable: boolean | null = null

export function isGitAvailable(): boolean {
  if (gitAvailable !== null) return gitAvailable
  try {
    const proc = Bun.spawnSync(["git", "--version"], { stdout: "ignore", stderr: "ignore" })
    gitAvailable = proc.exitCode === 0
  } catch {
    gitAvailable = false
  }
  gitChecked = true
  return gitAvailable
}

function runGit(args: string[], opts: { cwd: string }): { ok: boolean; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["git", ...args], { cwd: opts.cwd, env: { ...process.env, ...GIT_ENV } })
  const stdout = proc.stdout?.toString("utf8") ?? ""
  const stderr = proc.stderr?.toString("utf8") ?? ""
  return { ok: proc.exitCode === 0, stdout, stderr }
}

export function ensureBaseline(): boolean {
  if (!isGitAvailable()) return false
  const root = memoryRoot()
  const gitDir = path.join(root, ".git")
  if (!fs.existsSync(gitDir)) {
    const init = runGit(["init"], { cwd: root })
    if (!init.ok) return false
  }
  runGit(["add", "-A"], { cwd: root })
  const hasFiles = runGit(["diff", "--cached", "--quiet"], { cwd: root })
  if (!hasFiles.ok) {
    const commit = runGit(["commit", "-m", "memex baseline", "--allow-empty"], { cwd: root })
    if (!commit.ok) return false
  } else {
    const commit = runGit(["commit", "-m", "memex baseline", "--allow-empty"], { cwd: root })
    if (!commit.ok && !commit.stderr.includes("nothing to commit")) return false
  }
  return true
}

export function captureWorkspaceDiff(): string {
  if (!isGitAvailable()) return ""
  const root = memoryRoot()
  runGit(["add", "-A"], { cwd: root })
  const diff = runGit(["diff", "--cached", "--no-color"], { cwd: root })
  return diff.stdout
}

export function resetBaseline(): boolean {
  if (!isGitAvailable()) return false
  const root = memoryRoot()
  runGit(["add", "-A"], { cwd: root })
  const hasChanges = runGit(["diff", "--cached", "--quiet"], { cwd: root })
  if (!hasChanges.ok) {
    const commit = runGit(["commit", "-m", "memex consolidated"], { cwd: root })
    return commit.ok
  }
  return true
}