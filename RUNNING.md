# Using opencode-memex with the official opencode release

This plugin is designed to be installed on top of the **official, released opencode** (the one users get from npm / the website). No need to build opencode from source.

## Prerequisites

- Official opencode installed (`npm install -g opencode-ai` or equivalent)
- Bun (for developing / testing the plugin locally)
- `git` in PATH (required for Phase 2)

## Step 1 — Install the plugin

### Option A: Local development / testing (recommended while iterating)

1. Clone this repo and build it:

```bash
cd opencode-memex
bun install
bun run build          # produces dist/ if you add a build step, or just use src/
```

2. Tell opencode to load it by path. In your `~/.config/opencode/opencode.json`:

```json
{
  "plugins": ["/absolute/path/to/opencode-memex"]
}
```

You can also use a relative path if your config is in a known location.

### Option B: Published package (future)

Once published to npm as `opencode-memex`:

```json
{
  "plugins": ["opencode-memex"]
}
```

## Step 2 — Merge the agent definitions (important)

The plugin ships `opencode.json` containing two sub-agents:

- `memorize` — used for Phase 2 consolidation
- `memorize-extract` — used for Phase 1 extraction

These agents have restricted permissions (no bash, no web tools). You **must** include their definitions in your config, otherwise opencode will refuse to create sessions with those agents.

Copy the `agent` section from `opencode-memex/opencode.json` into your own `~/.config/opencode/opencode.json`, or merge it.

Example minimal merge:

```json
{
  "plugins": ["/path/to/opencode-memex"],
  "agent": {
    "memorize": { ... },
    "memorize-extract": { ... }
  }
}
```

## Step 3 — Create an initial memory (Stage 0)

```bash
mkdir -p ~/.local/share/opencode/memories
echo 'User likes TypeScript strict mode and 2-space indentation.' > ~/.local/share/opencode/memories/memory_summary.md
```

## Step 4 — Start opencode and verify the read path

1. Start the official opencode TUI or CLI.
2. In the first turn, ask something like: "What do you know about my coding style?"
3. The model should reference the content of `memory_summary.md`.

If it does not appear:
- Check the console / logs for `[opencode-memex] system.transform error`.
- Verify the plugin was actually loaded (opencode usually logs loaded plugins).
- Make sure `memory_summary.md` is not empty and under ~10k characters.

## Step 5 — Test the tools (Stage 1)

Ask the model to use the tools:

- "Use memory_read to read MEMORY.md"
- "Use memory_search to find mentions of TypeScript"
- "Use memory_add_note to remember that I prefer dark mode"

Check that notes appear under `extensions/ad_hoc/notes/`.

## Step 6 — Trigger automatic extraction (Stage 2)

1. Work in a few normal sessions (not sub-agent sessions).
2. When a session becomes idle, the `session.idle` event fires and the plugin starts Phase 1 in the background.
3. After extraction you should see rows in `memory.db`:

```bash
sqlite3 ~/.local/share/opencode/memory.db \
  "SELECT session_id, substr(raw_memory,1,60) FROM memory_stage1_outputs LIMIT 5;"
```

If nothing appears:
- Check that the session was not marked `polluted` or `disabled`.
- Look for `[opencode-memex] phase1 error` in the logs.
- Verify the `memorize-extract` agent definition exists.

## Step 7 — Trigger consolidation (Stage 3)

After several Phase 1 outputs exist, Phase 2 will eventually run (subject to the 6-hour cooldown). You should see:

- `MEMORY.md` and `memory_summary.md` updated
- `rollout_summaries/` populated
- `memories/.git` containing baseline + consolidated commits

If Phase 2 is skipped:
- "skipped_cooldown" — less than 6h since last success
- "skipped_running" — another Phase 2 is already in progress
- "skipped_no_git" — `git` binary not found

## Step 8 — Citations and usage tracking

When the model uses information from memory, it should emit:

```
<memory-citation>
<citation_entries>session-abc123</citation_entries>
</memory-citation>
```

The plugin strips this block from the displayed output and increments `usage_count` in the database.

## Step 9 — Reset everything

Call the `memory_reset` tool with `confirm: true`. This clears the SQLite tables and wipes the `memories/` directory (except `.git`).

## Common issues when using the official opencode

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Plugin never loads | Wrong path in `plugins` array | Use absolute path, check file permissions |
| "agent not found: memorize" | Agent definitions not merged | Copy `memorize` + `memorize-extract` blocks from the plugin's `opencode.json` |
| No memory injected | `memory_summary.md` missing or empty | Create the file with some content |
| Phase 1 never runs | Current session is polluted/disabled or `session.idle` not firing | Check `memory_session_meta` table |
| Phase 2 fails with git error | `git` not in PATH | Install git or add to PATH |
| Sub-agent sessions stay around | Cleanup failed in `finally` block | Harmless; they are temporary sessions |

## Logging

All plugin errors are logged via `console.error` with the `[opencode-memex]` prefix. The official opencode captures plugin stderr and usually surfaces it in the TUI or logs.

## Security model (production use)

- The two sub-agents have `bash`/`webfetch`/`websearch`/`task` explicitly denied.
- `memory_reset` refuses to run if the memories root is a symlink.
- All secrets are redacted before any LLM call or storage.
- Sessions that used web tools are marked `polluted` and excluded from extraction.

## Next steps

- Once the plugin is stable, publish it to npm as `opencode-memex`.
- Consider adding a small CLI (`opencode-memex init`) that creates the initial `memory_summary.md` and merges the agent config.
- Wire real rate-limit information from opencode's provider hooks when they become available.

This is the intended usage model: official opencode + plugin, no custom builds.