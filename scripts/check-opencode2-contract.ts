/**
 * V2 contract check for the opencode2 host adapter (src/v2/*).
 *
 * No LLM, no auth, no Docker. Safe for every PR / pre-release ritual.
 *
 * Checks:
 *   1. opencode2 binary present; version ≥ floor (OPENCODE2_MIN_VERSION,
 *      default 0.0.0-beta-19296 — the beta this adapter was verified against)
 *   2. Live OpenAPI (/openapi.json via the background service): every
 *      operation the shim + setup depend on is present
 *   3. Built plugin dual-exports V1 server() and V2 setup()
 *   4. V2 memorize agent satisfies the deny-first allowlist shape
 *   5. V2 tool registration yields the expected 7/3 tool sets
 *
 * Exit 0 = aligned. Exit 1 = contract break. Exit 2 = setup error.
 */
import fs from "fs"
import os from "os"
import path from "path"
import { $ } from "bun"

const MIN_VERSION = process.env.OPENCODE2_MIN_VERSION?.trim() || "0.0.0-beta-19296"

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

function betaNum(v: string): number | null {
  const m = v.trim().match(/beta-(\d+)/)
  return m ? Number(m[1]) : null
}

// Semver-ish compare with beta-suffix awareness for 0.0.0-beta-NNN.
function versionGte(a: string, b: string): boolean {
  const an = betaNum(a)
  const bn = betaNum(b)
  if (an !== null && bn !== null) {
    const [acore] = a.split("-beta-")
    const [bcore] = b.split("-beta-")
    if (acore !== bcore) return acore > bcore
    return an >= bn
  }
  return a >= b
}

const REQUIRED_OPS = [
  "v2.session.create",
  "v2.session.get",
  "v2.session.prompt",
  "v2.session.wait",
  "v2.session.context",
  "v2.session.generate",
  "v2.session.switchAgent",
  "v2.session.switchModel",
  "v2.session.interrupt",
  "v2.generate.text",
  "v2.mcp.list",
  "v2.agent.get",
  "v2.event.subscribe",
  "v2.model.list",
] as const

async function main(): Promise<void> {
  // --- binary ---
  let version = ""
  try {
    version = (await $`opencode2 --version`.text()).trim()
  } catch {
    failSetup("opencode2 binary not found on PATH")
  }
  log("bin", `opencode2 @ ${version}`)
  note(versionGte(version, MIN_VERSION), `opencode2 ${version} ≥ ${MIN_VERSION}`)

  // --- OpenAPI via the background service (no auth needed for /openapi.json) ---
  let doc: { paths?: Record<string, Record<string, { operationId?: string }>> }
  try {
    const raw = await $`opencode2 api get /openapi.json`.text()
    doc = JSON.parse(raw)
  } catch (e) {
    failSetup(`could not fetch /openapi.json: ${e instanceof Error ? e.message : String(e)}`)
  }
  const ops = new Set<string>()
  for (const methods of Object.values(doc.paths ?? {})) {
    for (const spec of Object.values(methods)) {
      if (spec?.operationId) ops.add(spec.operationId)
    }
  }
  note(ops.size > 0, `openapi has ${ops.size} operations`)
  for (const op of REQUIRED_OPS) {
    note(ops.has(op), `operation ${op} present`)
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
    for (const t of ["memory_read", "memory_search", "memory_list", "memory_add_note", "memory_reset", "memory_inspect", "memory_mode"]) {
      note(names.includes(t), `v2 tool ${t} registered`)
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
