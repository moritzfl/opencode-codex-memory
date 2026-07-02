# Running opencode-memex with a local opencode build

This document describes how to test the plugin end-to-end with a real opencode instance.

## Prerequisites

- Bun 1.1+
- A local clone of https://github.com/sst/opencode (or the opencode-ai/opencode repo)
- `git` in PATH (required for Phase 2 consolidation)

## Step 1 — Build / run opencode from source

```bash
cd /path/to/opencode
bun install
bun run dev          # or the equivalent dev command in that repo
```

Note the `serverUrl` that opencode prints (usually `http://127.0.0.1:4096` or similar). The plugin will use this to spawn sub-agent sessions.

## Step 2 — Link the plugin

Option A — via absolute path in your `~/.config/opencode/opencode.json`:

```json
{
  "plugins": ["/absolute/path/to/opencode-memex"]
}
```

Option B — if you publish the package to a registry or use a workspace link, use the package name `"opencode-memex"`.

## Step 3 — Merge the agent definitions

The plugin ships `opencode.json` with two sub-agents (`memorize`, `memorize-extract`). You must include their permission blocks in your config, otherwise sub-agent creation will fail with "agent not found".

Copy the `agent` section from `opencode-memex/opencode.json` into your config, or merge it.

## Step 4 — Create an initial memory (Stage 0 test)

```bash
mkdir -p ~/.local/share/opencode/memories
cat > ~/.local/share/opencode/memories/memory_summary.md <<'EOF'
User prefers TypeScript strict mode, 2-space indentation, and avoids `any`.
Project root contains `src/`, `tests/`, `AGENTS.md`.
EOF
```

## Step 5 — Start a session and verify injection

1. Start opencode (the TUI or headless).
2. In the first message, ask: "What do you know about my project conventions?"
3. The model should reference the content of `memory_summary.md` (e.g. "You prefer TypeScript strict mode...").

Inspect the system prompt via the TUI debug view or the session history — you should see two system messages: the normal header + the memory block.

## Step 6 — Test tools (Stage 1)

Ask the model:
- "Read MEMORY.md using the memory_read tool."
- "Search for 'TypeScript' using memory_search."
- "Add a note that I like the color blue" (uses `memory_add_note`).

Verify the note appears under `extensions/ad_hoc/notes/`.

## Step 7 — Trigger Phase 1 extraction (Stage 2)

1. Have a few real sessions (with actual work).
2. Wait for the session to become idle, or send a message that triggers `session.idle`.
3. Watch the logs for `[opencode-memex] phase1` messages.
4. After extraction, query the plugin DB:

```bash
sqlite3 ~/.local/share/opencode/memory.db "SELECT session_id, substr(raw_memory,1,80) FROM memory_stage1_outputs;"
```

## Step 8 — Trigger Phase 2 consolidation (Stage 3)

After several Phase 1 outputs exist, Phase 2 should run (subject to 6h cooldown). Check:

- `memories/MEMORY.md` updated
- `memories/memory_summary.md` updated (and under 10k chars)
- `memories/rollout_summaries/` populated
- Git log inside `memories/.git` shows "memex baseline" and "memex consolidated" commits

## Step 9 — Test citation flow

Ask the model a question whose answer is in memory, and instruct it to cite. Example:

> "What are my TypeScript preferences? Please cite the source session."

The model should emit a `<memory-citation>` block. Verify:
- The block is stripped from the final displayed answer.
- `usage_count` in `memory_stage1_outputs` increased for the cited session(s).

## Step 10 — Reset

Call the `memory_reset` tool with `confirm: true`. Verify the memories dir and DB tables are empty, and the next system prompt no longer contains memory content.

## Common failure modes & diagnostics

- **"agent not found" when creating memorize-extract** — You did not merge the agent definitions from the plugin's `opencode.json`.
- **Phase 2 says "skipped_no_git"** — `git` binary not in PATH.
- **Phase 1/2 never run** — The `session.idle` event is not firing, or the current session is excluded (polluted/disabled). Check `memory_session_meta`.
- **Citations not stripped** — The `experimental.chat.messages.transform` hook is not registered (plugin load failure). Check console for `[opencode-memex] messages.transform error`.
- **Sub-agent sessions leak** — If `deleteSession` fails, temporary sessions remain. This is harmless but noisy. The `finally` block logs the error.

## Logging

All plugin errors go to `console.error` with the `[opencode-memex]` prefix. opencode captures plugin stderr.

## Security notes for testing

- Never point the plugin at a real production `opencode.db` with sensitive data during early testing.
- The `memory_reset` tool refuses to run if the memories root is a symlink — this is intentional.
- All external content (websearch/webfetch) marks the session `polluted` and excludes it from extraction.

## Next steps after manual testing

- Add an integration test harness that starts a headless opencode server + the plugin and drives the HTTP API directly.
- Wire real rate-limit information from opencode's provider context once exposed.
- Add `generate_memory` / `extract_model` plugin options.

This document plus the README should be enough for a contributor to reproduce the full pipeline.