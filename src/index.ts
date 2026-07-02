import { ensureMemoryLayout, buildMemorySystemPrompt, invalidateCache } from "./source.js"
import { stripCitations, extractCitedSessionIds } from "./citation.js"
import { memory_read, memory_search, memory_add_note } from "../tools/memory.js"
import { memory_reset, memory_inspect, memory_mode } from "../tools/control.js"
import { MemoryStore } from "./store.js"
import { runPhase1, DEFAULT_PHASE1_OPTIONS } from "./phase1.js"
import { runPhase2, DEFAULT_PHASE2_OPTIONS } from "./phase2.js"
import { setPluginInput } from "./llm.js"
import type { PluginInput, PluginOptions } from "@opencode-ai/plugin"

let store: MemoryStore | null = null
let phase1InFlight = false
let phase2InFlight = false

function getStore(): MemoryStore {
  if (!store) store = new MemoryStore()
  return store
}

const EXTRACT_AGENTS = new Set(["memorize", "memorize-extract"])
export { EXTRACT_AGENTS }

export default {
  id: "opencode-memex",
  async server(input: PluginInput, _options?: PluginOptions) {
    setPluginInput(input)
    return hooks
  },
}

const hooks = {
  async "experimental.chat.system.transform"(
    input: { sessionID?: string; model: unknown },
    output: { system: string[] },
  ): Promise<void> {
    try {
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
            part.text = stripCitations(part.text)
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
        const part = (ev.properties as { part?: { type: string; text?: string; sessionID?: string } }).part
        if (!part || part.type !== "text" || typeof part.text !== "string") return
        if (!part.text.includes("<memory-citation>")) return
        let ids: string[] = []
        try {
          ids = extractCitedSessionIds(part.text)
        } catch {
          return
        }
        if (ids.length > 0) {
          try {
            getStore().recordUsage(ids)
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
        if (!sid) return
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
  if (phase1InFlight) return
  phase1InFlight = true
  try {
    await runPhase1(getStore(), { ...DEFAULT_PHASE1_OPTIONS, excludeSession: currentSessionId })
  } catch (err) {
    console.error("[opencode-memex] phase1 error:", err)
  } finally {
    phase1InFlight = false
  }
  void triggerPhase2()
}

async function triggerPhase2(): Promise<void> {
  if (phase2InFlight) return
  phase2InFlight = true
  try {
    await runPhase2(getStore(), DEFAULT_PHASE2_OPTIONS)
  } catch (err) {
    console.error("[opencode-memex] phase2 error:", err)
  } finally {
    phase2InFlight = false
  }
}