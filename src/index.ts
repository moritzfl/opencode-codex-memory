import { ensureMemoryLayout, buildMemorySystemPrompt, invalidateCache } from "./source.js"
import { stripCitations, extractCitedSessionIds } from "./citation.js"
import { memory_read, memory_search, memory_add_note } from "../tools/memory.js"
import { memory_reset, memory_inspect, memory_mode } from "../tools/control.js"
import { MemoryStore } from "./store.js"
import { runPhase1, DEFAULT_PHASE1_OPTIONS } from "./phase1.js"
import { runPhase2, DEFAULT_PHASE2_OPTIONS } from "./phase2.js"
import { setPluginInput, cleanupOldSubSessions, isMemexSubSession } from "./llm.js"
import type { PluginInput, PluginOptions } from "@opencode-ai/plugin"

let store: MemoryStore | null = null
let phase1InFlight = false

let pluginOptions: {
  generate_memory: boolean
  extract_model?: string
  max_unused_days: number
  max_rollout_age_days: number
  min_rollout_idle_hours: number
} = {
  generate_memory: true,
  max_unused_days: 30,
  max_rollout_age_days: 14,
  min_rollout_idle_hours: 1,
}

function getStore(): MemoryStore {
  if (!store) store = new MemoryStore()
  return store
}

// Citation blocks arrive via message.part.updated once per streaming delta,
// so the same completed block is seen many times. Track which session ids
// were already recorded per part to count each citation once.
const recordedCitations = new Map<string, Set<string>>()
const MAX_TRACKED_PARTS = 500

export function takeNewCitations(partKey: string, ids: string[]): string[] {
  let seen = recordedCitations.get(partKey)
  if (!seen) {
    seen = new Set()
    recordedCitations.set(partKey, seen)
    if (recordedCitations.size > MAX_TRACKED_PARTS) {
      const oldest = recordedCitations.keys().next().value
      if (oldest !== undefined) recordedCitations.delete(oldest)
    }
  }
  const fresh = ids.filter((id) => !seen.has(id))
  for (const id of fresh) seen.add(id)
  return fresh
}

export default {
  id: "opencode-memex",
  async server(input: PluginInput, opts?: PluginOptions) {
    setPluginInput(input)
    if (opts) {
      if (typeof opts.generate_memory === "boolean") pluginOptions.generate_memory = opts.generate_memory
      if (typeof opts.extract_model === "string") pluginOptions.extract_model = opts.extract_model
      if (typeof opts.max_unused_days === "number") pluginOptions.max_unused_days = opts.max_unused_days
      if (typeof opts.max_rollout_age_days === "number") pluginOptions.max_rollout_age_days = opts.max_rollout_age_days
      if (typeof opts.min_rollout_idle_hours === "number") pluginOptions.min_rollout_idle_hours = opts.min_rollout_idle_hours
    }
    void cleanupOldSubSessions().catch(() => {})
    return hooks
  },
}

const hooks = {
  async "experimental.chat.system.transform"(
    input: { sessionID?: string; model: unknown },
    output: { system: string[] },
  ): Promise<void> {
    try {
      if (input.sessionID && isMemexSubSession(input.sessionID)) return
      ensureMemoryLayout()
      const memoryPrompt = buildMemorySystemPrompt()
      if (memoryPrompt) {
        output.system.push(memoryPrompt)
      }
    } catch (err) {
      console.error("[opencode-memex] system.transform error:", err)
    }
  },

  async "experimental.chat.messages.transform"(
    _input: unknown,
    output: { messages: { info: { role?: string }; parts: { type: string; text?: string }[] }[] },
  ): Promise<void> {
    try {
      for (const msg of output.messages) {
        if (msg.info?.role !== "assistant") continue
        for (const part of msg.parts) {
          if (part.type === "text" && typeof part.text === "string" && part.text.includes("<memory-citation>")) {
            const before = part.text
            part.text = stripCitations(part.text)
            if (part.text.includes("<memory-citation>")) {
              console.warn("[opencode-memex] citation marker still present after stripCitations — hook contract may have changed")
            }
          }
        }
      }
    } catch (err) {
      console.error("[opencode-memex] messages.transform error:", err)
    }
  },

  async event(input: { event: { type: string; properties: unknown } }): Promise<void> {
    try {
      const ev = input.event
      if (ev.type === "message.part.updated") {
        const part = (ev.properties as { part?: { id?: string; type: string; text?: string; sessionID?: string } }).part
        if (!part || part.type !== "text" || typeof part.text !== "string") return
        if (part.sessionID && isMemexSubSession(part.sessionID)) return
        if (!part.text.includes("<memory-citation>")) return
        let ids: string[] = []
        try {
          ids = extractCitedSessionIds(part.text)
        } catch {
          return
        }
        const fresh = takeNewCitations(`${part.sessionID ?? ""}:${part.id ?? ""}`, ids)
        if (fresh.length > 0) {
          try {
            getStore().recordUsage(fresh)
          } catch (e) {
            console.error("[opencode-memex] recordUsage failed:", e)
          }
        }
        return
      }

      if (ev.type === "tool.execute.after") {
        const props = ev.properties as { tool?: string; sessionID?: string }
        const toolName = props?.tool ?? ""
        if ((toolName === "websearch" || toolName === "webfetch") && props.sessionID) {
          try {
            getStore().markPolluted(props.sessionID)
          } catch (e) {
            console.error("[opencode-memex] markPolluted failed:", e)
          }
        }
        return
      }

      if (ev.type === "session.idle") {
        const props = ev.properties as { sessionID?: string }
        const sid = props?.sessionID
        if (!sid || isMemexSubSession(sid)) return
        void triggerPhase1(sid)
        return
      }
    } catch (err) {
      console.error("[opencode-memex] event error:", err)
    }
  },

  async dispose(): Promise<void> {
    invalidateCache()
  },

  tool: {
    memory_read,
    memory_search,
    memory_add_note,
    memory_reset,
    memory_inspect,
    memory_mode,
  },
}

async function triggerPhase1(currentSessionId: string): Promise<void> {
  if (phase1InFlight || !pluginOptions.generate_memory) return
  phase1InFlight = true
  try {
    await runPhase1(getStore(), {
      maxAgeDays: pluginOptions.max_rollout_age_days,
      minIdleHours: pluginOptions.min_rollout_idle_hours,
      excludeSession: currentSessionId,
    })
  } catch (err) {
    console.error("[opencode-memex] phase1 error:", err)
  } finally {
    phase1InFlight = false
  }
  void triggerPhase2()
}

async function triggerPhase2(): Promise<void> {
  try {
    // runPhase2 has its own in-flight guard
    await runPhase2(getStore(), {
      maxRaw: 50,
      maxUnusedDays: pluginOptions.max_unused_days,
      extensionRetentionDays: 7,
    })
  } catch (err) {
    console.error("[opencode-memex] phase2 error:", err)
  }
}