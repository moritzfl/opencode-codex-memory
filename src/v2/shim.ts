/**
 * opencode2 host-compatibility shim.
 *
 * V2 intentionally reuses the V1 pipeline (phase1/phase2/capture/llm/store/…
 * run byte-identical) by presenting a V1-shaped client façade backed by the
 * V2 plugin context. Only genuinely missing V2 surfaces are adapted:
 *
 * - session list/discovery → the authenticated public service client
 *   discovered through the registered local service.
 * - session.prompt agent/system/model/format/variant → V2 create-time
 *   agent/model (via switchAgent/switchModel) + generate.text for the
 *   json_schema extraction path (V2 prompts carry text only).
 * - session.messages → public message.list with V1-shaped row adaptation.
 * - session.delete → public session.remove, with a released-set fallback so
 *   the V1 shutdown/liveness logic keeps working across hosts.
 * - config.get → public service config documents adapted for the V1 resolver;
 *   callers fall back to session defaults if the service is unavailable.
 * - provider.list → catalog.model.list adapted to the V1 catalog shape for
 *   reasoning-variant mapping.
 * - mcp.status → mcp.list adapted to the V1 status map.
 *
 * Nothing in this file changes V1 behavior: V1 hosts never load it.
 */
import type { Plugin } from "@opencode/plugin"
import { memoryRoot } from "../paths.js"
import { invalidateOwnService, ownServiceClient, type V2ServiceClient } from "./service.js"

export type V2Context = Plugin.Context

let v2ctx: V2Context | null = null

export function setV2Context(ctx: V2Context | null): void {
  v2ctx = ctx
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

/** Stable synthetic id for extraction helpers (see create below). */
export const EXTRACT_STUB_SESSION_ID = "codex-memory-extract-stub"

/** Test seam. */
export function resetV2ShimStateForTest(): void {
  releasedSubSessions.clear()
  invalidateOwnService()
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
 * V2 public transcript messages → V1 session.messages rows
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
    const gen = await (c as any).generate.text(
      {
        prompt,
        ...(parsed || body.variant
          ? {
              model: {
                ...(parsed ? { providerID: parsed.providerID, id: parsed.modelID } : {}),
                ...(body.variant ? { variant: body.variant } : {}),
              },
            }
          : {}),
      },
      signal ? { signal } : undefined,
    )
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
      await waitP.catch(() => {})
      throw new Error("sub-agent prompt cancelled")
    }
    await Promise.race([
      waitP,
      new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("sub-agent prompt cancelled")), { once: true })
      }),
    ]).catch(async (e) => {
      await (c.session as any).interrupt({ sessionID }).catch(() => {})
      await waitP.catch(() => {})
      throw e
    })
  } else {
    await waitP
  }
  return { data: { posted } }
}

/** Build the V1-shaped client. Passed to setPluginInput() by V2 setup(). */
export function buildV1ClientShim(): unknown {
  async function serviceOrThrow(): Promise<V2ServiceClient> {
    const client = await ownServiceClient()
    if (!client) throw new Error("no healthy registered OpenCode 2 service for global memory operations")
    return client
  }

  async function listGlobalSessions(limit: number, cursor?: string): Promise<{ data: unknown[] }> {
    const client = await serviceOrThrow()
    const pageSize = Math.min(Math.max(limit, 1), 5000)
    const out: unknown[] = []
    const seenCursors = new Set<string>()
    let next = cursor
    while (out.length < limit) {
      const response = (await client.session.list?.({
        limit: pageSize,
        order: "desc",
        parentID: null,
        ...(next ? { cursor: next } : {}),
      })) as any
      const payload = und(response)
      let rows = response
      if (!Array.isArray(rows)) rows = response?.data
      if (!Array.isArray(rows)) rows = Array.isArray(payload) ? payload : payload?.data
      if (!Array.isArray(rows)) throw new Error("registered service returned an invalid session list")
      out.push(...rows)
      const candidate = response?.cursor?.next ?? payload?.cursor?.next
      if (typeof candidate !== "string" || candidate.length === 0 || seenCursors.has(candidate) || rows.length === 0) break
      seenCursors.add(candidate)
      next = candidate
    }
    return { data: out.slice(0, limit) }
  }

  const session = {
    create: async (opts: { query?: { directory?: string }; body?: { title?: string; metadata?: Record<string, unknown> } }) => {
      try {
        // Extraction turns run through generate.text (see prompt below) and
        // never touch a session, so hand out a stable synthetic id instead
        // of creating a server row per extraction (without this each
        // extraction would litter one dead
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
        const client = await serviceOrThrow()
        const response = await client.message?.list({ sessionID: opts.path.id, order: "asc" })
        const payload = und(response)
        return { data: adaptV2Messages(Array.isArray(payload) ? payload : payload?.data ?? []) }
      } catch (e) {
        return { error: e }
      }
    },
    delete: async (opts: { path: { id: string } }) => {
      try {
        const client = await serviceOrThrow()
        await client.session.remove?.({ sessionID: opts.path.id })
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
        const client = await serviceOrThrow()
        const info = und(await client.session.get?.({ sessionID: opts.path.id }))
        return { data: info }
      } catch (e) {
        if (isNotFoundError(e)) return { response: { status: 404 }, error: e }
        return { error: e }
      }
    },
    abort: async (opts: { path: { id: string } }) => {
      try {
        const client = await serviceOrThrow()
        await client.session.interrupt?.({ sessionID: opts.path.id })
      } catch {
        // Best-effort, mirrors V1.
      }
      return {}
    },
  }
  const config = {
    get: async () => {
      try {
        const client = await serviceOrThrow()
        const response = await client.config?.get({ location: { directory: ctx().location.directory } })
        const documents = und(response)
        let document = null
        if (Array.isArray(documents)) {
          document = documents.find((entry) => entry?.type === "document")
        } else if (documents?.type === "document") {
          document = documents
        }
        const info = document?.info
        if (!info || typeof info !== "object") return { data: {} }
        const model = (info as any).model
        let normalizedModel = model
        if (model && typeof model === "object" && typeof model.providerID === "string" && typeof model.model === "string") {
          normalizedModel = `${model.providerID}/${model.model}`
        }
        return { data: { ...info, ...(normalizedModel !== undefined ? { model: normalizedModel } : {}) } }
      } catch (e) {
        return { error: e }
      }
    },
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
        return listGlobalSessions(typeof q.limit === "number" ? q.limit : 5000, typeof q.cursor === "string" ? q.cursor : undefined)
      }
      if (opts.url === "/provider") {
        return provider.list()
      }
      return { error: { message: `unsupported shim route ${opts.url}` } }
    },
  }
  return { session, config, provider, mcp, _client }
}
