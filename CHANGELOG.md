# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-07-15

### Changed

- More reliable memory extraction — the background learning agent now returns
  its results in a structured format instead of having its reply parsed as
  text, so an occasional malformed response no longer causes a session's memory
  to be skipped.

## [0.2.1] - 2026-07-15

### Changed

- Now requires opencode 1.18 or newer.

## [0.2.0] - 2026-07-12

### Fixed

- **Consolidation works again on opencode 1.17+**: opencode gates file tools
  outside the session's project behind the `external_directory` permission,
  and the global memory workspace is always outside the project — the
  consolidator's wildcard deny blocked every memory read/write. The injected
  `memorize` agent now carries an `external_directory` allow scoped to the
  memory root. Verified end-to-end against opencode 1.17.18.
- Transcript/DB errors no longer masquerade as an empty transcript (which
  finalized as a successful no-output extraction and deleted the previous
  extraction); they fail the job, which retries under its lease.
- `memory_reset` propagates deletion failures instead of reporting a
  successful reset while files survive, and refuses to run while a
  consolidation is in flight in the same process.
- A symlinked memory root is rejected by every memory tool (previously only
  descendants were checked, and search/note-writing bypassed the guard).
- Phase-2 completion updates the job row and the selected-input retention
  flags in one transaction (codex parity); a crash between them could let
  pruning delete inputs backing the consolidated artifacts.
- Secret redaction catches quoted keys in JSON/YAML tool payloads
  (`"password": "..."`); the aws pattern no longer emits a literal `$1`.
- `memory_read` can page past 256 KiB via `line_offset` (the byte cap now
  applies to the windowed output); the workspace diff cap counts UTF-8 bytes
  instead of UTF-16 code units; `memory_inspect` reports the promised phase-2
  success watermark; internal workspace walks no longer follow symlinked
  directories (a self-link looped forever).
- Developer-role messages are excluded from extraction transcripts (codex
  `sanitize_response_item_for_memories`).

### Changed

- **opencode data is read exclusively through the official API** — transcripts
  via `session.messages`, cross-project session discovery via `project.list` +
  per-project `session.list(scope=project, roots=true)`. `opencode.db` is
  never opened; the only SQLite left is the plugin's own `memory.db`.
- **The extraction agent has no tools** (codex parity: stage-1 is a raw
  prompt with an inline transcript). Previously it could read/glob/grep the
  host project — a poisoned transcript could induce unrelated file reads.
- `memory_search` ports codex's full search schema: `queries[]`, `match_mode`
  (`any` / `all_on_same_line` / `all_within_lines` with minimal-window
  pruning), `path` scoping, integer-cursor pagination (`next_cursor` /
  `truncated`), `context_lines`, and `normalized` comparison. Arg renames:
  `query` → `queries`, `limit` → `max_results`. The `since`/`until` time
  filter and no-query listing mode are unchanged.
- Citations are recorded and stripped in the new `experimental.text.complete`
  hook, before the final text is persisted — neither the UI nor stored
  history shows citation markup anymore (matching codex). Older hooks remain
  as fallbacks for pre-existing history.
- Memory mode is stamped and phase 1 pumped at the first `chat.message` of a
  session (codex stamps at thread creation); `session.status {type: idle}` is
  handled alongside the deprecated `session.idle` event.
- The manual write-pipeline test runs fully sandboxed (XDG overrides) and
  drives triggers through a persistent `opencode serve` — `opencode run`
  exits before the async extraction pass claims anything.

## [0.1.9] - 2026-07-11

### Fixed

- `disable_on_external_context` now works: pollution marking moved to the real
  `tool.execute.after` plugin hook (it previously listened for a nonexistent
  event-bus type and never fired).
- `max_unused_days` is now honored by the phase-1 prune (it was hardcoded to
  30 days there while phase-2 selection used the configured value, so raising
  it silently still pruned at 30).
- Reasoning/chain-of-thought parts are excluded from extraction transcripts,
  matching codex's rollout policy.
- A failed workspace diff no longer looks like "no changes" and falsely marks
  consolidation succeeded; the job now fails and retries (codex
  `failed_workspace_status`).
- A corrupt git baseline is recovered by re-initializing instead of failing
  every consolidation run (codex `reset_git_repository_sync`).
- Stuck unowned phase-2 jobs are recovered by the failure path (codex
  `failed_if_unowned`); the heartbeat no longer dies silently on store errors.
- The stage-1 claim cap follows `max_rollouts_per_startup` (1-128) instead of
  being silently limited to the execution concurrency of 8; the extraction
  timeout mirrors the 1h job lease so large transcripts cannot exhaust retries.
- Session deletion no longer triggers a consolidation attempt while
  `generate_memories` is off (the memorize agent is not registered then).
- The consolidation prompt no longer instructs shell commands or file deletion
  the sandboxed memorize agent cannot perform; stage-1 input restores codex's
  "empty string when unknown" contract; `memory_search` flags capped result
  sets; transcript head/tail truncation uses codex's 50/50 split.

### Changed

- README: clarified that no codex subscription or OpenAI account is needed,
  documented the model-selection precedence chain and `dedicated_tools: false`
  behavior, and corrected several claims (idle timing, read-only opencode.db
  access, redaction scope, sandbox wording, data layout).
- With `dedicated_tools: false` the injected memory guidance now uses codex's
  file-based wording instead of referencing unregistered `memory_*` tools.

## [0.1.8] - 2026-07-11

### Fixed

- Stage-1 output changes now enqueue global consolidation, so new extractions
  and deleted sessions trigger a phase-2 pass without waiting for the next
  session.idle. If phase 2 is already running, its lease is preserved and only
  the input watermark advances.
- Deleting a session whose stage-1 output was already consumed by phase 2 now
  enqueues a forgetting pass, so the diff drives removal of the stale memory.
- Shipped memory subagents (`memorize`, `memorize-extract`) now default-deny
  unknown tools so IDE and MCP integrations cannot bypass the shell/network
  restrictions.

## [0.1.7] - 2026-07-10

### Fixed

- Phase 2 now validates consolidation artifacts like codex (#32193): early
  no-diff succeed only when `MEMORY.md` exists and `memory_summary.md` starts
  with `v1`; after the consolidator, invalid artifacts fail the job without
  resetting the git baseline so INIT/repair can run again.
- Stage-1 extraction treats either empty `raw_memory` or empty `rollout_summary`
  as no-output (codex parity); previously only both-empty was discarded.

### Changed

- Re-synced `stage_one_system.md`, `consolidation.md`, and `read_path.md` from
  codex HEAD (were ~half the upstream size), re-applying the port's platform
  adaptations on top: the `<memory-citation>`/`<session_ids>` citation contract
  that `citation.ts` parses, `memory_search`/`memory_read`/`memory_add_note`
  tool guidance (the memory dir lives outside the workspace), per-session
  markdown rollout summaries with `session_id` metadata (codex references raw
  `.jsonl` rollouts via `rollout_path`/`thread_id`), and codex's
  memory-extension prompt blocks now rendered by `buildConsolidationPrompt`
  (prompts.rs parity). `stage_one_input.md` stays platform-shaped. New
  `tests/prompts.test.ts` guards the placeholder inventory and citation/tool
  contracts. Bumped `codex_ref` in `codex-map.yaml`.

## [0.1.6] - 2026-07-10

### Fixed

- Published package was missing every runtime asset outside compiled JS: `tsc`
  does not copy `src/templates/*.md` into `dist/`, and the bundled
  `opencode.json` was shipped at the package root while `injectAgentDefinitions`
  resolves it relative to `dist/src/` (`dist/opencode.json`). Memory extraction,
  consolidation, read-path injection, and agent auto-registration were all
  broken in the npm artifact (dev checkouts were unaffected). The build now
  copies templates to `dist/src/templates/` and `opencode.json` to `dist/`.
- Added a `prepack` smoke test (`scripts/smoke.ts`) that loads the built entry
  the same way opencode does (V1 module -> `server()` -> hooks) and exercises
  template reads and agent injection, so this class of packaging bug fails
  `npm pack`/`npm publish` instead of shipping. Pattern borrowed from
  opencode-gemini-auth's prepack import smoke test.

## [0.1.5] - 2026-07-08

(No functional changes — release artifact only.)

## [0.1.4] - 2026-07-08

### Fixed

- Plugin was published as TypeScript source (`"main": "src/index.ts"`) with no compiled JavaScript output, so the opencode binary could not load or execute it even though it appeared in the plugin list. The package now compiles to `dist/` with `tsc`, ships only compiled JS, and points `main`/`exports` at `dist/src/index.js`.
- `tools/control.ts` and `tools/memory.ts` used Bun path aliases (`@/...`) that `tsc` does not rewrite; they now import from `../src/*.js` so the compiled output resolves under Node/Bun module resolution.

## [0.1.3] - 2026-07-05

### Fixed

- `memory_reset` no longer breaks memory until restart: it closed the SQLite
  handle while the plugin kept using a cached store, so every subsequent
  hook-driven DB operation failed silently. The DB now stays open across resets
  (matching codex, which only wipes directories) and the store is no longer
  cached.
- Startup sub-session cleanup no longer can kill an in-flight consolidation:
  the cutoff was 30 minutes while consolidation is allowed 60; it is now
  90 minutes.

### Changed

- Internal cleanup: dead code removed, `node:crypto` short hash for summary
  filenames (was hand-rolled base36), template fill via `replaceAll`.

## [0.1.2] - 2026-07-04

### Added

- The `memorize` / `memorize-extract` sub-agents register themselves via the
  plugin `config` hook — no manual `agent` block needed anymore. Definitions
  come from the bundled `opencode.json`; a user-defined agent with the same
  name always wins. Skipped when `generate_memories` is off.

## [0.1.1] - 2026-07-04

### Fixed

- **Parity pass after a full subsystem audit vs codex** (`codex-map.yaml` now
  records every remaining deliberate divergence, and the drift script watches
  the config/lifecycle/pollution files where past blind spots lived):
  - `ensureBaseline` no longer commits over an existing baseline: the phase-2
    diff now spans last-success → now, so manual edits to `MEMORY.md` and
    ad-hoc notes actually reach consolidation instead of being silently
    baselined away.
  - Baseline reset re-initializes `.git` (fresh single-commit history) and
    `memory_reset` deletes `.git` too — deleted/redacted memory content is no
    longer recoverable from git history, matching codex.
  - Ad-hoc notes are never pruned (they are explicit user requests; codex
    keeps them permanently). The seeded instructions template regained
    codex's never-delete rule, `[ad-hoc note]` provenance tag, and
    prompt-injection warning.
  - Phase-2 retry semantics match codex: backoff (now 1 h) is enforced
    regardless of job status, the retry counter is no longer reset on claim,
    and retries never exhaust; stage-1 retry delay is 1 h; phase-2 lease 1 h;
    a failing consolidation no longer re-invokes the LLM on every idle event.
  - Multi-process safety: claims run in immediate transactions with
    per-claim ownership tokens; all finalizers require ownership + running
    status (a zombie worker can no longer clobber a re-claimed job's output);
    phase 2 confirms ownership one final time before resetting the baseline;
    the DB opens with a 5 s busy timeout.
  - `disable_on_external_context` now covers MCP tools (matched via
    `client.mcp.status()`), as the README already claimed.
  - Extraction sees full tool payloads (previously sliced to 200/500 chars
    per call) with a 600k-char (~150k-token) transcript budget, matching
    codex's evidence budget; `rollout_slug` is redacted; Bearer redaction is
    case-insensitive; injected AGENTS.md/`<skill>` blocks are excluded from
    extraction.
  - Path guard rejects symlinks per path component and hides dotfiles; the
    search walker skips symlinks and hidden files.
  - Sessions seen while `generate_memories: false` are permanently stamped
    `disabled` (codex stamps at thread creation) instead of being retroactively
    extractable after re-enabling; deleting a session now deletes its
    extracted memory and job (`session.deleted`).
  - `memory_reset` preserves per-session memory modes (disabled/polluted
    sessions stay excluded), matching codex `clear_memory_data`.
  - Summary truncation keeps head + tail with a marker instead of silently
    dropping the end of `memory_summary.md`.
- Phase 2 consolidation never actually ran: the git baseline was committed *after* the workspace rebuild, so the captured diff was always empty. The baseline is now established before the rebuild.
- Staging deleted files no longer throws (`isogit.add` → `isogit.remove`); previously any pruned rollout summary permanently broke baseline commits and diff capture.
- Stage 1 jobs stuck in `running` after a crash are reclaimed once their lease expires.
- Sessions with new activity after a successful extraction are re-extracted; `source_updated_at` and the success watermark now use the session's real `time_updated` instead of extraction wall-clock time.
- Phase 2 input selection kept dropping old-but-actively-cited memories (recent activity *or* recent usage now qualifies), and `pruneStage1Outputs` is now actually called each Phase 2 run.
- Citation usage was counted once per streaming delta instead of once per message part, inflating `usage_count`.
- Template substitution no longer expands `$&`/`$'`/`$n` patterns contained in transcripts or the memory summary.
- The plugin's own sub-sessions are isolated: no memory prompt injection, no phase-1 triggering on their idle events, and excluded from session capture at the SQL level.

### Added

- Full codex config parity for plugin options, using codex's exact names and defaults so the two stay easy to compare and sync: `generate_memories`, `use_memories`, `dedicated_tools`, `disable_on_external_context`, `max_raw_memories_for_consolidation`, `max_rollouts_per_startup` are now configurable (alongside the existing `extract_model`, `consolidation_model`, `max_unused_days`, `max_rollout_age_days`, `min_rollout_idle_hours`). Defaults now match codex (`max_rollout_age_days` 10, `min_rollout_idle_hours` 6, `max_rollouts_per_startup` 2, `max_raw_memories_for_consolidation` 256). One intentional divergence: `dedicated_tools` defaults to `true` (codex: `false`) so the plugin ships its memory tools out of the box.
- `memory_search` supports `since`/`until` for time-scoped recall over time-anchored files (rollout summaries, ad-hoc notes); with a window and no query it returns a chronological listing of that period's sessions/notes. Extends beyond codex.
- `memory_list` tool (port of codex `memories/list`): sorted directory listings with entry types; hidden files and symlinks are skipped.
- `memory_read` supports `line_offset`/`max_lines` with start-line reporting, so `file:line` citations work on large files.
- Numeric plugin options are clamped to codex's valid ranges; unknown option keys log a warning; `use_memories: false` now also hides the memory tools (codex extension gating).
- Default model selection mirrors codex's split via opencode's own config: unset `extract_model` uses opencode's `small_model` (codex: `gpt-5.4-mini`), unset `consolidation_model` uses opencode's main `model` (codex: `gpt-5.4`); both fall back to the session default when not configured.

### Changed

- **Renamed to `opencode-codex-memory`** for npm publishing (`opencode-memex` is
  taken by an unrelated plugin). Plugin id, log prefixes, baseline commit
  author/message, the test-root env var (`OPENCODE_CODEX_MEMORY_TEST_ROOT`), and
  the sub-session title prefix (`codex-memory-`) all follow. Sub-sessions titled
  with the old prefix are no longer auto-cleaned or excluded from capture —
  delete any stragglers from before the rename.
- **Behavior change (parity):** `memory_search` is now case-sensitive by default (pass `case_sensitive: false` for the old behavior), searches all non-hidden files instead of only `.md`/`.txt`/`.json`, and returns results in `(path, line)` order with a default limit of 200. Ad-hoc note filenames use codex's hyphen layout (`<timestamp>-<slug>.md`) and never overwrite on collision.
- **Behavior change from new defaults:** memory now waits longer before extracting a session (idle ≥6h, was ≥1h), only looks back 10 days (was 14), and processes at most 2 sessions per pass. Web/MCP sessions are no longer excluded from memory by default — set `disable_on_external_context: true` to restore that.
- Renamed the `generate_memory` option to `generate_memories` to match codex; update your `opencode.json` if you set it.
- **Codex memory parity pass** (breaking: reset local memory state — DB schema, summary filenames, and memory_summary schema all changed):
  - All three prompt templates replaced with full adaptations of codex's memory prompts: stage-1 extraction (minimum-signal gate, task outcome triage, preference-signal extraction, task-grouped raw_memory format), Phase 2 consolidation (MEMORY.md Task Group schema, `v1` memory_summary schema with User Profile / User preferences / General Tips / What's in Memory, skills format, diff-driven forgetting workflow), and the read path (decision boundary, budgeted quick memory pass, staleness guidance).
  - System/input prompt split for extraction (system via prompt body's `system` field); all-empty output is a supported no-op that deletes any stale stage-1 row.
  - Rich citations: `citation_entries` with `file:line-range|note=[...]` plus a `session_ids` block (legacy format still parses).
  - Forgetting: disabled/polluted sessions are excluded from Phase 2 selection so their workspace files disappear and the diff drives memory pruning; `selected_for_phase2` snapshots are tracked and protected from retention pruning.
  - Job claiming mirrors codex: retry backoff respected, newer session activity overrides backoff and resets exhausted retries, leases cleared on completion/failure.
  - Session `cwd` captured and rendered through raw_memories.md and rollout summaries; summary files named `<timestamp>-<shorthash>-<slug>.md`; transcripts strip citation blocks and truncate head+tail.
  - `extensions/ad_hoc/instructions.md` seeded; resource pruning is filename-timestamp based and never touches notes or instructions; `extract_model` and `consolidation_model` plugin options wired to sub-agent prompts.
- `phase2_workspace_diff.md` now matches codex's format: a `## Status` listing plus a `## Diff` section with the real unified content diff since the last consolidation (per-file diffs rendered in full, total bounded at 4 MiB with a truncation marker). Previously the consolidation agent only got the file-status list. The artifact is removed before diffing and before baseline commits so it never enters baseline history.
- Full implementation of the codex memory architecture as a standalone opencode plugin (`opencode-codex-memory`).
- **Stage 0 (Read path MVP)**: `memory_summary.md` (≤2500 tokens) is read from `~/.local/share/opencode/memories/` and injected into every system prompt via `experimental.chat.system.transform`. Byte-identical append → provider cache stable.
- **Stage 1 (Tools + Citations)**:
  - Tools: `memory_read`, `memory_search`, `memory_add_note`.
  - Citation parser for `<memory-citation><citation_entries>...</citation_entries></memory-citation>`.
  - Citations are stripped from assistant output via `experimental.chat.messages.transform`.
  - Usage recording stub (wired in Stage 2).
- **Stage 2 (SQLite + Phase 1 extraction)**:
  - Plugin-owned SQLite DB (`memory.db`) with `memory_stage1_outputs`, `memory_jobs`, `memory_session_meta`, and schema versioning.
  - `MemoryStore` with claim/lease/heartbeat, stage-1 CRUD, usage counters, session mode/pollution tracking.
  - Session capture via read-only access to `opencode.db` + `session.idle` trigger.
  - Secret redaction before LLM calls and storage.
  - Phase 1 extraction via `memorize-extract` sub-agent over the HTTP API.
- **Stage 3 (Phase 2 consolidation)**:
  - Workspace management (`raw_memories.md`, `rollout_summaries/`, `skills/`, `extensions/`).
  - Git baseline diffing inside the memories directory (bundled `isomorphic-git`, no external binary).
  - Phase 2 orchestration with 6h cooldown, 90s heartbeat, and singleton job claim.
  - Consolidation via the sandboxed `memorize` sub-agent.
  - Ships `opencode.json` with `memorize` and `memorize-extract` agent definitions (network/tools denied).
- **Stage 4 (Control tools)**:
  - `memory_reset` (with symlink guard and confirm flag).
  - `memory_inspect` (counts, token estimate, file listing).
  - `memory_mode` (per-session enabled/disabled/polluted).
- **Stage 5 (Polish)**:
  - Rate-limit stub (`checkRateLimit`).
  - Comprehensive unit tests (42 tests).
- Basic read-path integration harness (`tests/integration.ts`) and a detailed manual/agentic write-pipeline test procedure (`tests/WRITE_PIPELINE_TEST.md`) added. No automated Jest/Bun end-to-end harness yet.
  - Documentation: `README.md`, `RUNNING.md` (official opencode + plugin install), implementation plan preserved.
  - Plugin renamed from its `opencode-memory` working title.

### Changed

- All hooks are wrapped in try/catch with graceful degradation (plugin crash does not affect the host session).
- The workspace diff is truncated at 4 MiB with an explicit marker.
- Event handlers defensively catch per-operation errors (recordUsage, markPolluted).

### Security

- Sub-agents (`memorize`, `memorize-extract`) have `bash`/`webfetch`/`websearch`/`task`/`todowrite` denied.
- `memory_reset` refuses to run if the memories root is a symlink.
- Aggressive secret redaction (OpenAI/Anthropic/AWS/GitHub/Slack keys, bearer tokens, private keys, password assignments) before any LLM call or storage.
- With `disable_on_external_context: true`, sessions that used web or MCP tools are marked `polluted` and excluded from extraction (off by default, matching codex).

## [0.1.0] - 2026-07-02

Initial public development release. All stages (0–5) implemented and tested. Ready for manual end-to-end testing against the official opencode release.

[Unreleased]: https://github.com/moritzfl/opencode-codex-memory/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/moritzfl/opencode-codex-memory/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/moritzfl/opencode-codex-memory/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/moritzfl/opencode-codex-memory/compare/v0.1.9...v0.2.0
[0.1.9]: https://github.com/moritzfl/opencode-codex-memory/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/moritzfl/opencode-codex-memory/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/moritzfl/opencode-codex-memory/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/moritzfl/opencode-codex-memory/compare/v0.1.3...v0.1.6
[0.1.3]: https://github.com/moritzfl/opencode-codex-memory/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/moritzfl/opencode-codex-memory/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/moritzfl/opencode-codex-memory/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/moritzfl/opencode-codex-memory/releases/tag/v0.1.0