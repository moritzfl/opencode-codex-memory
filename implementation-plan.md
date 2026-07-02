# OpenCode Memory System — Implementation Plan

> Porting codex's memory system to opencode as a **standalone plugin**, with feature parity, in reviewable stages. No PR to opencode core required.

## TL;DR

A single opencode plugin (`opencode-memory`) that implements codex's closed-loop memory system (read path → write pipeline → citation feedback) using:
- **`experimental.chat.system.transform`** hook for system-prompt injection (read path)
- **`hooks.tool`** for memory read/search/add-note tools
- **`event` + `chat.message`** hooks for session capture and lifecycle triggers
- **Plugin's own SQLite DB** (`~/.local/share/opencode/memory.db`) for stage1 outputs + job/lease queue
- **Read-only access to opencode's `opencode.db`** for retroactive session transcript extraction
- **Custom `memorize` subagent** (defined in shipped `opencode.json`) for sandboxed consolidation

The plugin is installed via `"plugins": ["opencode-memory"]` in the user's `opencode.json`. No core modifications, no MCP server, no separate process.

---

## Architecture overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  opencode-memory plugin                                             │
│                                                                     │
│  READ PATH                                                          │
│    experimental.chat.system.transform hook                          │
│      → reads ~/.local/share/opencode/memories/memory_summary.md     │
│      → truncates to 2500 tokens (chars/4 estimate)                  │
│      → appends byte-identical string to system[] every turn         │
│      → cache-stable (content-addressed provider cache)              │
│      → only re-reads file when Phase 2 writes a new version         │
│                                                                     │
│    hooks.tool: memory_read, memory_search (FTS5), memory_add_note   │
│                                                                     │
│    event hook: parse <memory-citation> from assistant output        │
│      → strip from displayed text                                    │
│      → record usage_count / last_usage in memory.db                 │
│                                                                     │
│  WRITE PATH                                                         │
│    Phase 1: Per-session extraction (background fiber in plugin)     │
│      Trigger: event hook on SessionEvent.Step.Ended                 │
│      Read transcript via:                                           │
│        GET /api/session/:id/history (HTTP API)                      │
│        OR read-only SELECT on opencode.db session_message table     │
│      Filter out AGENTS.md / instruction fragments                   │
│      Redact secrets                                                 │
│      LLM call (own provider credentials or opencode's HTTP API)     │
│      Store raw_memory + rollout_summary in memory.db                │
│                                                                     │
│    Phase 2: Global consolidation                                    │
│      Trigger: after Phase 1 success                                 │
│      Claim singleton global job (6h cooldown, lease)                │
│      git init memories/ dir → capture baseline tree                 │
│      Rebuild raw_memories.md, rollout_summaries/                    │
│      Compute git diff vs baseline                                   │
│      If no changes → succeed                                        │
│      Else: spawn memorize subagent via task tool                    │
│        → agent reads phase2_workspace_diff.md                       │
│        → agent updates MEMORY.md, memory_summary.md, skills/        │
│      Heartbeat lease every 90s                                      │
│      Reset git baseline on success                                  │
│      → plugin's system.transform hook re-reads memory_summary.md    │
│                                                                     │
│  STORAGE                                                            │
│    ~/.local/share/opencode/memory.db     (plugin's SQLite)          │
│      memory_stage1_outputs, memory_jobs                             │
│    ~/.local/share/opencode/memories/     (filesystem artifacts)     │
│      MEMORY.md, memory_summary.md, raw_memories.md                  │
│      rollout_summaries/, extensions/, skills/, .git/                │
│    ~/.local/share/opencode/opencode.db  (read-only access)          │
│      session, session_message (transcripts for extraction)          │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Plugin structure

```
opencode-memory/
├── package.json
├── opencode.json              # Ships memorize subagent config + plugin registration
├── src/
│   ├── index.ts               # Plugin entry: register all hooks + tools
│   ├── db.ts                  # bun:sqlite, opens ~/.local/share/opencode/memory.db
│   ├── store.ts               # MemoryStore: claim/lease/heartbeat, stage1 CRUD, usage
│   ├── source.ts              # system.transform hook: read + inject memory_summary
│   ├── capture.ts             # event + chat.message hooks: session observation capture
│   ├── citation.ts            # Parse <memory-citation> from assistant output, strip, record
│   ├── phase1.ts              # Background extraction: claim jobs, read transcript, LLM call
│   ├── phase2.ts              # Background consolidation: git baseline, diff, spawn subagent
│   ├── workspace.ts           # Filesystem artifact management (raw_memories.md, summaries)
│   ├── git-baseline.ts        # git init/capture/diff in memories/ dir (shells out to git)
│   ├── redact.ts              # Secret redaction before LLM calls and storage
│   ├── token.ts               # Token estimate (chars/4), truncate to budget
│   ├── llm.ts                 # LLM call helper (uses opencode HTTP API or own credentials)
│   └── templates/
│       ├── read_path.md       # System-prompt fragment (adapted from codex)
│       ├── stage_one_system.md
│       └── consolidation.md
├── tools/
│   ├── memory_read.ts         # Tool: read file from memories root
│   ├── memory_search.ts       # Tool: FTS5 search across memories
│   └── memory_add_note.ts     # Tool: add ad-hoc note to extensions/ad_hoc/notes/
└── tests/
    ├── citation.test.ts
    ├── redact.test.ts
    ├── store.test.ts
    └── integration.test.ts
```

---

## What codex has vs what opencode plugin uses

| Codex concept | Codex location | Plugin equivalent | Status |
|---|---|---|---|
| Session transcripts | `~/.codex/sessions/*.jsonl` | Read-only access to `opencode.db` `session_message` table, or `GET /api/session/:id/history` | **Already exists** — accessed read-only |
| SQLite persistence | `~/.codex/memories_1.sqlite` | `~/.local/share/opencode/memory.db` (plugin's own DB) | **Plugin creates** |
| Job/lease queue | `state/memory_migrations/0001_memories.sql:17` | `memory_jobs` table in plugin's DB | **Plugin creates** |
| Stage-1 outputs | `state/memory_migrations/0001_memories.sql:1` | `memory_stage1_outputs` table in plugin's DB | **Plugin creates** |
| Developer prompt injection | `ContextContributor` trait | `experimental.chat.system.transform` hook | **Hook exists** (`plugin/src/index.ts:291`) |
| Memory summary file | `~/.codex/memories/memory_summary.md` | `~/.local/share/opencode/memories/memory_summary.md` | **Plugin creates** |
| Memory read/search tools | `memories/*` tools | `hooks.tool` definitions | **Hook exists** (`plugin/src/index.ts:226`) |
| Config section | `[memories]` in config.toml | Plugin options in `opencode.json` | **Plugin defines** |
| `memory/reset` RPC | app-server v2 | `memory_reset` tool (callable by model/user) | **Plugin provides** |
| Git baseline diff | `git-utils/src/baseline.rs` | Shell out to `git` directly in `git-baseline.ts` | **Plugin implements** |
| Consolidation sub-agent | Ephemeral sandboxed agent | `memorize` subagent in shipped `opencode.json` (deny bash/webfetch/websearch/task) | **Plugin configures** |
| Token counting | tiktoken | `chars / 4` estimate | **Plugin implements** |
| Citation parsing | `<oai-mem-citation>` | `<memory-citation>` parsed in `event` hook | **Plugin implements** |
| Session lifecycle hook | `start_memories_startup_task` | `event` hook (fires on all events, filter for Step.Ended) | **Hook exists** (`plugin/src/index.ts:224`) |
| LLM call for extraction | Internal codex model client | opencode HTTP API (`POST /api/session/:id/prompt`) or direct provider call | **Workaround** (see below) |

---

## Key design decisions and workarounds

### D1: Prompt cache stability (workaround for no V2 SystemContext.Source)

**Problem:** V1's `experimental.chat.system.transform` hook has no epoch-aware injection. The system prompt is rebuilt every turn. The V2 `SystemContext.Source` (which handles cache stability via snapshot comparison) is not exposed to plugins.

**Workaround:** Append the **same byte-identical string every turn**. Provider-side prompt caches (Anthropic, OpenAI) are content-addressed — they key on byte prefix, not on whether a hook mutated the array. The hook mutation itself (calling `.push()`) doesn't invalidate cache.

Implementation:
- Plugin caches `memory_summary.md` content + hash in process memory
- On every `system.transform` call, append the cached string verbatim
- Only re-read the file when Phase 2 consolidation completes (the plugin controls that event — it knows when the file changed)
- Track `lastInjectedHash` per session to skip even reading the file if nothing changed
- The prefix before the plugin's append is opencode's responsibility; if the baseline (env/skills/mcp) changes, that's opencode's cache miss, not the plugin's

**Limitation:** Not the V2 epoch guarantee. The plugin's append is stable, but if opencode's baseline shifts (date change, skill added, MCP tool set changed), the prefix cache misses. This is acceptable — it's the same behavior any plugin hook has.

**Reference:** `packages/opencode/src/session/llm/request.ts:58-78` — the hook fires after the system array is joined into a single string. The plugin appends to `output.system` array. If exactly one string is appended, `system.length === 2` and the `length > 2` re-join branch at line 74 is skipped → two system messages: `[header, pluginString]`. Byte-identical across turns.

### D2: Consolidation sub-agent sandboxing (workaround for no process-level sandbox)

**Problem:** Codex uses Seatbelt to prevent network access. OpenCode has no process-level sandbox. The `task` tool's sub-agent inherits the named agent's permission ruleset, not the caller's.

**Workaround:** Ship a `memorize` agent config in the plugin's `opencode.json` with explicit permission denies:

```json
{
  "agent": {
    "memorize": {
      "mode": "subagent",
      "prompt": "<consolidation system prompt>",
      "permission": {
        "bash": "deny",
        "webfetch": "deny",
        "websearch": "deny",
        "task": "deny",
        "todowrite": "deny",
        "read": "allow",
        "edit": "allow",
        "write": "allow",
        "glob": "allow",
        "grep": "allow"
      }
    }
  }
}
```

The `task` tool (`packages/opencode/src/tool/task.ts:116`) looks up the agent by name. `resolveTools` (`packages/opencode/src/session/llm/request.ts:208`) filters the tool set by the agent's permission ruleset. The consolidation agent gets `read`/`write`/`edit`/`glob`/`grep` but **not** `bash`/`webfetch`/`websearch`/`task`.

This is the same pattern opencode's built-in `explore` agent uses (`packages/opencode/src/agent/agent.ts:196-218` — deny-by-default, allow specific tools).

**Path-scoped writes (optional hardening):** Use pattern rules to restrict writes to the memories directory:
```json
"write": { "~/.local/share/opencode/memories/**": "allow", "*": "deny" },
"edit": { "~/.local/share/opencode/memories/**": "allow", "*": "deny" }
```

**Limitation:** Tool-permission-level, not process-level. If a `read`/`write` tool somehow leaked data, the agent still has host filesystem access. Path-scoped permissions mitigate this. This is an accepted trade-off vs codex's Seatbelt.

**Reference:** `packages/core/src/v1/config/permission.ts:17-36` — permission keys include `bash`, `webfetch`, `websearch`, `task`, `read`, `edit`, `write`, etc. Each accepts `"allow" | "deny" | "ask"` or `Record<string, Action>` for pattern rules.

### D3: LLM calls for extraction (workaround for no plugin LLM API)

**Problem:** Neither V1 nor V2 plugin SDK exposes a "make a model call" API. The `provider` hook only declares models. The `aisdk` V2 hook intercepts model construction but doesn't provide a standalone call API. A plugin doesn't receive provider credentials.

**Workaround — two options:**

**Option A (recommended): Use opencode's HTTP API.** The plugin runs inside the opencode process and has access to `serverUrl` (`packages/plugin/src/index.ts:56-66` — `PluginInput` includes `serverUrl`). The plugin can `POST /api/session/:id/prompt` to create a temporary session with the `memorize` agent and send an extraction prompt. This uses opencode's full auth/provider/usage-tracking stack. The extraction prompt asks the model to return structured JSON `{ raw_memory, rollout_summary, rollout_slug }`.

This means Phase 1 extraction is also done via a sub-agent session (like Phase 2), not a raw LLM call. This is actually closer to how codex works (codex spawns a configured model client for extraction; opencode spawns a sub-agent session).

**Option B: Direct provider HTTP call.** The plugin brings its own API key (configured in plugin options) and calls the provider directly (e.g. `fetch("https://api.anthropic.com/v1/messages", ...)`). Feasible but bypasses opencode's auth, usage tracking, and provider routing. Only use if Option A has unacceptable overhead.

**Chosen approach:** Option A. Both Phase 1 extraction and Phase 2 consolidation spawn sub-agent sessions via the HTTP API. Phase 1 uses a lightweight `memorize-extract` agent (reasoning low, limited steps). Phase 2 uses the `memorize` consolidation agent. This reuses opencode's entire LLM stack and needs zero credentials in the plugin.

### D4: Retroactive session transcript access (read-only SQLite or HTTP API)

**Problem:** The plugin needs to read past session transcripts for Phase 1 extraction. The `chat.message` hook only captures messages as they happen.

**Workaround — two options:**

**Option A: HTTP API.** `GET /api/session/:sessionID/history` (`packages/protocol/src/groups/session.ts:307`) returns durable session events. Use `GET /api/session` (or `session.list`) to enumerate sessions. Clean, versioned, no schema coupling.

**Option B: Read-only SQLite.** Open `~/.local/share/opencode/opencode.db` with `readonly: true` via `bun:sqlite`. WAL mode allows concurrent readers — no corruption risk, no lock contention. Query `session_message` directly: `SELECT data FROM session_message WHERE session_id = ? ORDER BY seq`. Faster, no pagination, but couples to opencode's schema.

**Chosen approach:** Option B for transcripts (fast, simple query), with Option A as fallback if schema changes. The plugin detects the opencode version and adapts the query. Read-only access is safe — WAL guarantees no interference with opencode's writes.

### D5: Plugin's own SQLite DB (separate from opencode.db)

The plugin creates `~/.local/share/opencode/memory.db` with its own schema. This avoids:
- Migration conflicts with opencode's migration system
- Coupling to opencode's Drizzle schema definitions
- Any risk of corrupting opencode's data

The DB is opened with `bun:sqlite` (or `better-sqlite3` on Node), WAL mode, and contains `memory_stage1_outputs` + `memory_jobs` tables. The plugin manages its own migrations (simple version table).

---

## opencode.json shipped by the plugin

The plugin ships an `opencode.json` that users include (or the plugin installer merges):

```json
{
  "plugins": ["opencode-memory"],
  "agent": {
    "memorize": {
      "mode": "subagent",
      "prompt": "You are a memory consolidation agent. Read the workspace diff file and update MEMORY.md, memory_summary.md, and skills/ to reflect the latest memories. Keep memory_summary.md under 2500 tokens (10000 chars). Prune stale entries. Do not access the network.",
      "permission": {
        "bash": "deny",
        "webfetch": "deny",
        "websearch": "deny",
        "task": "deny",
        "todowrite": "deny",
        "read": "allow",
        "edit": "allow",
        "write": "allow",
        "glob": "allow",
        "grep": "allow"
      }
    },
    "memorize-extract": {
      "mode": "subagent",
      "prompt": "You are a memory extraction agent. Read the session transcript and extract raw_memory, rollout_summary, and rollout_slug as JSON. Exclude AGENTS.md/instruction content. Redact secrets.",
      "permission": {
        "bash": "deny",
        "webfetch": "deny",
        "websearch": "deny",
        "task": "deny",
        "todowrite": "deny",
        "read": "allow",
        "write": "deny",
        "edit": "deny",
        "glob": "allow",
        "grep": "allow"
      }
    }
  }
}
```

---

## Stage 0 — Read path MVP (manual memory)

**Goal:** A user can write `~/.local/share/opencode/memories/memory_summary.md` by hand, and it gets injected into the system prompt on every turn. No write pipeline, no tools, no SQLite. This proves the injection seam works.

**Milestone:** Start a session, write a memory file, verify it appears in the system prompt and the model references it.

### Tasks

1. **Plugin scaffold: `src/index.ts`**
   - Export plugin definition with `experimental.chat.system.transform` hook
   - Plugin receives `{ serverUrl, directory, project }` via `PluginInput` (`packages/plugin/src/index.ts:56-66`)

2. **Memory root + file reading: `src/source.ts`**
   - `memoryRoot()` → `path.join(os.homedir(), ".local", "share", "opencode", "memories")`
   - Read `memory_summary.md`, truncate to 2500 tokens (10,000 chars via chars/4 estimate)
   - Cache content + hash in process memory; only re-read when file mtime changes
   - If file missing or empty → skip injection (no-op)

3. **System prompt injection: `experimental.chat.system.transform` hook**
   - Hook receives `{ sessionID, model }` and `{ system: string[] }`
   - Read cached memory summary (or re-read if mtime changed)
   - Render `templates/read_path.md` with `{{ base_path }}` and `{{ memory_summary }}`
   - `output.system.push(renderedString)` — append one string
   - Byte-identical across turns when summary unchanged → cache-stable

4. **Template: `src/templates/read_path.md`**
   - Adapted from `codex-rs/memories/read/templates/memories/read_path.md`
   - Describes memory folder layout, quick memory pass decision logic, citation format

5. **Ensure layout**
   - `mkdir -p` the memories root on plugin init if it doesn't exist
   - Graceful no-op if `memory_summary.md` is missing

### Files
- `src/index.ts` (new) — plugin entry
- `src/source.ts` (new) — read + inject
- `src/token.ts` (new) — chars/4 estimate, truncate
- `src/templates/read_path.md` (new)

### Evaluation
- Write `memory_summary.md` by hand, start a session, ask a question → model references the memory
- Verify the injected string is byte-identical across turns (check via session context inspection)
- Verify truncation: write a >10,000 char summary → it's cut to 10,000 chars
- Verify graceful degradation: delete the file → no injection, no errors

---

## Stage 1 — Memory tools + citation parsing

**Goal:** The model can actively read/search the memory workspace via dedicated tools, and citations in model output are parsed and recorded for usage feedback. Still no write pipeline.

**Milestone:** Model uses `memory_search` tool mid-conversation, emits `<memory-citation>`, citations are parsed and stripped from output.

### Tasks

1. **Memory tools: `tools/memory_read.ts`, `tools/memory_search.ts`, `tools/memory_add_note.ts`**
   - `memory_read` — read a file from the memories root (path-escaped, bounded)
   - `memory_search` — FTS5 search across `MEMORY.md` + `rollout_summaries/*.md` (use `bun:sqlite` with a virtual FTS5 table synced from files, or ripgrep)
   - `memory_add_note` — append a note to `extensions/ad_hoc/notes/` (for user-requested memory updates)
   - Register via `hooks.tool` in plugin definition (`plugin/src/index.ts:226-228`):
     ```typescript
     export default {
       tool: {
         memory_read: { description: "...", args: z.object({ path: z.string() }), execute: async (args, ctx) => { ... } },
         memory_search: { description: "...", args: z.object({ query: z.string() }), execute: async (args, ctx) => { ... } },
         memory_add_note: { description: "...", args: z.object({ note: z.string() }), execute: async (args, ctx) => { ... } },
       },
       "experimental.chat.system.transform": async (input, output) => { ... },
     }
     ```
   - Tools are registered via `fromPlugin(id, def)` at `packages/opencode/src/tool/registry.ts:183-192`

2. **Citation parsing: `src/citation.ts`**
   - Parse `<memory-citation>` blocks from assistant text output
   - Extract session IDs from `<citation_entries>` / `<session_ids>` (adapt from `codex-rs/memories/read/src/citations.rs:6`)
   - Wire into `event` hook: filter for assistant text events, parse citations
   - Usage recording deferred to Stage 2 (when the SQLite store exists); for now, just strip citations from output

3. **Citation stripping**
   - In the `event` hook, when assistant text contains `<memory-citation>`, strip it before display
   - The `event` hook fires on all events — filter for text/assistant message events
   - Adapt from `codex-rs/core/src/stream_events_utils.rs:273`

4. **Update `read_path.md` template**
   - Add instructions for citation format: `<memory-citation><citation_entries>session-id-1,session-id-2</citation_entries></memory-citation>`
   - Add instructions for memory tools (when they're registered)

### Files
- `tools/memory_read.ts` (new)
- `tools/memory_search.ts` (new)
- `tools/memory_add_note.ts` (new)
- `src/citation.ts` (new)
- `src/templates/read_path.md` (update)

### Evaluation
- Model reads `MEMORY.md` via `memory_read` tool
- Model searches memories via `memory_search` (FTS5)
- Model emits `<memory-citation>` → parsed, stripped from output
- `memory_add_note` writes to `extensions/ad_hoc/notes/`
- Verify tools appear in the model's tool list

---

## Stage 2 — SQLite schema + Phase 1 extraction

**Goal:** Past sessions are automatically extracted into `memory_stage1_outputs` via a background job pipeline. The write path begins. No consolidation yet.

**Milestone:** After N sessions, run the extractor, verify `memory_stage1_outputs` rows exist with `raw_memory` + `rollout_summary`. AGENTS.md content is excluded.

### Tasks

1. **Plugin SQLite DB: `src/db.ts`**
   - Open `~/.local/share/opencode/memory.db` with `bun:sqlite`, WAL mode
   - Simple migration runner (version table + sequential SQL files embedded as strings)
   - Schema (adapt from `codex-rs/state/memory_migrations/0001_memories.sql`):
     ```sql
     CREATE TABLE memory_stage1_outputs (
       session_id TEXT PRIMARY KEY,
       source_updated_at INTEGER NOT NULL,
       raw_memory TEXT NOT NULL,
       rollout_summary TEXT NOT NULL,
       rollout_slug TEXT,
       generated_at INTEGER NOT NULL,
       usage_count INTEGER DEFAULT 0,
       last_usage INTEGER,
       selected_for_phase2 INTEGER NOT NULL DEFAULT 0,
       selected_for_phase2_source_updated_at INTEGER
     );
     CREATE INDEX idx_memory_stage1_source_updated_at
       ON memory_stage1_outputs(source_updated_at DESC, session_id DESC);

     CREATE TABLE memory_jobs (
       kind TEXT NOT NULL,
       job_key TEXT NOT NULL,
       status TEXT NOT NULL,
       worker_id TEXT,
       ownership_token TEXT,
       started_at INTEGER,
       finished_at INTEGER,
       lease_until INTEGER,
       retry_at INTEGER,
       retry_remaining INTEGER NOT NULL,
       last_error TEXT,
       input_watermark INTEGER,
       last_success_watermark INTEGER,
       PRIMARY KEY (kind, job_key)
     );
     CREATE INDEX idx_memory_jobs_kind_status_retry_lease
       ON memory_jobs(kind, status, retry_at, lease_until);
     ```
   - Job kinds: `memory_stage1` (per-session, `job_key = session_id`), `memory_consolidate_global` (singleton, `job_key = "global"`)

2. **Memory store: `src/store.ts`**
   - `claimStage1Jobs(params)` — enumerate sessions via read-only opencode.db or HTTP API, claim via `INSERT ... ON CONFLICT DO UPDATE` with lease + concurrency cap (8) + retry guards
   - `markStage1Succeeded(sessionId, output)` — update job to done, upsert `memory_stage1_outputs` (only if `source_updated_at` advanced)
   - `markStage1Failed(sessionId, error)` — set error, decrement `retry_remaining`, set `retry_at`
   - `recordUsage(sessionIds)` — increment `usage_count`, set `last_usage` (wired from citation parser)
   - `pruneStage1Outputs(maxUnusedDays)` — delete rows unused beyond retention
   - Constants: `DEFAULT_RETRY_REMAINING = 3`, lease 3600s, scan limit 5000, concurrency 8
   - Adapt from `codex-rs/state/src/runtime/memories.rs`

3. **Session enumeration: `src/capture.ts`**
   - Enumerate sessions: `SELECT id, updated_at FROM session ORDER BY updated_at DESC LIMIT ?` (read-only on opencode.db)
   - Or via HTTP API: `GET /api/session`
   - Filter: `memory_mode = 'enabled'` (tracked in plugin DB, not opencode.db), within age window, idle time, excluding current session
   - For each eligible session, attempt to claim a stage1 job

4. **Transcript loading: `src/phase1.ts`**
   - Read session transcript from opencode.db (read-only):
     ```sql
     SELECT data FROM session_message WHERE session_id = ? ORDER BY seq
     ```
   - Parse JSON `data` column (types: `user`, `assistant`, `system`, `synthetic`, `shell`, `compaction`, etc.)
   - Filter out `system` messages containing AGENTS.md / instruction context (adapt `isMemoryExcludedFragment` from `codex-rs/memories/write/src/phase1.rs:466`)
   - Redact secrets (`src/redact.ts` — adapt codex's redaction logic)

5. **Extraction LLM call: `src/llm.ts`**
   - Use opencode HTTP API: create a temporary session with `memorize-extract` agent, send extraction prompt
   - `POST /api/session` with `agent: "memorize-extract"`, then `POST /api/session/:id/prompt` with the transcript + extraction instructions
   - Parse structured JSON output from the response: `{ raw_memory, rollout_summary, rollout_slug }`
   - Redact secrets again after extraction
   - Store in `memory_stage1_outputs` via `MemoryStore.markStage1Succeeded`
   - On error: `MemoryStore.markStage1Failed` with retry backoff

6. **Phase 1 orchestration: `src/phase1.ts`**
   - `runPhase1()`:
     - `MemoryStore.claimStage1Jobs(params)` → batch of sessions
     - For each (parallel, concurrency 8 via Promise pool):
       - Load transcript
       - Filter + redact
       - Build extraction prompt from `templates/stage_one_system.md`
       - LLM call via HTTP API
       - Parse + redact + store
     - On error: mark failed with retry
   - Enqueue Phase 2 attempt after each success

7. **Trigger: `event` hook**
   - In the `event` hook, filter for session end / step end events
   - When a session ends (gated by `generate_memory` config option and non-sub-agent), spawn `runPhase1` as a background async operation in the plugin process
   - Skip if session was spawned by `memorize` or `memorize-extract` agents (avoid recursive extraction)

8. **Templates: `src/templates/stage_one_system.md`, `stage_one_input.md`**
   - Adapt from `codex-rs/memories/write/templates/memories/stage_one_system.md`
   - Instructions: extract raw_memory (detailed markdown), rollout_summary (compact), rollout_slug (kebab-case)

9. **Plugin config options**
   - `generate_memory` (default true) — gates write path
   - `extract_model` (optional, defaults to opencode's current model)
   - `max_rollouts_per_startup`, `max_rollout_age_days`, `min_rollout_idle_hours`, `max_unused_days`

### Files
- `src/db.ts` (new)
- `src/store.ts` (new)
- `src/capture.ts` (new)
- `src/phase1.ts` (new)
- `src/llm.ts` (new)
- `src/redact.ts` (new)
- `src/templates/stage_one_system.md` (new)
- `src/templates/stage_one_input.md` (new)
- `src/citation.ts` (update — wire `recordUsage` to store)

### Evaluation
- Run 3 sessions, trigger extraction, verify `memory_stage1_outputs` has 3 rows
- Verify AGENTS.md content does NOT appear in `raw_memory`
- Verify job retry: kill extraction mid-flight, verify `retry_remaining` decrements and `retry_at` is set
- Verify concurrency cap: only 8 jobs run simultaneously
- Verify pruning: old unused rows are deleted
- Verify citations from Stage 1 now increment `usage_count`

---

## Stage 3 — Phase 2 consolidation

**Goal:** Stage-1 outputs are consolidated into the on-disk memory workspace via the sandboxed `memorize` subagent. The closed loop is complete.

**Milestone:** After Stage 2 produces N outputs, run Phase 2, verify `memory_summary.md` is updated and the model references the new memory in a subsequent session.

### Tasks

1. **Phase 2 job claim: extend `src/store.ts`**
   - `claimGlobalPhase2Job()` — singleton row `(kind='memory_consolidate_global', job_key='global')`
     - 6h success cooldown, lease-based mutual exclusion
     - Returns `Claimed` / `SkippedCooldown` / `SkippedRunning` / `SkippedRetryUnavailable`
     - Adapt from `codex-rs/state/src/runtime/memories.rs:1045`
   - `heartbeatPhase2Job()` — refresh `lease_until` (only owner)
   - `markPhase2Succeeded()` / `markPhase2Failed()`
   - `getPhase2InputSelection(maxRaw)` — select top-N ranked by `usage_count` desc, then recency, excluding unused beyond `max_unused_days`

2. **Workspace management: `src/workspace.ts`**
   - `ensureLayout(root)` — create `memories/`, `rollout_summaries/`, `extensions/ad_hoc/notes/`, `skills/`
   - `rebuildRawMemories(root, outputs)` — write `raw_memories.md` (stable ascending session-id order)
   - `writeRolloutSummaries(root, outputs)` — one file per output; prune stale
   - `pruneExtensionResources(root, retentionDays)` — 7-day retention
   - Adapt from `codex-rs/memories/write/src/storage.rs`

3. **Git baseline diff: `src/git-baseline.ts`**
   - `git init` the memories dir if no `.git` exists
   - `git add -A && git commit -m "baseline"` → baseline commit
   - After syncing workspace inputs (rebuildRawMemories, writeRolloutSummaries):
     - `git add -A && git diff --cached --no-color` → unified diff
   - Write diff to `memories/phase2_workspace_diff.md` (max 4 MiB, truncate if larger)
   - If no changes → `markPhase2Succeeded` with `no_workspace_changes`, return
   - After consolidation agent completes: `git add -A && git commit -m "consolidated"` → reset baseline
   - Adapt from `codex-rs/git-utils/src/baseline.rs` + `codex-rs/memories/write/src/workspace.rs`
   - **Implementation:** Shell out to `git` binary directly (no library dependency). The plugin's `PluginInput` includes a Bun `$` shell helper (`packages/plugin/src/index.ts:56-66`).

4. **Consolidation sub-agent spawn: `src/phase2.ts`**
   - Spawn via opencode HTTP API:
     - `POST /api/session` with `agent: "memorize"` (the subagent defined in shipped `opencode.json`)
     - `POST /api/session/:id/prompt` with prompt: "Read `phase2_workspace_diff.md` in your working directory. Update `MEMORY.md`, `memory_summary.md`, and `skills/` to reflect the latest memories. Keep `memory_summary.md` under 10000 chars (2500 tokens). Prune stale entries."
   - The `memorize` agent has `bash`/`webfetch`/`websearch`/`task` denied → no network, no spawning
   - The agent's `cwd` should be the memories root (set via session creation or prompt context)

5. **Phase 2 orchestration: `src/phase2.ts`**
   - `runPhase2()`:
     1. `claimGlobalPhase2Job()` → skip if cooldown/running
     2. `ensureLayout(root)`
     3. `getPhase2InputSelection(maxRaw)` → stage1 outputs
     4. `rebuildRawMemories`, `writeRolloutSummaries`, `pruneExtensionResources`
     5. Capture git diff → if no changes, succeed
     6. Write `phase2_workspace_diff.md`
     7. Spawn `memorize` subagent via HTTP API
     8. Heartbeat loop: every 90s, `heartbeatPhase2Job()`; if lost, abort
     9. On agent completion: re-confirm lock, reset git baseline, `markPhase2Succeeded`
     10. **Invalidate plugin's memory_summary cache** → next `system.transform` call re-reads `memory_summary.md`
     11. On failure: `markPhase2Failed`

6. **Consolidation prompt template: `src/templates/consolidation.md`**
   - Adapt from `codex-rs/memories/write/templates/memories/consolidation.md`
   - Instructions: read the diff, update MEMORY.md (searchable index), memory_summary.md (≤2500 tok), skills/ (reusable procedures), prune stale

7. **Polluted mode**
   - When `disable_on_external_context` is true and a session uses websearch/webfetch/MCP tools, mark it excluded from extraction
   - Detect in `event` hook: if `tool.execute.after` fires for `websearch`/`webfetch`, flag the session in plugin DB as `polluted`
   - Phase 1 skips `polluted` sessions

### Files
- `src/store.ts` (extend: phase2 claim/heartbeat/input selection)
- `src/workspace.ts` (new)
- `src/git-baseline.ts` (new)
- `src/phase2.ts` (new)
- `src/templates/consolidation.md` (new)

### Evaluation
- After Stage 2 produces 5+ outputs, trigger Phase 2
- Verify `MEMORY.md` and `memory_summary.md` are created/updated
- Verify the diff-driven approach: run Phase 2 again with no new stage1 → `no_workspace_changes`
- Start a new session → model references consolidated memory (system prompt now contains updated summary)
- Verify 6h cooldown: second Phase 2 within 6h → `SkippedCooldown`
- Verify lease: spawn two Phase 2 attempts concurrently → only one proceeds
- Verify `memorize` agent can't access network (websearch/webfetch/bash denied)
- Verify plugin cache invalidation: after Phase 2, the next turn's system prompt reflects the new `memory_summary.md`

---

## Stage 4 — Memory reset + inspection tools

**Goal:** Allow users and the model to reset memory, inspect memory state, and control per-session memory mode. Since we can't add RPC endpoints (no core access), these are exposed as plugin tools.

**Milestone:** Model or user calls `memory_reset` tool, verify SQLite + filesystem are wiped. Call `memory_inspect` tool, verify it returns memory state.

### Tasks

1. **`memory_reset` tool: `tools/memory_reset.ts`**
   - Clears plugin DB tables (`DELETE FROM memory_stage1_outputs`, `DELETE FROM memory_jobs`)
   - Wipes `~/.local/share/opencode/memories/` contents (refuse if symlinked root)
   - Adapts `clearMemoryRootsContents` from `codex-rs/memories/write/src/control.rs:3`
   - Invalidates plugin's memory_summary cache

2. **`memory_inspect` tool: `tools/memory_inspect.ts`**
   - Returns: stage1_outputs count, last consolidation time, memory_summary token count, memories dir file listing
   - Read-only, no side effects

3. **`memory_mode` tool: `tools/memory_mode.ts`**
   - Sets per-session memory mode (`enabled` / `disabled` / `polluted`) in plugin DB
   - Phase 1 extraction respects this flag

4. **Register tools via `hooks.tool`**
   - Add `memory_reset`, `memory_inspect`, `memory_mode` to the plugin's `tool` map

### Files
- `tools/memory_reset.ts` (new)
- `tools/memory_inspect.ts` (new)
- `tools/memory_mode.ts` (new)
- `src/store.ts` (add `clearMemoryData`, `setMemoryMode`, `getMemoryMode`)

### Evaluation
- Call `memory_reset` → verify memories dir is empty, DB tables are empty, system prompt no longer contains memory
- Call `memory_inspect` → returns counts and metadata
- Call `memory_mode` with `disabled` → verify session excluded from Phase 1

---

## Stage 5 — Polish, telemetry, edge cases

**Goal:** Production readiness — secret redaction hardening, rate-limit awareness, extension pruning, tests.

### Tasks

1. **Secret redaction hardening: `src/redact.ts`**
   - Port codex's redaction patterns: API keys (OpenAI `sk-`, Anthropic `sk-ant-`, AWS `AKIA*`), bearer tokens, passwords in env vars, private keys
   - Redact before sending transcript to extraction model AND before storing in SQLite
   - Test with known secret patterns

2. **Rate-limit awareness**
   - Before Phase 1/2, check if opencode has rate-limit info available (via HTTP API or event hook)
   - Skip extraction if provider is near limit
   - Adapt from `codex-rs/memories/write/src/guard.rs`

3. **Extension resources: `src/extensions/`**
   - Prune old extension resources (7-day retention)
   - Seed ad-hoc instructions for `extensions/ad_hoc/notes/`
   - Adapt from `codex-rs/memories/write/src/extensions/`

4. **Token accuracy**
   - For the 2500-token cap: chars/4 is sufficient
   - For Phase 1's 70%-context-window calculation: use the model's context window size from opencode's model config (queryable via HTTP API)
   - Calculate: `maxInputTokens = contextWindow * 0.7 - estimatedPromptTokens`

5. **Tests**
   - Unit: citation parsing, secret redaction, stage1 filtering (excludes AGENTS.md), path helpers, token truncation, git baseline diff
   - Integration: full pipeline (session → extract → consolidate → inject → cite → rank → reset)
   - Lease contention: two concurrent Phase 2 attempts → only one proceeds
   - Cooldown enforcement: Phase 2 within 6h → skipped
   - Sub-agent sandboxing: `memorize` agent can't use bash/webfetch/websearch

6. **Error handling**
   - Plugin crash in a hook should not affect the running session (wrap all hook handlers in try/catch)
   - SQLite errors → graceful degradation (skip extraction, log error)
   - Git not installed → skip Phase 2, log warning
   - opencode.db schema changed → fallback to HTTP API for transcript access

7. **Documentation**
   - README with install instructions, config options, memory directory layout
   - Document accepted trade-offs vs codex (tool-permission sandbox, approximate token counting, V1 hook stability)

### Files
- `src/redact.ts` (harden)
- `src/extensions/` (new)
- `tests/` (new)

### Evaluation
- Secret redaction: grep `memory_stage1_outputs.raw_memory` for known secret patterns → none found
- Full integration test: 5 sessions → extract → consolidate → new session references memory → citations recorded → Phase 2 ranking reflects usage → reset
- Error recovery: kill plugin mid-extraction → opencode session unaffected, plugin retries on next event
- Git not installed → Phase 2 skipped with warning, Phase 1 still works

---

## Known gaps vs codex (accepted trade-offs)

| Gap | Codex | Plugin | Mitigation |
|---|---|---|---|
| Process-level network sandbox | Seatbelt (`CODEX_SANDBOX_NETWORK_DISABLED`) | Tool-permission-level (deny `bash`/`webfetch`/`websearch`) | `memorize` agent config denies network tools. Optional path-scoped write permissions. Accepted trade-off. |
| Accurate token counting | tiktoken | chars/4 estimate | Sufficient for 2500-token cap. For context-window math, query model config via HTTP API. |
| Dedicated SQLite DB | `memories_1.sqlite` (separate) | `memory.db` (plugin's own, separate from `opencode.db`) | Same isolation as codex. No migration conflicts. |
| V2 SystemContext.Source | Epoch-aware cache-stable injection | V1 `experimental.chat.system.transform` hook | Append byte-identical string every turn. Cache-stable in practice (content-addressed provider cache). Re-read only when Phase 2 writes new summary. |
| Plugin LLM API | Internal model client | HTTP API (spawn sub-agent session) | Both Phase 1 and Phase 2 use sub-agent sessions via `POST /api/session/:id/prompt`. Reuses opencode's auth/provider/usage stack. Zero credentials in plugin. |
| Retroactive transcript access | Direct DB access (own schema) | Read-only `opencode.db` or HTTP API | WAL mode allows safe concurrent reads. Fallback to HTTP API if schema changes. |
| `experimental.*` hook stability | N/A (core code) | V1 hooks could be deprecated | Accepted risk (per discussion). If deprecated, plugin would need to migrate to V2 plugin SDK when it exposes `SystemContext.Source` registration. |
| Git baseline via gix crate | `gix` (libgit2) | Shell out to `git` binary | Functionally equivalent. Plugin has Bun `$` shell access. |

---

## Implementation order and dependencies

```
Stage 0 (read path MVP)         ← no dependencies, ship first
  ↓
Stage 1 (tools + citations)     ← depends on Stage 0 (injection registered)
  ↓
Stage 2 (SQLite + Phase 1)      ← depends on Stage 1 (citation parser)
  ↓
Stage 3 (Phase 2 consolidation) ← depends on Stage 2 (stage1_outputs)
  ↓
Stage 4 (reset + inspect tools) ← depends on Stage 2+3 (data to reset)
  ↓
Stage 5 (polish + tests)        ← depends on all above
```

Each stage is independently shippable:
- **After Stage 0:** users can manually currate memory → model uses it
- **After Stage 1:** model can actively read/search memory, citations parsed
- **After Stage 2:** memory is auto-extracted from past sessions
- **After Stage 3:** full closed loop — extract → consolidate → inject → cite → rank
- **After Stage 4:** users/model can reset and inspect memory
- **After Stage 5:** production-ready

---

## Key file reference map (codex → plugin port)

| Codex source | Purpose | Plugin target |
|---|---|---|
| `ext/memories/src/extension.rs:50` | ContextContributor | `src/source.ts` (`experimental.chat.system.transform` hook) |
| `ext/memories/src/prompts.rs:27` | Build memory instructions | `src/source.ts` (read + render) |
| `memories/read/templates/memories/read_path.md` | Read-path prompt template | `src/templates/read_path.md` |
| `memories/read/src/citations.rs:6` | Citation parser | `src/citation.ts` |
| `memories/read/src/usage.rs:29` | Usage classification | `src/citation.ts` (usage recording) |
| `state/memory_migrations/0001_memories.sql` | DB schema | `src/db.ts` (embedded SQL) |
| `state/src/runtime/memories.rs` | MemoryStore (claim/lease/heartbeat) | `src/store.ts` |
| `state/src/model/memories.rs` | Rust models | `src/store.ts` (TS types) |
| `memories/write/src/start.rs:22` | Startup task entry | `src/index.ts` (`event` hook) |
| `memories/write/src/phase1.rs:70` | Phase 1 extraction | `src/phase1.ts` |
| `memories/write/src/phase1.rs:466` | Exclude AGENTS.md fragments | `src/phase1.ts` (filter logic) |
| `memories/write/src/phase2.rs:46` | Phase 2 consolidation | `src/phase2.ts` |
| `memories/write/src/phase2.rs:301` | Consolidation agent config | `opencode.json` (`memorize` agent) |
| `memories/write/src/workspace.rs` | Workspace diff | `src/git-baseline.ts` + `src/workspace.ts` |
| `memories/write/src/storage.rs:13` | Rebuild raw_memories, summaries | `src/workspace.ts` |
| `memories/write/src/control.rs:3` | Clear memory | `tools/memory_reset.ts` |
| `memories/write/src/guard.rs` | Rate-limit guard | `src/phase1.ts` / `src/phase2.ts` (rate-limit check) |
| `git-utils/src/baseline.rs:78` | Git baseline repo | `src/git-baseline.ts` (shells out to `git`) |
| `config/src/types.rs:283` | MemoriesToml config | Plugin options in `opencode.json` |
| `app-server-protocol/src/protocol/v2/thread.rs:890` | Memory RPC types | `tools/memory_reset.ts`, `tools/memory_inspect.ts`, `tools/memory_mode.ts` |
| `app-server/src/request_processors/thread_processor.rs:1544` | RPC handlers | Tool execute functions |
| `protocol/src/memory_citation.rs` | Citation wire types | `src/citation.ts` (TS types) |

---

## Codex memory stability assessment

Codex's memory system is **young** — first commits landed May 26, 2026 (5 weeks before this plan). The initial burst was ~10 PRs in one week, followed by structural refactors (dedicated SQLite DB, memories root moved out of core config) within weeks of landing. Recent commits are mostly incidental (metadata renames, async_trait removal, toolchain bumps).

**Implication for the plugin:** The core architecture (two-phase pipeline, citation loop, git baseline, on-disk artifacts) is unlikely to be thrown away, but storage layout and config shape were still evolving as of late May. The plugin ports the *architecture*, not the *storage schema* — so codex schema changes don't affect the plugin's own `memory.db`. If codex's memory prompts or extraction logic improve, those are template files that can be updated independently in the plugin.

**De-risking:** Stage 0-1 (read path + tools) are stable and simple — they depend only on opencode's plugin hooks, which are the mature part. Stage 2-3 (write pipeline) port codex's architecture but implement it independently in TypeScript. If codex's approach shifts, the plugin's implementation is self-contained and won't break.