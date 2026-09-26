/**
 * opencode2 plugin setup.
 *
 * The V1 pipeline (phase1/phase2/capture/llm/…) runs unchanged on top of the
 * V1-client shim (./shim.ts). This module only translates V2 host surfaces
 * into the same calls the V1 hooks made:
 *
 * - prompt hook        → turn-start stamp + phase-1 pump (was chat.message)
 * - context hook       → memory injection (was system.transform) + citation
 *                        record/strip (was text.complete/messages.transform)
 * - tool.execute.before→ external-context pollution mark (unchanged name)
 * - execution.succeeded→ phase-1 pump (was session.status idle/session.idle)
 * - agent.transform    → memorize sub-agent provisioning (was config hook)
 * - tool.transform     → memory tool registration (was returned tool map)
 *
 * Known V2 adaptations (see ARCHITECTURE.md): global session reads use the
 * registered public service; finalized citations are accounted from durable
 * text events and stripped from model-bound context; config documents are
 * adapted for the shared model resolver.
 */
import { ensureMemoryLayout, buildMemorySystemPrompt, invalidateCache } from "../source.js"
import { stripCitations, extractCitedSessionIds, hasCitationMarkup } from "../citation.js"
import { MemoryStore, existingMemoryStores } from "../store.js"
import { runMemoryPipeline, runMemoryConsolidation } from "../pipeline.js"
import { sessionMemoryVersion, withSessionMemoryVersion } from "../session-version.js"
import {
  setPluginInput,
  setSubSessionDirectory,
  cleanupOldSubSessions,
  isMemorySubSession,
  abortActiveSubSessions,
} from "../llm.js"
import { pluginOptions, clearConfigWarnings, resetPluginOptions } from "../options.js"
import { dataRoot } from "../paths.js"
import { closeDb } from "../db.js"
import { beginPluginShutdown, isPluginShuttingDown, resetPluginLifecycle } from "../lifecycle.js"
import { hostMcpStatus } from "../host-client.js"
import { recordDiagnostic } from "../diagnostics.js"
import { resetAgentHealth } from "../agent-health.js"
import { applyPluginOptions, handleSessionDeleted } from "../index.js"
import {
  setV2Context,
  buildV1ClientShim,
  rememberV2Session,
  type V2Context,
} from "./shim.js"
import { ensureV2Agents } from "./agents.js"
import { buildV2Tools } from "./tools.js"
import { performMemoryReset } from "../../tools/control.js"
import { guardMemorySearchTools } from "./search-sandbox.js"
import { MemoryStatusRpc } from "./status-rpc.js"
import { readMemoryStatus } from "./status.js"
import { recordInjection, resetInjectionStats } from "./injection.js"
import { overlayV2CitationInstructions } from "./citation-overlay.js"
import { estimateTokens } from "../token.js"

let shimClient: unknown = null
const backgroundTasks = new Set<Promise<void>>()
const statusListeners = new Set<() => void>()

/**
 * The V2 host runs one plugin instance per location in the same process and
 * evicts idle locations independently. Process-wide state (lifecycle, shim
 * context, panel toggles) belongs to the set of live instances, not to
 * whichever location booted or disposed last.
 */
const liveInstances: V2Context[] = []
type RuntimeOptionKey = "use_memories" | "generate_memories"
/** Panel toggles; survive later location setups until the last instance disposes. */
const runtimeOverrides: Partial<Record<RuntimeOptionKey, boolean>> = {}
const eventLoops = new Set<AbortController>()

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    signal.addEventListener("abort", done, { once: true })
  })
}

// Context hooks fire on every LLM step; each emit makes every open panel
// re-read status. Coalesce bursts.
let statusNotifyTimer: ReturnType<typeof setTimeout> | null = null

function notifyStatusChanged(): void {
  if (statusNotifyTimer) return
  statusNotifyTimer = setTimeout(() => {
    statusNotifyTimer = null
    for (const notify of statusListeners) notify()
  }, 250)
  ;(statusNotifyTimer as { unref?: () => void }).unref?.()
}

function trackBackgroundTask(task: Promise<void>): void {
  const tracked = task.catch((err) => {
    console.error("[opencode-codex-memory] background task error:", err)
  })
  backgroundTasks.add(tracked)
  void tracked.then(() => backgroundTasks.delete(tracked))
}

/** Test seam: wait for hook-launched work to settle. */
export async function waitForV2BackgroundTasks(): Promise<void> {
  while (backgroundTasks.size > 0) {
    await Promise.all([...backgroundTasks])
  }
}

/** Test seam: reset module state between tests. */
export function resetV2ModuleStateForTest(): void {
  statusListeners.clear()
  if (statusNotifyTimer) clearTimeout(statusNotifyTimer)
  statusNotifyTimer = null
  backgroundTasks.clear()
  seenTurnSessions.clear()
  mcpStatusInFlight = null
  liveInstances.length = 0
  for (const loop of eventLoops) loop.abort()
  eventLoops.clear()
  for (const key of Object.keys(runtimeOverrides) as RuntimeOptionKey[]) delete runtimeOverrides[key]
}

function getStore(): MemoryStore {
  return new MemoryStore()
}

function recordV2Citations(sessionId: string, assistantMessageId: string, text: string): void {
  if (!hasCitationMarkup(text)) return
  const ids = extractCitedSessionIds(text)
  if (ids.length > 0) withSessionMemoryVersion(sessionId, () => getStore().recordUsageOnce(sessionId, assistantMessageId, ids))
}

function stripAndReconcileCitations(sessionId: string, messages: any[] | undefined): void {
  for (const msg of messages ?? []) {
    // Model-bound LLM.Message uses role; persisted/legacy rows use type.
    if ((msg?.role ?? msg?.type) !== "assistant" || !Array.isArray(msg.content)) continue
    let emptied = false
    for (const part of msg.content) {
      if (part?.type !== "text" || typeof part.text !== "string") continue
      if (!hasCitationMarkup(part.text)) continue
      try {
        // Context fragments may have no durable id. Inventing one would count
        // the same citation again after text.ended (and after compaction).
        if (typeof msg.id === "string") recordV2Citations(sessionId, msg.id, part.text)
      } catch (e) {
        console.error("[opencode-codex-memory] citation recording failed:", e)
      }
      part.text = stripCitations(part.text)
      if (part.text === "") emptied = true
    }
    // The host drops empty text parts before this hook; some providers reject them.
    if (emptied && msg.content.some((part: any) => part?.type !== "text" || part.text !== "")) {
      for (let i = msg.content.length - 1; i >= 0; i--) {
        if (msg.content[i]?.type === "text" && msg.content[i].text === "") msg.content.splice(i, 1)
      }
    }
  }
}

function sessionIdFromV2Event(data: Record<string, any>): string {
  if (typeof data.sessionID === "string") return data.sessionID
  if (typeof data.info?.id === "string") return data.info.id
  if (typeof data.id === "string") return data.id
  return ""
}

function lruSet<K, V>(map: Map<K, V>, key: K, value: V, max: number): V {
  map.delete(key)
  map.set(key, value)
  if (map.size > max) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
  return value
}

// One stamp+pump per session per process from the prompt hook.
const seenTurnSessions = new Map<string, number>()
const MAX_TRACKED_TURN_SESSIONS = 1000

export function markV2TurnSeen(sessionId: string): boolean {
  const first = seenTurnSessions.get(sessionId)
  lruSet(seenTurnSessions, sessionId, first ?? Date.now(), MAX_TRACKED_TURN_SESSIONS)
  return first === undefined
}

let mcpStatusInFlight: Promise<string[] | null> | null = null
const MCP_STATUS_TIMEOUT_MS = 1_000

async function mcpToolPrefixes(): Promise<string[] | null> {
  if (!shimClient) return null
  if (!mcpStatusInFlight) {
    mcpStatusInFlight = (async () => {
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const res = await Promise.race([
          hostMcpStatus(shimClient as any, controller.signal),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort()
              reject(new Error(`mcp status timed out after ${MCP_STATUS_TIMEOUT_MS}ms`))
            }, MCP_STATUS_TIMEOUT_MS)
          }),
        ])
        if (!res || (res as { error?: unknown }).error) return null
        const servers = (res as { data?: unknown }).data
        if (!servers || typeof servers !== "object" || Array.isArray(servers)) return null
        const prefixes: string[] = []
        for (const [server, status] of Object.entries(servers as Record<string, unknown>)) {
          if (!status || typeof status !== "object" || typeof (status as { status?: unknown }).status !== "string") continue
          prefixes.push(server.replace(/[^a-zA-Z0-9_-]/g, "_"))
        }
        return prefixes
      } catch {
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
    if (toolName.startsWith(`${prefix}_`) || toolName.startsWith(`mcp_${prefix}_`)) return true
  }
  return false
}

function stampAndPump(sid: string, directory?: string | null): void {
  rememberV2Session(sid, directory ?? null)
  try {
    sessionMemoryVersion(sid)
    getStore().stampMemoryModeIfAbsent(sid, pluginOptions.generate_memories ? "enabled" : "disabled")
  } catch (e) {
    console.error("[opencode-codex-memory] stampMemoryModeIfAbsent failed:", e)
  }
  trackBackgroundTask(triggerPhase1(sid))
}

async function triggerPhase1(currentSessionId: string): Promise<void> {
  notifyStatusChanged()
  try {
    await runMemoryPipeline(currentSessionId)
  } finally {
    notifyStatusChanged()
  }
}

async function triggerPhase2(): Promise<string> {
  try {
    return (await runMemoryConsolidation()).join(", ")
  } finally {
    notifyStatusChanged()
  }
}

/** Panel "Consolidate now": one phase-1 pass over idle sessions, then phase 2 without cooldown. */
async function consolidateNow(): Promise<string> {
  notifyStatusChanged()
  try {
    return (await runMemoryPipeline(undefined, true)).join(", ")
  } finally {
    notifyStatusChanged()
  }
}

export async function setup(ctx: V2Context): Promise<(() => void | Promise<void>) | void> {
  // Later locations join a running process: resetting the lifecycle would
  // abort the live consolidator, and resetting stats/health would erase state
  // the other locations still report.
  if (liveInstances.length === 0) {
    resetPluginLifecycle()
    resetInjectionStats()
    resetAgentHealth()
  }
  setV2Context(ctx)
  shimClient = buildV1ClientShim()
  setPluginInput({ client: shimClient } as any)
  setSubSessionDirectory(ctx.location.directory)
  mcpStatusInFlight = null
  clearConfigWarnings()
  const rawOptions = ctx.options as Record<string, unknown> | undefined
  if (rawOptions && Object.keys(rawOptions).length > 0) applyPluginOptions(rawOptions)
  else {
    const previousDb = dataRoot()
    resetPluginOptions()
    if (dataRoot() !== previousDb) closeDb()
  }
  Object.assign(pluginOptions, runtimeOverrides)
  await ensureV2Agents(ctx as any)

  const statusRegistration = await ctx.rpc.register(MemoryStatusRpc, {
    status: async (input: unknown) => {
      const sessionID = (input as { sessionID?: unknown } | undefined)?.sessionID
      const minimum = (input as { minConsolidatedThreads?: number } | undefined)?.minConsolidatedThreads
      return readMemoryStatus(typeof sessionID === "string" ? sessionID : null, minimum)
    },
    setOption: async (input: unknown) => {
      const { key, value } = (input ?? {}) as { key?: unknown; value?: unknown }
      if ((key !== "use_memories" && key !== "generate_memories") || typeof value !== "boolean") return { ok: false }
      const instances = liveInstances.includes(ctx) ? [...liveInstances] : [ctx]
      if (key === "generate_memories" && value && !pluginOptions.generate_memories) {
        pluginOptions.generate_memories = true
        try {
          for (const instance of instances) await ensureV2Agents(instance as any)
        } catch (error) {
          pluginOptions.generate_memories = false
          console.error("[opencode-codex-memory] failed to provision V2 agents while enabling memory:", error)
          return { ok: false }
        }
      }
      const previous = pluginOptions[key]
      pluginOptions[key] = value
      if (key === "use_memories" && value !== previous) {
        // Transforms capture options but the host only replays them after an
        // explicit registry invalidation. Affect future tool snapshots now,
        // in every location.
        const reloaded: V2Context[] = []
        try {
          for (const instance of instances) {
            await instance.tool.reload()
            reloaded.push(instance)
          }
        } catch (error) {
          pluginOptions[key] = previous
          for (const instance of reloaded) await instance.tool.reload().catch(() => {})
          console.error("[opencode-codex-memory] failed to reload V2 memory tools:", error)
          return { ok: false }
        }
      }
      runtimeOverrides[key] = value
      invalidateCache()
      notifyStatusChanged()
      return { ok: true }
    },
    setSessionMode: async (input: unknown) => {
      const { sessionID, mode } = (input ?? {}) as { sessionID?: unknown; mode?: unknown }
      if (typeof sessionID !== "string" || (mode !== "enabled" && mode !== "disabled")) return { ok: false }
      getStore().setMemoryMode(sessionID, mode)
      notifyStatusChanged()
      return { ok: true }
    },
    consolidateNow: async () => {
      // Runs detached so the dialog does not block on a multi-minute turn.
      const run = consolidateNow()
      trackBackgroundTask(run.then(() => {}))
      return { status: "started" }
    },
    resetMemory: async (input: unknown) => {
      if ((input as { confirm?: unknown } | undefined)?.confirm !== true) return { ok: false, message: "Reset not confirmed." }
      const result = performMemoryReset()
      notifyStatusChanged()
      return result
    },
  })
  const publishStatus = () => {
    void statusRegistration.events.emit("changed", {}).catch((err) => {
      console.warn("[opencode-codex-memory] status notification failed:", err)
    })
  }

  await ctx.tool.transform((editor: any) => {
    guardMemorySearchTools(editor, (sessionID) => ctx.session.get({ sessionID } as any))
    for (const t of buildV2Tools()) editor.add(t)
  })

  await ctx.session.hook("prompt", (ev: any) => {
    try {
      const sid = ev?.sessionID
      if (!sid || isMemorySubSession(sid)) return
      if (!markV2TurnSeen(sid)) return
      stampAndPump(sid, ctx.location?.directory)
    } catch (err) {
      console.error("[opencode-codex-memory] v2 prompt hook error:", err)
    }
  })

  const handleModelBoundSession = (ev: any, inject: boolean): void => {
    const sid = ev?.sessionID
    if (!sid || isMemorySubSession(sid)) return
    try {
      stripAndReconcileCitations(sid, ev.messages)
    } catch (e) {
      console.error("[opencode-codex-memory] v2 citation handling failed:", e)
    }
    if (!inject || !pluginOptions.use_memories) return
    const memoryPrompt = withSessionMemoryVersion(sid, () => {
      ensureMemoryLayout()
      return buildMemorySystemPrompt(pluginOptions.dedicated_tools)
    })
    if (!memoryPrompt) return
    const text = overlayV2CitationInstructions(memoryPrompt, sessionMemoryVersion(sid))
    if (!Array.isArray(ev.system)) ev.system = []
    ev.system.push({ type: "text", text })
    recordInjection(sid, estimateTokens(text))
    notifyStatusChanged()
  }

  await ctx.session.hook("context", (ev: any) => {
    try {
      handleModelBoundSession(ev, true)
    } catch (err) {
      console.error("[opencode-codex-memory] v2 context hook error:", err)
    }
  })

  await ctx.session.hook("compaction", (ev: any) => {
    try {
      handleModelBoundSession(ev, false)
    } catch (err) {
      console.error("[opencode-codex-memory] v2 compaction hook error:", err)
    }
  })

  await ctx.session.hook("generate", (ev: any) => {
    try {
      handleModelBoundSession(ev, false)
    } catch (err) {
      console.error("[opencode-codex-memory] v2 generate hook error:", err)
    }
  })

  // Title requests replay history too; citation markup is noise there.
  await ctx.session.hook("title", (ev: any) => {
    try {
      handleModelBoundSession(ev, false)
    } catch (err) {
      console.error("[opencode-codex-memory] v2 title hook error:", err)
    }
  })

  await ctx.tool.hook("execute.before", async (ev: any) => {
    try {
      if (!pluginOptions.disable_on_external_context || !ev?.sessionID) return
      if ((await classifyExternalContextTool(ev.tool)) !== true) return
      getStore().markPolluted(ev.sessionID)
    } catch (err) {
      console.error("[opencode-codex-memory] v2 tool hook error:", err)
    }
  })

  // Bounded reseed before the event loop can see leftover helpers as user sessions.
  await cleanupOldSubSessions()
  try {
    for (const store of existingMemoryStores()) {
      if (store.releaseOrphanedPhase2Job()) {
        console.warn(`[opencode-codex-memory] released orphaned ${store.version} consolidation lease`)
      }
    }
  } catch (err) {
    console.warn("[opencode-codex-memory] orphaned phase2 sweep failed:", err)
  }
  statusListeners.add(publishStatus)

  // Event loop: execution.succeeded pumps phase 1 the way V1's idle events did.
  const eventAbort = new AbortController()
  void (async () => {
    while (!eventAbort.signal.aborted && !isPluginShuttingDown()) {
      try {
        for await (const raw of ctx.event.subscribe({ signal: eventAbort.signal })) {
          const e = raw as { type?: string } & Record<string, any>
          try {
            const data = (e as { data?: Record<string, any> }).data ?? e
            if (e.type === "session.text.ended") {
              const sid = typeof data.sessionID === "string" ? data.sessionID : ""
              const messageId = typeof data.assistantMessageID === "string" ? data.assistantMessageID : ""
              if (sid && messageId && !isMemorySubSession(sid) && typeof data.text === "string") {
                try {
                  recordV2Citations(sid, messageId, data.text)
                } catch (err) {
                  console.error("[opencode-codex-memory] durable citation accounting failed:", err)
                }
              }
            }
            if (e.type === "session.execution.succeeded" || e.type === "session.execution.ended") {
              const sid = sessionIdFromV2Event(data)
              if (sid && !isMemorySubSession(sid)) {
                rememberV2Session(sid, ctx.location?.directory)
                trackBackgroundTask(triggerPhase1(sid))
              }
            }
            if (e.type === "session.deleted") {
              const sid = sessionIdFromV2Event(data)
              if (sid) {
                try {
                  handleSessionDeleted(sid, undefined, () => {
                    if (pluginOptions.generate_memories) trackBackgroundTask(triggerPhase2().then(() => {}))
                  })
                } catch (err) {
                  console.error("[opencode-codex-memory] v2 session.deleted handling failed:", err)
                }
              }
            }
          } catch (err) {
            console.error("[opencode-codex-memory] v2 event handling error:", err)
          }
        }
        // A stream that ends without dispose (host restart of the bus) must
        // not silently stop phase-1 pumps and citation accounting.
        if (eventAbort.signal.aborted || isPluginShuttingDown()) break
      } catch (err) {
        if (eventAbort.signal.aborted || isPluginShuttingDown()) break
        console.error("[opencode-codex-memory] v2 event subscription error:", err)
      }
      await abortableSleep(5000, eventAbort.signal)
    }
  })().catch((err) => console.error("[opencode-codex-memory] v2 event loop error:", err))
    .finally(() => eventLoops.delete(eventAbort))
  eventLoops.add(eventAbort)

  liveInstances.push(ctx)
  return () => {
    statusListeners.delete(publishStatus)
    eventAbort.abort()
    const index = liveInstances.indexOf(ctx)
    if (index >= 0) liveInstances.splice(index, 1)
    const survivor = liveInstances.at(-1)
    if (survivor) {
      // Only the newest location owns the shim; re-point when it leaves.
      if (index === liveInstances.length) {
        setV2Context(survivor)
        setSubSessionDirectory(survivor.location.directory)
      }
      return
    }
    for (const key of Object.keys(runtimeOverrides) as RuntimeOptionKey[]) delete runtimeOverrides[key]
    beginPluginShutdown()
    setSubSessionDirectory()
    setV2Context(null)
    void abortActiveSubSessions().catch((err) => {
      console.warn("[opencode-codex-memory] v2 dispose abort of sub-sessions failed:", err)
    })
    invalidateCache()
  }
}
