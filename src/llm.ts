import fs from "fs"
import path from "path"
import type { PluginInput } from "@opencode-ai/plugin"
import { memoryRoot } from "./paths.js"
import {
  hostListSessionsGlobal,
  hostSessionCreate,
  hostSessionDeletionConfirmed,
  hostSessionPrompt,
  hostStructuredOutput,
  ignoreLateRejection,
  pluginHttpGet,
  withHostTimeout,
} from "./host-client.js"
import { isPluginShuttingDown, pluginShutdownSignal } from "./lifecycle.js"
import { SCAN_LIMIT } from "./store.js"
import { isProviderCapacityError, ProviderCapacityError } from "./ratelimit.js"

export interface ExtractionResult {
  raw_memory: string
  rollout_summary: string
  rollout_slug: string | null
}

let inputRef: PluginInput | null = null
let inputGeneration = 0

export function setPluginInput(input: PluginInput): void {
  inputRef = input
  inputGeneration++
  configModels = null
  configModelsInFlight = null
}

export function getPluginInput(): PluginInput | null {
  return inputRef
}

// Sessions this plugin spawned for extraction/consolidation. The main
// hooks skip these so the plugin never injects memory into (or memorizes) its
// own sub-agents.
const activeSubSessions = new Set<string>()
const SUBSESSION_METADATA_KEY = "opencode-codex-memory"
const SUBSESSION_LIST_TIMEOUT_MS = 5_000
const SUBSESSION_ABORT_TIMEOUT_MS = 1_000
const SUBSESSION_CONFIRM_TIMEOUT_MS = 1_000
const SUBSESSION_DELETE_TIMEOUT_MS = 10_000
const SUBSESSION_CREATE_TIMEOUT_MS = 10_000
const CONFIG_GET_TIMEOUT_MS = 5_000
const SUBSESSION_DELETE_CONCURRENCY = 8
const SUBSESSION_DELETE_BATCH_TIMEOUT_MS = 30_000
let createTimeoutMs = SUBSESSION_CREATE_TIMEOUT_MS
let configGetTimeoutMs = CONFIG_GET_TIMEOUT_MS
let staleDeleteBatchTimeoutMs = SUBSESSION_DELETE_BATCH_TIMEOUT_MS

/** Test seam. */
export function setSubSessionCreateTimeoutForTest(ms?: number): void {
  createTimeoutMs = ms ?? SUBSESSION_CREATE_TIMEOUT_MS
}

/** Test seam. */
export function setConfigGetTimeoutForTest(ms?: number): void {
  configGetTimeoutMs = ms ?? CONFIG_GET_TIMEOUT_MS
}

/** Test seam. */
export function setStaleDeleteBatchTimeoutForTest(ms?: number): void {
  staleDeleteBatchTimeoutMs = ms ?? SUBSESSION_DELETE_BATCH_TIMEOUT_MS
}

export function isMemorySubSession(sessionId: string): boolean {
  return activeSubSessions.has(sessionId)
}

/**
 * Host directory for memory sub-sessions. Must exist: OpenCode resolves it in
 * SystemPrompt.environment and fails the turn with UnknownError/ENOENT when
 * missing. Prefer the memory workspace itself — global, always ours, already
 * granted to `memorize` via external_directory, and independent of whatever
 * (possibly deleted) project PluginInput.directory points at.
 */
function resolveSubSessionDirectory(): string {
  const root = memoryRoot()
  fs.mkdirSync(root, { recursive: true })
  return root
}

async function createSession(agent: string, title?: string): Promise<string> {
  const input = getPluginInput()
  if (!input) throw new Error("plugin input not initialized")
  if (isPluginShuttingDown()) throw new SubagentCancelledError()
  const directory = resolveSubSessionDirectory()
  // directory is a query param (not body); without it the client inherits
  // PluginInput.directory, which may be a deleted project path.
  const controller = new AbortController()
  const res = await withHostTimeout(
    hostSessionCreate(input.client, {
      directory,
      body: {
        title: title ?? `codex-memory-${agent}`,
        metadata: { [SUBSESSION_METADATA_KEY]: true },
      },
      signal: controller.signal,
    }),
    createTimeoutMs,
    "session.create",
    controller,
  )
  if (!res.data) throw new Error(`session create failed: ${JSON.stringify(res.error ?? {})}`)
  const body = res.data as { id?: string }
  const id = body.id
  if (!id) throw new Error(`session create returned no id: ${JSON.stringify(body)}`)
  activeSubSessions.add(id)
  return id
}

interface PromptOptions {
  timeoutMs?: number
  system?: string
  model?: string
  signal?: AbortSignal
  // json_schema structured-output request. opencode's PromptInput accepts a
  // `format` field (schema v1/session.ts) but the generated SDK body type omits
  // it, so it is passed through an `as any` cast at the call site.
  format?: Record<string, unknown>
  // Host PromptInput.variant → model reasoningEffort (low/medium/high).
  // Unknown variant is a host no-op.
  variant?: string
}

/**
 * opencode's config carries the same split codex expresses with provider
 * model preferences: `small_model` for cheap background work (codex:
 * memory_extraction_preferred_model = gpt-5.4-mini) and `model` for capable
 * work (codex: memory_consolidation_preferred_model = gpt-5.4). Cached per
 * plugin instance — opencode reloads plugins on config change.
 */
let configModels: { model?: string; smallModel?: string } | null = null
let configModelsInFlight: Promise<{ model?: string; smallModel?: string }> | null = null

async function getConfigModels(): Promise<{ model?: string; smallModel?: string }> {
  if (configModels) return configModels
  if (configModelsInFlight) return configModelsInFlight
  const input = getPluginInput()
  if (!input) return {}
  const generation = inputGeneration
  const request = (async (): Promise<{ model?: string; smallModel?: string }> => {
    const controller = new AbortController()
    try {
      const res = await withHostTimeout(
        input.client.config.get({ signal: controller.signal }),
        configGetTimeoutMs,
        "config.get",
        controller,
      ) as { data?: { model?: string; small_model?: string }; error?: unknown }
      if (res.error || !res.data || generation !== inputGeneration) return {}
      const resolved = { model: res.data.model, smallModel: res.data.small_model }
      configModels = resolved
      return resolved
    } catch {
      // Config endpoint unavailable: leave models unset so the sub-agent runs
      // on the session default. Do not cache failures: the next call can recover.
      return {}
    }
  })()
  configModelsInFlight = request
  try {
    return await request
  } finally {
    if (configModelsInFlight === request) configModelsInFlight = null
  }
}

export async function resolveExtractionModel(configured?: string): Promise<string | undefined> {
  return configured ?? (await getConfigModels()).smallModel
}

export async function resolveConsolidationModel(configured?: string): Promise<string | undefined> {
  return configured ?? (await getConfigModels()).model
}

// extract_model / consolidation model strings are "providerID/modelID".
function parseModelRef(ref: string): { providerID: string; modelID: string } | null {
  const slash = ref.indexOf("/")
  if (slash <= 0 || slash === ref.length - 1) return null
  return { providerID: ref.slice(0, slash), modelID: ref.slice(slash + 1) }
}

/**
 * Thrown when a sub-agent prompt exceeds its budget. A distinct type (rather
 * than matching on the message text) is what tells the catch below that the
 * run is still executing server-side and must be aborted.
 */
export class SubagentTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`sub-agent prompt timed out after ${timeoutMs}ms`)
    this.name = "SubagentTimeoutError"
  }
}

/** Thrown after an external owner cancels a running sub-agent prompt. */
export class SubagentCancelledError extends Error {
  constructor() {
    super("sub-agent prompt cancelled")
    this.name = "SubagentCancelledError"
  }
}

/**
 * Thrown when a sub-agent session could not be closed. Codex treats a failed
 * consolidation-agent shutdown as "the agent may still be alive", so the caller
 * must keep its job lease instead of completing the job (phase2.rs).
 */
export class SubagentShutdownError extends Error {
  constructor(sessionId: string) {
    super(`failed to close memory sub-session ${sessionId}`)
    this.name = "SubagentShutdownError"
  }
}

async function abortSession(sessionId: string): Promise<void> {
  const input = getPluginInput()
  const session = (input?.client as {
    session?: { abort?: (opts: { path: { id: string }; signal?: AbortSignal }) => Promise<unknown> }
  })?.session
  if (typeof session?.abort !== "function") return
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      session.abort({ path: { id: sessionId }, signal: controller.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error(`session.abort timed out after ${SUBSESSION_ABORT_TIMEOUT_MS}ms`))
        }, SUBSESSION_ABORT_TIMEOUT_MS)
      }),
    ])
  } catch {
    // Best-effort: deleteSession is the backup cancel path.
  } finally {
    clearTimeout(timer)
  }
}

/** Runs a sub-agent prompt and returns the raw response data (`{ info, parts }`). */
async function runPrompt(sessionId: string, prompt: string, agent: string, opts: PromptOptions = {}): Promise<any> {
  const timeoutMs = opts.timeoutMs ?? 300_000
  const input = getPluginInput()
  if (!input) throw new Error("plugin input not initialized")
  if (opts.signal?.aborted) {
    await abortSession(sessionId)
    throw new SubagentCancelledError()
  }
  const model = opts.model ? parseModelRef(opts.model) : null
  const promptPromise = hostSessionPrompt(input.client, {
    sessionId,
    body: {
      agent,
      ...(opts.system ? { system: opts.system } : {}),
      ...(model ? { model } : {}),
      ...(opts.format ? { format: opts.format } : {}),
      ...(opts.variant ? { variant: opts.variant } : {}),
      parts: [{ type: "text", text: prompt }],
    },
  })
  ignoreLateRejection(promptPromise)
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    const cancellation = new Promise<never>((_, reject) => {
      if (!opts.signal) return
      // Abort may fire between the pre-check above and this setup (e.g. dispose
      // during hostSessionPrompt construction). Already-aborted signals do not
      // re-emit; observe current state after attaching the listener.
      onAbort = () => reject(new SubagentCancelledError())
      opts.signal.addEventListener("abort", onAbort, { once: true })
      if (opts.signal.aborted) onAbort()
    })
    const res = await Promise.race([
      promptPromise,
      cancellation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SubagentTimeoutError(timeoutMs)), timeoutMs)
      }),
    ])
    if (!res.data) {
      const message = `prompt failed: ${JSON.stringify(res.error ?? {})}`
      if (isProviderCapacityError(res.error)) throw new ProviderCapacityError(message)
      throw new Error(message)
    }
    const promptError = (res.data as {
      info?: {
        error?: {
          name?: string
          data?: { message?: string; statusCode?: number }
        }
      }
    }).info?.error
    if (promptError) {
      const detail = promptError.data?.message
      const status = promptError.data?.statusCode
      const message =
        `sub-agent prompt failed${promptError.name ? ` (${promptError.name})` : ""}` +
        `${detail ? `: ${detail}` : ""}${status !== undefined ? ` (HTTP ${status})` : ""}`
      if (isProviderCapacityError(promptError)) throw new ProviderCapacityError(message, status)
      throw new Error(message)
    }
    return res.data
  } catch (err) {
    // A timeout or owner cancellation can leave the turn running server-side;
    // other failures mean the request already settled. Stop the live run so
    // tokens stop burning — deleteSession in the caller is the backup.
    if (err instanceof SubagentTimeoutError || err instanceof SubagentCancelledError) {
      await abortSession(sessionId)
    }
    throw err
  } finally {
    clearTimeout(timer)
    if (onAbort) opts.signal?.removeEventListener("abort", onAbort)
  }
}

async function promptSession(sessionId: string, prompt: string, agent: string, opts: PromptOptions = {}): Promise<string> {
  return extractAssistantText(await runPrompt(sessionId, prompt, agent, opts))
}

function extractAssistantText(body: any): string {
  if (!body) return ""
  if (typeof body === "string") return body
  if (Array.isArray(body)) return body.map(extractAssistantText).join("\n")
  if (typeof body.text === "string") return body.text
  if (body.parts && Array.isArray(body.parts)) return body.parts.map((p: any) => p?.text ?? "").filter(Boolean).join("\n")
  if (body.messages && Array.isArray(body.messages)) {
    return body.messages
      .filter((m: any) => m?.info?.role === "assistant")
      .flatMap((m: any) => (m.parts ?? []).map((p: any) => p?.text ?? ""))
      .filter(Boolean)
      .join("\n")
  }
  if (body.output && typeof body.output === "string") return body.output
  return JSON.stringify(body)
}

export interface ExtractOptions {
  cwd?: string
  model?: string
  /** Override the default 1h extract timeout (tests / advanced). */
  timeoutMs?: number
  /**
   * Cancel in-flight extract. Defaults to pluginShutdownSignal() so dispose
   * unblocks phase1 without waiting on the host to reject session.prompt.
   */
  signal?: AbortSignal
}

// JSON Schema for structured stage-1 output. Mirrors the deliverables in
// stage_one_system.md (three required string fields; all-empty = no-op) and is
// opencode's equivalent of codex's output_schema + output_schema_strict.
const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    raw_memory: { type: "string" },
    rollout_summary: { type: "string" },
    rollout_slug: { type: "string" },
  },
  required: ["raw_memory", "rollout_summary", "rollout_slug"],
} as const

/**
 * Returns null when the extractor reported a no-op (nothing worth remembering).
 *
 * Defaults to pluginShutdownSignal so dispose cancels the in-flight prompt
 * race the same way as consolidateViaSubagent (phase-2 scope). dispose still
 * session.aborts the sub-session for host-side cleanup; extractor has no FS
 * write tools (D2) so a lingering server turn cannot dual-write the memory root.
 */
export async function extractViaSubagent(sessionId: string, transcript: string, opts: ExtractOptions = {}): Promise<ExtractionResult | null> {
  const agent = "memorize-extract"
  const subId = await createSession(agent, `codex-memory-extract-${sessionId}`)
  try {
    const prompt = buildExtractionInput(sessionId, opts.cwd ?? "unknown", transcript)
    // extract_model option > opencode small_model > session default.
    const model = await resolveExtractionModel(opts.model)
    const data = await runPrompt(subId, prompt, agent, {
      // Mirrors the stage-1 job lease (1h): codex has no per-request timeout,
      // and a near-600k-char transcript on a slow model can easily exceed a
      // short one — repeated timeouts would exhaust the job's retries.
      timeoutMs: opts.timeoutMs ?? 3600_000,
      system: readTemplate("stage_one_system.md"),
      model,
      signal: opts.signal ?? pluginShutdownSignal(),
      // opencode enforces json_schema output via a forced StructuredOutput tool
      // call (toolChoice: required) — which is why memorize-extract must allow
      // that one otherwise-denied tool.
      format: { type: "json_schema", schema: EXTRACTION_SCHEMA },
      // Codex extraction ReasoningEffort::Low. Host maps variant → reasoningEffort;
      // missing variant on the model is a no-op.
      variant: "low",
    })
    // The captured JSON lands on AssistantMessage.structured (schema
    // v1/session.ts; absent from the generated SDK type — see host-client.ts).
    // Fall back to text parsing when structured output is unavailable (a host
    // without the feature, or a model that emitted JSON as plain text).
    const structured = hostStructuredOutput(data)
    if (structured) {
      return validateExtraction(structured as Partial<ExtractionResult>)
    }
    return parseExtraction(extractAssistantText(data))
  } finally {
    // Fire-and-forget on purpose (unlike consolidation): stage 1 has no codex
    // agent-shutdown step, and memorize-extract has no write tools, so a
    // lingering extract session cannot touch the memory root.
    void deleteSession(subId).catch(() => {})
  }
}

// codex runs the consolidation agent under a 1h job lease with heartbeats;
// its INIT pass is explicitly allowed to run long ("do not be lazy"). A short
// timeout here would fail the job after the workspace was already synced.
const CONSOLIDATION_TIMEOUT_MS = 3600_000

export async function consolidateViaSubagent(
  memoryRoot: string,
  diffFileName: string,
  model?: string,
  signal?: AbortSignal,
): Promise<void> {
  const agent = "memorize"
  const subId = await createSession(agent, "codex-memory-consolidate")
  let promptError: unknown
  let promptFailed = false
  try {
    const prompt = buildConsolidationPrompt(memoryRoot, diffFileName)
    // consolidation_model option > opencode model (main) > session default.
    const resolved = await resolveConsolidationModel(model)
    await promptSession(subId, prompt, agent, {
      model: resolved,
      timeoutMs: CONSOLIDATION_TIMEOUT_MS,
      signal,
      // Codex consolidation ReasoningEffort::Medium.
      variant: "medium",
    })
  } catch (err) {
    promptError = err
    promptFailed = true
  }
  // codex phase2.rs awaits the consolidation agent's shutdown BEFORE artifacts
  // are validated and the job is finished, and a failed shutdown outranks the
  // run result: the caller must keep its lease rather than release it to a
  // worker that could race a consolidator which is still alive. The
  // consolidation agent holds write access to the memory root, so this is the
  // difference between one writer and two.
  if (!(await deleteSession(subId))) throw new SubagentShutdownError(subId)
  if (promptFailed) throw promptError
}

// Must exceed the longest legitimate sub-session lifetime (consolidation may
// run up to CONSOLIDATION_TIMEOUT_MS = 60min), or a second opencode instance /
// plugin reload would delete a working sub-session mid-run.
export async function cleanupOldSubSessions(
  maxAgeMinutes = 90,
  timeoutMs = SUBSESSION_LIST_TIMEOUT_MS,
): Promise<void> {
  const input = getPluginInput()
  if (!input) return
  if (!pluginHttpGet(input.client)) return
  const controller = new AbortController()
  const staleSessionIds: string[] = []
  try {
    const cutoff = Date.now() - maxAgeMinutes * 60 * 1000
    const deadline = Date.now() + timeoutMs
    const seen = new Set<string>()
    let cursor: number | undefined
    let pageLimit = SCAN_LIMIT
    while (true) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return
      const res = await withHostTimeout(
        hostListSessionsGlobal(input.client, {
          limit: pageLimit,
          cursor,
          search: "codex-memory-",
          signal: controller.signal,
        }),
        remaining,
        "experimental.session.list",
        controller,
      )
      if (res.error || !Array.isArray(res.data)) return
      const list = res.data as Array<{
        id: string
        title?: string
        metadata?: Record<string, unknown>
        time?: { created?: number; updated?: number }
      }>
      let newSessionCount = 0
      for (const s of list) {
        if (!s.id || seen.has(s.id)) continue
        seen.add(s.id)
        newSessionCount++
        const pluginTitle = isPluginSubSessionTitle(s.title)
        const owned = s.metadata?.[SUBSESSION_METADATA_KEY] === true && pluginTitle
        const legacy = s.metadata?.[SUBSESSION_METADATA_KEY] !== true && pluginTitle
        if (!owned && !legacy) continue
        // Durable ownership requires marker + generated title; a legacy title
        // alone can reseed the skip set but never authorizes deletion.
        activeSubSessions.add(s.id)
        if (!owned) continue
        const created = s.time?.created ?? 0
        if (created && created < cutoff) {
          staleSessionIds.push(s.id)
        }
      }
      if (list.length < pageLimit) return
      const updates = list.map((s) => s.time?.updated).filter((updated): updated is number =>
        typeof updated === "number" && Number.isFinite(updated) && updated >= 0
      )
      if (updates.length === 0) return
      // listGlobal uses `updated < cursor`. Add one millisecond so sessions
      // tied at the page boundary remain visible, then dedupe repeated rows.
      const nextCursor = updates.reduce((min, updated) => Math.min(min, updated), Infinity) + 1
      if (cursor !== undefined && (nextCursor >= cursor || newSessionCount === 0)) {
        // A full page can consist entirely of the same timestamp. Increase the
        // page size until unseen tied rows appear or the overall deadline wins.
        pageLimit += SCAN_LIMIT
        continue
      }
      cursor = nextCursor
      pageLimit = SCAN_LIMIT
    }
  } catch {
    // best effort only
  } finally {
    void deleteStaleSubSessions(staleSessionIds, input, staleDeleteBatchTimeoutMs)
  }
}

async function deleteStaleSubSessions(
  sessionIds: string[],
  input: PluginInput,
  timeoutMs: number,
): Promise<void> {
  let cursor = 0
  const deadline = Date.now() + timeoutMs
  const workers = Array.from(
    { length: Math.min(SUBSESSION_DELETE_CONCURRENCY, sessionIds.length) },
    async () => {
      while (cursor < sessionIds.length && Date.now() < deadline && !isPluginShuttingDown()) {
        const id = sessionIds[cursor++]
        try {
          await deleteSession(id, input, Math.max(1, Math.min(SUBSESSION_DELETE_TIMEOUT_MS, deadline - Date.now())))
        } catch {
          // deleteSession is best-effort; one unexpected failure must not stop
          // the remaining stale-helper cleanup.
        }
      }
    },
  )
  await Promise.all(workers)
}

function isPluginSubSessionTitle(title: string | undefined): boolean {
  return title === "codex-memory-consolidate" || /^codex-memory-extract-ses_[A-Za-z0-9]+$/.test(title ?? "")
}

/**
 * Closes a sub-session. Returns true when the delete call itself succeeded —
 * the port's equivalent of codex's `shutdown_consolidation_agent` returning Ok
 * (runtime.rs). A false return means the sub-agent may still be running.
 *
 * The 404 confirmation below is a separate, stricter question (is the session
 * really gone?) and only governs ownership tracking, never the shutdown result:
 * hosts without `session.get` would otherwise never report a clean shutdown.
 */
async function deleteSession(
  id: string,
  input: PluginInput | null = getPluginInput(),
  timeoutMs = SUBSESSION_DELETE_TIMEOUT_MS,
): Promise<boolean> {
  if (!input) return false
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const deletePromise = input.client.session.delete({ path: { id }, signal: controller.signal })
    ignoreLateRejection(deletePromise)
    const res = await Promise.race([
      deletePromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error(`session.delete timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        timer.unref?.()
      }),
    ])
    if (res.error) {
      console.warn(`[opencode-codex-memory] failed to delete sub-session ${id}: ${JSON.stringify(res.error)}`)
      return false
    }
    // OpenCode's Session.remove logs and swallows some internal failures while
    // the HTTP route still returns success. Only a confirmed 404 proves the
    // session is gone; otherwise retain ownership so hooks keep skipping it.
    // codex runtime.rs drops the thread from its manager the same way: only
    // after shutdown succeeded.
    if (await hostSessionDeletionConfirmed(input.client, id, SUBSESSION_CONFIRM_TIMEOUT_MS)) {
      activeSubSessions.delete(id)
    }
    return true
  } catch (err) {
    console.warn(`[opencode-codex-memory] error deleting sub-session ${id}:`, err)
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** Best-effort abort of every memory sub-session (plugin dispose / reload). */
export async function abortActiveSubSessions(): Promise<void> {
  const ids = [...activeSubSessions]
  await Promise.all(ids.map((id) => abortSession(id)))
}

// Substitute with a function so `$&`/`$'` sequences in the value are not
// expanded as String.replace replacement patterns.
export function fillTemplate(tmpl: string, vars: Record<string, string>): string {
  let out = tmpl
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`{{ ${key} }}`, () => value)
  }
  return out
}

function buildExtractionInput(sessionId: string, cwd: string, transcript: string): string {
  return fillTemplate(readTemplate("stage_one_input.md"), {
    session_id: sessionId,
    session_cwd: cwd,
    transcript,
  })
}

// codex lib.rs prompt_blocks: rendered into consolidation.md's
// {{ memory_extensions_* }} placeholders when <memory_root>/extensions exists
// (prompts.rs build_consolidation_prompt), empty strings otherwise.
const EXTENSIONS_FOLDER_STRUCTURE = `
Memory extensions (under {{ memory_extensions_root }}/):

- <extension_name>/instructions.md
  - Source-specific guidance for interpreting additional memory signals. If an
    extension folder exists, you must read its instructions.md to determine how to use this memory
    source.

If the user has any memory extensions, you MUST read the instructions for each extension to
determine how to use the memory source. If the workspace diff shows deleted extension resource files,
remove stale memories derived only from those resources. If it has no extension folders, continue
with the standard memory inputs only.
`

const EXTENSIONS_PRIMARY_INPUTS = `
Optional source-specific inputs:
Under \`{{ memory_extensions_root }}/\`:

- \`<extension_name>/instructions.md\`
  - If extension folders exist, read each instructions.md first and follow it when interpreting
    that extension's memory source.

If the workspace diff shows deleted memory extension resources, use that extension-specific deletion
signal to remove stale memories derived only from those resources.
`

export function buildConsolidationPrompt(memoryRoot: string, diffFileName: string): string {
  const extensionsRoot = path.join(memoryRoot, "extensions")
  let extensionsExist = false
  try {
    extensionsExist = fs.statSync(extensionsRoot).isDirectory()
  } catch {}
  const blockVars = { memory_extensions_root: extensionsRoot }
  return fillTemplate(readTemplate("consolidation.md"), {
    memory_root: memoryRoot,
    phase2_workspace_diff_file: diffFileName,
    memory_extensions_folder_structure: extensionsExist ? fillTemplate(EXTENSIONS_FOLDER_STRUCTURE, blockVars) : "",
    memory_extensions_primary_inputs: extensionsExist ? fillTemplate(EXTENSIONS_PRIMARY_INPUTS, blockVars) : "",
  })
}

function readTemplate(name: string): string {
  return fs.readFileSync(path.join(import.meta.dirname, "templates", name), "utf8")
}

/**
 * Validates a parsed stage-1 object into an ExtractionResult, or null for the
 * all-empty no-op. Shared by the structured-output path (AssistantMessage.
 * structured) and the text parser below.
 */
export function validateExtraction(obj: Partial<ExtractionResult>): ExtractionResult | null {
  if (typeof obj.raw_memory !== "string" || typeof obj.rollout_summary !== "string") {
    throw new Error("extraction response missing required fields")
  }
  // codex phase1: either field empty → SucceededNoOutput (not a partial upsert).
  if (!obj.raw_memory.trim() || !obj.rollout_summary.trim()) {
    return null
  }
  // Guard against the model echoing the format skeleton from the system prompt.
  const templateArtifacts = [
    "<success|partial|fail|uncertain>",
    "<primary task signature>",
    "<short quote or near-verbatim request>",
  ]
  if (templateArtifacts.some((a) => obj.raw_memory!.includes(a))) {
    throw new Error("extraction returned template placeholder text instead of actual content")
  }
  return {
    raw_memory: obj.raw_memory,
    rollout_summary: obj.rollout_summary,
    rollout_slug: typeof obj.rollout_slug === "string" && obj.rollout_slug.trim() ? obj.rollout_slug : null,
  }
}

/**
 * Parses stage-1 JSON from assistant text. Fallback for when structured output
 * is unavailable; the primary path reads AssistantMessage.structured directly.
 */
export function parseExtraction(raw: string): ExtractionResult | null {
  const cleaned = raw.replace(/^```(?:json)?/gim, "").replace(/```$/gim, "").trim()
  const start = cleaned.indexOf("{")
  const end = cleaned.lastIndexOf("}")
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("extraction response contained no JSON object")
  }
  return validateExtraction(JSON.parse(cleaned.slice(start, end + 1)) as Partial<ExtractionResult>)
}
