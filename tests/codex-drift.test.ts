import { expect, test } from "bun:test"
import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

test("drift detects a deleted watch-only path in a linked checkout", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-drift-"))
  try {
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim()
    git("init", "-q")
    fs.writeFileSync(path.join(dir, "watched"), "input")
    git("add", "watched")
    const commit = () => git("-c", "user.name=test", "-c", "user.email=test@local", "commit", "-qm", "fixture")
    commit()
    const pin = git("rev-parse", "HEAD")
    git("rm", "-q", "watched")
    commit()
    const tree = path.join(dir, "linked")
    git("worktree", "add", "-q", "--detach", tree)
    fs.mkdirSync(path.join(dir, "scripts"))
    const script = path.join(dir, "scripts/check-codex-drift.sh")
    fs.copyFileSync(path.join(import.meta.dir, "../scripts/check-codex-drift.sh"), script)
    const run = (watch: string) => {
      fs.writeFileSync(
        path.join(dir, "codex-map.yaml"),
        `codex_ref: ${pin}\ncodex_ref_date: today\nwatch_paths:\n${watch}`,
      )
      return spawnSync("bash", [script, tree], { encoding: "utf8" })
    }
    const deleted = run("  - watched\n")
    expect(deleted.status).toBe(1)
    expect(deleted.stdout).toContain("deletion")
    expect(run("").status).toBe(2)
    expect(run("  - typo\n").status).toBe(2)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)
