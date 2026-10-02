/**
 * V2 contract check for the opencode2 host adapter (src/v2/*).
 *
 * No LLM, no auth, no Docker. Safe for every PR / pre-release ritual.
 *
 * Checks:
 *   1. OpenCode 2 binary present; version ≥ floor (OPENCODE2_MIN_VERSION,
 *      default 2.0.3)
 *   2. Live OpenAPI (/openapi.json via the background service): every
 *      operation the shim + setup depend on is present
 *   3. Built plugin dual-exports V1 server() and V2 setup()
 *   4. V2 memorize agent satisfies the deny-first allowlist shape
 *   5. V2 tool registration yields the expected tools (reset stays panel-only)
 *   6. Packed artifact loads in isolated consumers and boots on the real V2 host
 *
 * Exit 0 = aligned. Exit 1 = contract break. Exit 2 = setup error.
 */
import fs from "fs"
import os from "os"
import path from "path"
import { $ } from "bun"
import { api, basicAuth, createSandbox, createSession, startServe, tail, waitFor, type ServeHandle } from "./lib/harness.js"
import { installFilePermissionProbe, probeFilePermissions } from "./lib/v2-file-permission-probe.js"
import type { MemoryStatus } from "../src/v2/status-rpc.js"

const MIN_VERSION = process.env.OPENCODE2_MIN_VERSION?.trim() || "2.0.3"

let failed = 0
function log(kind: string, msg: string): void {
  console.log(`[${kind}] ${msg}`)
}
function note(ok: boolean, msg: string): void {
  if (ok) log("ok", msg)
  else {
    console.error(`[fail] ${msg}`)
    failed++
  }
}
function failSetup(msg: string): never {
  console.error(`[setup] ${msg}`)
  process.exit(2)
}

async function runQuiet(command: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(command, { cwd, env: process.env, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

// Semver comparison with the historical beta-NNN format retained for an
// explicitly pinned pre-release floor.
function versionGte(a: string, b: string): boolean {
  const parse = (value: string) => {
    const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-beta-(\d+))?$/)
    if (!match) return null
    return { core: [Number(match[1]), Number(match[2]), Number(match[3])], beta: match[4] ? Number(match[4]) : null }
  }
  const av = parse(a)
  const bv = parse(b)
  if (!av || !bv) return false
  for (let i = 0; i < av.core.length; i++) {
    if (av.core[i] !== bv.core[i]) return av.core[i] > bv.core[i]
  }
  if (av.beta === null || bv.beta === null) return av.beta === null
  return av.beta >= bv.beta
}

/** Live 2.0.5 ids first; 2.0.3 `v2.*` aliases still accepted. */
const REQUIRED_OPS: { name: string; ids: string[] }[] = [
  { name: "session.create", ids: ["session.create", "v2.session.create"] },
  { name: "session.get", ids: ["session.get", "v2.session.get"] },
  { name: "session.prompt", ids: ["session.prompt", "v2.session.prompt"] },
  { name: "session.wait", ids: ["session.wait", "experimental.session.wait", "v2.session.wait"] },
  { name: "session.generate", ids: ["session.generate", "v2.session.generate"] },
  { name: "session.switchAgent", ids: ["session.switchAgent", "v2.session.switchAgent"] },
  { name: "session.switchModel", ids: ["session.switchModel", "v2.session.switchModel"] },
  { name: "session.interrupt", ids: ["session.interrupt", "v2.session.interrupt"] },
  { name: "session.list", ids: ["session.list", "v2.session.list"] },
  { name: "session.remove", ids: ["session.remove", "v2.session.remove"] },
  { name: "session.message.list", ids: ["session.message.list", "v2.message.list", "message.list"] },
  { name: "config.get", ids: ["config.get", "v2.config.get"] },
  { name: "generate.text", ids: ["experimental.generate.text", "generate.text", "v2.generate.text"] },
  { name: "mcp.list", ids: ["mcp.list", "v2.mcp.list"] },
  { name: "agent.get", ids: ["agent.get", "v2.agent.get"] },
  { name: "event.subscribe", ids: ["event.subscribe", "v2.event.subscribe"] },
  { name: "model.list", ids: ["model.list", "v2.model.list"] },
]

async function main(): Promise<void> {
  // --- binary ---
  let version = ""
  try {
    version = ((await $`opencode2 --version`.text()).trim().split(/\s+/).pop() ?? "").replace(/^v/, "")
  } catch {
    failSetup("opencode2 binary not found on PATH")
  }
  log("bin", `opencode2 @ ${version}`)
  note(versionGte(version, MIN_VERSION), `opencode2 ${version} ≥ ${MIN_VERSION}`)

  // --- OpenAPI from an isolated host, using its own sandbox auth ---
  let doc: { paths?: Record<string, Record<string, { operationId?: string }>> }
  const sandbox = createSandbox({ bare: true })
  installFilePermissionProbe(sandbox)
  let serve: ServeHandle | undefined
  try {
    serve = await startServe(sandbox, { bin: "opencode2" })
    const response = await api(serve, sandbox, "GET", "/openapi.json")
    if (response.status !== 200) throw new Error(`OpenAPI HTTP ${response.status}`)
    doc = response.json as typeof doc
    const { fetchServiceStatus } = (await import(
      path.resolve(import.meta.dirname, "../dist/src/v2/service.js")
    )) as typeof import("../src/v2/service.js")
    const status = await fetchServiceStatus({ url: serve.baseUrl }, basicAuth(sandbox), AbortSignal.timeout(3_000))
    note(status.version === version, `built service discovery recognizes OpenCode ${status.version}`)
    // Verify the create-time sandbox on the real host. Some hosts expose no
    // permission.rules method despite older SDK/docs advertising it.
    // Load the built artifact at runtime; typecheck must also work before build.
    const { consolidationPermissions } = (await import(
      path.resolve(import.meta.dirname, "../dist/src/v2/agents.js")
    )) as typeof import("../src/v2/agents.js")
    for (const version of ["v1", "v2"] as const) {
      const own = path.join(sandbox.opencodeData, version === "v1" ? "memories" : "memories_v2")
      const other = path.join(sandbox.opencodeData, version === "v1" ? "memories_v2" : "memories")
      const created = await api(serve, sandbox, "POST", "/api/session", {
        title: `contract-memory-${version}`,
        location: { directory: sandbox.project },
        permissions: consolidationPermissions(own),
      })
      const id = (created.json as { data?: { id?: string } })?.data?.id
      if (!id) throw new Error(`sandbox session create HTTP ${created.status}`)
      for (const [action, resource, expected] of [
        ["edit", path.join(own, "memory_summary.md"), "allow"],
        ["read", own, "allow"],
        ["glob", "**/*.md", "allow"],
        ["grep", "deployment", "allow"],
        ["edit", path.join(other, "memory_summary.md"), "deny"],
        ["read", path.join(other, "memory_summary.md"), "deny"],
        ["edit", path.join(sandbox.project, "source.ts"), "deny"],
        ["shell", "echo forbidden", "deny"],
      ]) {
        const checked = await api(serve, sandbox, "POST", `/api/session/${id}/permission`, { action, resources: [resource] })
        const effect = (checked.json as { data?: { effect?: string } })?.data?.effect
        note(effect === expected, `${version} helper ${action}: ${expected} ${resource}`)
      }
      // FileAccess.resolve asserts this form when the session directory contains
      // the memory root. Absolute-only grants deny it.
      const parent = path.dirname(own)
      const nested = await api(serve, sandbox, "POST", "/api/session", {
        title: `contract-memory-nested-${version}`,
        location: { directory: parent },
        permissions: consolidationPermissions(own, parent),
      }, { directory: parent })
      const nestedId = (nested.json as { data?: { id?: string } })?.data?.id
      if (!nestedId) throw new Error(`nested sandbox session create HTTP ${nested.status}`)
      const relRoot = path.basename(own)
      for (const [action, resource, expected] of [
        ["edit", `${relRoot}/memory_summary.md`, "allow"],
        ["edit", `${relRoot}/rollout_summaries/x.md`, "allow"],
        ["read", relRoot, "allow"],
        ["edit", "README.md", "deny"],
        ["edit", `${path.basename(other)}/memory_summary.md`, "deny"],
      ] as const) {
        const checked = await api(serve, sandbox, "POST", `/api/session/${nestedId}/permission`, { action, resources: [resource] }, { directory: parent })
        const effect = (checked.json as { data?: { effect?: string } })?.data?.effect
        note(effect === expected, `${version} nested helper ${action}: ${expected} ${resource}`)
      }
      for (const directory of [parent, own, path.join(own, "rollout_summaries")]) {
        fs.mkdirSync(directory, { recursive: true })
        const created = await api(serve, sandbox, "POST", "/api/session", {
          title: "native-file-permissions", location: { directory },
          permissions: consolidationPermissions(own, directory),
        }, { directory })
        const sessionID = (created.json as { data?: { id?: string } })?.data?.id
        if (!sessionID) throw new Error(created.text)
        const target = path.join(own, "probe.md")
        const outside = path.join(other, "probe.md")
        fs.mkdirSync(other, { recursive: true })
        fs.writeFileSync(outside, "outside")
        const results = await probeFilePermissions(serve, sandbox, sessionID, directory, [
          { tool: "write", input: { path: target, content: "inside" } },
          { tool: "read", input: { path: target } },
          { tool: "write", input: { path: outside, content: "forbidden" } },
          { tool: "read", input: { path: outside } },
        ])
        note(results[0]?.ok === true && results[1]?.ok === true, `native memory write/read from ${directory}: ${JSON.stringify(results)}`)
        note(results[2]?.ok === false && results[3]?.ok === false && fs.readFileSync(outside, "utf8") === "outside", "native tools deny sibling memory root")
      }
    }
  } catch (e) {
    throw new Error(`could not fetch /openapi.json: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    await serve?.stop()
    sandbox.cleanup()
  }
  const ops = new Set<string>()
  for (const methods of Object.values(doc.paths ?? {})) {
    for (const spec of Object.values(methods)) {
      if (spec?.operationId) ops.add(spec.operationId)
    }
  }
  note(ops.size > 0, `openapi has ${ops.size} operations`)
  for (const op of REQUIRED_OPS) {
    const found = op.ids.find((id) => ops.has(id))
    note(Boolean(found), `operation ${op.name} present${found && found !== op.name ? ` as ${found}` : ""}`)
  }

  // --- built plugin dual export ---
  const root = path.resolve(import.meta.dirname, "..")
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ocm-contract2-plugin-"))
  process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT = testRoot
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
    const entry = path.resolve(root, pkg.main)
    if (!fs.existsSync(entry)) failSetup(`main entry ${pkg.main} missing — run build first`)
    const mod = await import(entry + `?t=${Date.now()}`)
    note(typeof mod.default?.server === "function", "default export keeps V1 server()")
    note(typeof mod.default?.setup === "function", "default export adds V2 setup()")
    note(mod.default?.id === "opencode-codex-memory", "plugin id unchanged")

    const tuiEntry = path.resolve(root, pkg.exports?.["./tui"]?.import ?? "./dist/src/tui.js")
    if (!fs.existsSync(tuiEntry)) failSetup(`tui entry missing — run build first`)
    const tuiSrc = fs.readFileSync(tuiEntry, "utf8")
    note(!tuiSrc.includes("@opencode/plugin"), "./tui JS does not import the V2 TUI SDK")
    const tuimod = await import(tuiEntry + `?t=${Date.now()}`)
    note(typeof tuimod.default?.tui === "function", "./tui entry exports tui() for OpenCode 1.18.29+")
    note(typeof tuimod.default?.setup === "function", "./tui entry exports setup() for OpenCode 2")
    note(typeof tuimod.default?.server !== "function", "./tui entry has no server() (1.18.30 forbids both)")

    const v2entry = path.resolve(root, pkg.exports?.["./v2"]?.import ?? "./dist/src/v2/index.js")
    if (!fs.existsSync(v2entry)) failSetup(`v2 entry missing — run build first`)
    const v2mod = await import(v2entry + `?t=${Date.now()}`)
    note(typeof v2mod.default?.setup === "function", "./v2 entry exports setup()")

    // --- V2 agent shape (D2 allowlist, V2 action names) ---
    const agents = (await import(path.join(root, "dist", "src", "v2", "agents.js") + `?t=${Date.now()}`)) as typeof import("../src/v2/agents.js")
    const def = agents.buildMemorizeAgent()
    note(def.mode === "subagent", "memorize mode is subagent")
    const rules = def.permissions
    note(rules[0]?.action === "*" && rules[0]?.effect === "deny", "wildcard deny is first")
    const allows = new Set(rules.filter((r) => r.effect === "allow").map((r) => r.action))
    const safeAllows = new Set(["read", "edit", "glob", "grep", "external_directory"])
    note([...allows].every((a) => safeAllows.has(a)), `allows ⊆ read/edit/glob/grep/external_directory (got ${[...allows].join(",")})`)
    for (const t of ["read", "edit", "glob", "grep"]) note(allows.has(t), `allows ${t}`)

    // --- V2 tool sets ---
    const tools = (await import(path.join(root, "dist", "src", "v2", "tools.js") + `?t=${Date.now()}`)) as typeof import("../src/v2/tools.js")
    const names = tools.buildV2Tools().map((t) => t.name).sort()
    for (const t of ["memory_read", "memory_search", "memory_list", "memory_add_note", "memory_inspect", "memory_mode"]) {
      note(names.includes(t), `v2 tool ${t} registered`)
    }
    // Reset needs user approval, which V2 plugin tools cannot request.
    note(!names.includes("memory_reset"), "v2 memory_reset stays out of model tools (panel only)")

    const memoryRoot = path.join(testRoot, "memories")
    for (const rule of rules.filter((r) => r.effect === "allow" && r.action !== "external_directory")) {
      if (rule.action === "glob" || rule.action === "grep") {
        note(rule.resource === "*", `${rule.action} permits search patterns (executor enforces paths)`)
      } else {
        note([memoryRoot, path.join(memoryRoot, "*")].includes(rule.resource), `${rule.action} is scoped to the memory workspace`)
      }
    }

    // Exercise the package as consumers receive it. The V1 install omits all
    // V2 peers, proving the lazy entrypoint does not import them eagerly.
    const pack = await runQuiet(["npm", "pack", "--ignore-scripts", "--json", "--pack-destination", testRoot], root)
    if (pack.code !== 0) {
      note(false, `npm pack failed: ${pack.stderr.slice(-1000)}`)
    } else {
      let tarball = ""
      try {
        const metadata = JSON.parse(pack.stdout) as Array<{ filename?: string }>
        tarball = path.join(testRoot, metadata[0]?.filename ?? "")
      } catch {
        tarball = ""
      }
      note(Boolean(tarball && fs.existsSync(tarball)), "packed artifact exists")
      if (tarball && fs.existsSync(tarball)) {
        // `--install-strategy=nested` mirrors an isolated plugin cache: a
        // transitive/peer dependency cannot hoist to the root and silently
        // satisfy a missing runtime dependency. The published 0.9.5 loaded
        // here only because @opencode/plugin's own zod hoisted; nested makes
        // that masking impossible.
        // Keep both consumers under the finally-cleaned root, including when
        // spawning npm or a probe throws.
        const v1Install = path.join(testRoot, "v1-consumer")
        fs.mkdirSync(v1Install)
        const v1 = await runQuiet(["npm", "install", "--ignore-scripts", "--no-save", "--install-strategy=nested", tarball, "@types/node"], v1Install)
        note(v1.code === 0, `packed artifact installs for V1${v1.code === 0 ? "" : `: ${v1.stderr.slice(-1000)}`}`)
        if (v1.code === 0) {
          const loaded = await runQuiet([process.execPath, "--input-type=module", "-e", "import('opencode-codex-memory').then((m) => { if (typeof m.default?.server !== 'function') process.exit(1) }).then(() => import('opencode-codex-memory/tui')).then(async (m) => { if (typeof m.default?.tui !== 'function' || typeof m.default?.setup !== 'function' || typeof m.default?.server === 'function') process.exit(1); await m.default.tui() })"], v1Install)
          note(loaded.code === 0, "packed V1 artifact loads server+tui without V2 peers")
          const consumer = path.join(v1Install, "consumer.mts")
          fs.writeFileSync(consumer, 'import plugin from "opencode-codex-memory"\nconst server = plugin.server\nif (typeof server !== "function") throw new Error("missing V1 server export")\n')
          const typecheck = await runQuiet(
            [
              path.join(root, "node_modules", ".bin", "tsc"),
              "--noEmit",
              "--skipLibCheck",
              "false",
              "--module",
              "NodeNext",
              "--moduleResolution",
              "NodeNext",
              "--target",
              "ES2022",
              consumer,
            ],
            v1Install,
          )
          const typecheckOutput = typecheck.stderr || typecheck.stdout
          note(typecheck.code === 0, `packed V1 declarations typecheck without V2 peers${typecheck.code === 0 ? "" : `: ${typecheckOutput.slice(-1000)}`}`)

          // The actual cache does not install the V2 SDK peer. Boot that exact
          // package on V2: importing /v2 with a manually installed peer cannot
          // prove the host loader invokes the dual entrypoint's lazy setup.
          const packedSandbox = createSandbox({ bare: true })
          let packedServe: ServeHandle | undefined
          try {
            const configPath = path.join(packedSandbox.configHome, "opencode", "opencode.json")
            const config = JSON.parse(fs.readFileSync(configPath, "utf8"))
            config.plugins = [{
              package: path.join(v1Install, "node_modules", "opencode-codex-memory"),
              options: { test: true, generate_memories: false },
            }]
            fs.writeFileSync(configPath, JSON.stringify(config))
            packedServe = await startServe(packedSandbox, { bin: "opencode2" })
            // RPC itself does not activate a location's plugins on every host.
            await createSession(packedServe, packedSandbox, "packed-plugin-contract")
            await waitFor("packed plugin activation", async () => {
              const plugins = await api(packedServe!, packedSandbox, "GET", "/api/plugin", undefined, { "location[directory]": packedSandbox.project })
              const plugin = (plugins.json as { data?: { id: string; state: { status: string }; features?: { tui?: boolean } }[] })?.data
                ?.find((plugin) => plugin.id === "opencode-codex-memory" || plugin.state.status === "failed")
              if (plugin?.state.status === "failed") throw new Error(`packed plugin failed: ${JSON.stringify(plugin)}`)
              if (plugin?.state.status === "active") note(plugin.features?.tui === true, "packed local TUI entry discovered by V2")
              return plugin?.state.status === "active"
            }, { timeoutMs: 30_000, intervalMs: 200 })
            const status = await api(packedServe, packedSandbox, "POST", "/api/rpc/opencode-codex-memory/status", {
              input: {},
            }, { "location[directory]": packedSandbox.project })
            const state = (status.json as { output?: Partial<MemoryStatus> })?.output
            note(status.status === 200 && state?.activity === "read_only" && state.memoryRoot === packedSandbox.memories,
              `packed plugin boots on V2 without SDK peers and serves isolated status${status.status === 200 ? "" : `: ${status.text.slice(-1000)}\n${tail(packedServe.logPath, 20)}`}`)
            note(state?.v2Ready === false && state.v2SummaryBytes === null && state.v2NotReadyReason?.includes("ENOENT") === true,
              "packed V2 RPC reports missing-summary readiness diagnostics")
            const v2Root = path.join(packedSandbox.opencodeData, "memories_v2")
            fs.mkdirSync(v2Root, { recursive: true })
            const summary = "v1\n\n## User Profile\n\n## User preferences\n\n## General Tips\n\n## What's in Memory\n"
            for (const [label, content, reason] of [
              ["valid", summary, "insufficient consolidated threads: 0 < 20"],
              ["oversized", summary.padEnd(10_000, "x"), "insufficient consolidated threads: 0 < 20"],
            ] as const) {
              fs.writeFileSync(path.join(v2Root, "memory_summary.md"), content)
              const result = await api(packedServe, packedSandbox, "POST", "/api/rpc/opencode-codex-memory/status", {
                input: {},
              }, { "location[directory]": packedSandbox.project })
              const output = (result.json as { output?: Partial<MemoryStatus> })?.output
              note(result.status === 200 && output?.v2Ready === false && output.v2SummaryBytes === Buffer.byteLength(content)
                && output.v2NotReadyReason === reason && output.v2InjectedSummaryBytes != null && output.v2InjectedSummaryBytes < 10000,
                `packed V2 RPC reports ${label}-summary readiness diagnostics${result.status === 200 ? "" : `: ${result.text.slice(-1000)}`}`)
            }
            note(!fs.existsSync(path.join(packedSandbox.opencodeData, "memory_v2.db")), "packed V2 readiness does not create an inactive database")
          } finally {
            await packedServe?.stop()
            packedSandbox.cleanup()
          }
        }
        fs.rmSync(v1Install, { recursive: true, force: true })

        const v2Install = path.join(testRoot, "v2-consumer")
        fs.mkdirSync(v2Install)
        const v2 = await runQuiet(["npm", "install", "--ignore-scripts", "--no-save", "--install-strategy=nested", tarball, "@opencode/plugin@2.0.3"], v2Install)
        note(v2.code === 0, `packed artifact installs for V2${v2.code === 0 ? "" : `: ${v2.stderr.slice(-1000)}`}`)
        if (v2.code === 0) {
          // zod is a static import of dist/src/v2/tools.js. Assert it resolves
          // from the plugin's own directory, not via a hoisted copy.
          const reachable = await runQuiet(
            [process.execPath, "--input-type=module", "-e", "import('zod').then(() => process.exit(0)).catch(() => process.exit(1))"],
            path.join(v2Install, "node_modules", "opencode-codex-memory"),
          )
          note(reachable.code === 0, "zod resolves from the installed plugin directory (no hoisted peer)")

          const loaded = await runQuiet([process.execPath, "--input-type=module", "-e", "import('opencode-codex-memory/v2').then((m) => { if (typeof m.default?.setup !== 'function') process.exit(1) })"], v2Install)
          note(loaded.code === 0, `packed V2 artifact loads with the V2 peer${loaded.code === 0 ? "" : `: ${(loaded.stderr || loaded.stdout).slice(-1000)}`}`)
        }
        fs.rmSync(v2Install, { recursive: true, force: true })
      }
    }
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true })
  }

  if (failed > 0) {
    console.error(`contract2: FAIL — ${failed} check(s) broken`)
    process.exit(1)
  }
  console.log("contract2: OK — v2 host surface aligned")
}

await main()
