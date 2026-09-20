/**
 * Full write-pipeline live E2E against the official opencode release.
 *
 * XDG sandbox:
 *   read-path → work sessions → real idle → Phase 1 → Phase 2 →
 *   closed-loop injection → citation (soft) → memory_reset
 *
 * Needs: opencode in PATH, `.env` live credentials (API key + OpenAI-compatible
 * base URL + model). Never reads the host OpenCode DB / auth.json.
 * `opencode run` alone is NOT enough for the write path — extraction needs a
 * process that outlives the idle event, so this driver uses `opencode serve`.
 *
 * Flaky points (handled here):
 *   - serve must outlive the extraction pass (not `opencode run`)
 *   - min_rollout_idle_hours 0.01 so work sessions age out on the real clock
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
  api,
  clearPhase2Job,
  createSandbox,
  createSession,
  log,
  memoryDbPath,
  promptSession,
  opencodeVersion,
  requireAuth,
  requireModels,
  whichOpencode,
  sleep,
  sqlAll,
  startServe,
  tail,
  waitFor,
  writeSummary,
  type Sandbox,
  type ServeHandle,
} from "./lib/harness.js"

// Real artifacts + repeated user constraints meet Codex's minimum-signal gate.
// Sketch-only Q&A may correctly produce all-empty extraction output.
const FACTS = [
  {
    title: "e2e-csv-util",
    fact: "E2E_FACT_CSV: built a TypeScript CSV parser returning typed rows under strict mode",
    prompt:
      "Implement src/csv.ts and tests/csv.test.ts using TypeScript and bun:test. Export parseCsv(text: string): string[][], supporting commas, newlines, quoted fields, doubled quotes, and CRLF. Project decision E2E_FACT_CSV: warehouse identifiers such as 000742 must always remain strings with leading zeroes; never infer numbers, trim fields, or silently repair malformed quotes. Throw on unterminated quotes. Add regression tests and run them. Use file/shell tools for this implementation, but do not call memory tools; background learning handles this conversation.",
    followup: "For all future CSV changes in this repo, preserving identifier 000742 exactly is mandatory because our warehouse joins use string keys. Confirm the regression passes with bun test tests/csv.test.ts and report the result. No memory tool calls.",
    artifact: "src/csv.ts",
  },
  {
    title: "e2e-result-type",
    fact: "E2E_FACT_RESULT: refactored error handling to a Result type instead of throwing",
    prompt:
      "Implement src/result.ts and tests/result.test.ts using TypeScript and bun:test. Export Result<T,E> = {ok:true,value:T}|{ok:false,error:E} and parseAmount(text:string): Result<number,string>. Project decision E2E_FACT_RESULT: negative amounts return error code LEDGER_NEGATIVE_AMOUNT, malformed amounts return LEDGER_INVALID_AMOUNT, and callers must never catch exceptions. This is our ledger UI's permanent error contract. Add tests for -1, nonsense, and 42; run them. Use file/shell tools, but no memory tool calls.",
    followup: "Keep LEDGER_NEGATIVE_AMOUNT stable in all future ledger work: our UI translations key off it. Verify parseAmount('-1') returns that error without throwing and run bun test tests/result.test.ts. No memory tool calls.",
    artifact: "src/result.ts",
  },
  {
    title: "e2e-readme",
    fact: "E2E_FACT_README: wrote a README section explaining the two-phase memory plugin",
    prompt:
      "Update README.md with our permanent contribution workflow. Project decision E2E_FACT_README: this repo uses Bun only; run bun test tests/csv.test.ts tests/result.test.ts before every change, preserve CSV string identifiers, and keep ledger error codes stable. Document that the memory plugin uses Phase 1 extraction then Phase 2 consolidation. Read the implementation and run that exact verification command before documenting success. No memory tool calls.",
    followup: "For future work always use the exact targeted Bun test command from README, never substitute npm test. Confirm both CSV and Result tests passed and that README records the command. No memory tool calls.",
    artifact: "README.md",
  },
] as const

type Args = {
  keep: boolean
  skipReset: boolean
  skipCitation: boolean
  memoryVersion: "v1" | "v2"
  dualWrite: boolean
  phase1TimeoutMs: number
  phase2TimeoutMs: number
}

function parseArgs(argv: string[]): Args {
  return {
    keep: argv.includes("--keep") || process.env.OPENCODE_LIVE_KEEP === "1",
    skipReset: argv.includes("--skip-reset"),
    skipCitation: argv.includes("--skip-citation"),
    dualWrite: argv.includes("--dual-write"),
    memoryVersion:
      argv.includes("--version") && argv[argv.indexOf("--version") + 1] === "v2"
        ? "v2"
        : process.env.OPENCODE_LIVE_MEMORY_VERSION === "v2"
          ? "v2"
          : "v1",
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
    rollout_summary: string
    usage_count: number
  }>(
    memoryDbPath(sandbox),
    `SELECT session_id, raw_memory, rollout_summary, usage_count FROM memory_stage1_outputs ORDER BY source_updated_at DESC`,
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
  const bin = whichOpencode()
  log("e2e", `bin ${bin} @ ${opencodeVersion(bin)}`)
  log("e2e", `models model=${models.model} small=${models.smallModel}`)

  const sandbox = createSandbox({
    keep: args.keep,
    model: models.model,
    smallModel: models.smallModel,
    memoryVersion: args.memoryVersion,
    // Extraction/consolidation quality is the point of this suite — pin both
    // to the main model so a tiny small_model cannot no-op every stage1 job.
    pluginOptions: {
      extract_model: models.model,
      consolidation_model: models.model,
      dual_write: args.dualWrite,
    },
  })
  let serve: ServeHandle | null = null
  const shadow: Sandbox = {
    ...sandbox,
    memoryVersion: sandbox.memoryVersion === "v1" ? "v2" : "v1",
    memories: path.join(sandbox.opencodeData, sandbox.memoryVersion === "v1" ? "memories_v2" : "memories"),
  }
  const targets = args.dualWrite ? [sandbox, shadow] : [sandbox]
  let failures = 0
  const check = (ok: boolean, step: string, msg: string) => {
    if (ok) log(step, `OK — ${msg}`)
    else {
      console.error(`[${step}] FAIL — ${msg}`)
      failures++
    }
  }

  try {
    requireAuth()
    writeSummary(sandbox, `${MARKER_LINE}\n`)
    log("e2e", `sandbox ${sandbox.root}`)
    log("e2e", `plugin ${sandbox.pluginFileUrl}`)
    log("e2e", `memory version ${sandbox.memoryVersion} root ${sandbox.memories}`)

    // ----- Step 1: read path -----
    serve = await startServe(sandbox)
    log("read", `serve ${serve.baseUrl}`)
    {
      const sid = await createSession(serve, sandbox, "e2e-read")
      if (serve.v2) {
        const status = await api(serve, sandbox, "POST", "/api/rpc/opencode-codex-memory/status", { input: {} }, {
          "location[directory]": sandbox.project,
        })
        const effective = (status.json as { output?: { extractModel?: string; consolidationModel?: string } })?.output
        if (status.status !== 200 || effective?.extractModel !== models.model || effective.consolidationModel !== models.model) {
          throw new Error(`plugin options not applied: ${status.text}`)
        }
        log("config", "OK — V2 plugin received configured model options")
      }
      const text = await promptSession(
        serve,
        sandbox,
        sid,
        `What do you remember from memory? If you see ${MARKER}, repeat that whole marker line exactly.`,
        { timeoutMs: 300_000 },
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
      const reply = await promptSession(serve, sandbox, sid, f.prompt, { timeoutMs: 300_000 })
      // Second turn so the transcript is more than a single Q&A.
      await promptSession(
        serve,
        sandbox,
        sid,
        f.followup,
        { timeoutMs: 180_000 },
      )
      workIds.push(sid)
      check(fs.existsSync(path.join(sandbox.project, f.artifact)), "work", `${f.artifact} implemented`)
      log("work", `${sid} (${f.title}) reply_len=${reply.length}`)
      await sleep(1500)
    }
    const noteDir = path.join(sandbox.memories, "extensions", "ad_hoc", "notes")
    check(!fs.existsSync(noteDir) || fs.readdirSync(noteDir).length === 0, "work", "ordinary work completed without direct memory notes")

    // ----- Step 3: wait real idle, then trigger -----
    // 0.01h = 36s. Do not forge sqlite timestamps — that would not test
    // OpenCode 2's own session clock.
    const idleMs = 45_000
    log("idle", `waiting ${idleMs}ms for min_rollout_idle_hours=0.01`)
    await sleep(idleMs)
    for (const target of targets) clearPhase2Job(target)
    log("idle", "triggering idle via short session")
    await triggerIdle(serve, sandbox)
    log("idle", `memory.db ${fs.existsSync(memoryDbPath(sandbox)) ? "present" : "missing"}`)

    // ----- Step 4: Phase 1 -----
    log("phase1", `waiting up to ${args.phase1TimeoutMs}ms for stage1 outputs`)
    const phase1Started = Date.now()
    try {
      await waitFor(
        "phase1 outputs",
        () => {
          const rows = stage1Rows(sandbox).filter((r) => workIds.includes(r.session_id))
          if (rows.length > 0) return true
          const jobs = stage1Jobs(sandbox)
          if (!jobs.length && Date.now() - phase1Started > 60_000) throw new Error("no stage1 claims after real idle + trigger")
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

    let rows = stage1Rows(sandbox)
    log("phase1", `${rows.length} stage1 row(s)`)
    check(rows.length >= 1, "phase1", `at least one stage1 row (got ${rows.length})`)

    // Extra triggers if still under-filled (max_rollouts already 8, but rate gate is 30s).
    if (rows.length < 2) {
      log("phase1", "few rows — spacing another trigger pass")
      await sleep(35_000)
      await triggerIdle(serve, sandbox)
      await sleep(15_000)
      rows = stage1Rows(sandbox)
      log("phase1", `${rows.length} stage1 row(s) after extra trigger`)
    }

    const blob = rows.map((r) => `${r.raw_memory}\n${r.rollout_summary}`).join("\n")
    const factHits = FACTS.filter((f) => blob.includes(f.fact.split(":")[0]!))
    if (sandbox.memoryVersion === "v2") {
      const paraphrased = /csv|result type|readme|typed rows|two-phase/i.test(blob)
      check(
        rows.some((r) => (r.rollout_summary ?? "").trim().length > 0),
        "phase1",
        "v2 rows have non-empty rollout_summary",
      )
      check(
        factHits.length >= 1 || paraphrased,
        "phase1",
        factHits.length >= 1
          ? `stage1 summaries mention work facts (${factHits.length}/${FACTS.length} markers)`
          : `stage1 summaries paraphrase work facts (markers=${factHits.length}; v2 may omit E2E_FACT_* ids)`,
      )
    } else {
      check(
        factHits.length >= 1,
        "phase1",
        `stage1 output mentions work facts (${factHits.length}/${FACTS.length} markers)`,
      )
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
          if (job?.status === "done" && sqlAll<{ max_thread_count: number }>(memoryDbPath(sandbox),
            "SELECT max_thread_count FROM consolidation_progress WHERE singleton=1")[0]?.max_thread_count > 0) return true

          const mem = path.join(sandbox.memories, "MEMORY.md")
          const sum = path.join(sandbox.memories, "memory_summary.md")
          const rollouts = path.join(sandbox.memories, "rollout_summaries")
          const hasRollouts =
            fs.existsSync(rollouts) && fs.readdirSync(rollouts).some((f) => f.endsWith(".md"))
          // Progress only — keep waiting for job done so reset is not refused.
          if (!loggedArtifacts && sandbox.memoryVersion === "v1" && fs.existsSync(mem) && hasRollouts) {
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
    if (sandbox.memoryVersion === "v2") {
      check(!fs.existsSync(memoryMd), "phase2", "v2 has no MEMORY.md")
      check(!fs.existsSync(path.join(sandbox.memories, "raw_memories.md")), "phase2", "v2 has no raw_memories.md")
    } else {
      check(fs.existsSync(memoryMd), "phase2", "MEMORY.md exists")
    }
    check(fs.existsSync(summaryMd), "phase2", "memory_summary.md exists")
    const summaryText = fs.existsSync(summaryMd) ? fs.readFileSync(summaryMd, "utf8") : ""
    check(summaryText.length > 0, "phase2", `memory_summary non-empty (${summaryText.length} chars)`)
    check(summaryText.length < 20_000, "phase2", "memory_summary under 20k chars")
    if (sandbox.memoryVersion === "v2") {
      check(summaryText.split(/\r?\n/, 1)[0] === "v1", "phase2", "v2 summary starts with v1")
      for (const heading of ["## User Profile", "## User preferences", "## General Tips", "## What's in Memory"]) {
        check(summaryText.split(/\r?\n/).some((line) => line.trim() === heading), "phase2", `v2 heading ${heading}`)
      }
      check(Buffer.byteLength(summaryText, "utf8") < 10_000, "phase2", "v2 summary under 10k bytes")
    }
    const rolloutFiles = fs.existsSync(rollouts)
      ? fs.readdirSync(rollouts).filter((f) => f.endsWith(".md"))
      : []
    check(rolloutFiles.length >= 1, "phase2", `rollout_summaries has md files (${rolloutFiles.length})`)

    const gitDir = path.join(sandbox.memories, ".git")
    check(fs.existsSync(gitDir), "phase2", "memories/.git baseline present")
    if (serve.v2) {
      const listed = await api(serve, sandbox, "GET", "/api/session", undefined, { search: "codex-memory-consolidate" })
      if (listed.status !== 200) throw new Error(`helper session list failed: ${listed.text}`)
      const helpers = (listed.json as { data: { id: string }[] }).data
      let executed = 0
      for (const helper of helpers) {
        const transcript = await api(serve, sandbox, "GET", `/api/session/${helper.id}/message`, undefined, { limit: "100" })
        if (transcript.status !== 200) throw new Error(`helper transcript failed: ${transcript.text}`)
        for (const message of (transcript.json as { data: any[] }).data) {
          for (const part of message.content ?? []) {
            if (part.type !== "tool" || part.state?.status !== "completed") continue
            const calls = part.state?.metadata?.toolCalls ?? [{ tool: part.name }]
            for (const call of calls) {
              executed++
              if (!["read", "edit", "write", "patch", "glob", "grep"].includes(call.tool)) {
                throw new Error(`consolidator escaped file-tool allowlist: ${call.tool}`)
              }
            }
          }
        }
      }
      check(executed > 0, "sandbox", `consolidator used only file tools (${executed} calls)`)
    }

    // ----- Step 7: closed loop -----
    if (args.dualWrite) {
      await waitFor("shadow pipeline consolidated", () => {
        const job = phase2Job(shadow)
        if (job?.status === "failed") throw new Error(`shadow phase2 failed: ${job.last_error}`)
        const count = sqlAll<{ max_thread_count: number }>(memoryDbPath(shadow),
          "SELECT max_thread_count FROM consolidation_progress WHERE singleton=1")[0]?.max_thread_count ?? 0
        return job?.status === "done" && count > 0
      }, { timeoutMs: args.phase2TimeoutMs, intervalMs: 3000 })
      const shadowRows = stage1Rows(shadow).filter((row) => workIds.includes(row.session_id))
      check(shadowRows.length > 0, "dual", "same work sessions learned in shadow pipeline")
      if (shadow.memoryVersion === "v2") {
        check(shadowRows.every((row) => row.raw_memory === ""), "dual", "V2 extraction remains summary-only")
        check(!fs.existsSync(path.join(shadow.memories, "MEMORY.md")), "dual", "V2 creates no V1 handbook")
      }
      const shadowNotes = path.join(shadow.memories, "extensions/ad_hoc/notes")
      check(!fs.existsSync(shadowNotes) || fs.readdirSync(shadowNotes).length === 0, "dual", "shadow learning came from extraction")
    }
    {
      const sid = await createSession(serve, sandbox, "e2e-closed-loop")
      const text = await promptSession(
        serve,
        sandbox,
        sid,
         "What did we work on in previous sessions in this project? Recall a specific implementation decision from memory; if unknown, say so.",
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
        `Tell me about previous work in this project. Cite memory sources using the required ${serve.v2 ? "fenced memory-citation" : "<memory-citation>"} block at the end if you used memory.`,
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

    // Explicit requests are a second write path. Test only after the automatic
    // extraction loop, so an ad-hoc note cannot make a broken phase 1 look green.
    {
      const noteMarker = `E2E_EXPLICIT_${crypto.randomUUID()}`
      const sid = await createSession(serve, sandbox, "e2e-remember")
      await promptSession(serve, sandbox, sid,
        `Remember this for future sessions: the project deployment label is ${noteMarker}. Save it with memory_add_note, preserving the exact label.`,
      )
      const saved = fs.existsSync(noteDir) && fs.readdirSync(noteDir).some((file) =>
        fs.readFileSync(path.join(noteDir, file), "utf8").includes(noteMarker),
      )
      check(saved, "remember", "explicit remember request persisted a durable note")
    }

    if (args.dualWrite && sandbox.memoryVersion === "v1") {
      // Restart the same isolated host with only the read-version changed.
      // No copying/conversion of memories: V2 must already contain its learning.
      await serve.stop()
      const configFile = path.join(sandbox.configHome, "opencode/opencode.json")
      const config = JSON.parse(fs.readFileSync(configFile, "utf8"))
      config.plugin[0][1].version = "v2"
      config.plugins[0].options.version = "v2"
      fs.writeFileSync(configFile, JSON.stringify(config, null, 2))
      serve = await startServe(sandbox)
      const oldId = workIds[0]!
      const freshId = await createSession(serve, sandbox, "e2e-v2-cutover")
      const reply = await promptSession(serve, sandbox, freshId,
        "What did we work on in previous sessions in this project? Use memory tools to check a relevant recap, recall a specific implementation decision, and cite the recap you read.",
        { timeoutMs: 180_000 })
      check(/000742|leading zero|LEDGER_NEGATIVE_AMOUNT|bun test/i.test(reply), "cutover", "fresh session recalls learned V2 implementation decisions")
      const meta = path.join(sandbox.opencodeData, "memory.db")
      const versions = sqlAll<{ session_id: string; version: string }>(meta,
        "SELECT session_id, version FROM memory_session_versions WHERE session_id IN (?, ?)", [oldId, freshId])
      check(versions.some((row) => row.session_id === oldId && row.version === "v1"), "cutover", "existing session retains V1 namespace")
      check(versions.some((row) => row.session_id === freshId && row.version === "v2"), "cutover", "new session reads V2 namespace")
      check(stage1Rows(shadow).some((row) => row.usage_count > 0), "cutover", "V2 recap citation credited to V2")
      if (serve.v2) {
        const status = await api(serve, sandbox, "POST", "/api/rpc/opencode-codex-memory/status", {
          input: { sessionID: freshId, minConsolidatedThreads: 1 },
        }, { "location[directory]": sandbox.project })
        const state = (status.json as { output?: { v2Ready?: boolean; version?: string } })?.output
        check(state?.v2Ready === true && state.version === "v2", "cutover", "readiness RPC confirms successfully warmed V2")
      }
    }

    // ----- Step 9: reset -----
    if (!args.skipReset) {
      // Belt-and-suspenders: wait out any late consolidator so memory_reset
      // is not refused with "consolidation is currently running".
      await waitFor(
        "phase2 idle before reset",
        () => {
          return targets.every((target) => phase2Job(target)?.status !== "running")
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
      if (args.dualWrite) {
        check(stage1Rows(shadow).length === 0, "reset", "shadow stage1 outputs empty")
        check(!fs.existsSync(shadow.memories) || fs.readdirSync(shadow.memories).length === 0, "reset", "shadow workspace empty")
        const progress = sqlAll<{ max_thread_count: number }>(memoryDbPath(shadow),
          "SELECT max_thread_count FROM consolidation_progress WHERE singleton=1")[0]?.max_thread_count
        check(progress === 0, "reset", "shadow readiness progress reset")
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
