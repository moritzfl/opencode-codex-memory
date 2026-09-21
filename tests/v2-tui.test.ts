import { expect, it } from "bun:test"
import path from "node:path"

it("V2 memory dialog: keyboard, rendering, actions, recovery and cleanup", async () => {
  // The server suite imports Solid's non-reactive server build. A separate
  // browser-conditioned process gives the TUI the same reactive runtime as its host.
  const proc = Bun.spawn([
    process.execPath, "--conditions=browser", "--preload", "@opentui/solid/preload",
    "tests/fixtures/tui-ux.tsx",
  ], { cwd: path.resolve(import.meta.dirname, ".."), stdout: "pipe", stderr: "pipe", timeout: 25_000 })
  const [code, stdout, stderr] = await Promise.all([
    proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
  ])
  expect({ code, output: code === 0 ? "ok" : stdout + stderr }).toEqual({ code: 0, output: "ok" })
}, 30_000)
