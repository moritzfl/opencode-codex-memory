import { expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

it("lifecycle tests never write to the fallback memory home during teardown", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ocm-test-isolation-"))
  const root = path.join(home, "memories")
  const raw = path.join(root, "raw_memories.md")
  const recap = path.join(root, "rollout_summaries", "keep.md")
  fs.mkdirSync(path.dirname(recap), { recursive: true })
  fs.writeFileSync(raw, "Existing raw memories\n")
  fs.writeFileSync(recap, "Existing session recap\n")
  const env: NodeJS.ProcessEnv = { ...process.env, OPENCODE_CODEX_MEMORY_HOME: home }
  delete env.OPENCODE_CODEX_MEMORY_TEST_ROOT
  const child = Bun.spawn([process.execPath, "test", "tests/lifecycle.test.ts"], {
    cwd: path.resolve(import.meta.dirname, ".."), env, stdout: "pipe", stderr: "pipe",
  })
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, output: code === 0 ? "" : stdout + stderr }).toEqual({ code: 0, output: "" })
    expect(fs.readFileSync(raw, "utf8")).toBe("Existing raw memories\n")
    expect(fs.readFileSync(recap, "utf8")).toBe("Existing session recap\n")
  } finally {
    child.kill()
    await child.exited
    fs.rmSync(home, { recursive: true, force: true })
  }
}, 15_000)
