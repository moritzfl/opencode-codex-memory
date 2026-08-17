/**
 * T0 contract check against the official opencode binary + built plugin.
 *
 * No LLM, no auth, no Docker. Safe for every PR / pre-release ritual.
 *
 * Checks:
 *   1. opencode binary version ≥ floor (OPENCODE_MIN_VERSION, default 1.17.0)
 *   2. Live OpenAPI (/doc): session.list query params, prompt format,
 *      AssistantMessage.structured, session.status idle variant
 *   3. Built plugin loads like opencode does and registers required hooks/tools
 *   4. Bundled agents still satisfy the D2 allowlist shape
 *
 * Exit 0 = aligned. Exit 1 = contract break. Exit 2 = setup error.
 */
import fs from "fs"
import os from "os"
import path from "path"
import {
  api,
  createSandbox,
  ensureBuilt,
  fail,
  log,
  opencodeVersion,
  repoRoot,
  semverGte,
  startServe,
  whichOpencode,
} from "./lib/harness.js"

const MIN_VERSION = process.env.OPENCODE_MIN_VERSION?.trim() || "1.17.0"

const REQUIRED_SESSION_LIST_PARAMS = ["scope", "roots", "limit", "directory"] as const
const REQUIRED_HOOKS = [
  "config",
  "event",
  "tool",
  "chat.message",
  "tool.execute.before",
  "experimental.chat.system.transform",
  "experimental.chat.messages.transform",
  "experimental.text.complete",
] as const
const REQUIRED_TOOLS = [
  "memory_read",
  "memory_search",
  "memory_list",
  "memory_add_note",
  "memory_reset",
  "memory_inspect",
  "memory_mode",
] as const

type OpenAPI = {
  paths?: Record<string, Record<string, unknown>>
  components?: { schemas?: Record<string, unknown> }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function getPathOp(doc: OpenAPI, p: string, method: string): Record<string, unknown> | null {
  return asRecord(asRecord(doc.paths?.[p])?.[method])
}

function schemaHasProperty(schema: unknown, name: string): boolean {
  const s = asRecord(schema)
  if (!s) return false
  if (asRecord(s.properties)?.[name] !== undefined) return true
  if (Array.isArray(s.anyOf)) return s.anyOf.some((x) => schemaHasProperty(x, name))
  if (Array.isArray(s.oneOf)) return s.oneOf.some((x) => schemaHasProperty(x, name))
  if (Array.isArray(s.allOf)) return s.allOf.some((x) => schemaHasProperty(x, name))
  return false
}

function resolveRef(doc: OpenAPI, ref: string): unknown {
  if (!ref.startsWith("#/")) return null
  const parts = ref.slice(2).split("/")
  let cur: unknown = doc
  for (const p of parts) {
    cur = asRecord(cur)?.[p]
    if (cur === undefined) return null
  }
  return cur
}

function requestBodySchema(doc: OpenAPI, op: Record<string, unknown>): unknown {
  const rb = asRecord(op.requestBody)
  const content = asRecord(rb?.content)
  const json = asRecord(content?.["application/json"])
  const schema = json?.schema
  const ref = asRecord(schema)?.$ref
  if (typeof ref === "string") return resolveRef(doc, ref)
  return schema
}

async function main() {
  let failed = 0
  const note = (ok: boolean, msg: string) => {
    if (ok) log("ok", msg)
    else {
      console.error(`[fail] ${msg}`)
      failed++
    }
  }

  // --- binary ---
  let bin: string
  let version: string
  try {
    bin = whichOpencode()
    version = opencodeVersion(bin)
  } catch (e) {
    fail("setup", e instanceof Error ? e.message : String(e))
  }
  log("bin", `${bin} @ ${version}`)
  note(semverGte(version, MIN_VERSION), `opencode ${version} ≥ ${MIN_VERSION}`)

  // --- OpenAPI via live serve ---
  const sandbox = createSandbox({ bare: true, keep: process.argv.includes("--keep") })
  let serve: Awaited<ReturnType<typeof startServe>> | null = null
  try {
    serve = await startServe(sandbox, { bin })
    const health = await api(serve, sandbox, "GET", "/global/health")
    note(health.status === 200, `GET /global/health → ${health.status}`)
    const healthVer = (health.json as { version?: string } | null)?.version
    if (healthVer) note(healthVer === version, `health.version ${healthVer} matches CLI ${version}`)

    const docRes = await api(serve, sandbox, "GET", "/doc")
    note(docRes.status === 200, `GET /doc → ${docRes.status}`)
    const doc = docRes.json as OpenAPI
    if (!doc?.paths) {
      note(false, "/doc missing paths")
    } else {
      const listOp = getPathOp(doc, "/session", "get")
      note(!!listOp, "GET /session present")
      if (listOp) {
        const params = Array.isArray(listOp.parameters) ? listOp.parameters : []
        const names = new Set(
          params
            .map((p) => asRecord(p)?.name)
            .filter((n): n is string => typeof n === "string"),
        )
        for (const p of REQUIRED_SESSION_LIST_PARAMS) {
          note(names.has(p), `session.list query param '${p}'`)
        }
      }

      const msgOp = getPathOp(doc, "/session/{sessionID}/message", "post")
      note(!!msgOp, "POST /session/{sessionID}/message present")
      if (msgOp) {
        const body = requestBodySchema(doc, msgOp)
        note(schemaHasProperty(body, "format"), "prompt body has 'format' (structured extraction)")
        note(schemaHasProperty(body, "variant"), "prompt body has 'variant' (reasoning effort)")
        note(schemaHasProperty(body, "parts"), "prompt body has 'parts'")
      }

      const msgsOp = getPathOp(doc, "/session/{sessionID}/message", "get")
      note(!!msgsOp, "GET /session/{sessionID}/message present (transcript)")

      const schemas = doc.components?.schemas ?? {}
      note(!!schemas.AssistantMessage, "schema AssistantMessage present")
      note(
        schemaHasProperty(schemas.AssistantMessage, "structured"),
        "AssistantMessage.structured present (extraction capture)",
      )
      note(!!schemas.OutputFormat || !!schemas.OutputFormatJsonSchema, "OutputFormat schema present")
      note(!!schemas.SessionStatus, "SessionStatus schema present")
      if (schemas.SessionStatus) {
        const idle = JSON.stringify(schemas.SessionStatus).includes('"idle"')
        note(idle, "SessionStatus includes idle variant")
      }
      note(!!schemas.Session, "schema Session present")
      if (schemas.Session) {
        const t = asRecord(asRecord(schemas.Session)?.properties)?.time
        note(schemaHasProperty(t, "updated"), "Session.time.updated present (eligibility watermark)")
      }

      // global discovery used by Phase 1 (D4)
      const expSess = getPathOp(doc, "/experimental/session", "get")
      note(!!expSess, "GET /experimental/session present (global discovery)")
      if (expSess) {
        const params = Array.isArray(expSess.parameters) ? expSess.parameters : []
        const names = new Set(
          params
            .map((p) => asRecord(p)?.name)
            .filter((n): n is string => typeof n === "string"),
        )
        note(names.has("roots"), "experimental.session.list query param 'roots'")
        note(names.has("limit"), "experimental.session.list query param 'limit'")
      }
    }
  } finally {
    if (serve) await serve.stop()
    sandbox.cleanup()
  }

  // --- plugin load (same path as smoke, plus hook inventory) ---
  ensureBuilt()
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ocm-contract-plugin-"))
  process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT = testRoot
  try {
    fs.mkdirSync(path.join(testRoot, "memories"), { recursive: true })
    fs.writeFileSync(path.join(testRoot, "memories", "memory_summary.md"), "- contract\n")

    const entry = path.join(repoRoot(), "dist", "src", "index.js")
    const mod = await import(entry + `?t=${Date.now()}`)
    const v1 = mod.default as {
      server: (input: unknown, opts?: unknown) => Promise<Record<string, any>>
    }
    note(typeof v1?.server === "function", "default export is V1 plugin module ({ server })")

    const hooks = await v1.server({
      client: {
        session: { list: async () => ({ data: [] }) },
        mcp: { status: async () => ({ data: {} }) },
      },
      directory: testRoot,
      worktree: testRoot,
      project: { id: "contract" },
    })

    for (const h of REQUIRED_HOOKS) {
      if (h === "tool") {
        note(!!hooks.tool && typeof hooks.tool === "object", "hook 'tool' map present")
      } else {
        note(typeof hooks[h] === "function", `hook '${h}' registered`)
      }
    }
    const tools = Object.keys(hooks.tool ?? {})
    for (const t of REQUIRED_TOOLS) {
      note(tools.includes(t), `tool '${t}' registered`)
    }

    const cfg: { agent?: Record<string, unknown> } = {}
    await hooks.config?.(cfg)
    note(!!cfg.agent?.memorize, "config hook injects memorize agent")
    note(!!cfg.agent?.["memorize-extract"], "config hook injects memorize-extract agent")

    const out: { system: string[] } = { system: [] }
    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "ses_contract", model: {} },
      out,
    )
    note(out.system.length > 0, "system.transform injects memory prompt from templates")

    await hooks.dispose?.()
  } catch (e) {
    note(false, `plugin load: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true })
    delete process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT
  }

  // --- agent allowlist shape (D2) — cheap static guard ---
  try {
    const agents = (
      JSON.parse(fs.readFileSync(path.join(repoRoot(), "opencode.json"), "utf8")) as {
        agent: Record<string, { permission?: Record<string, unknown> }>
      }
    ).agent
    for (const [name, def] of Object.entries(agents)) {
      const perm = def.permission ?? {}
      const keys = Object.keys(perm)
      note(keys[0] === "*", `${name}: wildcard deny is first permission key`)
      note(perm["*"] === "deny", `${name}: '*' is deny`)
    }
  } catch (e) {
    note(false, `opencode.json agents: ${e instanceof Error ? e.message : String(e)}`)
  }

  // --- SDK type-lag report (informational, not fail) ---
  try {
    const pluginPkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot(), "node_modules/@opencode-ai/plugin/package.json"), "utf8"),
    ) as { version?: string }
    log("sdk", `@opencode-ai/plugin ${pluginPkg.version ?? "?"} vs opencode ${version}`)
    if (pluginPkg.version && pluginPkg.version !== version) {
      log(
        "sdk",
        "version skew is expected when generated types lag the server; recheck casts in src/llm.ts + src/capture.ts on each release",
      )
    }
  } catch {
    // optional
  }

  if (failed > 0) {
    console.error(`\ncontract: FAIL — ${failed} check(s) failed`)
    process.exit(1)
  }
  console.log("\ncontract: OK")
  process.exit(0)
}

main().catch((e) => {
  console.error("contract: setup error:", e)
  process.exit(2)
})
