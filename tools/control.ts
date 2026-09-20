import fs from "fs"
import path from "path"
import { tool } from "@opencode-ai/plugin"
import { allMemoryRoots, memoryDbPath, memoryRoot, memorySummaryPath, sessionMetaDbPath, dataRoot, memoryHomeSource } from "../src/paths.js"
import { clearAllVersionMemoryData, MemoryStore, PHASE2_COOLDOWN_MS } from "../src/store.js"
import { invalidateCache } from "../src/source.js"
import { estimateTokens } from "../src/token.js"
import { assertMemoryRootSafe, readRegularFileNoFollow } from "../src/path-guard.js"
import { isPhase2InFlight } from "../src/phase2.js"
import { pluginOptions, getConfigWarnings } from "../src/options.js"
import { codexInteropMtimes, resolveCodexInterop } from "../src/codex-interop.js"
import { claudeImportStatus, resolveClaudeHome } from "../src/claude-import.js"
import {
  formatDiagnosticLine,
  getDiscoveryStatus,
  getRecentDiagnostics,
} from "../src/diagnostics.js"
import { isPluginShuttingDown } from "../src/lifecycle.js"
import { getAgentHealth } from "../src/agent-health.js"
import { activeProviderCapacityBackoffs } from "../src/ratelimit.js"
import { readMigrationStatus, memoryPipelineSnapshots } from "../src/migration.js"
import { peekSessionMemoryVersion } from "../src/session-version.js"
import { withMemoryVersion, writeMemoryVersions } from "../src/memory-version.js"

function isSymlinkedRoot(): boolean {
  for (const root of allMemoryRoots()) {
    try {
      if (fs.lstatSync(root).isSymbolicLink()) return true
    } catch {
      // Missing root is fine.
    }
  }
  return false
}

// Mirrors codex clear_memory_root_contents: deletes EVERY entry including
// .git, so previously deleted/redacted memory content is not recoverable
// from git history after a reset. Deletion errors PROPAGATE — codex bubbles
// every remove failure up, and a swallowed error here would report a
// successful reset while secrets/memories survive on disk. lstat semantics:
// a symlinked entry is unlinked itself, never followed.
function wipeMemoryRoot(root: string): void {
  if (!fs.existsSync(root)) return
  for (const entry of fs.readdirSync(root)) {
    const abs = path.join(root, entry)
    const st = fs.lstatSync(abs)
    if (st.isDirectory()) fs.rmSync(abs, { recursive: true, force: true })
    else fs.unlinkSync(abs)
  }
}

function homeSourceLabel(source: ReturnType<typeof memoryHomeSource>): string {
  switch (source) {
    case "test":
      return "test root"
    case "option":
      return "option"
    case "env":
      return "OPENCODE_CODEX_MEMORY_HOME"
    case "default":
      return "OpenCode data dir"
  }
}

function wipeMemoriesDir(): void {
  for (const root of allMemoryRoots()) wipeMemoryRoot(root)
}

/**
 * Renders the effective (post-parse, post-clamp) plugin options plus any
 * problems recorded while applying them. The plugin never hard-fails on bad
 * configuration and plugin console output is invisible in the TUI, so this
 * block inside memory_inspect is THE place to verify the configuration took
 * effect: typos show up under "config_warnings", wrong values show up as the
 * default appearing instead of the expected one.
 */
function renderEffectiveConfig(): string[] {
  const o = pluginOptions
  const lines = [
    "Effective options:",
    `  generate_memories: ${o.generate_memories}`,
    `  use_memories: ${o.use_memories}`,
    `  version: ${o.version}`,
    `  dual_write: ${o.dual_write}`,
    `  memory_root: ${memoryRoot()}`,
    `  jobs_db: ${memoryDbPath()}`,
    `  session_meta_db: ${sessionMetaDbPath()}`,
    `  dedicated_tools: ${o.dedicated_tools}`,
    `  disable_on_external_context: ${o.disable_on_external_context}`,
    `  extract_model: ${o.extract_model ?? "(unset — opencode small_model, else agent/provider default)"}`,
    `  consolidation_model: ${o.consolidation_model ?? "(unset — opencode model, else agent/provider default)"}`,
    `  max_raw_memories_for_consolidation: ${o.max_raw_memories_for_consolidation}`,
    `  max_unused_days: ${o.max_unused_days}`,
    `  max_rollout_age_days: ${o.max_rollout_age_days}`,
    `  max_rollouts_per_startup: ${o.max_rollouts_per_startup}`,
    `  min_rollout_idle_hours: ${o.min_rollout_idle_hours}`,
    `  home: ${dataRoot()} (${homeSourceLabel(memoryHomeSource())})`,
  ]
  const ci = o.codex_interop
  if (!ci.import && !ci.export) {
    lines.push("  codex_interop: off")
  } else {
    const resolved = withMemoryVersion("v1", () => resolveCodexInterop(ci))
    if (!writeMemoryVersions().includes("v1")) {
      lines.push("  codex_interop: disabled (handbook exchange requires the v1 writer)")
    } else if (!resolved) {
      lines.push(
        `  codex_interop: MISCONFIGURED — the Codex memory root overlaps the plugin memory root (${memoryRoot()}); interop is disabled`,
      )
    } else {
      const reachable = fs.existsSync(resolved.codexMemoryRoot)
      lines.push(
        `  codex_interop: import=${ci.import} export=${ci.export}`,
        `    codex memories: ${resolved.codexMemoryRoot}${reachable ? "" : " (not found yet — nothing is imported/exported until Codex's memory feature creates it)"}`,
      )
      if (reachable) {
        const mt = withMemoryVersion("v1", () => codexInteropMtimes(resolved.codexMemoryRoot))
        const fmt = (ms: number | null) => (ms == null ? "none" : new Date(ms).toISOString())
        lines.push(
          `    last import mtimes: MEMORY.md=${fmt(mt.importMemoryMd)} summary=${fmt(mt.importSummary)}`,
          `    last export mtimes: MEMORY.md=${fmt(mt.exportMemoryMd)} summary=${fmt(mt.exportSummary)}`,
        )
      }
    }
  }
  const cl = o.claude_import
  if (!cl.enabled) {
    lines.push("  claude_import: off")
  } else {
    const home = resolveClaudeHome(cl)
    const reachable = fs.existsSync(home)
    const allow =
      cl.projects && cl.projects.length > 0 ? ` projects=[${cl.projects.join(", ")}]` : " projects=all"
    lines.push(
      `  claude_import: enabled${allow}`,
      `    claude home: ${home}${reachable ? "" : " (not found — nothing imported until Claude Code creates it)"}`,
    )
    const st = claudeImportStatus()
    if (st.extensionPresent) {
      const fmt = (ms: number | null) => (ms == null ? "none" : new Date(ms).toISOString())
      lines.push(
        `    imported projects (${st.projects.length}): ${st.projects.length > 0 ? st.projects.join(", ") : "(none)"}`,
        `    instructions mtime: ${fmt(st.instructionsMtimeMs)}`,
      )
    }
  }
  const warnings = getConfigWarnings()
  lines.push(
    warnings.length > 0 ? `config_warnings (${warnings.length}):` : "config_warnings: none",
    ...warnings.map((w) => `  - ${w}`),
  )
  return lines
}

function listMemoriesDir(): string[] {
  const root = memoryRoot()
  if (!fs.existsSync(root)) return []
  const out: string[] = []
  const walk = (dir: string, prefix: string) => {
    for (const name of fs.readdirSync(dir)) {
      if (name === ".git") continue
      const abs = path.join(dir, name)
      const rel = prefix ? `${prefix}/${name}` : name
      // lstat: report symlinks as entries but never walk THROUGH them —
      // a link to a big/looping directory must not be followed.
      let stat
      try { stat = fs.lstatSync(abs) } catch { continue }
      if (stat.isSymbolicLink()) {
        out.push(`${rel}@`)
      } else if (stat.isDirectory()) {
        out.push(`${rel}/`)
        walk(abs, rel)
      } else {
        out.push(rel)
      }
    }
  }
  walk(root, "")
  return out
}

function renderAgentHealth(): string[] {
  const health = getAgentHealth()
  const lines = [
    `agent_config: ${health.observed ? "observed" : "not observed (config hook has not run)"}`,
    `agent_generation_enabled: ${health.generationEnabled ?? "unknown"}`,
  ]
  for (const name of ["memorize", "memorize-extract"] as const) {
    const entry = health.agents[name]
    lines.push(
      `  agent_${name}: source=${entry.source} status=${entry.healthy ? "healthy" : "degraded"}`,
      ...entry.issues.map((issue) => `    issue: ${issue}`),
    )
  }
  return lines
}

export const memory_reset = tool({
  description:
    "Reset all persistent memory. Wipes the plugin's extracted memories and jobs tables and the entire " +
    "contents of the memories and memories_v2 directories (including git history). Per-session memory modes are preserved, " +
    "so disabled/polluted sessions stay excluded. Refuses to run if a memory root is a symlink.",
  args: {
    confirm: tool.schema.boolean().describe("Must be true to perform the reset."),
  },
  async execute(args) {
    if (!args.confirm) return { output: "Reset aborted: confirm=false." }
    if (isSymlinkedRoot()) {
      return { output: "Reset refused: memory root is a symlink. Remove it manually to be safe." }
    }
    // A consolidation running in THIS process would recreate files right
    // after the wipe (the sub-agent edits live artifacts and resets the git
    // baseline). Refuse instead of racing it. clearMemoryData also leaves a
    // phase-2 cooldown marker so the next idle/chat hook cannot first-run-claim
    // phase 2 and re-seed the root via ensureLayout. Cross-process consolidators
    // already in flight remain ownership-guarded (their final mark becomes a
    // no-op once the row is replaced) but may leave stray files — same window
    // codex has between CLI clear and a running daemon.
    if (isPhase2InFlight()) {
      return { output: "Reset refused: memory consolidation is currently running. Try again in a few minutes." }
    }
    try {
      clearAllVersionMemoryData()
      wipeMemoriesDir()
      // codex keeps its state DB pool open across resets (clear_memory_roots_contents
      // only wipes directories); closing here would strand cached handles elsewhere.
      invalidateCache()
      return { output: "Memory reset complete. Extracted memories and jobs cleared, memories directory (incl. git history) wiped, cache invalidated. Per-session memory modes were preserved." }
    } catch (err) {
      return { output: `memory_reset error: ${(err as Error).message}` }
    }
  },
})

function fmtUnixSec(sec: number | null | undefined): string {
  return sec ? new Date(sec * 1000).toISOString() : "none"
}

function fmtElapsedSec(startedAtSec: number | null | undefined): string {
  if (!startedAtSec) return "unknown"
  const sec = Math.max(0, Math.floor(Date.now() / 1000) - startedAtSec)
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`
}

function fmtWatermarkMs(ms: number | null | undefined): string {
  if (ms === 0) return "0 (no consumed inputs)"
  if (ms === null || ms === undefined) return "none"
  return new Date(ms).toISOString()
}

function phase2NoteLines(phase2: {
  status: string
  last_error: string | null
  finished_at: number | null
}): string[] {
  if (phase2.last_error || phase2.status === "running" || phase2.finished_at == null) return []
  const until = phase2.finished_at + PHASE2_COOLDOWN_MS / 1000
  const now = Math.floor(Date.now() / 1000)
  if (now < until) return [`phase2_note: idle, 6h cooldown until ${fmtUnixSec(until)}`]
  if (phase2.status === "pending") return ["phase2_note: pending, cooldown elapsed"]
  if (phase2.status === "done") return ["phase2_note: idle, cooldown elapsed"]
  return []
}

export const memory_inspect = tool({
  description:
    "Inspect the current memory state. Returns: stage1_outputs count, stage-1 job status " +
    "breakdown, failure classes (backoff / provider_capacity / other_exhausted), recent errors, " +
    "Phase 2 job status (including last error / retry time), " +
    "last discovery outcome, pipeline diagnostics, memory_summary token estimate " +
    "(on-disk; injection caps at ~2500), a listing of the memories directory, the " +
    "effective plugin options, and any configuration warnings. Use it to verify " +
    "configuration and debug why memory is not building. Read-only.",
  args: {
    min_consolidated_threads: tool.schema.number().int().min(1).max(4096).optional()
      .describe("V2 readiness threshold: distinct sessions in a successful consolidation (default 20)."),
  },
  async execute(args, ctx) {
    return withMemoryVersion(peekSessionMemoryVersion(ctx?.sessionID), () => inspect(args, ctx))
  },
})

function inspect(args: { min_consolidated_threads?: number }, ctx?: { sessionID?: string }) {
    try {
      // Refuse to walk/report through a symlinked root (same rule as reset).
      assertMemoryRootSafe()
      const store = new MemoryStore()
      const outputs = store.stage1Outputs()
      const staleBeforeSec = Math.floor(Date.now() / 1000) - pluginOptions.max_rollout_age_days * 86_400
      const stage1Jobs = store.stage1JobSnapshot(staleBeforeSec)
      const summaryPath = memorySummaryPath()
      let summaryChars = 0
      let summaryTokens = 0
      if (fs.existsSync(summaryPath)) {
        const text = readRegularFileNoFollow(summaryPath).content.toString("utf8")
        summaryChars = text.length
        summaryTokens = estimateTokens(text)
      }
      const listing = listMemoriesDir()
      const phase2 = store.phase2JobSnapshot()
      const phase2Lines = phase2
        ? [
            `phase2_status: ${phase2.status}`,
            `phase2_last_error: ${phase2.last_error ?? "none"}`,
            `phase2_started_at: ${fmtUnixSec(phase2.started_at)}`,
            `phase2_running_for: ${phase2.status === "running" ? fmtElapsedSec(phase2.started_at) : "n/a"}`,
            `phase2_lease_until: ${fmtUnixSec(phase2.lease_until)}`,
            `phase2_retry_at: ${fmtUnixSec(phase2.retry_at)}`,
            `phase2_last_attempt_finished_at: ${fmtUnixSec(phase2.finished_at)}`,
            `phase2_last_success_watermark: ${fmtWatermarkMs(phase2.last_success_watermark)}`,
            // Clean-success finish only — never a failure timestamp.
            `phase2_last_success_finished_at: ${fmtUnixSec(phase2.success_finished_at)}`,
            ...phase2NoteLines(phase2),
          ]
        : [
            "phase2_status: none",
            "phase2_last_error: none",
            "phase2_started_at: none",
            "phase2_running_for: n/a",
            "phase2_lease_until: none",
            "phase2_retry_at: none",
            "phase2_last_attempt_finished_at: none",
            "phase2_last_success_watermark: none",
            "phase2_last_success_finished_at: none",
          ]
      const stage1StatusParts = Object.entries(stage1Jobs.by_status)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([s, c]) => `${s}=${c}`)
      const fc = stage1Jobs.by_failure_class
      const failureParts = [
        fc.due > 0 ? `due=${fc.due}` : "",
        fc.backoff > 0 ? `backoff=${fc.backoff}` : "",
        fc.provider_capacity > 0 ? `provider_capacity=${fc.provider_capacity}` : "",
        fc.other_exhausted > 0 ? `other_exhausted=${fc.other_exhausted}` : "",
      ].filter(Boolean)
      const stage1Lines = [
        `stage1_jobs: ${stage1StatusParts.length > 0 ? stage1StatusParts.join(" ") : "none"}`,
        `stage1_failures: ${failureParts.length > 0 ? failureParts.join(" ") : "none"}`,
        ...(stage1Jobs.stale_exhausted > 0
          ? [
              `stage1_stale_exhausted: ${stage1Jobs.stale_exhausted} (older than max_rollout_age_days, will not retry)`,
            ]
          : []),
        ...stage1Jobs.recent_errors.map((e) => {
          const klass = e.failure_class ? `, ${e.failure_class}` : ""
          const retry = e.retry_at ? ` retry_at=${fmtUnixSec(e.retry_at)}` : ""
          return `  stage1_error ${e.session_id} (${e.status}${klass}): ${e.last_error.slice(0, 200)}${retry}`
        }),
      ]
      const discovery = getDiscoveryStatus()
      const discoveryLine = discovery
        ? `discovery: ${discovery.ok ? "ok" : "failed"} count=${discovery.count} at=${new Date(discovery.at).toISOString()}${discovery.error ? ` error=${discovery.error}` : ""} (this process's session list, not total chats)`
        : "discovery: never ran (no phase-1 pass yet this process)"
      const idleHours = pluginOptions.min_rollout_idle_hours
      const eligibilityHint =
        `eligibility: sessions must be idle ≥ ${idleHours}h and younger than ${pluginOptions.max_rollout_age_days}d ` +
        `(generate_memories=${pluginOptions.generate_memories}). ` +
        `For faster local testing, set min_rollout_idle_hours to 1 (clamp floor).`
      const processLines = [
        `phase2_in_flight: ${isPhase2InFlight()}`,
        `plugin_shutting_down: ${isPluginShuttingDown()}`,
      ]
      const capacityBackoffs = activeProviderCapacityBackoffs()
      const capacityLines = capacityBackoffs.length > 0
        ? capacityBackoffs.map((b) => `provider_capacity_backoff ${b.scope}: retry_at=${fmtUnixSec(b.retry_at)}`)
        : ["provider_capacity_backoff: none"]
      const diagnostics = getRecentDiagnostics(12)
      const migration = readMigrationStatus(args.min_consolidated_threads)
      const pipelines = memoryPipelineSnapshots()
      const diagnosticLines =
        diagnostics.length > 0
          ? ["recent_events:", ...diagnostics.map((e) => `  ${formatDiagnosticLine(e)}`)]
          : ["recent_events: none"]
      const out = [
        `stage1_outputs: ${outputs.length}`,
        `read_version: ${peekSessionMemoryVersion(ctx?.sessionID)}`,
        `dual_write: ${pluginOptions.dual_write}`,
        `v2_ready: ${migration.v2Ready}`,
        `v2_consolidated_threads: ${migration.v2ConsolidatedThreads} (minimum ${migration.minConsolidatedThreads})`,
        ...pipelines.map((p) => `pipeline_${p.version}: outputs=${p.stage1Count}, phase2=${p.phase2?.status ?? "none"}, root=${p.root}`),
        ...stage1Lines,
        ...phase2Lines,
        discoveryLine,
        eligibilityHint,
        ...processLines,
        ...capacityLines,
        `memory_summary_chars: ${summaryChars}`,
        `memory_summary_tokens_est: ${summaryTokens} (on disk; injection caps at ~2500)`,
        `memories_dir_entries: ${listing.length}`,
        "",
        ...renderEffectiveConfig(),
        "",
        ...renderAgentHealth(),
        "",
        ...diagnosticLines,
        "",
        "Files:",
        listing.length > 0 ? listing.join("\n") : "(empty)",
      ].join("\n")
      return {
        output: out,
        metadata: {
          stage1_count: outputs.length,
          migration,
          pipelines,
          read_version: peekSessionMemoryVersion(ctx?.sessionID),
          stage1_jobs: stage1Jobs.by_status,
          stage1_failures: stage1Jobs.by_failure_class,
          stage1_stale_exhausted: stage1Jobs.stale_exhausted,
          stage1_recent_errors: stage1Jobs.recent_errors,
          phase2_status: phase2?.status ?? null,
          phase2_last_error: phase2?.last_error ?? null,
          phase2_retry_at: phase2?.retry_at ?? null,
          phase2_last_attempt_finished_at: phase2?.finished_at ?? null,
          phase2_last_success_watermark: phase2?.last_success_watermark ?? null,
          phase2_last_success_finished_at: phase2?.success_finished_at ?? null,
          provider_capacity_backoffs: capacityBackoffs,
          // Back-compat aliases used by earlier inspect consumers.
          phase2_last_finished_at: phase2?.success_finished_at ?? null,
          discovery,
          summary_chars: summaryChars,
          summary_tokens_est: summaryTokens,
          files: listing,
          effective_options: {
            ...pluginOptions,
            codex_interop: { ...pluginOptions.codex_interop },
            claude_import: {
              ...pluginOptions.claude_import,
              ...(pluginOptions.claude_import.projects
                ? { projects: [...pluginOptions.claude_import.projects] }
                : {}),
            },
          },
          config_warnings: [...getConfigWarnings()],
          agent_health: getAgentHealth(),
          recent_events: diagnostics,
        },
      }
    } catch (err) {
      return { output: `memory_inspect error: ${(err as Error).message}` }
    }
}

export const memory_mode = tool({
  description:
    "Set the memory mode for the target session (current session by default). 'enabled' allows Phase 1 extraction. " +
    "'disabled' excludes this session from extraction. 'polluted' marks it as having external context " +
    "(websearch/webfetch) that should not be trusted for memory.",
  args: {
    mode: tool.schema.enum(["enabled", "disabled", "polluted"]).describe("The memory mode to set."),
    sessionId: tool.schema.string().optional().describe("Session ID. Defaults to the current session."),
  },
  async execute(args, ctx) {
    try {
      const store = new MemoryStore()
      const sid = args.sessionId ?? ctx.sessionID
      store.setMemoryMode(sid, args.mode)
      return { output: `Memory mode for session ${sid} set to '${args.mode}'.`, metadata: { sessionId: sid, mode: args.mode } }
    } catch (err) {
      return { output: `memory_mode error: ${(err as Error).message}` }
    }
  },
})
