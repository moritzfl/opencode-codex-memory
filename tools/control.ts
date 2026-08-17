import fs from "fs"
import path from "path"
import { tool } from "@opencode-ai/plugin"
import { memoryRoot, memorySummaryPath } from "../src/paths.js"
import { MemoryStore } from "../src/store.js"
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

function isSymlinkedRoot(): boolean {
  try {
    assertMemoryRootSafe()
    return false
  } catch {
    return true
  }
}

// Mirrors codex clear_memory_root_contents: deletes EVERY entry including
// .git, so previously deleted/redacted memory content is not recoverable
// from git history after a reset. Deletion errors PROPAGATE — codex bubbles
// every remove failure up, and a swallowed error here would report a
// successful reset while secrets/memories survive on disk. lstat semantics:
// a symlinked entry is unlinked itself, never followed.
function wipeMemoriesDir(): void {
  const root = memoryRoot()
  if (!fs.existsSync(root)) return
  for (const entry of fs.readdirSync(root)) {
    const abs = path.join(root, entry)
    const st = fs.lstatSync(abs)
    if (st.isDirectory()) fs.rmSync(abs, { recursive: true, force: true })
    else fs.unlinkSync(abs)
  }
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
    `  dedicated_tools: ${o.dedicated_tools}`,
    `  disable_on_external_context: ${o.disable_on_external_context}`,
    `  extract_model: ${o.extract_model ?? "(unset — opencode small_model, else agent/provider default)"}`,
    `  consolidation_model: ${o.consolidation_model ?? "(unset — opencode model, else agent/provider default)"}`,
    `  max_raw_memories_for_consolidation: ${o.max_raw_memories_for_consolidation}`,
    `  max_unused_days: ${o.max_unused_days}`,
    `  max_rollout_age_days: ${o.max_rollout_age_days}`,
    `  max_rollouts_per_startup: ${o.max_rollouts_per_startup}`,
    `  min_rollout_idle_hours: ${o.min_rollout_idle_hours}`,
  ]
  const ci = o.codex_interop
  if (!ci.import && !ci.export) {
    lines.push("  codex_interop: off")
  } else {
    const resolved = resolveCodexInterop(ci)
    if (!resolved) {
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
        const mt = codexInteropMtimes(resolved.codexMemoryRoot)
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
    "contents of the memories directory (including git history). Per-session memory modes are preserved, " +
    "so disabled/polluted sessions stay excluded. Refuses to run if the memory root is a symlink.",
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
      const store = new MemoryStore()
      store.clearMemoryData()
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

function fmtWatermarkMs(ms: number | null | undefined): string {
  if (ms === 0) return "0 (no consumed inputs)"
  if (ms === null || ms === undefined) return "none"
  return new Date(ms).toISOString()
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
  args: {},
  async execute() {
    try {
      // Refuse to walk/report through a symlinked root (same rule as reset).
      assertMemoryRootSafe()
      const store = new MemoryStore()
      const outputs = store.stage1Outputs()
      const stage1Jobs = store.stage1JobSnapshot()
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
            `phase2_retry_at: ${fmtUnixSec(phase2.retry_at)}`,
            `phase2_last_attempt_finished_at: ${fmtUnixSec(phase2.finished_at)}`,
            `phase2_last_success_watermark: ${fmtWatermarkMs(phase2.last_success_watermark)}`,
            // Clean-success finish only — never a failure timestamp.
            `phase2_last_success_finished_at: ${fmtUnixSec(phase2.success_finished_at)}`,
          ]
        : [
            "phase2_status: none",
            "phase2_last_error: none",
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
        fc.backoff > 0 ? `backoff=${fc.backoff}` : "",
        fc.provider_capacity > 0 ? `provider_capacity=${fc.provider_capacity}` : "",
        fc.other_exhausted > 0 ? `other_exhausted=${fc.other_exhausted}` : "",
      ].filter(Boolean)
      const stage1Lines = [
        `stage1_jobs: ${stage1StatusParts.length > 0 ? stage1StatusParts.join(" ") : "none"}`,
        `stage1_failures: ${failureParts.length > 0 ? failureParts.join(" ") : "none"}`,
        ...stage1Jobs.recent_errors.map((e) => {
          const klass = e.failure_class ? `, ${e.failure_class}` : ""
          const retry = e.retry_at ? ` retry_at=${fmtUnixSec(e.retry_at)}` : ""
          return `  stage1_error ${e.session_id} (${e.status}${klass}): ${e.last_error.slice(0, 200)}${retry}`
        }),
      ]
      const discovery = getDiscoveryStatus()
      const discoveryLine = discovery
        ? `discovery: ${discovery.ok ? "ok" : "failed"} count=${discovery.count} at=${new Date(discovery.at).toISOString()}${discovery.error ? ` error=${discovery.error}` : ""}`
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
      const diagnostics = getRecentDiagnostics(12)
      const diagnosticLines =
        diagnostics.length > 0
          ? ["recent_events:", ...diagnostics.map((e) => `  ${formatDiagnosticLine(e)}`)]
          : ["recent_events: none"]
      const out = [
        `stage1_outputs: ${outputs.length}`,
        ...stage1Lines,
        ...phase2Lines,
        discoveryLine,
        eligibilityHint,
        ...processLines,
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
          stage1_jobs: stage1Jobs.by_status,
          stage1_failures: stage1Jobs.by_failure_class,
          stage1_recent_errors: stage1Jobs.recent_errors,
          phase2_status: phase2?.status ?? null,
          phase2_last_error: phase2?.last_error ?? null,
          phase2_retry_at: phase2?.retry_at ?? null,
          phase2_last_attempt_finished_at: phase2?.finished_at ?? null,
          phase2_last_success_watermark: phase2?.last_success_watermark ?? null,
          phase2_last_success_finished_at: phase2?.success_finished_at ?? null,
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
  },
})

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
