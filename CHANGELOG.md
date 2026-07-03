# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Phase 2 consolidation never actually ran: the git baseline was committed *after* the workspace rebuild, so the captured diff was always empty. The baseline is now established before the rebuild.
- Staging deleted files no longer throws (`isogit.add` → `isogit.remove`); previously any pruned rollout summary permanently broke baseline commits and diff capture.
- Stage 1 jobs stuck in `running` after a crash are reclaimed once their lease expires.
- Sessions with new activity after a successful extraction are re-extracted; `source_updated_at` and the success watermark now use the session's real `time_updated` instead of extraction wall-clock time.
- Phase 2 input selection kept dropping old-but-actively-cited memories (recent activity *or* recent usage now qualifies), and `pruneStage1Outputs` is now actually called each Phase 2 run.
- Citation usage was counted once per streaming delta instead of once per message part, inflating `usage_count`.
- Template substitution no longer expands `$&`/`$'`/`$n` patterns contained in transcripts or the memory summary.
- memex's own sub-sessions are isolated: no memory prompt injection, no phase-1 triggering on their idle events, and excluded from session capture at the SQL level.

### Added

- **Codex memory parity pass** (breaking: reset local memory state — DB schema, summary filenames, and memory_summary schema all changed):
  - All three prompt templates replaced with full adaptations of codex's memory prompts: stage-1 extraction (minimum-signal gate, task outcome triage, preference-signal extraction, task-grouped raw_memory format), Phase 2 consolidation (MEMORY.md Task Group schema, `v1` memory_summary schema with User Profile / User preferences / General Tips / What's in Memory, skills format, diff-driven forgetting workflow), and the read path (decision boundary, budgeted quick memory pass, staleness guidance).
  - System/input prompt split for extraction (system via prompt body's `system` field); all-empty output is a supported no-op that deletes any stale stage-1 row.
  - Rich citations: `citation_entries` with `file:line-range|note=[...]` plus a `session_ids` block (legacy format still parses).
  - Forgetting: disabled/polluted sessions are excluded from Phase 2 selection so their workspace files disappear and the diff drives memory pruning; `selected_for_phase2` snapshots are tracked and protected from retention pruning.
  - Job claiming mirrors codex: retry backoff respected, newer session activity overrides backoff and resets exhausted retries, leases cleared on completion/failure.
  - Session `cwd` captured and rendered through raw_memories.md and rollout summaries; summary files named `<timestamp>-<shorthash>-<slug>.md`; transcripts strip citation blocks and truncate head+tail.
  - `extensions/ad_hoc/instructions.md` seeded; note pruning is filename-timestamp based and never touches instructions; `extract_model` and `consolidation_model` plugin options wired to sub-agent prompts.
- `phase2_workspace_diff.md` now matches codex's format: a `## Status` listing plus a `## Diff` section with the real unified content diff since the last consolidation (per-file diffs over 64 KiB are stubbed, total bounded at 4 MiB with a truncation marker). Previously the consolidation agent only got the file-status list. The artifact is removed before diffing and before baseline commits so it never enters baseline history.
- Full implementation of the codex memory architecture as a standalone opencode plugin (`opencode-memex`).
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
  - Git baseline diffing inside the memories directory (shells out to `git`).
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
  - Plugin renamed from `opencode-memory` to `opencode-memex` for clarity.

### Changed

- All hooks are wrapped in try/catch with graceful degradation (plugin crash does not affect the host session).
- Phase 2 aborts early if the workspace diff exceeds 4 MiB.
- Event handlers defensively catch per-operation errors (recordUsage, markPolluted).

### Security

- Sub-agents (`memorize`, `memorize-extract`) have `bash`/`webfetch`/`websearch`/`task`/`todowrite` denied.
- `memory_reset` refuses to run if the memories root is a symlink.
- Aggressive secret redaction (OpenAI/Anthropic/AWS/GitHub/Slack keys, bearer tokens, private keys, password assignments) before any LLM call or storage.
- Sessions that used web tools are marked `polluted` and excluded from extraction.

## [0.1.0] - 2026-07-02

Initial public development release. All stages (0–5) implemented and tested. Ready for manual end-to-end testing against the official opencode release.

[Unreleased]: https://github.com/anomalyco/opencode-memex/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/anomalyco/opencode-memex/releases/tag/v0.1.0