// Prepack smoke test. Two phases:
//
//   1. Development flow — load the built entry from the repo exactly the way
//      opencode does (readPluginPackage -> main -> import -> readV1Plugin ->
//      server(input)) and exercise every hook that reads files shipped in the
//      package (templates, bundled opencode.json). Catches packaging bugs
//      (missing assets, unresolvable imports) before publish.
//
//   2. Real-world install flow — `npm pack` the artifact, install it into a
//      throwaway consumer exactly as opencode's package cache does (a bare
//      `npm install`, no repo node_modules to hoist into), then load the V1
//      entry and the V2 tool adapter from the installed copy. This is where
//      the shipped 0.9.5 broke: zod was an optional peer, the cache never
//      installs it, and V2 setup failed with ERR_MODULE_NOT_FOUND even though
//      the dev flow was green. Mirrors opencode-gemini-auth's prepack smoke.
import fs from "fs"
import os from "os"
import path from "path"

// process.exit() skips `finally` in bun and node, so every exit path funnels
// through here; otherwise each run leaks its temp tree.
function exit(code: number, tempDirs: string[]): never {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
  process.exit(code)
}

function fail(msg: string, tempDirs: string[]): never {
  console.error(`smoke: FAIL — ${msg}`)
  exit(1, tempDirs)
}

async function run(command: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  // Bun's implicit environment does not include process.env changes made
  // after startup. Carry the test-root override into the installed probe.
  const proc = Bun.spawn(command, { cwd, env: process.env, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

const root = path.resolve(import.meta.dirname, "..")
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-memory-smoke-"))
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "codex-memory-smoke-pack-"))
const tempDirs = [testRoot, stage]
process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT = testRoot

fs.mkdirSync(path.join(testRoot, "memories"), { recursive: true })
fs.writeFileSync(path.join(testRoot, "memories", "memory_summary.md"), "- smoke memory [[ses_smoke]]\n")

async function main(): Promise<number> {
  // --- Phase 1: development flow -------------------------------------------
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
  const entry = path.resolve(root, pkg.main)
  if (!fs.existsSync(entry)) fail(`main entry ${pkg.main} does not exist — run build first`, tempDirs)

  const mod = await import(entry)
  const v1 = mod.default
  if (typeof v1?.server !== "function") fail("default export is not a V1 plugin module ({ id, server() })", tempDirs)

  const tuiPath = pkg.exports?.["./tui"]?.import
  if (typeof tuiPath !== "string") fail("package.json missing exports['./tui'].import", tempDirs)
  const tuiEntry = path.resolve(root, tuiPath)
  if (!fs.existsSync(tuiEntry)) fail(`tui entry ${tuiPath} does not exist — run build first`, tempDirs)
  const tuiSrc = fs.readFileSync(tuiEntry, "utf8")
  if (tuiSrc.includes("@opencode/plugin")) fail("tui entry must not mention @opencode/plugin (1.x has no V2 TUI SDK)", tempDirs)
  const tui = (await import(tuiEntry)).default
  if (typeof tui?.tui !== "function") fail("tui export missing tui() — OpenCode 1.18.29+ TUI loader requires it", tempDirs)
  if (typeof tui?.setup !== "function") fail("tui export missing setup() — OpenCode 2 TUI loader requires it", tempDirs)
  if (typeof tui?.server === "function") fail("tui export must not also have server() — 1.18.30 forbids both", tempDirs)
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
  if (!tools.includes("memory_read")) fail(`memory tools missing (got: ${tools.join(", ") || "none"})`, tempDirs)

  // config hook -> agent injection (requires bundled opencode.json next to dist/src/..)
  const cfg: { agent?: Record<string, unknown> } = {}
  await hooks.config(cfg)
  if (!cfg.agent?.memorize || !cfg.agent?.["memorize-extract"]) {
    fail("agent injection failed — bundled opencode.json not found in package", tempDirs)
  }

  // system.transform -> read_path template (requires dist/src/templates/*.md)
  const out: { system: string[] } = { system: [] }
  await hooks["experimental.chat.system.transform"]({ sessionID: "ses_smoke", model: {} }, out)
  if (out.system.length === 0) fail("memory system prompt not injected — templates missing from package", tempDirs)

  await hooks.dispose?.()

  // --- Phase 2: real-world install flow ------------------------------------
  const packed = await run(["npm", "pack", "--ignore-scripts", "--json", "--pack-destination", stage], root)
  if (packed.code !== 0) fail(`npm pack failed: ${packed.stderr.slice(-500)}`, tempDirs)
  const meta = JSON.parse(packed.stdout) as Array<{ filename?: string }>
  const tarball = path.join(stage, meta[0]?.filename ?? "")
  if (!meta[0]?.filename || !fs.existsSync(tarball)) fail("npm pack produced no tarball", tempDirs)

  // Consumer with no repo node_modules above it: nothing to hoist. Matches
  // opencode's cache layout (~/.cache/opencode/packages/<spec>/).
  const consumer = path.join(stage, "consumer")
  fs.mkdirSync(consumer, { recursive: true })
  fs.writeFileSync(
    path.join(consumer, "package.json"),
    JSON.stringify({ name: "smoke-consumer", private: true, type: "module" }, null, 2),
  )
  const install = await run(["npm", "install", "--ignore-scripts", "--no-save", "--install-strategy=nested", tarball], consumer)
  if (install.code !== 0) fail(`npm install of packed artifact failed: ${install.stderr.slice(-1000)}`, tempDirs)

  const pluginDir = path.join(consumer, "node_modules", "opencode-codex-memory")
  if (!fs.existsSync(pluginDir)) fail("installed package directory missing", tempDirs)

  // Every bare specifier the plugin imports at runtime must resolve from the
  // installed copy. Optional peers (V2 SDK, opentui) are intentionally absent,
  // so probe the entrypoints that need only runtime dependencies: the V1 entry
  // and the V2 tool adapter (whose static `zod` import is the exact
  // regression). Exercise hooks/assets and tool schemas too: successful
  // imports alone cannot establish that the installed plugin works.
  const toolsModule = path.join(pluginDir, "dist", "src", "v2", "tools.js")
  if (!fs.existsSync(toolsModule)) fail("packed V2 tool adapter missing", tempDirs)
  const probe = `
    const { default: assert } = await import("node:assert/strict");
    assert.equal(process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT, ${JSON.stringify(testRoot)}, "probe must use the isolated memory root");
    const report = { ok: true, errors: [] };
    try {
      const v1 = (await import("opencode-codex-memory")).default;
      assert.equal(typeof v1?.server, "function");
      assert.equal((await import("./server.js")).default, v1, "local server entry must match npm export");
      const hooks = await v1.server({
        client: { session: { list: async () => ({ data: [] }) }, mcp: { status: async () => ({ data: {} }) } },
        directory: process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT,
        worktree: process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT,
        project: { id: "packed-smoke" },
      });
      try {
        assert.equal(Object.keys(hooks.tool).length, 7);
        const config = {};
        await hooks.config(config);
        assert.ok(config.agent?.memorize && config.agent?.["memorize-extract"], "packed agents missing");
        const out = { system: [] };
        await hooks["experimental.chat.system.transform"]({ sessionID: "ses_packed_v1", model: {} }, out);
        assert.ok(out.system.join("\\n").includes("smoke memory"), "packed read-path template missing");
        const read = await hooks.tool.memory_read.execute({ path: "memory_summary.md" }, { sessionID: "ses_packed_v1" });
        assert.ok(read.output.includes("smoke memory"), "packed V1 read failed");
      } finally { await hooks.dispose?.(); }
      const tui = (await import("opencode-codex-memory/tui")).default;
      assert.equal((await import("./tui.js")).default, tui, "local TUI entry must match npm export");
      assert.equal(typeof tui.tui, "function");
      assert.equal(typeof tui.setup, "function");
      assert.equal(tui.server, undefined);
      await tui.tui();
    } catch (e) { report.errors.push("V1 hooks/assets/tui: " + e.message); }
    try {
      const { buildV2Tools } = await import(${JSON.stringify(toolsModule)});
      const { z } = await import("zod");
      const tools = buildV2Tools();
      assert.equal(tools.length, 6);
      for (const tool of tools) {
        assert.equal(tool.options.codemode, false);
        assert.equal(z.toJSONSchema(tool.input).type, "object");
      }
      for (const [name, args, expected] of [
        ["memory_read", { path: "memory_summary.md" }, "smoke memory"],
        ["memory_search", { queries: ["smoke memory"] }, "smoke memory"],
        ["memory_list", {}, "memory_summary.md"],
      ]) {
        const tool = tools.find((t) => t.name === name);
        const result = await tool.execute(tool.input.parse(args), { sessionID: "ses_packed_v2", messageID: "msg_smoke", agent: "build" });
        assert.ok(result.content.includes(expected), name + " returned unexpected content");
        assert.deepEqual(result, JSON.parse(JSON.stringify(result)), name + " returned non-JSON metadata");
      }
    } catch (e) { report.errors.push("V2 schemas/tools: " + e.message); }
    report.ok = report.errors.length === 0;
    console.log(JSON.stringify(report));
  `
  const probed = await run([process.execPath, "-e", probe], pluginDir)
  if (probed.code !== 0) fail(`installed-artifact probe exited ${probed.code}: ${probed.stderr.slice(-1000)}`, tempDirs)
  const line = probed.stdout.trim().split("\n").filter(Boolean).pop() ?? ""
  let result: { ok?: boolean; errors?: string[] } = {}
  try {
    result = JSON.parse(line)
  } catch {
    fail(`installed-artifact probe produced no JSON (stdout: ${probed.stdout.slice(-500)}, stderr: ${probed.stderr.slice(-500)})`, tempDirs)
  }
  if (result.ok !== true) fail(`installed artifact failed to load: ${(result.errors ?? []).join("; ")}`, tempDirs)

  console.log(`smoke: OK — dev entry loads (${tools.length} tools, agents, templates) + packed V1 hooks/assets/tui and V2 schemas/tools work`)
  return 0
}

main().then(
  (code) => exit(code, tempDirs),
  (e) => fail(e instanceof Error ? e.message : String(e), tempDirs),
)
