// Prepack smoke test: load the built plugin exactly the way opencode does
// (readPluginPackage -> main -> import -> readV1Plugin -> server(input)) and
// exercise every hook that reads files shipped in the package (templates,
// bundled opencode.json). Catches packaging bugs (missing assets, unresolvable
// imports) before publish. Mirrors opencode-gemini-auth's prepack smoke test.
import fs from "fs"
import os from "os"
import path from "path"

function fail(msg: string): never {
  console.error(`smoke: FAIL — ${msg}`)
  process.exit(1)
}

const root = path.resolve(import.meta.dirname, "..")
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-memory-smoke-"))
process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT = testRoot

try {
  fs.mkdirSync(path.join(testRoot, "memories"), { recursive: true })
  fs.writeFileSync(path.join(testRoot, "memories", "memory_summary.md"), "- smoke memory [[ses_smoke]]\n")

  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
  const entry = path.resolve(root, pkg.main)
  if (!fs.existsSync(entry)) fail(`main entry ${pkg.main} does not exist — run build first`)

  const mod = await import(entry)
  const v1 = mod.default
  if (typeof v1?.server !== "function") fail("default export is not a V1 plugin module ({ id, server() })")

  const tuiPath = pkg.exports?.["./tui"]?.import
  if (typeof tuiPath !== "string") fail("package.json missing exports['./tui'].import")
  const tuiEntry = path.resolve(root, tuiPath)
  if (!fs.existsSync(tuiEntry)) fail(`tui entry ${tuiPath} does not exist — run build first`)
  const tuiSrc = fs.readFileSync(tuiEntry, "utf8")
  if (tuiSrc.includes("@opencode/plugin")) fail("tui entry must not mention @opencode/plugin (1.x has no V2 TUI SDK)")
  const tui = (await import(tuiEntry)).default
  if (typeof tui?.tui !== "function") fail("tui export missing tui() — OpenCode 1.18.29+ TUI loader requires it")
  if (typeof tui?.setup !== "function") fail("tui export missing setup() — OpenCode 2 TUI loader requires it")
  if (typeof tui?.server === "function") fail("tui export must not also have server() — 1.18.30 forbids both")
  await tui.tui()

  const stubClient = {
    session: { list: async () => ({ data: [] }) },
    mcp: { status: async () => ({ data: {} }) },
  }
  const hooks = await v1.server({
    client: stubClient,
    directory: testRoot,
    worktree: testRoot,
    project: { id: "smoke" },
  })

  const tools = Object.keys(hooks.tool ?? {})
  if (!tools.includes("memory_read")) fail(`memory tools missing (got: ${tools.join(", ") || "none"})`)

  // config hook -> agent injection (requires bundled opencode.json next to dist/src/..)
  const cfg: { agent?: Record<string, unknown> } = {}
  await hooks.config(cfg)
  if (!cfg.agent?.memorize || !cfg.agent?.["memorize-extract"]) {
    fail("agent injection failed — bundled opencode.json not found in package")
  }

  // system.transform -> read_path template (requires dist/src/templates/*.md)
  const out: { system: string[] } = { system: [] }
  await hooks["experimental.chat.system.transform"]({ sessionID: "ses_smoke", model: {} }, out)
  if (out.system.length === 0) fail("memory system prompt not injected — templates missing from package")

  await hooks.dispose?.()
  console.log(`smoke: OK — entry loads, ${tools.length} tools, agents injected, templates readable`)
  process.exit(0)
} finally {
  fs.rmSync(testRoot, { recursive: true, force: true })
}
