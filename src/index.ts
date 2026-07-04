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

// Option names and defaults mirror codex's MemoriesToml/MemoriesConfig
// (codex-rs/config/src/types.rs). Keep them 1:1 so the drift script and manual
// syncing stay trivial; do not rename for taste.
let pluginOptions: {
  generate_memories: boolean
  use_memories: boolean
  dedicated_tools: boolean
  disable_on_external_context: boolean
  extract_model?: string
  consolidation_model?: string
  max_raw_memories_for_consolidation: number
  max_unused_days: number
  max_rollout_age_days: number
  max_rollouts_per_startup: number
  min_rollout_idle_hours: number
} = {
  generate_memories: true,
  use_memories: true,
  dedicated_tools: true,
  disable_on_external_context: false,
  max_raw_memories_for_consolidation: 256,
  max_unused_days: 30,
  max_rollout_age_days: 10,
  max_rollouts_per_startup: 2,
  min_rollout_idle_hours: 6,
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
      if (typeof opts.generate_memories === "boolean") pluginOptions.generate_memories = opts.generate_memories
      if (typeof opts.use_memories === "boolean") pluginOptions.use_memories = opts.use_memories
      if (typeof opts.dedicated_tools === "boolean") pluginOptions.dedicated_tools = opts.dedicated_tools
      if (typeof opts.disable_on_external_context === "boolean") pluginOptions.disable_on_external_context = opts.disable_on_external_context
      if (typeof opts.extract_model === "string") pluginOptions.extract_model = opts.extract_model
      if (typeof opts.consolidation_model === "string") pluginOptions.consolidation_model = opts.consolidation_model
      if (typeof opts.max_raw_memories_for_consolidation === "number") pluginOptions.max_raw_memories_for_consolidation = opts.max_raw_memories_for_consolidation
      if (typeof opts.max_unused_days === "number") pluginOptions.max_unused_days = opts.max_unused_days
      if (typeof opts.max_rollout_age_days === "number") pluginOptions.max_rollout_age_days = opts.max_rollout_age_days
      if (typeof opts.max_rollouts_per_startup === "number") pluginOptions.max_rollouts_per_startup = opts.max_rollouts_per_startup
      if (typeof opts.min_rollout_idle_hours === "number") pluginOptions.min_rollout_idle_hours = opts.min_rollout_idle_hours
    }
    void cleanupOldSubSessions().catch(() => {})
    return buildHooks()
  },
}

function buildHooks() {
  const base = {
  async "experimental.chat.system.transform"(
    input: { sessionID?: string; model: unknown },
    output: { system: string[] },
  ): Promise<void> {
    try {
      if (!pluginOptions.use_memories) return
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
        // Mirrors codex: external context (web/mcp) only pollutes the session's
        // memory when disable_on_external_context is enabled. Off by default.
        if (!pluginOptions.disable_on_external_context) return
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
  }

  // Control tools (reset/inspect/mode) are always available. The memory
  // read/search/add-note tools are gated by dedicated_tools, mirroring codex's
  // MemoriesExtension.tools() (codex-rs/ext/memories/src/tests.rs).
  const tool = pluginOptions.dedicated_tools
    ? {
        memory_read,
        memory_search,
        memory_add_note,
        memory_reset,
        memory_inspect,
        memory_mode,
      }
    : {
        memory_reset,
        memory_inspect,
        memory_mode,
      }

  return { ...base, tool }
}

async function triggerPhase1(currentSessionId: string): Promise<void> {
  if (phase1InFlight || !pluginOptions.generate_memories) return
  phase1InFlight = true
  try {
    await runPhase1(getStore(), {
      maxAgeDays: pluginOptions.max_rollout_age_days,
      minIdleHours: pluginOptions.min_rollout_idle_hours,
      maxClaimed: pluginOptions.max_rollouts_per_startup,
      excludeSession: currentSessionId,
      extractModel: pluginOptions.extract_model,
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
      maxRaw: pluginOptions.max_raw_memories_for_consolidation,
      maxUnusedDays: pluginOptions.max_unused_days,
      extensionRetentionDays: 7,
      consolidationModel: pluginOptions.consolidation_model,
    })
  } catch (err) {
    console.error("[opencode-memex] phase2 error:", err)
  }
}