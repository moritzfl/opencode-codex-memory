/**
 * opencode2 host-compatibility shim.
 *
 * V2 intentionally reuses the V1 pipeline (phase1/phase2/capture/llm/store/…
 * run byte-identical) by presenting a V1-shaped client façade backed by the
 * V2 plugin context. Only genuinely missing V2 surfaces are adapted:
 *
 * - session list/discovery → process-local session registry (ctx has no
 *   list API; raw HTTP is 401 from inside plugins). Fed by session.created
 *   events + the prompt hook; pruned on observed NotFound.
 * - session.prompt agent/system/model/format/variant → V2 create-time
 *   agent/model (via switchAgent/switchModel) + generate.text for the
 *   json_schema extraction path (V2 prompts carry text only).
 * - session.messages → session.context with V1-shaped row adaptation.
 * - session.delete → interrupt + released-set (V2 has no delete; the row
 *   remains as inert history). get() on a released id reports 404 so the
 *   V1 shutdown/liveness logic keeps working.
 * - config.get → unavailable (V2 exposes no config API to plugins); callers
 *   fall back to session defaults, exactly like a V1 host without config.
 * - provider.list → catalog.model.list adapted to the V1 catalog shape for
 *   reasoning-variant mapping.
 * - mcp.status → mcp.list adapted to the V1 status map.
 *
 * Nothing in this file changes V1 behavior: V1 hosts never load it.
 */
import type { Plugin } from "@opencode/plugin"
import { memoryRoot } from "../paths.js"

export type V2Context = Plugin.Context

let v2ctx: V2Context | null = null

export function setV2Context(ctx: V2Context | null): void {
  v2ctx = ctx
}

export function getV2Context(): V2Context | null {
  return v2ctx
}

function ctx(): V2Context {
  if (!v2ctx) throw new Error("v2 context not initialized")
  return v2ctx
}

/** Unwrap {data} vs direct payloads (client shape varies by call). */
function und(v: unknown): any {
  const r = v as { data?: unknown } | null | undefined
  if (r && typeof r === "object" && "data" in r) return (r as { data: unknown }).data
  return v
}

function isNotFoundError(e: unknown): boolean {
  if (!e || typeof e !== "object") return String(e ?? "").includes("404")
  const r = e as { _tag?: unknown; name?: unknown; message?: unknown; status?: unknown }
  if (r.status === 404) return true
  for (const f of [r._tag, r.name, r.message]) {
    if (typeof f === "string" && /notfound|404/i.test(f)) return true
  }
  return false
}

/** Sub-session ids released via delete(): report 404 from get(). */
const releasedSubSessions = new Set<string>()
const RELEASED_CAP = 500

function markReleased(id: string): void {
  releasedSubSessions.add(id)
  if (releasedSubSessions.size > RELEASED_CAP) {
    const oldest = releasedSubSessions.values().next().value
    if (oldest !== undefined) releasedSubSessions.delete(oldest)
  }
}

export function isReleasedSubSession(id: string): boolean {
  return releasedSubSessions.has(id)
}

// ---------------------------------------------------------------------------
// Session registry (V2 discovery replacement)
// ---------------------------------------------------------------------------

export interface RegistryEntry {
  id: string
  title?: string
  directory: string | null
  parentID?: string | null
  created: number
  updated: number
}

const registry = new Map<string, RegistryEntry>()
const REGISTRY_CAP = 5000

export function recordSessionSighting(
  id: string,
  opts: { title?: string; directory?: string | null; parentID?: string | null; updated?: number } = {},
): void {
  const now = Date.now()
  const prev = registry.get(id)
  registry.set(id, {
    id,
    title: opts.title ?? prev?.title,
    directory: opts.directory ?? prev?.directory ?? null,
    parentID: opts.parentID ?? prev?.parentID,
    created: prev?.created ?? now,
    updated: opts.updated ?? now,
  })
  if (registry.size > REGISTRY_CAP) {
    let oldestKey: string | undefined
    let oldest = Infinity
    for (const [k, v] of registry) {
      if (v.updated < oldest) {
        oldest = v.updated
        oldestKey = k
      }
    }
    if (oldestKey !== undefined) registry.delete(oldestKey)
  }
  // Backfill parentID once (excludes subagent children like V1 roots=true).
  if (registry.get(id)?.parentID === undefined) {
    void (async () => {
      try {
        const info = und(await (ctx().session as any).get({ sessionID: id }))
        if (info?.parentID !== undefined) {
          const cur = registry.get(id)
          if (cur) cur.parentID = info.parentID ?? null
        } else {
          const cur = registry.get(id)
          if (cur && cur.parentID === undefined) cur.parentID = null
        }
      } catch {
        // Best-effort backfill; a later liveness check prunes gone rows.
      }
    })()
  }
}

export function dropSessionFromRegistry(id: string): void {
  registry.delete(id)
}

/** Stable synthetic id for extraction helpers (see create below). */
export const EXTRACT_STUB_SESSION_ID = "codex-memory-extract-stub"

/** Test seam. */
export function clearSessionRegistryForTest(): void {
  registry.clear()
  releasedSubSessions.clear()
}

function registryRows(limit: number, cursor?: number, search?: string): RegistryEntry[] {
  let rows = [...registry.values()]
  if (cursor !== undefined) rows = rows.filter((r) => r.updated < cursor)
  if (search) {
    const q = search.toLowerCase()
    rows = rows.filter(
      (r) => r.id.toLowerCase().includes(q) || (r.title ?? "").toLowerCase().includes(q),
    )
  }
  rows.sort((a, b) => b.updated - a.updated)
  return rows.slice(0, limit)
}

// ---------------------------------------------------------------------------
// Shape adapters
// ---------------------------------------------------------------------------

function joinTextParts(content: unknown): string {
  if (!Array.isArray(content)) return ""
  const out: string[] = []
  for (const p of content) {
    if (p && typeof p === "object" && (p as { type?: unknown }).type === "text" && typeof (p as { text?: unknown }).text === "string") {
      out.push((p as { text: string }).text)
    } else if (typeof p === "string") {
      out.push(p)
    }
  }
  return out.join("\n")
}

/**
 * V2 context()/transcript messages → V1 session.messages rows
 * ({info:{role}, parts:[...]}) consumed by capture.ts extractText.
 */
export function adaptV2Messages(msgs: unknown): Array<{ info?: { role?: string }; parts?: unknown[] }> {
  if (!Array.isArray(msgs)) return []
  const rows: Array<{ info?: { role?: string }; parts?: unknown[] }> = []
  for (const m of msgs as any[]) {
    if (!m || typeof m !== "object") continue
    if (m.type === "user") {
      rows.push({ info: { role: "user" }, parts: [{ type: "text", text: m.text }] })
      continue
    }
    if (m.type === "system") {
      rows.push({ info: { role: "system" }, parts: [{ type: "system", text: m.text }] })
      continue
    }
    if (m.type === "assistant") {
      const parts: unknown[] = []
      for (const p of m.content ?? []) {
        if (!p || typeof p !== "object") continue
        if (p.type === "text") parts.push({ type: "text", text: p.text })
        else if (p.type === "reasoning") parts.push({ type: "reasoning" })
        else if (p.type === "tool") {
          // The codemode `execute` wrapper runs code that calls the real
          // tools; expand its toolCalls so the transcript keeps V1's
          // per-tool granularity ([tool: name] input/output).
          const calls = (p.state as any)?.metadata?.toolCalls ?? (p as any)?.metadata?.toolCalls
          if (p.name === "execute" && Array.isArray(calls) && calls.length > 0) {
            const outputText = joinTextParts((p.state as any)?.content)
            for (const c of calls) {
              parts.push({
                type: "tool",
                tool: c.tool ?? "execute",
                state: {
                  input: c.input ?? (p.state as any)?.input,
                  ...(outputText ? { output: outputText } : {}),
                },
              })
            }
          } else {
            const st = (p.state as any) ?? {}
            const outputText = joinTextParts(st.content)
            parts.push({
              type: "tool",
              tool: p.name ?? "unknown",
              state: {
                ...(st.input !== undefined ? { input: st.input } : {}),
                ...(outputText ? { output: outputText } : {}),
                ...(typeof st.error === "string" ? { error: st.error } : {}),
              },
            })
          }
        }
      }
      rows.push({ info: { role: "assistant" }, parts })
      continue
    }
    // synthetic/skill/shell/compaction/…: keep visible text, if any.
    if (typeof m.text === "string") {
      rows.push({ info: { role: m.type }, parts: [{ type: "text", text: m.text }] })
    } else {
      rows.push({ info: { role: m.type }, parts: [] })
    }
  }
  return rows
}

/** V2 catalog.model.list → V1 provider-list shape for catalogVariantKeys. */
export function adaptProviderCatalog(v2: unknown): unknown {
  const items = und(v2)
  const list: any[] = Array.isArray(items) ? items : (items as any)?.data ?? []
  const providers = new Map<string, Record<string, unknown>>()
  for (const m of list) {
    if (!m || typeof m !== "object") continue
    const providerID = (m as any).providerID
    const modelID = (m as any).modelID ?? (m as any).id
    if (typeof providerID !== "string" || typeof modelID !== "string") continue
    if (!providers.has(providerID)) providers.set(providerID, {})
    const variants: Record<string, unknown> = {}
    for (const v of (m as any).variants ?? []) {
      if (v && typeof v === "object" && typeof (v as any).id === "string") {
        variants[(v as any).id] = { ...(typeof (v as any).disabled === "boolean" ? { disabled: (v as any).disabled } : {}) }
      }
    }
    ;(providers.get(providerID) as Record<string, unknown>)[modelID] = { variants }
  }
  return { all: [...providers.entries()].map(([id, models]) => ({ id, models })) }
}

/** V2 mcp.list → V1 mcp.status map shape. */
export function adaptMcpStatus(v2: unknown): unknown {
  const items = und(v2)
  const list: any[] = Array.isArray(items) ? items : []
  const out: Record<string, unknown> = {}
  for (const s of list) {
    if (!s || typeof s !== "object" || typeof (s as any).name !== "string") continue
    const st = (s as any).status
    out[(s as any).name] = { status: typeof st === "string" ? st : (st?.status ?? "unknown") }
  }
  return out
}

function parseModelRef(ref: string): { providerID: string; modelID: string } | null {
  const slash = ref.indexOf("/")
  if (slash <= 0 || slash === ref.length - 1) return null
  return { providerID: ref.slice(0, slash), modelID: ref.slice(slash + 1) }
}

// ---------------------------------------------------------------------------
// The façade: V1-shaped client over the V2 context
// ---------------------------------------------------------------------------

async function v2promptWithWait(
  sessionID: string,
  body: { agent: string; system?: string; model?: { providerID: string; modelID: string }; format?: unknown; variant?: string; parts: { type: string; text: string }[] },
  signal?: AbortSignal,
): Promise<{ error?: unknown; data?: unknown }> {
  const c = ctx()
  const text = body.parts.map((p) => p.text ?? "").join("\n")
  // Structured-output extraction: V2 prompts carry text only, so run the
  // turn through generate.text (inherently tool-less, like the V1
  // memorize-extract sandbox) with the system prompt prepended. The caller
  // falls back to JSON text parsing (hostStructuredOutput finds nothing).
  if (body.format) {
    const prompt = body.system ? `${body.system}\n\n---\n\n${text}` : text
    const parsed = body.model ? parseModelRef(`${body.model.providerID}/${body.model.modelID}`) : null
    const gen = await (c as any).generate.text({
      prompt,
      ...(parsed || body.variant
        ? {
            model: {
              ...(parsed ? { providerID: parsed.providerID, id: parsed.modelID } : {}),
              ...(body.variant ? { variant: body.variant } : {}),
            },
          }
        : {}),
    })
    const outText = typeof gen?.text === "string" ? gen.text : JSON.stringify(gen)
    return { data: { parts: [{ type: "text", text: outText }] } }
  }
  // Agentic turn (consolidation): the agent/model must be set at CREATE time
  // in V2, so switch the fresh helper session first, then prompt + wait to
  // preserve V1's "prompt resolves after the turn" semantics.
  if (body.agent) {
    await (c.session as any).switchAgent({ sessionID, agent: body.agent })
  }
  if (body.model) {
    await (c.session as any).switchModel({
      sessionID,
      model: {
        providerID: body.model.providerID,
        id: body.model.modelID,
        ...(body.variant ? { variant: body.variant } : {}),
      },
    })
  }
  const posted = await (c.session as any).prompt({ sessionID, text })
  const waitP = (c.session as any).wait({ sessionID })
  if (signal) {
    if (signal.aborted) {
      await (c.session as any).interrupt({ sessionID }).catch(() => {})
      throw new Error("sub-agent prompt cancelled")
    }
    await Promise.race([
      waitP,
      new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("sub-agent prompt cancelled")), { once: true })
      }),
    ]).catch(async (e) => {
      await (c.session as any).interrupt({ sessionID }).catch(() => {})
      throw e
    })
  } else {
    await waitP
  }
  return { data: { posted } }
}

/** Build the V1-shaped client. Passed to setPluginInput() by V2 setup(). */
export function buildV1ClientShim(): unknown {
  const session = {
    create: async (opts: { query?: { directory?: string }; body?: { title?: string; metadata?: Record<string, unknown> } }) => {
      try {
        // Extraction turns run through generate.text (see prompt below) and
        // never touch a session, so hand out a stable synthetic id instead
        // of creating a server row per extraction (V2 has no session
        // delete; without this each extraction would litter one dead
        // `codex-memory-extract-*` session). Skip/tracking logic keys off
        // the id string only, so behavior is unchanged.
        if (opts?.body?.title?.startsWith("codex-memory-extract-")) {
          releasedSubSessions.delete(EXTRACT_STUB_SESSION_ID)
          return { data: { id: EXTRACT_STUB_SESSION_ID } }
        }
        const res = await (ctx().session as any).create({
          ...(opts?.body?.title ? { title: opts.body.title } : {}),
          ...(opts?.body?.metadata ? { metadata: opts.body.metadata } : {}),
          location: { directory: opts?.query?.directory ?? memoryRoot() },
        })
        return { data: { id: und(res)?.id } }
      } catch (e) {
        return { error: e }
      }
    },
    prompt: async (opts: { path: { id: string }; body: any; signal?: AbortSignal }) => {
      try {
        return await v2promptWithWait(opts.path.id, opts.body, opts.signal)
      } catch (e) {
        return { error: e }
      }
    },
    messages: async (opts: { path: { id: string } }) => {
      try {
        if (isReleasedSubSession(opts.path.id)) throw Object.assign(new Error("SessionNotFound"), { _tag: "SessionNotFoundError" })
        const rows = und(await (ctx().session as any).context({ sessionID: opts.path.id }))
        return { data: adaptV2Messages(rows) }
      } catch (e) {
        return { error: e }
      }
    },
    delete: async (opts: { path: { id: string } }) => {
      // V2 has no session delete: stop the turn and treat the id as
      // released so get()-based checks report 404 from here on.
      try {
        await (ctx().session as any).interrupt({ sessionID: opts.path.id }).catch(() => {})
      } finally {
        markReleased(opts.path.id)
      }
      return {}
    },
    get: async (opts: { path: { id: string } }) => {
      try {
        if (isReleasedSubSession(opts.path.id)) {
          return { response: { status: 404 }, error: { _tag: "SessionNotFoundError" } }
        }
        const info = und(await (ctx().session as any).get({ sessionID: opts.path.id }))
        return { data: info }
      } catch (e) {
        if (isNotFoundError(e)) return { response: { status: 404 }, error: e }
        return { error: e }
      }
    },
    abort: async (opts: { path: { id: string } }) => {
      try {
        await (ctx().session as any).interrupt({ sessionID: opts.path.id })
      } catch {
        // Best-effort, mirrors V1.
      }
      return {}
    },
  }
  const config = {
    get: async () => ({ error: { message: "config unavailable to V2 plugins; using session defaults" } }),
  }
  const provider = {
    list: async () => {
      try {
        const res = await (ctx() as any).catalog.model.list()
        return { data: adaptProviderCatalog(res) }
      } catch (e) {
        return { error: e }
      }
    },
  }
  const mcp = {
    status: async () => {
      try {
        const res = await (ctx().mcp as any).list()
        return { data: adaptMcpStatus(res) }
      } catch (e) {
        return { error: e }
      }
    },
  }
  const _client = {
    get: async (opts: { url: string; query?: Record<string, unknown> }) => {
      if (opts.url === "/experimental/session") {
        const q = opts.query ?? {}
        const rows = registryRows(
          typeof q.limit === "number" ? q.limit : 5000,
          typeof q.cursor === "number" ? q.cursor : undefined,
          typeof q.search === "string" ? q.search : undefined,
        )
        return {
          data: rows.map((r) => ({
            id: r.id,
            ...(r.parentID ? { parentID: r.parentID } : {}),
            ...(r.title ? { title: r.title } : {}),
            time: { created: r.created, updated: r.updated },
            ...(r.directory ? { directory: r.directory } : {}),
          })),
        }
      }
      if (opts.url === "/provider") {
        return provider.list()
      }
      return { error: { message: `unsupported shim route ${opts.url}` } }
    },
  }
  return { session, config, provider, mcp, _client }
}
