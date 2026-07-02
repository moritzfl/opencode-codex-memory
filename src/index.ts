import { ensureMemoryLayout, buildMemorySystemPrompt, invalidateCache } from "./source.js"

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

  async event(input: { event: unknown }): Promise<void> {
    // Stage 1+: citation parsing, session capture, Phase 1/2 triggers
  },

  async dispose(): Promise<void> {
    invalidateCache()
  },

  tool: {
    // Stage 1: memory_read, memory_search, memory_add_note
    // Stage 4: memory_reset, memory_inspect, memory_mode
  },
}