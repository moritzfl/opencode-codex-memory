import fs from "fs"
import path from "path"
import type { PluginInput } from "@opencode-ai/plugin"

export interface ExtractionResult {
  raw_memory: string
  rollout_summary: string
  rollout_slug: string | null
}

let inputRef: PluginInput | null = null

export function setPluginInput(input: PluginInput): void {
  inputRef = input
}

export function getPluginInput(): PluginInput | null {
  return inputRef
}

// Sessions this plugin spawned for extraction/consolidation. The main
// hooks skip these so the plugin never injects memory into (or memorizes) its
// own sub-agents.
const activeSubSessions = new Set<string>()

export function isMemorySubSession(sessionId: string): boolean {
  return activeSubSessions.has(sessionId)
}

async function createSession(agent: string, title?: string): Promise<string> {
  const input = getPluginInput()
  if (!input) throw new Error("plugin input not initialized")
  const res = await input.client.session.create({
    body: { title: title ?? `codex-memory-${agent}` },
  })
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
  // json_schema structured-output request. opencode's PromptInput accepts a
  // `format` field (schema v1/session.ts) but the generated SDK body type omits
  // it, so it is passed through an `as any` cast at the call site.
  format?: Record<string, unknown>
}

/**
 * opencode's config carries the same split codex expresses with provider
 * model preferences: `small_model` for cheap background work (codex:
 * memory_extraction_preferred_model = gpt-5.4-mini) and `model` for capable
 * work (codex: memory_consolidation_preferred_model = gpt-5.4). Cached per
 * plugin instance — opencode reloads plugins on config change.
 */
let configModels: { model?: string; smallModel?: string } | null = null

async function getConfigModels(): Promise<{ model?: string; smallModel?: string }> {
  if (configModels) return configModels
  const input = getPluginInput()
  if (!input) return {}
  try {
    const res = await input.client.config.get()
    const cfg = (res as { data?: { model?: string; small_model?: string } })?.data
    configModels = { model: cfg?.model, smallModel: cfg?.small_model }
  } catch {
    // Config endpoint unavailable: leave models unset so the sub-agent runs
    // on the session default, the previous behavior.
    configModels = {}
  }
  return configModels
}

// extract_model / consolidation model strings are "providerID/modelID".
function parseModelRef(ref: string): { providerID: string; modelID: string } | null {
  const slash = ref.indexOf("/")
  if (slash <= 0 || slash === ref.length - 1) return null
  return { providerID: ref.slice(0, slash), modelID: ref.slice(slash + 1) }
}

/** Runs a sub-agent prompt and returns the raw response data (`{ info, parts }`). */
async function runPrompt(sessionId: string, prompt: string, agent: string, opts: PromptOptions = {}): Promise<any> {
  const timeoutMs = opts.timeoutMs ?? 300_000
  const input = getPluginInput()
  if (!input) throw new Error("plugin input not initialized")
  const model = opts.model ? parseModelRef(opts.model) : null
  const promptPromise = input.client.session.prompt({
    path: { id: sessionId },
    // `format` lives in the server's PromptInput but not the generated SDK body
    // type yet (same OpenAPI lag as session.list scope/roots), hence the cast.
    body: {
      agent,
      ...(opts.system ? { system: opts.system } : {}),
      ...(model ? { model } : {}),
      ...(opts.format ? { format: opts.format } : {}),
      parts: [{ type: "text", text: prompt } as any],
    } as any,
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const res = await Promise.race([
      promptPromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`sub-agent prompt timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
    if (!res.data) throw new Error(`prompt failed: ${JSON.stringify(res.error ?? {})}`)
    return res.data
  } finally {
    clearTimeout(timer)
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

/** Returns null when the extractor reported a no-op (nothing worth remembering). */
export async function extractViaSubagent(sessionId: string, transcript: string, opts: ExtractOptions = {}): Promise<ExtractionResult | null> {
  const agent = "memorize-extract"
  const subId = await createSession(agent, `codex-memory-extract-${sessionId}`)
  try {
    const prompt = buildExtractionInput(sessionId, opts.cwd ?? "unknown", transcript)
    // extract_model option > opencode small_model > session default.
    const model = opts.model ?? (await getConfigModels()).smallModel
    const data = await runPrompt(subId, prompt, agent, {
      // Mirrors the stage-1 job lease (1h): codex has no per-request timeout,
      // and a near-600k-char transcript on a slow model can easily exceed a
      // short one — repeated timeouts would exhaust the job's retries.
      timeoutMs: 3600_000,
      system: readTemplate("stage_one_system.md"),
      model,
      // opencode enforces json_schema output via a forced StructuredOutput tool
      // call (toolChoice: required) — which is why memorize-extract must allow
      // that one otherwise-denied tool.
      format: { type: "json_schema", schema: EXTRACTION_SCHEMA },
    })
    // The captured JSON lands on AssistantMessage.structured (schema
    // v1/session.ts; absent from the generated SDK type, so read it untyped).
    // Fall back to text parsing when structured output is unavailable (a host
    // without the feature, or a model that emitted JSON as plain text).
    const structured = (data as any)?.info?.structured
    if (structured && typeof structured === "object") {
      return validateExtraction(structured as Partial<ExtractionResult>)
    }
    return parseExtraction(extractAssistantText(data))
  } finally {
    void deleteSession(subId).catch(() => {})
  }
}

// codex runs the consolidation agent under a 1h job lease with heartbeats;
// its INIT pass is explicitly allowed to run long ("do not be lazy"). A short
// timeout here would fail the job after the workspace was already synced.
const CONSOLIDATION_TIMEOUT_MS = 3600_000

export async function consolidateViaSubagent(memoryRoot: string, diffFileName: string, model?: string): Promise<void> {
  const agent = "memorize"
  const subId = await createSession(agent, "codex-memory-consolidate")
  try {
    const prompt = buildConsolidationPrompt(memoryRoot, diffFileName)
    // consolidation_model option > opencode model (main) > session default.
    const resolved = model ?? (await getConfigModels()).model
    await promptSession(subId, prompt, agent, { model: resolved, timeoutMs: CONSOLIDATION_TIMEOUT_MS })
  } finally {
    void deleteSession(subId).catch(() => {})
  }
}

// Must exceed the longest legitimate sub-session lifetime (consolidation may
// run up to CONSOLIDATION_TIMEOUT_MS = 60min), or a second opencode instance /
// plugin reload would delete a working sub-session mid-run.
export async function cleanupOldSubSessions(maxAgeMinutes = 90): Promise<void> {
  const input = getPluginInput()
  if (!input) return
  try {
    const res = await input.client.session.list()
    if (!res.data) return
    const list = res.data as Array<{ id: string; title?: string; time?: { created?: number } }>
    const cutoff = Date.now() - maxAgeMinutes * 60 * 1000
    for (const s of list) {
      if (s.title && s.title.startsWith("codex-memory-")) {
        const created = s.time?.created ?? 0
        if (created && created < cutoff) {
          await deleteSession(s.id)
        }
      }
    }
  } catch {
    // best effort only
  }
}

async function deleteSession(id: string): Promise<void> {
  activeSubSessions.delete(id)
  const input = getPluginInput()
  if (!input) return
  try {
    const res = await input.client.session.delete({ path: { id } })
    if (res.error) {
      console.warn(`[opencode-codex-memory] failed to delete sub-session ${id}: ${JSON.stringify(res.error)}`)
    }
  } catch (err) {
    console.warn(`[opencode-codex-memory] error deleting sub-session ${id}:`, err)
  }
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