# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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