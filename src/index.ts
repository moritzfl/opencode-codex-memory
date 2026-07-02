import { ensureMemoryLayout, buildMemorySystemPrompt, invalidateCache } from "./source.js"
import { stripCitations, extractCitedSessionIds } from "./citation.js"
import { memory_read, memory_search, memory_add_note } from "../tools/memory.js"

export default {
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
      if (input.event.type !== "message.part.updated") return
      const part = (input.event.properties as { part?: { type: string; text?: string } }).part
      if (!part || part.type !== "text" || typeof part.text !== "string") return
      if (!part.text.includes("<memory-citation>")) return
      extractCitedSessionIds(part.text)
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
  },
}