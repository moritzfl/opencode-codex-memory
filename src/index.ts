import { ensureMemoryLayout, buildMemorySystemPrompt, invalidateCache } from "./source.js"
import { memoryRoot } from "./paths.js"
import { stripCitations, extractCitedSessionIds } from "./citation.js"
import { memory_read, memory_search, memory_list, memory_add_note } from "../tools/memory.js"
import { memory_reset, memory_inspect, memory_mode } from "../tools/control.js"
import { MemoryStore } from "./store.js"
import { runPhase1 } from "./phase1.js"
import { runPhase2 } from "./phase2.js"
import { setPluginInput, cleanupOldSubSessions, isMemorySubSession, abortActiveSubSessions } from "./llm.js"
import { pluginOptions, recordConfigWarning, clearConfigWarnings, resetPluginOptions } from "./options.js"
import { beginPluginShutdown, isPluginShuttingDown, resetPluginLifecycle } from "./lifecycle.js"
import { hostMcpStatus } from "./host-client.js"
import { recordDiagnostic } from "./diagnostics.js"
import { loadBundledAgentDefinitions, recordAgentConfig, resetAgentHealth } from "./agent-health.js"
import type { PluginInput, PluginOptions } from "@opencode-ai/plugin"
import path from "path"

let phase1InFlight = false
let pluginClient: PluginInput["client"] | null = null
const backgroundTasks = new Set<Promise<void>>()

function trackBackgroundTask(task: Promise<void>): void {
  // Hooks must remain non-blocking, but test teardown needs a way to wait until
  // work started by a hook has released its DB handle.
  const tracked = task.catch((err) => {
    console.error("[opencode-codex-memory] background task error:", err)
  })
  backgroundTasks.add(tracked)
  void tracked.then(() => backgroundTasks.delete(tracked))
}

/** Test seam: wait for all hook-launched work, including follow-up phase 2. */
export async function waitForBackgroundTasks(): Promise<void> {
  while (backgroundTasks.size > 0) {
    await Promise.all([...backgroundTasks])
  }
}
// Single-flight guard for mcp.status(); see mcpToolPrefixes below.
let mcpStatusInFlight: Promise<string[] | null> | null = null
const MCP_STATUS_TIMEOUT_MS = 1_000

// Deliberately uncached: openDb() is already a singleton, and caching a store
// here would hold a stale handle across closeDb() (e.g. after memory_reset).
function getStore(): MemoryStore {
  return new MemoryStore()
}

// Citation blocks are seen by both the text.complete hook (once, at
// completion) and message.part.updated (once per streaming delta), so the
// same block surfaces many times. Track which session ids were already
// recorded per part to count each citation exactly once across both paths.
const recordedCitations = new Map<string, Set<string>>()
const MAX_TRACKED_PARTS = 500

/**
 * Inserts `key` at the most-recently-used end and evicts the oldest entry
 * beyond `max`. Map.set alone does NOT reorder an existing key, so the
 * delete is what makes eviction least-recently-*used* rather than
 * first-inserted — long-lived sessions must not age out mid-use.
 */
function lruSet<K, V>(map: Map<K, V>, key: K, value: V, max: number): V {
  map.delete(key)
  map.set(key, value)
  if (map.size > max) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
  return value
}

export function takeNewCitations(partKey: string, ids: string[]): string[] {
  const seen = recordedCitations.get(partKey) ?? new Set<string>()
  lruSet(recordedCitations, partKey, seen, MAX_TRACKED_PARTS)
  const fresh = ids.filter((id) => !seen.has(id))
  for (const id of fresh) seen.add(id)
  return fresh
}

// One stamp+pump per session per process from the chat.message hook; later
// messages in the same session add nothing (stamp is idempotent, the pump
// re-fires on idle anyway). Value = first-seen timestamp (debugging only).
const seenTurnSessions = new Map<string, number>()
const MAX_TRACKED_TURN_SESSIONS = 1000

export function markTurnSeen(sessionId: string): boolean {
  const first = seenTurnSessions.get(sessionId)
  lruSet(seenTurnSessions, sessionId, first ?? Date.now(), MAX_TRACKED_TURN_SESSIONS)
  return first === undefined
}

// opencode 1.17 publishes BOTH session.status {type:"idle"} and the
// deprecated session.idle for the same transition, back to back. Handle
// whichever arrives first and swallow the twin within a short window.
const recentIdle = new Map<string, number>()
const IDLE_DEDUP_MS = 5000
const MAX_TRACKED_IDLE = 500

export function shouldHandleIdle(sessionId: string, now: number = Date.now()): boolean {
  const last = recentIdle.get(sessionId)
  const deduped = last !== undefined && now - last < IDLE_DEDUP_MS
  // Keep the original stamp while deduping so the window cannot be extended
  // indefinitely by a stream of twins; refresh LRU order either way.
  lruSet(recentIdle, sessionId, deduped ? last! : now, MAX_TRACKED_IDLE)
  return !deduped
}

export function handleSessionDeleted(
  sessionId: string,
  store: Pick<MemoryStore, "deleteSessionMemory"> = getStore(),
  // With generation off the memorize agent is not injected, so a consolidation
  // attempt could only fail; the row deletion above still happens, and the
  // enqueued job runs when generation is re-enabled (codex: delete only
  // enqueues; the pipeline itself is gated elsewhere).
  schedulePhase2: () => void = () => { if (pluginOptions.generate_memories) trackBackgroundTask(triggerPhase2()) },
): void {
  if (store.deleteSessionMemory(sessionId)) schedulePhase2()
}

export default {
  id: "opencode-codex-memory",
  async server(input: PluginInput, opts?: PluginOptions) {
    // A reload after dispose must be able to run the pipeline again.
    resetPluginLifecycle()
    setPluginInput(input)
    pluginClient = input.client
    resetAgentHealth()
    mcpStatusInFlight = null
    // Unconditional, like the caches above: a boot WITHOUT options must not
    // inherit the previous boot's warnings (opencode can host several
    // instances in one process — see the ARCHITECTURE known-gaps table).
    clearConfigWarnings()
    if (opts) applyPluginOptions(opts)
    else resetPluginOptions()
    // Finish bounded reseeding before hooks can see a surviving memory
    // sub-session after a plugin reload.
    await cleanupOldSubSessions()
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
  "codex_interop",
  "claude_import",
])
const KNOWN_CODEX_INTEROP_KEYS = new Set(["import", "export", "codex_home"])
const KNOWN_CLAUDE_IMPORT_KEYS = new Set(["enabled", "claude_home", "projects"])

// codex clamps numeric knobs in From<MemoriesToml> for MemoriesConfig
// (config/src/types.rs); mirror the exact ranges. Non-finite values fall back
// to the default.
function clampInt(key: string, value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    recordConfigWarning(`${key} must be a finite number; using default ${fallback}`)
    return fallback
  }
  return Math.min(max, Math.max(min, Math.floor(value)))
}

export function applyPluginOptions(opts: PluginOptions): void {
  // Fresh pass per apply so memory_inspect never shows warnings for keys the
  // caller has since fixed. server() clears too, for boots without options.
  clearConfigWarnings()
  resetPluginOptions()
  const raw = opts as Record<string, unknown>
  for (const key of Object.keys(opts)) {
    if (!KNOWN_OPTION_KEYS.has(key)) {
      // codex uses deny_unknown_fields; a plugin can only warn (recorded for
      // memory_inspect). Covers typos and the deliberately unimplemented
      // min_rate_limit_remaining_percent.
      recordConfigWarning(`unknown/unsupported option '${key}' ignored`)
    }
  }
  for (const key of ["generate_memories", "use_memories", "dedicated_tools", "disable_on_external_context"] as const) {
    if (!(key in raw)) continue
    if (typeof raw[key] === "boolean") pluginOptions[key] = raw[key]
    else recordConfigWarning(`${key} must be a boolean; using default ${pluginOptions[key]}`)
  }
  for (const key of ["extract_model", "consolidation_model"] as const) {
    if (!(key in raw)) continue
    if (typeof raw[key] === "string") pluginOptions[key] = raw[key]
    else recordConfigWarning(`${key} must be a string; using the opencode model default`)
  }
  if ("max_raw_memories_for_consolidation" in opts)
    pluginOptions.max_raw_memories_for_consolidation = clampInt("max_raw_memories_for_consolidation", opts.max_raw_memories_for_consolidation, 1, 4096, 256)
  if ("max_unused_days" in opts) pluginOptions.max_unused_days = clampInt("max_unused_days", opts.max_unused_days, 0, 365, 30)
  if ("max_rollout_age_days" in opts) pluginOptions.max_rollout_age_days = clampInt("max_rollout_age_days", opts.max_rollout_age_days, 0, 90, 10)
  if ("max_rollouts_per_startup" in opts) pluginOptions.max_rollouts_per_startup = clampInt("max_rollouts_per_startup", opts.max_rollouts_per_startup, 1, 128, 2)
  if ("min_rollout_idle_hours" in opts) pluginOptions.min_rollout_idle_hours = clampInt("min_rollout_idle_hours", opts.min_rollout_idle_hours, 1, 48, 6)
  if ("codex_interop" in opts) {
    const raw = opts.codex_interop
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const o = raw as Record<string, unknown>
      for (const key of Object.keys(o)) {
        if (!KNOWN_CODEX_INTEROP_KEYS.has(key)) {
          recordConfigWarning(`unknown codex_interop option '${key}' ignored`)
        }
      }
      if ("import" in o && typeof o.import !== "boolean") {
        recordConfigWarning("codex_interop.import must be a boolean; using false")
      }
      if ("export" in o && typeof o.export !== "boolean") {
        recordConfigWarning("codex_interop.export must be a boolean; using false")
      }
      if ("codex_home" in o && (typeof o.codex_home !== "string" || o.codex_home.length === 0)) {
        recordConfigWarning("codex_interop.codex_home must be a non-empty string; using the default Codex home")
      }
      pluginOptions.codex_interop = {
        import: o.import === true,
        export: o.export === true,
        ...(typeof o.codex_home === "string" && o.codex_home.length > 0 ? { codex_home: o.codex_home } : {}),
      }
    } else {
      recordConfigWarning("codex_interop must be an object like { import, export, codex_home }; ignored")
    }
  }
  if ("claude_import" in opts) {
    const raw = opts.claude_import
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const o = raw as Record<string, unknown>
      for (const key of Object.keys(o)) {
        if (!KNOWN_CLAUDE_IMPORT_KEYS.has(key)) {
          recordConfigWarning(`unknown claude_import option '${key}' ignored`)
        }
      }
      if ("enabled" in o && typeof o.enabled !== "boolean") {
        recordConfigWarning("claude_import.enabled must be a boolean; using false")
      }
      if ("claude_home" in o && (typeof o.claude_home !== "string" || o.claude_home.length === 0)) {
        recordConfigWarning("claude_import.claude_home must be a non-empty string; using ~/.claude")
      }
      let projects: string[] | undefined
      if ("projects" in o) {
        if (Array.isArray(o.projects) && o.projects.every((p) => typeof p === "string")) {
          projects = (o.projects as string[]).filter((p) => p.length > 0)
        } else {
          recordConfigWarning("claude_import.projects must be an array of strings; ignoring allowlist")
        }
      }
      pluginOptions.claude_import = {
        enabled: o.enabled === true,
        ...(typeof o.claude_home === "string" && o.claude_home.length > 0 ? { claude_home: o.claude_home } : {}),
        ...(projects && projects.length > 0 ? { projects } : {}),
      }
    } else {
      recordConfigWarning("claude_import must be an object like { enabled, claude_home, projects }; ignored")
    }
  }
}

/**
 * codex marks every MCP server as memory-polluting unconditionally
 * (codex-mcp server.rs pollutes_memory: true). opencode registers MCP tools
 * as "<server>_<tool>", so match tool names against the configured server
 * list. Query live status so runtime MCP changes cannot escape pollution
 * marking. Falls back to the web-tools-only check when status is unavailable.
 *
 * Concurrent tool calls coalesce on one in-flight status fetch. Deliberately
 * NOT cached with a TTL: a stale list would miss servers connected
 * mid-session and silently stop marking their calls as polluting, which is
 * the failure this classification exists to prevent. The accepted cost is one
 * status round trip per tool call — bounded to sessions that opt in with
 * disable_on_external_context (off by default), and paid only in
 * tool.execute.before.
 */
async function mcpToolPrefixes(): Promise<string[] | null> {
  if (!pluginClient) return null
  if (!mcpStatusInFlight) {
    mcpStatusInFlight = (async () => {
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const res = await Promise.race([
          hostMcpStatus(pluginClient, controller.signal),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort()
              reject(new Error(`mcp.status timed out after ${MCP_STATUS_TIMEOUT_MS}ms`))
            }, MCP_STATUS_TIMEOUT_MS)
          }),
        ])
        if (!res || res.error) return null
        const servers = res.data
        if (!servers || typeof servers !== "object" || Array.isArray(servers)) return null
        const prefixes: string[] = []
        for (const [server, status] of Object.entries(servers as Record<string, unknown>)) {
          if (!status || typeof status !== "object" || typeof (status as { status?: unknown }).status !== "string") continue
          // Mirrors OpenCode's McpCatalog.sanitize when constructing tool names.
          prefixes.push(server.replace(/[^a-zA-Z0-9_-]/g, "_"))
        }
        return prefixes
      } catch {
        // MCP status unavailable (older OpenCode); keep web-tools-only checks.
        return null
      } finally {
        clearTimeout(timer)
        mcpStatusInFlight = null
      }
    })()
  }
  return mcpStatusInFlight
}

async function classifyExternalContextTool(toolName: string): Promise<boolean | null> {
  if (toolName === "websearch" || toolName === "webfetch") return true
  const prefixes = await mcpToolPrefixes()
  if (prefixes === null) return null
  for (const prefix of prefixes) {
    if (toolName.startsWith(`${prefix}_`)) return true
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
    defs = loadBundledAgentDefinitions()
  } catch (err) {
    console.warn("[opencode-codex-memory] could not load bundled agent definitions:", err)
    return
  }
  // Sub-sessions use directory=memoryRoot (llm.ts), so memory paths are usually
  // in-bounds. Keep an explicit external_directory allow for the memory root as
  // belt-and-suspenders (path is homedir/env-dependent; out-ranks `"*": deny`).
  const memorize = defs["memorize"] as { permission?: Record<string, unknown> } | undefined
  if (memorize?.permission && !("external_directory" in memorize.permission)) {
    memorize.permission["external_directory"] = { [path.join(memoryRoot(), "*")]: "allow" }
  }
  config.agent ??= {}
  for (const [name, def] of Object.entries(defs)) {
    if (!config.agent[name]) config.agent[name] = def
  }
  recordAgentConfig(config, true, defs)
}

function buildHooks() {
  const base = {
  async config(input: { agent?: Record<string, unknown> }): Promise<void> {
    try {
      // The write pipeline is the only consumer of the sub-agents; with
      // generation off they would just pollute the user's agent list.
      if (!pluginOptions.generate_memories) {
        try {
          recordAgentConfig(input, false, loadBundledAgentDefinitions())
        } catch (err) {
          console.warn("[opencode-codex-memory] could not inspect bundled agent definitions:", err)
        }
        return
      }
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
      // OpenCode also invokes this hook while generating agent definitions,
      // without a session. Memory belongs only in real conversation prompts.
      if (!input.sessionID || isMemorySubSession(input.sessionID)) return
      ensureMemoryLayout()
      const memoryPrompt = buildMemorySystemPrompt(pluginOptions.dedicated_tools)
      if (memoryPrompt) {
        output.system.push(memoryPrompt)
      }
    } catch (err) {
      console.error("[opencode-codex-memory] system.transform error:", err)
    }
  },

  /**
   * Fires at text-end, before opencode persists the final part text
   * (session/processor.ts): the returned text replaces the stored one.
   * Primary citation seam — records usage and strips the block so neither
   * the UI nor history ever shows citation markup (matches codex, which
   * strips from the displayed/persisted message). The event and
   * messages.transform paths below stay as fallbacks for older opencode
   * hosts and for history persisted before this hook existed.
   */
  async "experimental.text.complete"(
    input: { sessionID: string; messageID: string; partID: string },
    output: { text: string },
  ): Promise<void> {
    try {
      if (isMemorySubSession(input.sessionID)) return
      if (!output.text.includes("<memory-citation>")) return
      try {
        const ids = extractCitedSessionIds(output.text)
        // Same part key as the event path: whichever hook sees the ids first
        // records them; the other becomes a no-op.
        const fresh = takeNewCitations(`${input.sessionID}:${input.partID}`, ids)
        if (fresh.length > 0) getStore().recordUsage(fresh)
      } catch (e) {
        console.error("[opencode-codex-memory] citation recording failed:", e)
      }
      output.text = stripCitations(output.text)
    } catch (err) {
      console.error("[opencode-codex-memory] text.complete error:", err)
    }
  },

  // Fallback strip for history that still carries citation blocks (messages
  // persisted by plugin versions before the text.complete seam, or hosts
  // without it). Keeps citation markup out of the model-facing transcript.
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

  /**
   * Turn start. codex stamps memory_mode at thread creation (session.rs) and
   * schedules memory work per startup/turn; the first user message is the
   * closest plugin-visible moment. Stamping here (instead of waiting for the
   * first idle) means a session created while generate_memories=false keeps
   * its 'disabled' stamp even if the option flips mid-session, and the
   * phase-1 pump no longer depends on idle events at all. The idle path
   * below stays as a second pump trigger; both are cheap (stamp is INSERT OR
   * IGNORE, the pump is gated by in-flight/rate/claim guards).
   */
  async "chat.message"(input: { sessionID?: string }): Promise<void> {
    try {
      const sid = input?.sessionID
      if (!sid || isMemorySubSession(sid)) return
      if (!markTurnSeen(sid)) return
      try {
        getStore().stampMemoryModeIfAbsent(sid, pluginOptions.generate_memories ? "enabled" : "disabled")
      } catch (e) {
        console.error("[opencode-codex-memory] stampMemoryModeIfAbsent failed:", e)
      }
      trackBackgroundTask(triggerPhase1(sid))
    } catch (err) {
      console.error("[opencode-codex-memory] chat.message error:", err)
    }
  },

  /**
   * Dedicated plugin hook (NOT an event-bus type). Marks the session polluted
   * at INVOCATION, mirroring codex: mcp_tool_call.rs calls
   * maybe_mark_thread_memory_mode_polluted inside handle_approved_mcp_tool_call
   * BEFORE the call runs, and web search marks on the completed response item
   * (stream_events_utils.rs response_item_may_include_external_context).
   *
   * Deliberately not tool.execute.after: opencode does not guarantee that hook
   * (session/tools.ts awaits execute() with no ensuring/catchAll, and an abort
   * interrupts the fiber), so a failed or cancelled websearch/webfetch/MCP call
   * left the session unmarked while its output had already entered the
   * transcript. Marking early over-marks a permission-denied call, which is the
   * safe direction for an opt-in guard.
   *
   * Pollution remains gated by disable_on_external_context, off by default.
   */
  async "tool.execute.before"(input: { tool: string; sessionID: string; callID: string }): Promise<void> {
    try {
      if (!pluginOptions.disable_on_external_context || !input.sessionID) return
      // null = MCP status unavailable; websearch/webfetch still classify true
      // without it, so only MCP-prefixed tools go unmarked.
      if ((await classifyExternalContextTool(input.tool)) !== true) return
      getStore().markPolluted(input.sessionID)
    } catch (err) {
      console.error("[opencode-codex-memory] tool.execute.before error:", err)
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

      // session.idle is deprecated in opencode 1.17 in favor of
      // session.status {type:"idle"}; both are still emitted. Support both so
      // the pipeline keeps triggering when the legacy event disappears.
      if (ev.type === "session.status") {
        const props = ev.properties as { sessionID?: string; status?: { type?: string } }
        if (props?.status?.type === "idle" && props.sessionID) handleSessionIdle(props.sessionID)
        return
      }

      if (ev.type === "session.idle") {
        const props = ev.properties as { sessionID?: string }
        if (props?.sessionID) handleSessionIdle(props.sessionID)
        return
      }
    } catch (err) {
      console.error("[opencode-codex-memory] event error:", err)
    }
  },

  async dispose(): Promise<void> {
    // Stop new pumps, abort the consolidator helper if it is mid-write, and
    // best-effort abort extract sessions so a reload cannot leave two writers.
    beginPluginShutdown()
    try {
      await abortActiveSubSessions()
    } catch (err) {
      console.warn("[opencode-codex-memory] dispose abort of sub-sessions failed:", err)
    }
    invalidateCache()
  },
  }

  function handleSessionIdle(sid: string): void {
    if (isMemorySubSession(sid)) return
    if (!shouldHandleIdle(sid)) return
    // codex stamps memory_mode at thread creation from generate_memories:
    // sessions first seen while generation is off keep that stamp when the
    // option is re-enabled (manual override: the memory_mode tool).
    try {
      getStore().stampMemoryModeIfAbsent(sid, pluginOptions.generate_memories ? "enabled" : "disabled")
    } catch (e) {
      console.error("[opencode-codex-memory] stampMemoryModeIfAbsent failed:", e)
    }
    trackBackgroundTask(triggerPhase1(sid))
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
  if (phase1InFlight || !pluginOptions.generate_memories || isPluginShuttingDown()) return
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
    recordDiagnostic("error", "phase1", err instanceof Error ? err.message : String(err))
  } finally {
    phase1InFlight = false
  }
  trackBackgroundTask(triggerPhase2())
}

async function triggerPhase2(): Promise<void> {
  if (isPluginShuttingDown()) return
  try {
    // runPhase2 has its own in-flight guard
    const result = await runPhase2(getStore(), {
      maxRaw: pluginOptions.max_raw_memories_for_consolidation,
      maxUnusedDays: pluginOptions.max_unused_days,
      extensionRetentionDays: 7,
      consolidationModel: pluginOptions.consolidation_model,
      codexInterop: pluginOptions.codex_interop,
      claudeImport: pluginOptions.claude_import,
    })
    if (result.status !== "already_running" && result.status !== "skipped_cooldown" && result.status !== "skipped_running") {
      recordDiagnostic(
        result.status === "succeeded" || result.status === "no_workspace_changes" ? "info" : "warn",
        "phase2",
        result.status,
      )
    }
  } catch (err) {
    console.error("[opencode-codex-memory] phase2 error:", err)
    recordDiagnostic("error", "phase2", err instanceof Error ? err.message : String(err))
  }
}
