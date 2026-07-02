# Write Pipeline Integration Test (Manual / Agentic)

This document describes a reproducible, step-by-step procedure to exercise the **full write pipeline** (Phase 1 extraction + Phase 2 consolidation) against the official opencode release.

It is intentionally **not** a `bun test` because it requires real user-like sessions and timing. Instead, it is designed to be followed by a human or an agent.

## Prerequisites

- Official opencode 1.17+ installed and in PATH
- This plugin configured in `~/.config/opencode/opencode.json` (path or package name)
- `git` available
- Fresh `~/.local/share/opencode/memories/` (recommended: back it up first)
- SQLite CLI (`sqlite3`) available for verification

## Step 0 — Prepare clean state

```bash
# Optional: back up existing memory
cp -r ~/.local/share/opencode/memories ~/.local/share/opencode/memories.bak

# Wipe for a clean test
rm -rf ~/.local/share/opencode/memories
rm -f ~/.local/share/opencode/memory.db
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

```bash
opencode run "Search the web for the current weather in Berlin and summarize it."
```

This session should be marked `polluted` and **excluded** from extraction.

After each session, wait ~10–20 seconds so `updated_at` is distinct.

## Step 3 — Trigger Phase 1 extraction

The plugin listens for the `session.idle` event. In practice this fires when:

- The session has been idle for a short period (usually < 30s), **or**
- You send any follow-up message in the same working directory.

**Recommended action:** After finishing a work session, immediately run one trivial follow-up command in the same directory:

```bash
opencode run "ok"
```

This guarantees the `session.idle` event is emitted and Phase 1 is triggered in the background.

Watch the logs (opencode usually prints them to stderr/stdout) for:

```
[opencode-memex] phase1 ...
```

If nothing appears after 30–60 seconds, the current session may have been marked `polluted` or `disabled`. Check with:

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
- At least 3 rows with non-empty `raw_memory`
- The polluted session (weather) should **not** appear
- `usage_count` starts at 0

## Step 5 — Trigger Phase 2 consolidation

Phase 2 runs automatically after successful Phase 1 extractions, but only if **all** of the following are true:

- No other Phase 2 job is currently running (singleton lock)
- The 6-hour cooldown has passed since the last successful consolidation (first run after a DB wipe **always** proceeds)
- `git` binary is available in `$PATH`

**How to force a Phase 2 run (useful during testing):**

```bash
sqlite3 ~/.local/share/opencode/memory.db "
  DELETE FROM memory_jobs
  WHERE kind = 'memory_consolidate_global' AND job_key = 'global';
"
```

Then send any message in the project directory to trigger the next `session.idle` → Phase 1 → Phase 2 chain.

Watch the logs for:

```
[opencode-memex] phase2 ...
```

If you see a warning like:

```
[opencode-memex] git binary not found — Phase 2 consolidation will be disabled
```

then Phase 2 will be skipped for the entire opencode run. Install `git` and restart opencode.

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
- `memories/.git` has at least two commits ("baseline" and "consolidated")

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

**Expected:** Directory is empty (except possibly `.git`), DB tables are empty, next system prompt contains no memory.

## Step 10 — Restore (optional)

```bash
rm -rf ~/.local/share/opencode/memories
mv ~/.local/share/opencode/memories.bak ~/.local/share/opencode/memories
```

## Success criteria

The test passes if:

1. Phase 1 produces ≥3 meaningful `raw_memory` rows
2. Polluted sessions are excluded
3. Phase 2 updates `MEMORY.md` and `memory_summary.md`
4. New sessions see the consolidated memory (closed loop)
5. Citations increment `usage_count`
6. `memory_reset` cleanly wipes everything

## Known flaky points & mitigations

| Flaky point | Why it happens | Mitigation in this document |
|-------------|----------------|-----------------------------|
| Timing of `session.idle` | The event only fires after the session has been idle for a short period. | Explicitly recommend sending `opencode run "ok"` immediately after each work session. |
| 6h Phase 2 cooldown | The singleton global job has a hard 6-hour success cooldown. | Provide the exact `DELETE` statement to clear the job row so the next idle event will run Phase 2. |
| Git not installed | `ensureBaseline()` / `captureWorkspaceDiff()` require the `git` binary. | One-time warning is logged at plugin load. The test document now tells the user to install `git` and restart opencode if the warning appears. |

These three points are the only known sources of non-determinism when running the write-pipeline test manually. All other steps are deterministic once the prerequisites are met.

## Notes for agents

When following this document:
- Be patient with timing.
- Capture the exact log lines containing `[opencode-memex]`.
- If a step fails, note the exact error and the current state of `memory.db` and the `memories/` directory.
- Prefer short, focused sessions (5–15 turns) so transcripts stay readable.

This procedure gives high confidence that the write pipeline works end-to-end on the official opencode release.