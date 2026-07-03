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
// hooks skip these so memex never injects memory into (or memorizes) its
// own sub-agents.
const activeSubSessions = new Set<string>()

export function isMemexSubSession(sessionId: string): boolean {
  return activeSubSessions.has(sessionId)
}

async function createSession(agent: string, title?: string): Promise<string> {
  const input = getPluginInput()
  if (!input) throw new Error("plugin input not initialized")
  const res = await input.client.session.create({
    body: { title: title ?? `memex-${agent}` },
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
}

// extract_model / consolidation model strings are "providerID/modelID".
function parseModelRef(ref: string): { providerID: string; modelID: string } | null {
  const slash = ref.indexOf("/")
  if (slash <= 0 || slash === ref.length - 1) return null
  return { providerID: ref.slice(0, slash), modelID: ref.slice(slash + 1) }
}

async function promptSession(sessionId: string, prompt: string, agent: string, opts: PromptOptions = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 300_000
  const input = getPluginInput()
  if (!input) throw new Error("plugin input not initialized")
  const model = opts.model ? parseModelRef(opts.model) : null
  const promptPromise = input.client.session.prompt({
    path: { id: sessionId },
    body: {
      agent,
      ...(opts.system ? { system: opts.system } : {}),
      ...(model ? { model } : {}),
      parts: [{ type: "text", text: prompt } as any],
    },
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
    return extractAssistantText(res.data)
  } finally {
    clearTimeout(timer)
  }
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

/** Returns null when the extractor reported a no-op (nothing worth remembering). */
export async function extractViaSubagent(sessionId: string, transcript: string, opts: ExtractOptions = {}): Promise<ExtractionResult | null> {
  const agent = "memorize-extract"
  const subId = await createSession(agent, `memex-extract-${sessionId}`)
  try {
    const prompt = buildExtractionInput(sessionId, opts.cwd ?? "unknown", transcript)
    const raw = await promptSession(subId, prompt, agent, {
      timeoutMs: 180_000,
      system: readTemplate("stage_one_system.md"),
      model: opts.model,
    })
    return parseExtraction(raw)
  } finally {
    void deleteSession(subId).catch(() => {})
  }
}

export async function consolidateViaSubagent(memoryRoot: string, diffFileName: string, model?: string): Promise<void> {
  const agent = "memorize"
  const subId = await createSession(agent, "memex-consolidate")
  try {
    const prompt = buildConsolidationPrompt(memoryRoot, diffFileName)
    await promptSession(subId, prompt, agent, { model })
  } finally {
    void deleteSession(subId).catch(() => {})
  }
}

export async function cleanupOldSubSessions(maxAgeMinutes = 30): Promise<void> {
  const input = getPluginInput()
  if (!input) return
  try {
    const res = await input.client.session.list()
    if (!res.data) return
    const list = res.data as Array<{ id: string; title?: string; time?: { created?: number } }>
    const cutoff = Date.now() - maxAgeMinutes * 60 * 1000
    for (const s of list) {
      if (s.title && s.title.startsWith("memex-")) {
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
      console.warn(`[opencode-memex] failed to delete sub-session ${id}: ${JSON.stringify(res.error)}`)
    }
  } catch (err) {
    console.warn(`[opencode-memex] error deleting sub-session ${id}:`, err)
  }
}

// Substitute with a function so `$&`/`$'` sequences in the value are not
// expanded as String.replace replacement patterns.
export function fillTemplate(tmpl: string, vars: Record<string, string>): string {
  let out = tmpl
  for (const [key, value] of Object.entries(vars)) {
    out = out.replace(`{{ ${key} }}`, () => value)
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

function buildConsolidationPrompt(memoryRoot: string, diffFileName: string): string {
  const tmpl = readTemplate("consolidation.md")
  let out = tmpl
  // These placeholders appear many times in the template; replace all occurrences.
  out = out.split("{{ memory_root }}").join(memoryRoot)
  out = out.split("{{ phase2_workspace_diff_file }}").join(diffFileName)
  return out
}

function readTemplate(name: string): string {
  return fs.readFileSync(path.join(import.meta.dirname, "templates", name), "utf8")
}

/** Parses the stage-1 JSON output. Returns null for the all-empty no-op response. */
export function parseExtraction(raw: string): ExtractionResult | null {
  const cleaned = raw.replace(/^```(?:json)?/gim, "").replace(/```$/gim, "").trim()
  const start = cleaned.indexOf("{")
  const end = cleaned.lastIndexOf("}")
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("extraction response contained no JSON object")
  }
  const json = cleaned.slice(start, end + 1)
  const obj = JSON.parse(json) as Partial<ExtractionResult>
  if (typeof obj.raw_memory !== "string" || typeof obj.rollout_summary !== "string") {
    throw new Error("extraction response missing required fields")
  }
  if (!obj.raw_memory.trim() && !obj.rollout_summary.trim()) {
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