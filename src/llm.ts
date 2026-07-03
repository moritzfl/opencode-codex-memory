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

async function promptSession(sessionId: string, prompt: string, agent: string, timeoutMs = 300_000): Promise<string> {
  const input = getPluginInput()
  if (!input) throw new Error("plugin input not initialized")
  const promptPromise = input.client.session.prompt({
    path: { id: sessionId },
    body: {
      agent,
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

export async function extractViaSubagent(sessionId: string, transcript: string): Promise<ExtractionResult> {
  const agent = "memorize-extract"
  const subId = await createSession(agent, `memex-extract-${sessionId}`)
  try {
    const prompt = buildExtractionPrompt(sessionId, transcript)
    const raw = await promptSession(subId, prompt, agent, 180_000)
    return parseExtraction(raw)
  } finally {
    void deleteSession(subId).catch(() => {})
  }
}

export async function consolidateViaSubagent(diffPath: string, workdir: string): Promise<void> {
  const agent = "memorize"
  const subId = await createSession(agent, "memex-consolidate")
  try {
    const prompt = buildConsolidationPrompt(diffPath)
    await promptSession(subId, prompt, agent)
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

function buildExtractionPrompt(sessionId: string, transcript: string): string {
  return fillTemplate(readTemplate("stage_one_system.md"), {
    session_id: sessionId,
    transcript: transcript.slice(0, 200_000),
  })
}

function buildConsolidationPrompt(diffPath: string): string {
  return fillTemplate(readTemplate("consolidation.md"), { diff_path: diffPath })
}

function readTemplate(name: string): string {
  return fs.readFileSync(path.join(import.meta.dirname, "templates", name), "utf8")
}

export function parseExtraction(raw: string): ExtractionResult {
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
  if (obj.raw_memory.startsWith("<write") || obj.raw_memory.includes("Detailed markdown. Include: what the user was doing")) {
    throw new Error("extraction returned placeholder text instead of actual content")
  }
  if (obj.raw_memory.includes("User debugged a CSV parser. Found that quoted fields with embedded newlines")) {
    throw new Error("extraction returned example text instead of actual content")
  }
  if (obj.rollout_slug === "kebab-case-slug-of-the-session-topic" || obj.rollout_slug === "csv-parser-quoted-newlines" || (obj.rollout_slug && obj.rollout_slug.startsWith("<write"))) {
    throw new Error("extraction returned placeholder slug instead of actual content")
  }
  return {
    raw_memory: obj.raw_memory,
    rollout_summary: obj.rollout_summary,
    rollout_slug: typeof obj.rollout_slug === "string" ? obj.rollout_slug : null,
  }
}