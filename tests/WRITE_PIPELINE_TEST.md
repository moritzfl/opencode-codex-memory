# Write Pipeline Integration Test (Manual / Agentic)

This document describes a reproducible, step-by-step procedure to exercise the **full write pipeline** (Phase 1 extraction + Phase 2 consolidation) against the official opencode release.

It is intentionally **not** a `bun test` because it requires real user-like sessions and timing. Instead, it is designed to be followed by a human or an agent.

## Prerequisites

- Official opencode 1.17+ installed and in PATH
- This plugin configured in `~/.config/opencode/opencode.json` (path or package
  name). The `memorize`/`memorize-extract` sub-agents register themselves — no
  `agent` block is needed.
- **Recommended: run the whole test in a sandbox** instead of your real
  opencode home. opencode resolves its dirs via XDG env vars, and the plugin's
  data root has its own override, so full isolation (real memories, sessions,
  and config untouched) is:

  ```bash
  SANDBOX=/tmp/memex-live-test
  mkdir -p $SANDBOX/data/opencode/memories $SANDBOX/config/opencode $SANDBOX/cache $SANDBOX/state $SANDBOX/project
  cp ~/.local/share/opencode/auth.json $SANDBOX/data/opencode/auth.json  # provider credentials
  # config: model of your choice + this plugin from the local checkout
  cat > $SANDBOX/config/opencode/opencode.json <<'EOF'
  {
    "model": "<provider/model>",
    "small_model": "<provider/small-model>",
    "plugin": [["file:///absolute/path/to/opencode-memex", { "min_rollout_idle_hours": 1, "max_rollouts_per_startup": 8 }]]
  }
  EOF
  # prefix EVERY opencode/sqlite3 command in this doc with:
  #   env -u OPENCODE -u OPENCODE_PID -u OPENCODE_SERVER_PASSWORD -u OPENCODE_PRINT_LOGS \
  #     XDG_DATA_HOME=$SANDBOX/data XDG_CONFIG_HOME=$SANDBOX/config \
  #     XDG_CACHE_HOME=$SANDBOX/cache XDG_STATE_HOME=$SANDBOX/state \
  #     OPENCODE_CODEX_MEMORY_TEST_ROOT=$SANDBOX/data/opencode
  # and replace ~/.local/share/opencode with $SANDBOX/data/opencode in paths.
  # Delete $SANDBOX afterwards (it contains a copy of auth.json).
  ```

  Sandbox mode makes Step 0's backup and Step 10's restore unnecessary and
  works while other opencode instances are running (they use the real dirs).
  When testing the local checkout via `file://`, run `bun run build` first —
  the plugin entry is `dist/`.
- **Test-friendly plugin options.** The production defaults make the pipeline
  too patient for a same-day test: sessions only become eligible for
  extraction after 6 h idle, and at most 2 are extracted per pass. Configure:

  ```json
  {
    "plugin": [
      ["opencode-codex-memory", { "min_rollout_idle_hours": 1, "max_rollouts_per_startup": 8 }]
    ]
  }
  ```

  1 h is the clamp floor for `min_rollout_idle_hours` — Step 3 explains how to
  backdate sessions instead of waiting.
- Fresh `~/.local/share/opencode/memories/` (recommended: back it up first)
- SQLite CLI (`sqlite3`) available for verification

No `git` binary is needed — git is bundled via `isomorphic-git`.

## Step 0 — Prepare clean state

Quit all running opencode instances first (TUI, web panels, IDE integrations) —
the plugin keeps an open handle on `memory.db`, and a live instance would keep
writing to the deleted file.

```bash
# Optional: back up existing memory
cp -r ~/.local/share/opencode/memories ~/.local/share/opencode/memories.bak

# Wipe for a clean test (include WAL/SHM sidecars or old state can resurrect)
rm -rf ~/.local/share/opencode/memories
rm -f ~/.local/share/opencode/memory.db ~/.local/share/opencode/memory.db-wal ~/.local/share/opencode/memory.db-shm
```

Create the initial summary (Stage 0 baseline):

```bash
mkdir -p ~/.local/share/opencode/memories
echo 'User prefers TypeScript strict mode and 2-space indentation.' > ~/.local/share/opencode/memories/memory_summary.md
```

## Step 1 — Verify read path still works

Run:

```bash
opencode run "What do you know about my coding style?"
```

**Expected:** Model mentions "TypeScript strict mode" and "2-space indentation".

## Step 2 — Create 3–5 real work sessions

Do several short but meaningful sessions. Examples:

**Session A (TypeScript project)**

```bash
opencode run "Create a small TypeScript utility that parses CSV and returns typed rows. Use strict mode."
```

Work with the model on the file, make real edits, then end the session naturally.

**Session B (Bug investigation)**

```bash
opencode run "I have a bug where my Bun test is failing with 'Cannot find module'. Help me debug."
```

**Session C (Refactoring)**

```bash
opencode run "Refactor this function to use a Result type instead of throwing."
```

**Session D (Documentation)**

```bash
opencode run "Write a short README section explaining how the memory plugin works."
```

**Session E (Polluted session — optional)**

Pollution is opt-in (matching codex): set `disable_on_external_context: true`
in the plugin options first, then:

```bash
opencode run "Search the web for the current weather in Berlin and summarize it."
```

With the option on, this session should be marked `polluted` and **excluded**
from extraction (web and MCP tools both count). With the default (`false`),
it stays eligible.

After each session, wait ~10–20 seconds so `updated_at` is distinct.

## Step 3 — Trigger Phase 1 extraction

Two separate conditions must hold, and the doc-follower must arrange both:

1. **An idle event fires in a process that stays alive.** opencode emits it
   whenever a session finishes processing a message — but `opencode run`
   exits immediately after printing the reply, which kills the extraction
   pass mid-flight (verified on 1.17.18: no jobs are even claimed). The
   trigger instance must outlive the pass. Start a persistent server and
   drive the trigger through its API:

   ```bash
   OPENCODE_SERVER_PASSWORD=memex-test opencode serve --port 14096 &
   # basic auth username is "opencode"
   SID=$(curl -s -u "opencode:memex-test" -X POST \
     "http://127.0.0.1:14096/session?directory=$PWD" \
     -H 'Content-Type: application/json' -d '{"title":"trigger session"}' \
     | sed -E 's/.*"id":"(ses_[^"]+)".*/\1/')
   curl -s -u "opencode:memex-test" -X POST \
     "http://127.0.0.1:14096/session/$SID/message" \
     -H 'Content-Type: application/json' \
     -d '{"parts":[{"type":"text","text":"Reply with just: ok"}]}' > /dev/null
   ```

   Leave the server running until phase 2 finishes (Step 5), then kill it.
   (An interactive TUI session going idle works too; the triggering session
   itself is excluded from the pass either way.)

2. **The work sessions are eligible.** A session is only claimed when it has
   been idle for `min_rollout_idle_hours` (≥1 h even in test config). Either
   wait an hour after Step 2, or backdate the sessions — with **all opencode
   instances stopped** (do this before starting the server above):

   ```bash
   sqlite3 ~/.local/share/opencode/opencode.db "
     UPDATE session SET time_updated = time_updated - 2*3600*1000
     WHERE parent_id IS NULL AND title NOT LIKE 'codex-memory-%';
   "
   ```

   (Discovery reads sessions through the server API, which serves them from
   this same database — backdating is visible immediately on next start.)

Successful extraction is **silent** — `[opencode-codex-memory]` log lines
appear only on errors or rate-limit skips, and they go to the server log
(`~/.local/share/opencode/log/opencode.log`), not the terminal. Verify via the
job table instead:

```bash
sqlite3 ~/.local/share/opencode/memory.db "
  SELECT job_key, status, last_error FROM memory_jobs WHERE kind='memory_stage1';
"
```

Notes:

- Consecutive passes are rate-limited to one per 30 s in-process; if you
  trigger repeatedly, space the trivial runs out.
- If a session never gets claimed, check whether it was marked `polluted` or
  `disabled`:

  ```bash
  sqlite3 ~/.local/share/opencode/memory.db "
    SELECT session_id, memory_mode, polluted FROM memory_session_meta;
  "
  ```

## Step 4 — Verify Phase 1 outputs

```bash
sqlite3 ~/.local/share/opencode/memory.db "
  SELECT session_id, substr(raw_memory,1,60) AS preview, usage_count
  FROM memory_stage1_outputs
  ORDER BY source_updated_at DESC
  LIMIT 10;
"
```

**Expected:**
- Rows with non-empty `raw_memory` for the substantive work sessions (with
  the default `max_rollouts_per_startup` of 2 this takes multiple passes —
  the test config from the prerequisites raises it to 8 so one pass covers
  all sessions)
- The extractor legitimately returns no output for thin sessions ("ok"
  triggers, single Q&A turns) — their jobs land on `done` with no row. That
  is correct selectivity, not a failure; if you need more rows, make the
  Step 2 sessions more substantive (multiple concrete edits per session).
- The polluted session (weather) should **not** appear
- `usage_count` starts at 0

## Step 5 — Trigger Phase 2 consolidation

Phase 2 runs automatically after successful Phase 1 extractions, but only if **all** of the following are true:

- No other Phase 2 job is currently running (singleton lock)
- The 6-hour cooldown has passed since the last successful consolidation (first run after a DB wipe **always** proceeds)
- A failed run's retry backoff (1 hour) has elapsed

**How to force a Phase 2 run (useful during testing):**

```bash
sqlite3 ~/.local/share/opencode/memory.db "
  DELETE FROM memory_jobs
  WHERE kind = 'memory_consolidate_global' AND job_key = 'global';
"
```

Then send any message in the project directory to trigger the next `session.idle` → Phase 1 → Phase 2 chain.

Like Phase 1, a successful run is silent (only errors are logged, to
`~/.local/share/opencode/log/opencode.log`). Confirm completion via the job
row — `status` flips to `running` while the consolidation sub-agent works
(it can take a few minutes) and lands on `done`:

```bash
sqlite3 ~/.local/share/opencode/memory.db "
  SELECT status, last_error, finished_at FROM memory_jobs
  WHERE kind = 'memory_consolidate_global';
"
```

Note: consecutive Phase 2 attempts are also rate-limited to one per 5 min
in-process.

## Step 6 — Verify Phase 2 artifacts

```bash
ls -la ~/.local/share/opencode/memories/
cat ~/.local/share/opencode/memories/MEMORY.md | head -30
cat ~/.local/share/opencode/memories/memory_summary.md
ls ~/.local/share/opencode/memories/rollout_summaries/
```

**Expected:**
- `MEMORY.md` contains entries for the sessions you created
- `memory_summary.md` is updated and still under ~10k characters
- `rollout_summaries/` contains `.md` files
- `memories/.git` has exactly **one** commit — the baseline is re-initialized
  after each consolidation so deleted memory content is not retained in git
  history (matching codex)

## Step 7 — Test new memory injection (closed loop)

Start a completely new session:

```bash
opencode run "What did we work on in the previous sessions? Be specific."
```

**Expected:** The model references content that only exists in the newly consolidated memory (e.g. "CSV parser", "Result type refactoring", "memory plugin README").

## Step 8 — Test citation usage tracking

Ask the model:

```bash
opencode run "Tell me about the CSV work we did. Please cite the source session."
```

After the response, check:

```bash
sqlite3 ~/.local/share/opencode/memory.db "
  SELECT session_id, usage_count, last_usage
  FROM memory_stage1_outputs
  WHERE usage_count > 0;
"
```

**Expected:** At least one row now has `usage_count >= 1` and a recent `last_usage` timestamp.

## Step 9 — Test memory_reset

```bash
opencode run "Please reset all memory using the memory_reset tool with confirm=true."
```

Then verify:

```bash
ls ~/.local/share/opencode/memories/
sqlite3 ~/.local/share/opencode/memory.db "SELECT COUNT(*) FROM memory_stage1_outputs;"
```

**Expected:** Directory is completely empty (including `.git` — reset drops git
history so wiped memories are unrecoverable), `memory_stage1_outputs` and
`memory_jobs` are empty, next system prompt contains no memory. Per-session
memory modes (`memory_session_meta`) are intentionally preserved so
disabled/polluted sessions stay excluded after the reset.

## Step 10 — Restore (optional)

```bash
rm -rf ~/.local/share/opencode/memories
mv ~/.local/share/opencode/memories.bak ~/.local/share/opencode/memories
```

## Success criteria

The test passes if:

1. Phase 1 claims all eligible sessions and produces meaningful `raw_memory`
   rows for the substantive ones (thin sessions correctly finish as no-output)
2. Polluted sessions are excluded
3. Phase 2 updates `MEMORY.md` and `memory_summary.md`
4. New sessions see the consolidated memory (closed loop)
5. Citations increment `usage_count`
6. `memory_reset` cleanly wipes everything

## Known flaky points & mitigations

| Flaky point | Why it happens | Mitigation in this document |
|-------------|----------------|-----------------------------|
| Trigger process exits too early | `opencode run` terminates right after the reply; the async extraction pass dies before claiming anything. | Step 3 uses a persistent `opencode serve` driven via curl as the trigger vehicle. |
| Session eligibility window | Sessions must be idle ≥ `min_rollout_idle_hours` (floor 1 h) before extraction claims them. | Test config sets it to 1 h; Step 3 shows how to backdate `time_updated` instead of waiting. |
| Per-pass extraction cap | At most `max_rollouts_per_startup` sessions per pass, plus a 30 s in-process rate gate between passes. | Test config raises the cap to 8; otherwise trigger multiple spaced passes. |
| 6h Phase 2 cooldown | The singleton global job has a hard 6-hour success cooldown (a 1 h retry backoff after failures, and a 5 min in-process gate). | Provide the exact `DELETE` statement to clear the job row so the next idle event will run Phase 2. |
| Failed stage-1 jobs back off | A failed extraction retries after 1 h (3 attempts), so re-triggering immediately does nothing for that session. | Check `last_error` in `memory_jobs`; clear the row to retry immediately. |

These are the only known sources of non-determinism when running the write-pipeline test manually. All other steps are deterministic once the prerequisites are met (git is bundled, so no external binary can be missing).

## Notes for agents

When following this document:
- Be patient with timing.
- Capture the exact log lines containing `[opencode-codex-memory]`.
- If a step fails, note the exact error and the current state of `memory.db` and the `memories/` directory.
- Prefer short, focused sessions (5–15 turns) so transcripts stay readable.

This procedure gives high confidence that the write pipeline works end-to-end on the official opencode release.