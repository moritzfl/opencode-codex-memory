/**
 * Full write-pipeline live E2E against the official opencode release.
 *
 * XDG sandbox:
 *   read-path → work sessions → backdate → Phase 1 → Phase 2 →
 *   closed-loop injection → citation (soft) → memory_reset
 *
 * Needs: opencode in PATH, provider auth, model config. Costs real tokens.
 * `opencode run` alone is NOT enough for the write path — extraction needs a
 * process that outlives the idle event, so this driver uses `opencode serve`.
 *
 * Flaky points (handled here):
 *   - serve must outlive the extraction pass (not `opencode run`)
 *   - sessions backdated past min_rollout_idle_hours (floor 1h)
 *   - max_rollouts_per_startup raised to 8; 30s in-process rate gate
 *   - Phase 2 6h cooldown cleared via job-row delete on fresh DB
 *
 *   bun run live:e2e
 *   OPENCODE_LIVE_KEEP=1 bun run live:e2e
 *   bun run live:e2e -- --skip-reset --skip-citation
 */
import fs from "fs"
import path from "path"
import {
  MARKER,
  MARKER_LINE,
  backdateSessions,
  clearPhase2Job,
  createSandbox,
  createSession,
  log,
  memoryDbPath,
  promptSession,
  requireAuth,
  requireModels,
  sleep,
  sqlAll,
  startServe,
  tail,
  waitFor,
  writeSummary,
  type Sandbox,
  type ServeHandle,
} from "./lib/harness.js"

const FACTS = [
  {
    title: "e2e-csv-util",
    fact: "E2E_FACT_CSV: built a TypeScript CSV parser returning typed rows under strict mode",
    prompt:
      "Remember this project fact for later (repeat it back once): E2E_FACT_CSV: built a TypeScript CSV parser returning typed rows under strict mode. Then briefly sketch the parser API in one short paragraph.",
  },
  {
    title: "e2e-result-type",
    fact: "E2E_FACT_RESULT: refactored error handling to a Result type instead of throwing",
    prompt:
      "Remember this project fact for later (repeat it back once): E2E_FACT_RESULT: refactored error handling to a Result type instead of throwing. Then show a 5-line Result<T,E> sketch.",
  },
  {
    title: "e2e-readme",
    fact: "E2E_FACT_README: wrote a README section explaining the two-phase memory plugin",
    prompt:
      "Remember this project fact for later (repeat it back once): E2E_FACT_README: wrote a README section explaining the two-phase memory plugin. Then write two bullet points for that section.",
  },
] as const

type Args = {
  keep: boolean
  skipReset: boolean
  skipCitation: boolean
  phase1TimeoutMs: number
  phase2TimeoutMs: number
}

function parseArgs(argv: string[]): Args {
  return {
    keep: argv.includes("--keep") || process.env.OPENCODE_LIVE_KEEP === "1",
    skipReset: argv.includes("--skip-reset"),
    skipCitation: argv.includes("--skip-citation"),
    phase1TimeoutMs: numEnv("OPENCODE_LIVE_PHASE1_TIMEOUT_MS", 12 * 60_000),
    phase2TimeoutMs: numEnv("OPENCODE_LIVE_PHASE2_TIMEOUT_MS", 20 * 60_000),
  }
}

function numEnv(name: string, fallback: number): number {
  const v = process.env[name]?.trim()
  if (!v) return fallback
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

async function triggerIdle(serve: ServeHandle, sandbox: Sandbox): Promise<void> {
  const sid = await createSession(serve, sandbox, "e2e-trigger")
  await promptSession(serve, sandbox, sid, "Reply with exactly: ok", { timeoutMs: 120_000 })
}

function stage1Rows(sandbox: Sandbox) {
  return sqlAll<{
    session_id: string
    raw_memory: string
    usage_count: number
  }>(
    memoryDbPath(sandbox),
    `SELECT session_id, raw_memory, usage_count FROM memory_stage1_outputs ORDER BY source_updated_at DESC`,
  )
}

function stage1Jobs(sandbox: Sandbox) {
  return sqlAll<{ job_key: string; status: string; last_error: string | null }>(
    memoryDbPath(sandbox),
    `SELECT job_key, status, last_error FROM memory_jobs WHERE kind='memory_stage1'`,
  )
}

function phase2Job(sandbox: Sandbox) {
  return sqlAll<{ status: string; last_error: string | null; finished_at: number | null }>(
    memoryDbPath(sandbox),
    `SELECT status, last_error, finished_at FROM memory_jobs
     WHERE kind='memory_consolidate_global' AND job_key='global'`,
  )[0]
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const models = requireModels()
  log("e2e", `models model=${models.model} small=${models.smallModel}`)

  const sandbox = createSandbox({
    keep: args.keep,
    model: models.model,
    smallModel: models.smallModel,
    // Extraction/consolidation quality is the point of this suite — pin both
    // to the main model so a tiny small_model cannot no-op every stage1 job.
    pluginOptions: {
      extract_model: models.model,
      consolidation_model: models.model,
    },
  })
  let serve: ServeHandle | null = null
  let failures = 0
  const check = (ok: boolean, step: string, msg: string) => {
    if (ok) log(step, `OK — ${msg}`)
    else {
      console.error(`[${step}] FAIL — ${msg}`)
      failures++
    }
  }

  try {
    requireAuth(sandbox)
    writeSummary(sandbox, `${MARKER_LINE}\n`)
    log("e2e", `sandbox ${sandbox.root}`)
    log("e2e", `plugin ${sandbox.pluginFileUrl}`)

    // ----- Step 1: read path -----
    serve = await startServe(sandbox)
    log("read", `serve ${serve.baseUrl}`)
    {
      const sid = await createSession(serve, sandbox, "e2e-read")
      const text = await promptSession(
        serve,
        sandbox,
        sid,
        `What do you remember from memory? If you see ${MARKER}, repeat that whole marker line exactly.`,
      )
      check(text.includes(MARKER), "read", "memory_summary visible to model")
      if (!text.includes(MARKER)) {
        console.error("model reply:", text.slice(0, 1000))
      }
    }

    // ----- Step 2: work sessions -----
    log("work", `creating ${FACTS.length} substantive sessions`)
    const workIds: string[] = []
    for (const f of FACTS) {
      const sid = await createSession(serve, sandbox, f.title)
      const reply = await promptSession(serve, sandbox, sid, f.prompt, { timeoutMs: 180_000 })
      // Second turn so the transcript is more than a single Q&A.
      await promptSession(
        serve,
        sandbox,
        sid,
        `Confirm you stored the fact containing ${f.fact.split(":")[0]}. One sentence.`,
        { timeoutMs: 120_000 },
      )
      workIds.push(sid)
      log("work", `${sid} (${f.title}) reply_len=${reply.length}`)
      await sleep(1500)
    }

    // ----- Step 3: stop → backdate → restart → trigger -----
    log("idle", "stopping serve to backdate sessions")
    await serve.stop()
    serve = null
    await sleep(500)
    const n = backdateSessions(sandbox, 2)
    log("idle", `backdated ${n} session(s) by 2h`)
    clearPhase2Job(sandbox)

    serve = await startServe(sandbox)
    log("idle", "triggering idle via short session")
    await triggerIdle(serve, sandbox)

    // ----- Step 4: Phase 1 -----
    log("phase1", `waiting up to ${args.phase1TimeoutMs}ms for stage1 outputs`)
    try {
      await waitFor(
        "phase1 outputs",
        () => {
          const rows = stage1Rows(sandbox)
          if (rows.length > 0) return true
          const jobs = stage1Jobs(sandbox)
          const failed = jobs.filter((j) => j.status === "failed" || (j.last_error && j.status !== "done"))
          if (failed.length >= FACTS.length) {
            throw new Error(
              `all stage1 jobs failed: ${failed.map((j) => `${j.job_key}:${j.last_error}`).join("; ")}`,
            )
          }
          // Work sessions finished as selective no-output — fail fast (do not
          // burn the full phase1 timeout waiting for rows that will never come).
          const workDone = workIds.filter((id) =>
            jobs.some((j) => j.job_key === id && j.status === "done"),
          )
          if (workDone.length >= workIds.length && rows.length === 0) {
            throw new Error(
              `all ${workIds.length} work sessions extracted as no-output (model too selective or transcripts empty)`,
            )
          }
          return false
        },
        { timeoutMs: args.phase1TimeoutMs, intervalMs: 3000 },
      )
    } catch (e) {
      const jobs = stage1Jobs(sandbox)
      console.error("stage1 jobs:", JSON.stringify(jobs, null, 2))
      console.error("serve log tail:\n", tail(serve.logPath, 50))
      throw new Error(`phase1: ${e instanceof Error ? e.message : String(e)}`)
    }

    const rows = stage1Rows(sandbox)
    log("phase1", `${rows.length} stage1 row(s)`)
    check(rows.length >= 1, "phase1", `at least one raw_memory row (got ${rows.length})`)

    const blob = rows.map((r) => r.raw_memory).join("\n")
    const factHits = FACTS.filter((f) => blob.includes(f.fact.split(":")[0]!))
    check(
      factHits.length >= 1,
      "phase1",
      `raw_memory mentions work facts (${factHits.length}/${FACTS.length} markers)`,
    )

    // Extra triggers if still under-filled (max_rollouts already 8, but rate gate is 30s).
    if (rows.length < 2) {
      log("phase1", "few rows — spacing another trigger pass")
      await sleep(35_000)
      await triggerIdle(serve, sandbox)
      await sleep(15_000)
    }

    // ----- Step 5: Phase 2 -----
    // Phase 1 already schedules phase 2 after successful extractions. Do NOT
    // clear the job row first — that races a running consolidator.
    // Completion = job status done (not merely artifacts on disk): the
    // consolidator writes MEMORY.md before markPhase2Succeeded, and
    // memory_reset refuses while isPhase2InFlight() is true.
    log("phase2", `waiting up to ${args.phase2TimeoutMs}ms for consolidate`)
    const phase2Started = Date.now()
    let nudged = false
    let loggedArtifacts = false
    try {
      await waitFor(
        "phase2 done",
        () => {
          const job = phase2Job(sandbox)
          if (job?.status === "failed") {
            throw new Error(`phase2 failed: ${job.last_error ?? "unknown"}`)
          }
          if (job?.status === "done") return true

          const mem = path.join(sandbox.memories, "MEMORY.md")
          const sum = path.join(sandbox.memories, "memory_summary.md")
          const rollouts = path.join(sandbox.memories, "rollout_summaries")
          const hasRollouts =
            fs.existsSync(rollouts) && fs.readdirSync(rollouts).some((f) => f.endsWith(".md"))
          // Progress only — keep waiting for job done so reset is not refused.
          if (!loggedArtifacts && fs.existsSync(mem) && hasRollouts) {
            loggedArtifacts = true
            log("phase2", "artifacts present; waiting for job status=done")
          } else if (!loggedArtifacts && fs.existsSync(sum)) {
            const summary = fs.readFileSync(sum, "utf8")
            if (!summary.includes(MARKER) && summary.trim().length > 40 && hasRollouts) {
              loggedArtifacts = true
              log("phase2", "summary rewritten; waiting for job status=done")
            }
          }

          // Nudge once after 90s if no job row appeared (phase1→phase2 chain missed).
          if (!nudged && !job && Date.now() - phase2Started > 90_000) {
            nudged = true
            log("phase2", "no job yet — clearing row + idle nudge")
            clearPhase2Job(sandbox)
            void triggerIdle(serve!, sandbox).catch(() => {})
          }
          return false
        },
        { timeoutMs: args.phase2TimeoutMs, intervalMs: 4000 },
      )
    } catch (e) {
      console.error("phase2 job:", phase2Job(sandbox))
      console.error("memories dir:", fs.existsSync(sandbox.memories) ? fs.readdirSync(sandbox.memories) : [])
      console.error("serve log tail:\n", tail(serve.logPath, 60))
      throw new Error(`phase2: ${e instanceof Error ? e.message : String(e)}`)
    }

    const memoryMd = path.join(sandbox.memories, "MEMORY.md")
    const summaryMd = path.join(sandbox.memories, "memory_summary.md")
    const rollouts = path.join(sandbox.memories, "rollout_summaries")
    check(fs.existsSync(memoryMd), "phase2", "MEMORY.md exists")
    check(fs.existsSync(summaryMd), "phase2", "memory_summary.md exists")
    const summaryText = fs.existsSync(summaryMd) ? fs.readFileSync(summaryMd, "utf8") : ""
    check(summaryText.length > 0, "phase2", `memory_summary non-empty (${summaryText.length} chars)`)
    check(summaryText.length < 20_000, "phase2", "memory_summary under 20k chars")
    const rolloutFiles = fs.existsSync(rollouts)
      ? fs.readdirSync(rollouts).filter((f) => f.endsWith(".md"))
      : []
    check(rolloutFiles.length >= 1, "phase2", `rollout_summaries has md files (${rolloutFiles.length})`)

    const gitDir = path.join(sandbox.memories, ".git")
    check(fs.existsSync(gitDir), "phase2", "memories/.git baseline present")

    // ----- Step 7: closed loop -----
    {
      const sid = await createSession(serve, sandbox, "e2e-closed-loop")
      const text = await promptSession(
        serve,
        sandbox,
        sid,
        "What did we work on in the previous sessions in this test? Be specific about CSV, Result type, or README if you know them.",
        { timeoutMs: 180_000 },
      )
      const hit =
        /csv|result type|readme|two-phase|memory plugin|typed rows/i.test(text) ||
        FACTS.some((f) => text.includes(f.fact.split(":")[0]!))
      check(hit, "loop", "new session sees consolidated memory")
      if (!hit) console.error("closed-loop reply:", text.slice(0, 1500))
    }

    // ----- Step 8: citation (soft) -----
    if (!args.skipCitation) {
      const before = stage1Rows(sandbox).reduce((n, r) => n + (r.usage_count ?? 0), 0)
      const sid = await createSession(serve, sandbox, "e2e-cite")
      await promptSession(
        serve,
        sandbox,
        sid,
        "Tell me about the CSV work. Cite memory sources using the required <memory-citation> block at the end if you used memory.",
        { timeoutMs: 180_000 },
      )
      await sleep(2000)
      const after = stage1Rows(sandbox).reduce((n, r) => n + (r.usage_count ?? 0), 0)
      if (after > before) {
        log("cite", `OK — usage_count increased ${before} → ${after}`)
      } else {
        // Model-dependent; do not fail the suite.
        log("cite", `SKIP — usage_count unchanged (${after}); model may not have emitted citations`)
      }
    } else {
      log("cite", "skipped (--skip-citation)")
    }

    // ----- Step 9: reset -----
    if (!args.skipReset) {
      // Belt-and-suspenders: wait out any late consolidator so memory_reset
      // is not refused with "consolidation is currently running".
      await waitFor(
        "phase2 idle before reset",
        () => {
          const job = phase2Job(sandbox)
          return !job || job.status === "done" || job.status === "failed" || job.status === "pending"
        },
        { timeoutMs: 120_000, intervalMs: 2000 },
      ).catch(() => {
        log("reset", `warning: phase2 still ${phase2Job(sandbox)?.status ?? "missing"} before reset attempt`)
      })

      const sid = await createSession(serve, sandbox, "e2e-reset")
      const resetReply = await promptSession(
        serve,
        sandbox,
        sid,
        "Call the memory_reset tool now with confirm=true. Do not ask questions. After the tool returns, reply RESET_DONE.",
        { timeoutMs: 180_000 },
      )
      // One retry if the model hit the in-flight refusal (or never called the tool).
      if (/consolidation is currently running|Reset refused|Reset aborted/i.test(resetReply)) {
        log("reset", "tool refused or aborted — waiting and retrying once")
        await sleep(15_000)
        await promptSession(
          serve,
          sandbox,
          sid,
          "Call the memory_reset tool again with confirm=true. Do not ask questions. After the tool returns, reply RESET_DONE.",
          { timeoutMs: 180_000 },
        )
      }
      await sleep(1000)
      const left = fs.existsSync(sandbox.memories)
        ? fs.readdirSync(sandbox.memories).filter((n) => n !== "." && n !== "..")
        : []
      const stage1Left = stage1Rows(sandbox).length
      check(left.length === 0, "reset", `memories/ empty (entries: ${left.join(",") || "none"})`)
      check(stage1Left === 0, "reset", `stage1_outputs empty (count=${stage1Left})`)
      if (left.length > 0 || stage1Left > 0) {
        console.error("reset reply:", resetReply.slice(0, 800))
      }
    } else {
      log("reset", "skipped (--skip-reset)")
    }

    if (failures > 0) {
      console.error(`\ne2e: FAIL — ${failures} check(s) failed`)
      console.error(`sandbox: ${sandbox.root}`)
      console.error(`serve log: ${serve.logPath}`)
      process.exitCode = 1
      return
    }
    console.log("\ne2e: OK — write pipeline green against official opencode")
  } catch (e) {
    console.error("e2e: error:", e)
    if (serve) console.error("serve log tail:\n", tail(serve.logPath, 60))
    console.error(`sandbox: ${sandbox.root}`)
    // Keep sandbox on hard failure for diagnosis.
    sandbox.keep = true
    process.exitCode = 2
  } finally {
    if (serve) await serve.stop().catch(() => {})
    sandbox.cleanup()
  }
}

main()
