import type { TranscriptMessage } from "./capture.js"
import { isMemoryExcludedFragment, redact } from "./redact.js"
import { stripCitations } from "./citation.js"
import { truncateToBytes } from "./token.js"

const OMITTED = "[... response items omitted ...]\n"
const TRUNCATION_RESERVE_BYTES = 96
const TOOL_ROW_BYTES = 8_000
const MAX_ROW_BYTES = 10_000
const DEFAULT_BYTE_LIMIT = 600_000

type Tier = "human" | "final" | "other_agent" | "commentary" | "context" | "tool"

const TIER_ORDER: Tier[] = ["human", "final", "other_agent", "commentary", "context", "tool"]

const LABELS: Record<Tier, string> = {
  human: "human user",
  final: "assistant final",
  other_agent: "other agent",
  commentary: "assistant commentary",
  context: "harness context",
  tool: "tool",
}

function isEnvContext(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.startsWith("<environment_context>") && trimmed.endsWith("</environment_context>")
}

function isOtherAgent(text: string): boolean {
  const trimmed = text.trimStart()
  return (
    trimmed.startsWith("<subagent_notification>")
    || (trimmed.startsWith("Message Type:")
      && trimmed.includes("\nTask name:")
      && trimmed.includes("\nSender:"))
  )
}

function classify(msg: TranscriptMessage): Tier | null {
  if (msg.type === "reasoning" || msg.type === "step-start" || msg.type === "step-finish") return null
  if (msg.role === "developer" || msg.role === "system") return null
  if (msg.userReply) return "human"
  if (msg.type === "tool") return "tool"
  if (msg.type === "file" || msg.type === "image") return msg.role === "user" ? "human" : "final"
  const text = msg.text ?? ""
  if (!text.trim() && msg.type !== "file" && msg.type !== "image") return null
  if (msg.type === "agent" || msg.type === "task") return "other_agent"
  if (isOtherAgent(text)) return "other_agent"
  if (msg.role === "user") {
    if (isMemoryExcludedFragment(text)) return null
    if (isEnvContext(text)) return "context"
    return "human"
  }
  if (msg.role === "assistant") {
    if (isOtherAgent(text)) return "other_agent"
    return "final"
  }
  return null
}

function rowText(msg: TranscriptMessage, tier: Tier): string {
  if (msg.type === "image") return "[image omitted]"
  if (msg.type === "file" && !msg.text?.trim()) return "[file omitted]"
  let text = redact(stripCitations(msg.userReply
    ? `Assistant question: ${msg.userReply.question}\nHuman reply: ${msg.userReply.answer}`
    : msg.text ?? ""))
  if (tier === "tool") text = truncateToBytes(text, TOOL_ROW_BYTES - TRUNCATION_RESERVE_BYTES)
  text = truncateToBytes(text, MAX_ROW_BYTES - TRUNCATION_RESERVE_BYTES)
  return text
}

/**
 * Human-first extract input. OpenCode parts, not Codex RolloutItem:
 * question-tool replies retain their question; host transcripts expose no
 * Codex MessagePhase::Commentary or internal content-item provenance.
 */
export function serializeTieredInput(
  items: TranscriptMessage[],
  byteLimit: number = DEFAULT_BYTE_LIMIT,
): string {
  const rows: { tier: Tier; text: string }[] = []
  for (const msg of items) {
    const tier = classify(msg)
    if (!tier) continue
    const body = rowText(msg, tier)
    if (!body.trim()) continue
    rows.push({ tier, text: `[${LABELS[tier]}]\n${body}\n` })
  }
  let remaining = Math.max(0, byteLimit - OMITTED.length)
  const selected: (string | null)[] = rows.map(() => null)
  for (const tier of TIER_ORDER) {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].tier !== tier || remaining <= OMITTED.length + TRUNCATION_RESERVE_BYTES) continue
      let text = rows[i].text
      if (Buffer.byteLength(text) > remaining - OMITTED.length) text = truncateToBytes(text, Math.max(0, remaining - OMITTED.length - TRUNCATION_RESERVE_BYTES))
      if (!text) continue
      remaining -= Buffer.byteLength(text) + OMITTED.length
      selected[i] = text
    }
  }
  let rendered = ""
  let gap = false
  for (const row of selected) {
    if (row) {
      rendered += row
      gap = false
    } else if (!gap) {
      rendered += OMITTED
      gap = true
    }
  }
  if (Buffer.byteLength(rendered) > byteLimit) return ""
  return rendered
}
