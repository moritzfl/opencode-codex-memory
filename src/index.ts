import { ensureMemoryLayout, buildMemorySystemPrompt, invalidateCache } from "./source.js"
import { memoryRoot } from "./paths.js"
import { stripCitations, extractCitedSessionIds } from "./citation.js"
import { memory_read, memory_search, memory_list, memory_add_note } from "../tools/memory.js"
import { memory_reset, memory_inspect, memory_mode } from "../tools/control.js"
import { MemoryStore } from "./store.js"
import { runPhase1 } from "./phase1.js"
import { runPhase2 } from "./phase2.js"
import { setPluginInput, cleanupOldSubSessions, isMemorySubSession } from "./llm.js"
import type { PluginInput, PluginOptions } from "@opencode-ai/plugin"
import fs from "fs"
import path from "path"

let phase1InFlight = false
let pluginClient: PluginInput["client"] | null = null
// Configured MCP server names, fetched lazily; null until first successful fetch.
let mcpServerNames: Set<string> | null = null

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

// Deliberately uncached: openDb() is already a singleton, and caching a store
// here would hold a stale handle across closeDb() (e.g. after memory_reset).
function getStore(): MemoryStore {
  return new MemoryStore()
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

export function handleSessionDeleted(
  sessionId: string,
  store: Pick<MemoryStore, "deleteSessionMemory"> = getStore(),
  // With generation off the memorize agent is not injected, so a consolidation
  // attempt could only fail; the row deletion above still happens, and the
  // enqueued job runs when generation is re-enabled (codex: delete only
  // enqueues; the pipeline itself is gated elsewhere).
  schedulePhase2: () => void = () => { if (pluginOptions.generate_memories) void triggerPhase2() },
): void {
  if (store.deleteSessionMemory(sessionId)) schedulePhase2()
}

export default {
  id: "opencode-codex-memory",
  async server(input: PluginInput, opts?: PluginOptions) {
    setPluginInput(input)
    pluginClient = input.client
    if (opts) applyPluginOptions(opts)
    void cleanupOldSubSessions().catch(() => {})
    return buildHooks()
  },
}

const KNOWN_OPTION_KEYS = new Set([
  "generate_memories",
  "use_memories",
  "dedicated_tools",
  "disable_on_external_context",
  "extract_model",
  "consolidation_model",
  "max_raw_memories_for_consolidation",
  "max_unused_days",
  "max_rollout_age_days",
  "max_rollouts_per_startup",
  "min_rollout_idle_hours",
])

// codex clamps numeric knobs in From<MemoriesToml> for MemoriesConfig
// (config/src/types.rs); mirror the exact ranges. Non-finite values fall back
// to the default.
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

function applyPluginOptions(opts: PluginOptions): void {
  for (const key of Object.keys(opts)) {
    if (!KNOWN_OPTION_KEYS.has(key)) {
      // codex uses deny_unknown_fields; a plugin can only warn. Covers typos
      // and the deliberately unimplemented min_rate_limit_remaining_percent.
      console.warn(`[opencode-codex-memory] unknown/unsupported option '${key}' ignored`)
    }
  }
  if (typeof opts.generate_memories === "boolean") pluginOptions.generate_memories = opts.generate_memories
  if (typeof opts.use_memories === "boolean") pluginOptions.use_memories = opts.use_memories
  if (typeof opts.dedicated_tools === "boolean") pluginOptions.dedicated_tools = opts.dedicated_tools
  if (typeof opts.disable_on_external_context === "boolean") pluginOptions.disable_on_external_context = opts.disable_on_external_context
  if (typeof opts.extract_model === "string") pluginOptions.extract_model = opts.extract_model
  if (typeof opts.consolidation_model === "string") pluginOptions.consolidation_model = opts.consolidation_model
  if ("max_raw_memories_for_consolidation" in opts)
    pluginOptions.max_raw_memories_for_consolidation = clampInt(opts.max_raw_memories_for_consolidation, 1, 4096, 256)
  if ("max_unused_days" in opts) pluginOptions.max_unused_days = clampInt(opts.max_unused_days, 0, 365, 30)
  if ("max_rollout_age_days" in opts) pluginOptions.max_rollout_age_days = clampInt(opts.max_rollout_age_days, 0, 90, 10)
  if ("max_rollouts_per_startup" in opts) pluginOptions.max_rollouts_per_startup = clampInt(opts.max_rollouts_per_startup, 1, 128, 2)
  if ("min_rollout_idle_hours" in opts) pluginOptions.min_rollout_idle_hours = clampInt(opts.min_rollout_idle_hours, 1, 48, 6)
}

/**
 * codex marks every MCP server as memory-polluting unconditionally
 * (codex-mcp server.rs pollutes_memory: true). opencode registers MCP tools
 * as "<server>_<tool>", so match tool names against the configured server
 * list. Fails closed to the web-tools-only check when the list is unavailable.
 */
async function isExternalContextTool(toolName: string): Promise<boolean> {
  if (toolName === "websearch" || toolName === "webfetch") return true
  if (!mcpServerNames && pluginClient) {
    try {
      const res = await (pluginClient as any).mcp.status()
      const servers = (res as any)?.data ?? res
      if (servers && typeof servers === "object") {
        mcpServerNames = new Set(Object.keys(servers))
      }
    } catch {
      // MCP status unavailable (older opencode); keep web-tools-only checks.
    }
  }
  if (!mcpServerNames) return false
  for (const server of mcpServerNames) {
    if (toolName.startsWith(`${server}_`)) return true
  }
  return false
}

/**
 * Registers the memorize / memorize-extract sub-agents through the config
 * hook so installing the plugin requires no manual agent setup. Definitions
 * are read from the plugin's bundled opencode.json (single source of truth
 * with the dev checkout). A user-defined agent of the same name always wins —
 * only missing entries are filled. opencode-specific packaging: codex ships
 * its memory agents inside the binary.
 */
export function injectAgentDefinitions(config: { agent?: Record<string, unknown> }): void {
  let defs: Record<string, unknown>
  try {
    const raw = fs.readFileSync(path.join(import.meta.dirname, "..", "opencode.json"), "utf8")
    defs = (JSON.parse(raw) as { agent?: Record<string, unknown> }).agent ?? {}
  } catch (err) {
    console.warn("[opencode-codex-memory] could not load bundled agent definitions:", err)
    return
  }
  // opencode gates file tools outside the session's project behind the
  // `external_directory` permission, and the memory workspace is global —
  // outside every project — so the consolidator's reads/writes there always
  // trigger that ask. The bundled `"*": "deny"` matches it (permission rules
  // are wildcard-on-name, last match wins), which would block consolidation
  // entirely. Grant the memory root here rather than in opencode.json: the
  // path is homedir/env-dependent (src/paths.ts is its single source of
  // truth). Appended last so it out-ranks the wildcard deny.
  const memorize = defs["memorize"] as { permission?: Record<string, unknown> } | undefined
  if (memorize?.permission && !("external_directory" in memorize.permission)) {
    memorize.permission["external_directory"] = { [path.join(memoryRoot(), "*")]: "allow" }
  }
  config.agent ??= {}
  for (const [name, def] of Object.entries(defs)) {
    if (!config.agent[name]) config.agent[name] = def
  }
}

function buildHooks() {
  const base = {
  async config(input: { agent?: Record<string, unknown> }): Promise<void> {
    try {
      // The write pipeline is the only consumer of the sub-agents; with
      // generation off they would just pollute the user's agent list.
      if (!pluginOptions.generate_memories) return
      injectAgentDefinitions(input)
    } catch (err) {
      console.error("[opencode-codex-memory] config hook error:", err)
    }
  },

  async "experimental.chat.system.transform"(
    input: { sessionID?: string; model: unknown },
    output: { system: string[] },
  ): Promise<void> {
    try {
      if (!pluginOptions.use_memories) return
      if (input.sessionID && isMemorySubSession(input.sessionID)) return
      ensureMemoryLayout()
      const memoryPrompt = buildMemorySystemPrompt(pluginOptions.dedicated_tools)
      if (memoryPrompt) {
        output.system.push(memoryPrompt)
      }
    } catch (err) {
      console.error("[opencode-codex-memory] system.transform error:", err)
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
              console.warn("[opencode-codex-memory] citation marker still present after stripCitations — hook contract may have changed")
            }
          }
        }
      }
    } catch (err) {
      console.error("[opencode-codex-memory] messages.transform error:", err)
    }
  },

  // Dedicated plugin hook (NOT an event-bus type): fires after every tool
  // call. Mirrors codex: external context (web search or any MCP tool) only
  // pollutes the session's memory when disable_on_external_context is
  // enabled. Off by default.
  async "tool.execute.after"(input: { tool: string; sessionID: string; callID: string }): Promise<void> {
    try {
      if (!pluginOptions.disable_on_external_context) return
      if (input.sessionID && (await isExternalContextTool(input.tool))) {
        getStore().markPolluted(input.sessionID)
      }
    } catch (err) {
      console.error("[opencode-codex-memory] tool.execute.after error:", err)
    }
  },

  async event(input: { event: { type: string; properties: unknown } }): Promise<void> {
    try {
      const ev = input.event
      if (ev.type === "message.part.updated") {
        const part = (ev.properties as { part?: { id?: string; type: string; text?: string; sessionID?: string } }).part
        if (!part || part.type !== "text" || typeof part.text !== "string") return
        if (part.sessionID && isMemorySubSession(part.sessionID)) return
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
            console.error("[opencode-codex-memory] recordUsage failed:", e)
          }
        }
        return
      }

      if (ev.type === "session.deleted") {
        // Mirrors codex delete_thread_memory: drop the extracted memory and
        // its job when the session is deleted. If phase 2 had consumed it,
        // enqueue and attempt consolidation so the diff drives forgetting.
        const props = ev.properties as { info?: { id?: string } }
        const sid = props?.info?.id
        if (sid) {
          try {
            handleSessionDeleted(sid)
          } catch (e) {
            console.error("[opencode-codex-memory] deleteSessionMemory failed:", e)
          }
        }
        return
      }

      if (ev.type === "session.idle") {
        const props = ev.properties as { sessionID?: string }
        const sid = props?.sessionID
        if (!sid || isMemorySubSession(sid)) return
        // codex stamps memory_mode at thread creation from generate_memories:
        // sessions first seen while generation is off keep that stamp when the
        // option is re-enabled (manual override: the memory_mode tool).
        try {
          getStore().stampMemoryModeIfAbsent(sid, pluginOptions.generate_memories ? "enabled" : "disabled")
        } catch (e) {
          console.error("[opencode-codex-memory] stampMemoryModeIfAbsent failed:", e)
        }
        void triggerPhase1(sid)
        return
      }
    } catch (err) {
      console.error("[opencode-codex-memory] event error:", err)
    }
  },

  async dispose(): Promise<void> {
    invalidateCache()
  },
  }

  // Control tools (reset/inspect/mode) are always available. The memory
  // read/search/list/add-note tools require BOTH use_memories and
  // dedicated_tools, mirroring codex's MemoriesExtension: use_memories=false
  // disables the whole extension including its tools (extension.rs).
  const tool =
    pluginOptions.use_memories && pluginOptions.dedicated_tools
      ? {
          memory_read,
          memory_search,
          memory_list,
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
      maxUnusedDays: pluginOptions.max_unused_days,
      excludeSession: currentSessionId,
      extractModel: pluginOptions.extract_model,
    })
  } catch (err) {
    console.error("[opencode-codex-memory] phase1 error:", err)
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
    console.error("[opencode-codex-memory] phase2 error:", err)
  }
}