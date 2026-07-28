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
    load transcript via session.messages API → filter instructions → redact
    → memorize-extract subagent (json_schema output; only StructuredOutput tool, transcript inline)
    → store raw_memory + rollout_summary in memory.db
  Phase 2 — global consolidation (singleton, 6h cooldown, lease)
    git baseline diff of memories/ → memorize subagent updates MEMORY.md,
    memory_summary.md, skills/ → reset baseline → invalidate read-path cache

STORAGE
  ~/.local/share/opencode/memory.db        plugin SQLite (stage1 outputs + jobs + session meta)
  ~/.local/share/opencode/memories/        MEMORY.md, memory_summary.md, raw_memories.md,
                                           rollout_summaries/, extensions/, skills/, .git/
  opencode session data                    never read from disk — transcripts and
                                           discovery go through the plugin API (D4)
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

One required carve-out: opencode additionally gates file tools outside the
session's project behind the `external_directory` permission, and the memory
workspace is global — outside every project — so the wildcard deny would match
that ask and block consolidation entirely. `injectAgentDefinitions` therefore
appends `external_directory: { "<memory root>/*": "allow" }` to the `memorize`
definition at injection time (dynamic because the root is homedir/env-dependent;
opencode's `*` glob crosses `/`, so one pattern covers nested dirs). The
extractor gets no grant — it works on an inline transcript.

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
  sessions from other projects. Errors propagate so the job fails and retries
  (an empty transcript finalizes as no-output and deletes the previous
  extraction, so errors must never masquerade as empty).
- Discovery: `session.list` is project-scoped, so the plugin enumerates
  `project.list()` and lists each project with `scope=project&roots=true`
  (scope widens the filter from the session directory to the whole project).
  Per-project failures skip that project; a failed project.list skips the
  pass — discovery is fail-safe because it never finalizes anything. Instance
  contexts the host creates for listed directories are cached per process, and
  the pass is rate-limited (30s min interval).

Trade-off accepted: discovery is N+1 requests instead of one SQL query, in
exchange for zero coupling to opencode's storage schema. The only SQLite the
plugin touches is its own `memory.db` (D5) — plugin-owned state with no API
equivalent.

### D5 — Separate plugin DB (`src/db.ts`)

The plugin owns `memory.db` (its own schema + migrations); opencode's own
database is never opened — not even read-only (see D4). No migration
conflicts, no risk to opencode's data. Same isolation codex uses with its
dedicated memories SQLite.

### D6 — Codex interop via extensions (`src/codex-interop.ts`)

Default-off two-way memory exchange with a local Codex CLI, built on the
generic extensions contract instead of a second memory root. Both memory
systems already render extension prompt blocks into their consolidation prompt
whenever `extensions/` exists and instruct the consolidator to read every
extension's `instructions.md` — so sharing is pure content, no read-path or
schema change on either side. This is the same mechanism codex itself uses to
import Claude memories (`external_agent_import` in
codex-rs/external-agent-migration).

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
- Resource files are nested and untimestamped, so extension-resource pruning
  never touches them. Overlapping memory roots fail closed.

The alternative — mounting Codex's workspace as a second, read-only memory
root — was rejected: it would need source-aware tools, a split summary
budget, and read-path changes, and it would strain the "memory is global, one
root" invariant. The extension approach is pure content.

---

## Known gaps vs codex (accepted trade-offs)

| Gap | Codex | This plugin | Mitigation |
|---|---|---|---|
| Network sandbox | Seatbelt | Tool-permission deny on subagents | `memorize*` deny `bash`/`webfetch`/`websearch`/`task` |
| Token counting | tiktoken | chars/4 estimate | Sufficient for the 2500-token cap |
| Cache-stable injection | V2 `SystemContext.Source` | V1 hook + byte-identical append | Content-addressed provider caches (D1) |
| LLM call API | Internal model client | HTTP API → subagent sessions | Reuses opencode auth/usage (D3) |
| Transcript access | Direct rollout files (own format) | `session.messages` + `project.list`/`session.list` APIs; `opencode.db` never read | Official surfaces only (D4) |
| Git baseline | gix / libgit2 | `isomorphic-git` (pure JS) | No external binary; git bundled |
| Hook stability | N/A (core code) | `experimental.*` V1 hooks may deprecate | Migrate to V2 SDK if/when it exposes the seam |
| Rate-limit awareness | Provider rate-limit info | Time-based heuristic stub | See `src/ratelimit.ts`; wire when opencode exposes it |
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
