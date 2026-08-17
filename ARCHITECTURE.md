# Architecture

`opencode-codex-memory` is a TypeScript port of codex's memory system, packaged as a
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
opencode-codex-memory plugin

READ PATH
  experimental.chat.system.transform hook
    → reads memories/memory_summary.md, truncates to 2500 tokens (chars/4)
    → appends a byte-identical string to system[] every turn (cache-stable)
    → stats the file every turn; re-reads only when its mtime changes
  tools: memory_read, memory_search, memory_list, memory_add_note
    (+ control tools: memory_reset, memory_inspect, memory_mode)
  experimental.text.complete hook: parse <memory-citation> at text end,
    BEFORE the part is persisted → record usage_count / last_usage → strip
    the block, so neither the UI nor stored history shows citation markup
    (matches codex; messages.transform + message.part.updated remain as
    fallbacks for older hosts and pre-existing history)

WRITE PATH
  Phase 1 — per-session extraction
    pumped at first chat.message of a session and on idle
    (session.status {type:"idle"} + deprecated session.idle, deduped)
    process-local 30s anti-stampede stamps only after a claim (empty passes free)
    load transcript via session.messages API → filter instructions → redact
    → memorize-extract subagent (json_schema output; only StructuredOutput tool, transcript inline)
    → store raw_memory + rollout_summary in memory.db
  Phase 2 — global consolidation (singleton, 6h DB cooldown, lease; no process timer)
    git baseline diff of memories/ → memorize subagent updates MEMORY.md,
    memory_summary.md, skills/ → reset baseline → invalidate read-path cache
    dispose() aborts the consolidator signal so reload cannot leave two writers

STORAGE
  ~/.local/share/opencode/memory.db        plugin SQLite (stage1 outputs + jobs + session meta)
  ~/.local/share/opencode/memories/        MEMORY.md, memory_summary.md, raw_memories.md,
                                           rollout_summaries/, extensions/, skills/, .git/
  opencode session data                    never read from disk — transcripts and
                                           discovery go through the plugin API (D4)
```

Source layout: `src/` holds the pipeline (`source`, `citation`, `db`, `store`,
`capture`, `phase1`, `phase2`, `workspace`, `git-baseline`, `redact`, `token`,
`llm`, `ratelimit`, `paths`, `path-guard`, `host-client`, `lifecycle`,
`options`, `diagnostics`, `agent-health`) plus external-agent exchange
(`codex-interop`, `claude-import`) and `src/templates/`; `tools/` holds the
model-facing tools (`memory.ts`, `control.ts`). Per-file upstream provenance
lives in `codex-map.yaml`.

---

## Design decisions & workarounds

These explain why the code diverges from a naive port. They are the load-bearing
constraints — read before changing the corresponding subsystem.

### D1 — Prompt cache stability (`src/source.ts`)

opencode's V1 `experimental.chat.system.transform` has no epoch-aware injection;
the system prompt is rebuilt each turn, and codex's V2 `SystemContext.Source` is
not exposed to plugins. **Workaround:** append the *same byte-identical string*
every turn.

opencode pre-joins everything of its own (agent/provider prompt, environment,
AGENTS.md, MCP instructions, skills, user system) into a single `system[0]`
before calling the hook, then keeps at most two entries: appending one string
leaves `[base, memory]` untouched, and two or more are collapsed into
`[base, rest.join("\n")]` (`session/llm/request.ts`). Its provider transform
puts cache breakpoints on the first two system messages
(`provider/transform.ts`, `.slice(0, 2)`). The stable memory block therefore
gets its own cache segment: changing memory invalidates that segment without
invalidating opencode's base prompt. The plugin caches the summary in process
memory, stats its mtime each turn, and re-reads only after an external edit
changes that mtime or Phase 2 explicitly invalidates the cache. Sessionless
invocations of the same hook (used by opencode while generating agent
definitions) are ignored, as is a symlinked memory root or summary file.

Limitations, both accepted:

- If opencode's own prompt prefix shifts (date, skills, MCP tool set), the
  prefix cache misses — same as any plugin hook.
- On OpenAI-OAuth providers opencode sends **no system messages at all**; the
  whole array is joined into the request's `instructions` field
  (`request.ts`), so no system cache breakpoints exist and D1 buys nothing
  there. Injection itself is unaffected — only the caching benefit is.
- Another plugin appending a *volatile* string triggers the collapse and shares
  one cache segment with ours, invalidating it whenever that plugin's text
  changes. Plugin order is deterministic, so a stable co-tenant is harmless.

### D2 — Consolidation subagent sandboxing (`opencode.json`)

codex uses Seatbelt to block network access; opencode has no process sandbox.
**Workaround:** every shipped memory subagent starts with `"*": "deny"` and
allowlists only the built-in opencode file tools it needs. The consolidator
(`memorize`) gets `read`/`edit`/`write`/`glob`/`grep`; the extractor
(`memorize-extract`) gets only `StructuredOutput` — opencode delivers
json_schema output through a forced call to that synthetic capture tool
(`toolChoice: required`), and it has no filesystem/shell/network capability, so
the extractor stays effectively tool-less: the transcript arrives inline and a
poisoned transcript still cannot induce file reads or any side effect. This also
blocks IDE and MCP tools that could otherwise bypass a narrower `bash` deny.
Tool-permission-level, not process-level — accepted trade-off.

Helper sessions are created with `directory` = the memory workspace
(`resolveSubSessionDirectory` in `src/llm.ts`), not the user's project. OpenCode
treats that path as the session project boundary (`containsPath` /
`external_directory`): in-bounds file tools freely touch the memory root only.
Paths under the user's real project are outside that boundary and hit
`external_directory`, which the wildcard deny blocks. So the consolidator is
effectively memory-root-scoped without Seatbelt — residual is still
tool-permission-level (not process-level), not "can edit the originating repo."

`injectAgentDefinitions` still appends
`external_directory: { "<memory root>/*": "allow" }` as a belt-and-suspenders
grant (homedir/env-dependent path; covers edge cases if a tool path is
classified external). The extractor gets no grant — inline transcript only.

### D3 — LLM calls for extraction/consolidation (`src/llm.ts`)

The plugin SDK exposes no "make a model call" API and no provider credentials.
**Workaround:** both phases spawn sub-agent sessions via opencode's HTTP API
(`session.create` + `session.prompt`), reusing opencode's auth/provider/usage
stack with zero credentials in the plugin. This is close to codex's model — codex
also spawns a configured model client for extraction.

### D4 — Retroactive transcript & session access (`src/capture.ts`)

Phase 1 needs past transcripts and a cross-project session listing; the live
message hook only sees current messages. **Approach: official API only —
`opencode.db` is never read.** Everything goes through the plugin's
authenticated client (`input.client`), which shares auth with the host:

- Transcripts: `session.messages` — the same surface opencode's own UI renders
  history from; the session-scoped route resolves the right instance even for
  sessions from other projects. Errors propagate so the job fails and retries.
  A first-time empty transcript finalizes as no-output; an empty transcript for
  a session with an existing extraction retries instead of deleting that row.
- Discovery: `GET /experimental/session?roots=true` (`Session.listGlobal`) —
   one call across all projects. The V1 plugin client has no `experimental`
   namespace, so the call goes through the host client's hey-api transport
   (`client._client.get`) which already carries baseUrl + auth. The SDK also
   auto-injects `directory` on GETs (project scope); we pass `directory=""` so
   the handler runs listGlobal without a directory filter — required because
   memory is global. Fail-safe: any error skips the pass and never finalizes a
   job. The pass is also rate-limited (30s min interval). Helper-session
   cleanup after reload uses the same host-wide list so memory-root
   extract/consolidate sessions are visible (project-scoped `session.list`
   cannot see them).

Trade-off accepted: discovery rides an experimental route (stable since
1.17.x) rather than reading `opencode.db`. The only SQLite the plugin touches
is its own `memory.db` (D5) — plugin-owned state with no API equivalent.

### D5 — Separate plugin DB (`src/db.ts`)

The plugin owns `memory.db` (its own schema + migrations); opencode's own
database is never opened — not even read-only (see D4). No migration
conflicts, no risk to opencode's data. Same isolation codex uses with its
dedicated memories SQLite.

### D6 — External-agent import via extensions

Default-off exchange with foreign agent memory stores, built on the generic
extensions contract instead of a second memory root. Both this plugin and
Codex already render extension prompt blocks into their consolidation prompt
whenever `extensions/` exists and instruct the consolidator to read every
extension's `instructions.md` — so sharing is pure content, no read-path or
schema change.

#### Codex CLI (`src/codex-interop.ts`)

Two-way exchange of *consolidated* global memory:

- **Import** (`codex_interop.import`): inside each claimed phase-2 job —
  after the baseline, before the diff capture — Codex's consolidated
  `MEMORY.md`/`memory_summary.md` are byte-compared and copied into
  `extensions/codex_import/resources/codex/`, so imported changes are
  consolidated in the same run (codex `memory_import.rs` orders
  prepare-workspace-then-copy the same way). Source-gone deletes the copies
  so the workspace diff carries the forgetting signal.
- **Export** (`codex_interop.export`): after a successful phase 2, our
  validated artifacts are copied into
  `$CODEX_HOME/memories/extensions/opencode_import/resources/opencode/` with
  an instructions.md written for Codex's consolidator. Strictly additive:
  never bootstraps Codex's workspace, never touches Codex's state DB — Codex
  discovers the files through its own workspace diff.
- **Echo guard**: both instructions files require a provenance tag
  (`[from codex]` / `[from opencode]`) and forbid re-importing content
  carrying the other side's tag; foreign metadata (thread UUIDs vs `ses_*`
  ids, citation formats) must never be reinterpreted. This is deliberately
  instruction-level, like every content rule in both memory systems. A
  code-level line filter at the sync boundary was tried and rejected: line
  granularity strips the very line that carries the provenance marker while
  leaving the rest of a multi-line entry behind as unattributable fragments —
  worst for entries whose origin memory has since been deleted, which become
  uninterpretable remnants. Only the consolidator can delimit semantic units,
  so it must see the tags, not their absence. Untagged leakage degrades to
  duplication, never to unsafe behavior (the consolidator's tool allowlist is
  the safety boundary, D2).
- Overlapping Codex/plugin memory roots fail closed.

#### Claude Code (`src/claude-import.ts`)

One-way port of codex's Claude memory importer
(`external-agent-migration` `memory.rs` + `memory_import.rs`), continuous on
phase 2 instead of a migration UI:

- Reads `~/.claude/projects/<key>/memory/**/*.md` (optional `claude_home` /
  `projects` allowlist).
- Resolves `cwd` from newest project `*.jsonl` with an absolute existing cwd
  (codex `project_cwd_from_sessions`); no-cwd projects are skipped.
- Whole-project replace into
  `extensions/external_agent_import/resources/<key>/` plus `scope.json`
  (`{ "cwd": "..." }`) and codex-aligned `instructions.md`.
- Source gone / dropped from allowlist → remove resources (forgetting signal).
- Unreachable Claude home is a no-op, never a mass-delete.
- Same extension name and layout as Codex, so a consolidator trained on either
  system can merge the files. No write-back to Claude; no second memory root.

Resource files for both importers are nested and untimestamped, so
extension-resource pruning never touches them.

The alternative — mounting a foreign workspace as a second, read-only memory
root — was rejected: it would need source-aware tools, a split summary
budget, and read-path changes, and it would strain the "memory is global, one
root" invariant. The extension approach is pure content.

---

## Known gaps vs codex (accepted trade-offs)

| Gap | Codex | This plugin | Mitigation |
|---|---|---|---|
| Network sandbox | Seatbelt | Tool-permission deny on subagents | `memorize*` deny `bash`/`webfetch`/`websearch`/`task` |
| Consolidator FS scope | `WorkspaceWrite` limited to memory root | Sub-session `directory` = memory root → project-bound tools only see that tree; user projects need `external_directory` (denied) | No shell/network; tool-permission sandbox, not process Seatbelt |
| Token counting | tiktoken | chars/4 estimate | Sufficient for the 2500-token cap |
| Cache-stable injection | V2 `SystemContext.Source` | V1 hook + byte-identical append | Content-addressed provider caches (D1) |
| LLM call API | Internal model client | HTTP API → subagent sessions | Reuses opencode auth/usage (D3) |
| Transcript access | Direct rollout files (own format) | `session.messages` + `experimental.session.list`; `opencode.db` never read | Official surfaces only (D4) |
| Git baseline | gix / libgit2 | `isomorphic-git` (pure JS) | No external binary; git bundled |
| Hook stability | N/A (core code) | `experimental.*` V1 hooks may deprecate | Migrate to V2 SDK if/when it exposes the seam |
| Rate-limit awareness | Provider rate-limit info (`min_rate_limit_remaining_percent`), fail open | Phase-1 30s anti-stampede plus an observed-quota circuit breaker (1h, scoped by resolved model or phase default); quota failures do not burn stage-1 retries | See `src/ratelimit.ts`; wire live provider quota when opencode exposes it |
| Plugin dispose / reload | N/A (in-process core) | `dispose` aborts `pluginShutdownSignal` (extract) + phase-2 scope (consolidator), releases jobs without 1h backoff; best-effort `session.abort` on sub-sessions; startup reseeds helpers via host-wide `experimental.session` | Signal-driven cancel unblocks both phases; host `session.abort` still best-effort for server-side cleanup. Cross-process lease may still run until expiry |
| Per-instance state | Single process per home | Module-global options/client/caches; when one opencode process hosts several instances (directories), the last-booted instance's plugin options and client win | Memory itself is global, so shared state is mostly correct; revisit if per-project plugin options ever matter |

---

## Codex stability assessment

Codex's memory system is young and still refactoring structurally (as of the
pinned `codex_ref`, `memories/read/` and `ext/memories/` coexist mid-migration).
The **architecture** (two-phase pipeline, citation loop, git baseline, on-disk
artifacts) is stable; **storage layout and module boundaries** still move. The
port copies the architecture, not codex's storage schema, so codex schema changes
don't touch `memory.db`. Prompt/extraction improvements land in template files
that can be updated independently — which is exactly what the drift script surfaces.
