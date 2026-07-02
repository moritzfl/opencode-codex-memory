# opencode-memory (opencode-memex)

Persistent memory plugin for opencode — ports codex's closed-loop memory system (extraction → consolidation → injection → citation feedback).

No core changes, no MCP server, no separate process. Install via your `opencode.json`.

## Install

1. Add the plugin to your `opencode.json`:

```json
{
  "plugins": ["opencode-memory"]
}
```

2. The plugin ships its own `opencode.json` with two sub-agents (`memorize`, `memorize-extract`). Merge or copy the agent definitions if your config manager does not auto-merge.

3. Ensure the memory workspace exists (plugin creates it on first use):

```
~/.local/share/opencode/memories/
```

## What it does

- **Read path (Stage 0):** Reads `memories/memory_summary.md` (≤2500 tokens) and appends it to every system prompt via `experimental.chat.system.transform`. Byte-identical across turns → provider cache stable.

- **Tools (Stage 1):** `memory_read`, `memory_search`, `memory_add_note` — model can actively read/search/write notes.

- **Citations:** Model outputs `<memory-citation><citation_entries>session-id,…</citation_entries></memory-citation>`. The plugin strips it from displayed output and records usage counts.

- **Write path (Stage 2–3):** On session idle, Phase 1 extracts past transcripts via the `memorize-extract` subagent and stores `raw_memory` + `rollout_summary` in the plugin's SQLite DB (`memory.db`). Phase 2 (global, 6h cooldown) consolidates via the `memorize` subagent and updates `MEMORY.md` / `memory_summary.md`.

- **Reset/inspect:** `memory_reset`, `memory_inspect`, `memory_mode` tools.

## Memory workspace layout

```
~/.local/share/opencode/memories/
├── MEMORY.md                 # Searchable index (one line per session)
├── memory_summary.md         # Compact summary injected into system prompt (≤10k chars)
├── raw_memories.md           # Merged raw memories (regenerated each Phase 2)
├── rollout_summaries/        # One file per extracted session
├── skills/                   # Reusable procedures discovered across sessions
├── extensions/ad_hoc/notes/  # User-requested notes via memory_add_note
└── .git/                     # Internal baseline for Phase 2 diffing
```

## Config options (future)

Currently no plugin options. Future:
- `generate_memory` (default true)
- `max_rollout_age_days`, `min_rollout_idle_hours`, `max_unused_days`

## Security & sandboxing

- The `memorize` and `memorize-extract` sub-agents have `bash`/`webfetch`/`websearch`/`task` denied.
- `memory_reset` refuses to run if the memory root is a symlink (prevents accidental data loss via symlink attack).
- Secrets are redacted before LLM calls and before storage (OpenAI/Anthropic/AWS/GitHub/Slack keys, bearer tokens, private keys, password assignments).

## Rate limiting

Phase 1/2 check `checkRateLimit()` before spawning extraction/consolidation. Currently a stub that always returns `ok`. Wire to opencode's rate-limit info when exposed.

## Known trade-offs vs codex

| Gap | Codex | This plugin | Mitigation |
|---|---|---|---|
| Process sandbox | Seatbelt (network disabled) | Tool-permission deny on sub-agents | `memorize`/`memorize-extract` deny network tools |
| Token counting | tiktoken | chars/4 estimate | Sufficient for the 2500-token cap |
| V2 SystemContext.Source | Epoch-aware injection | V1 `experimental.chat.system.transform` + byte-identical append | Content-addressed provider caches treat the string as stable |
| LLM call API | Internal model client | HTTP API → `memorize*` subagent sessions | Reuses opencode auth/usage; zero credentials in plugin |
| Transcript access | Direct DB | Read-only `opencode.db` or HTTP API | WAL mode safe; fallback to HTTP if schema changes |
| Git baseline | gix (libgit2) | Shell out to `git` binary | Functionally equivalent |

## Development

```bash
bun install
bun test
bun run typecheck
```

Tests live in `tests/`. Store tests use a temp root via `OPENCODE_MEMEX_TEST_ROOT`.

## License

MIT. Port of codex memory architecture; not affiliated with the codex project.