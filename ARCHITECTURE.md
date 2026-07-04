# Architecture

`opencode-memex` is a TypeScript port of codex's memory system, packaged as a
standalone opencode plugin (no core changes, no MCP server, no separate process).
This document explains *how the system is shaped and why*, and how to keep it
aligned with upstream codex over time.

For the historical, stage-by-stage build spec see git history
(`implementation-plan.md`, removed once the system was complete).

---

## Staying aligned with codex

The port tracks codex's Rust memory implementation. Alignment is maintained with
two artifacts, not with prose in this file (prose rots — codex already moved
`memories/read/` into `ext/memories/` once):

- **`codex-map.yaml`** — the provenance map. For each source file: which codex
  file it came from, plus the codex commit last audited (`codex_ref`) and the
  set of upstream paths to watch.
- **`scripts/check-codex-drift.sh`** — run it against a local codex checkout to
  see (1) whether any mapped codex file was moved/renamed and (2) what changed in
  codex memory code since `codex_ref`.

```bash
CODEX_REPO=/path/to/codex ./scripts/check-codex-drift.sh
# exit 0 = aligned, 1 = drift (review + port + bump codex_ref), 2 = setup error
```

**Maintenance loop when touching memory behavior:**

1. Read `codex-map.yaml` to find the upstream source for the file you're editing.
2. Run the drift script. If upstream changed, read the diff and port
   intentionally, or record a deliberate divergence in the mapping `note:`.
3. Bump `codex_ref` / `codex_ref_date` once re-audited.

**Design invariant:** memory is **global**. Project/cwd separation exists only as
a soft routing hint inside `consolidation.md` (and the read-path prompt), mirroring
codex exactly. Do **not** add schema-level, read-path, or job-level project
partitioning unless codex does it first.

---

## Architecture overview

```
opencode-memex plugin

READ PATH
  experimental.chat.system.transform hook
    → reads memories/memory_summary.md, truncates to 2500 tokens (chars/4)
    → appends a byte-identical string to system[] every turn (cache-stable)
    → re-reads the file only after Phase 2 rewrites it
  tools: memory_read, memory_search, memory_list, memory_add_note
  event hook: parse <memory-citation> from assistant output
    → record usage_count / last_usage; citations are stripped from
      model-facing history (messages.transform) — opencode owns the display,
      so the strip target is inverted vs codex (see codex-map.yaml)

WRITE PATH
  Phase 1 — per-session extraction (on session.idle)
    read transcript (read-only opencode.db) → filter instructions → redact
    → memorize-extract subagent → store raw_memory + rollout_summary in memory.db
  Phase 2 — global consolidation (singleton, 6h cooldown, lease)
    git baseline diff of memories/ → memorize subagent updates MEMORY.md,
    memory_summary.md, skills/ → reset baseline → invalidate read-path cache

STORAGE
  ~/.local/share/opencode/memory.db        plugin SQLite (stage1 outputs + jobs + session meta)
  ~/.local/share/opencode/memories/        MEMORY.md, memory_summary.md, raw_memories.md,
                                           rollout_summaries/, extensions/, skills/, .git/
  ~/.local/share/opencode/opencode.db      read-only (session transcripts for extraction)
```

Source layout: `src/` holds the pipeline (`source`, `citation`, `db`, `store`,
`capture`, `phase1`, `phase2`, `workspace`, `git-baseline`, `redact`, `token`,
`llm`, `ratelimit`, `paths`, `path-guard`) plus `src/templates/`; `tools/` holds
the model-facing tools (`memory.ts`, `control.ts`). Per-file upstream provenance
lives in `codex-map.yaml`.

---

## Design decisions & workarounds

These explain why the code diverges from a naive port. They are the load-bearing
constraints — read before changing the corresponding subsystem.

### D1 — Prompt cache stability (`src/source.ts`)

opencode's V1 `experimental.chat.system.transform` has no epoch-aware injection;
the system prompt is rebuilt each turn, and codex's V2 `SystemContext.Source` is
not exposed to plugins. **Workaround:** append the *same byte-identical string*
every turn. Provider prompt caches are content-addressed (they key on the byte
prefix), so a stable append stays cache-warm. The plugin caches the summary in
process memory and only re-reads the file when Phase 2 writes a new version.

Limitation: if opencode's own prompt prefix shifts (date, skills, MCP tool set),
the prefix cache misses — same as any plugin hook. Accepted.

### D2 — Consolidation subagent sandboxing (`opencode.json`)

codex uses Seatbelt to block network access; opencode has no process sandbox.
**Workaround:** ship `memorize` / `memorize-extract` subagents with explicit
permission denies (`bash`, `webfetch`, `websearch`, `task` denied;
`read`/`edit`/`write`/`glob`/`grep` allowed). Optionally path-scope writes to the
memories dir. Tool-permission-level, not process-level — accepted trade-off.

### D3 — LLM calls for extraction/consolidation (`src/llm.ts`)

The plugin SDK exposes no "make a model call" API and no provider credentials.
**Workaround:** both phases spawn sub-agent sessions via opencode's HTTP API
(`session.create` + `session.prompt`), reusing opencode's auth/provider/usage
stack with zero credentials in the plugin. This is close to codex's model — codex
also spawns a configured model client for extraction.

### D4 — Retroactive transcript access (`src/capture.ts`)

Phase 1 needs past transcripts; the live message hook only sees current messages.
**Workaround:** read `opencode.db` read-only (`SELECT ... FROM part JOIN message`),
WAL mode makes concurrent reads safe. Couples to opencode's schema; HTTP
`session/history` is the fallback if the schema changes.

### D5 — Separate plugin DB (`src/db.ts`)

The plugin owns `memory.db` (its own schema + migrations) rather than writing to
`opencode.db`, avoiding migration conflicts and any risk to opencode's data. Same
isolation codex uses with its dedicated memories SQLite.

---

## Known gaps vs codex (accepted trade-offs)

| Gap | Codex | This plugin | Mitigation |
|---|---|---|---|
| Network sandbox | Seatbelt | Tool-permission deny on subagents | `memorize*` deny `bash`/`webfetch`/`websearch`/`task` |
| Token counting | tiktoken | chars/4 estimate | Sufficient for the 2500-token cap |
| Cache-stable injection | V2 `SystemContext.Source` | V1 hook + byte-identical append | Content-addressed provider caches (D1) |
| LLM call API | Internal model client | HTTP API → subagent sessions | Reuses opencode auth/usage (D3) |
| Transcript access | Direct DB (own schema) | Read-only `opencode.db`, HTTP fallback | WAL-safe reads (D4) |
| Git baseline | gix / libgit2 | `isomorphic-git` (pure JS) | No external binary; git bundled |
| Hook stability | N/A (core code) | `experimental.*` V1 hooks may deprecate | Migrate to V2 SDK if/when it exposes the seam |
| Rate-limit awareness | Provider rate-limit info | Time-based heuristic stub | See `src/ratelimit.ts`; wire when opencode exposes it |

---

## Codex stability assessment

Codex's memory system is young and still refactoring structurally (as of the
pinned `codex_ref`, `memories/read/` and `ext/memories/` coexist mid-migration).
The **architecture** (two-phase pipeline, citation loop, git baseline, on-disk
artifacts) is stable; **storage layout and module boundaries** still move. The
port copies the architecture, not codex's storage schema, so codex schema changes
don't touch `memory.db`. Prompt/extraction improvements land in template files
that can be updated independently — which is exactly what the drift script surfaces.
