# Contributing

Thanks for your interest in improving `opencode-codex-memory`.

## What this project is (and isn't)

This repo has one goal: **a faithful port of codex's memory system to
opencode**. It is not a general-purpose memory plugin, and it does not aim to
grow its own feature set.

**Any PR that breaks parity with the codex memory implementation will be
rejected.** That includes, concretely:

- Adding memory features codex doesn't have (e.g. schema-level or job-level
  project partitioning — memory is global, see the design invariant in
  `AGENTS.md`).
- Changing pipeline behavior (extraction, consolidation, retention, redaction,
  citations, rate gating) in ways that diverge from codex without a documented
  reason.
- Renaming options or defaults away from their codex counterparts
  (`MemoriesToml` / `MemoriesConfig`).

Divergences are sometimes necessary — opencode's plugin API is not codex's
runtime. Those are fine **only** when they are deliberate and recorded as a
`note:` on the relevant mapping in `codex-map.yaml`. See `ARCHITECTURE.md`
(D1–D5) for the existing load-bearing workarounds.

## Before you open a PR

1. Read `ARCHITECTURE.md` and `AGENTS.md`.
2. If the change touches memory pipeline behavior or a file listed in
   `codex-map.yaml`, find its upstream source there and run the drift check
   against a local codex checkout:

   ```bash
   CODEX_REPO=/path/to/codex ./scripts/check-codex-drift.sh
   ```

   If upstream moved since `codex_ref`, port the change intentionally (or
   record a deliberate divergence), then bump `codex_ref` / `codex_ref_date`.

   Skip this step for pure plugin/host fixes that have no codex counterpart
   (opencode integration, packaging, host API adapters, tooling, docs-only,
   and similar). Still keep any divergence from mapped behavior deliberate
   and noted in `codex-map.yaml` if you touch those paths.

## Development

```bash
bun install
bun test
bun run typecheck
bun run build && bun run smoke && bun run contract
```

GitHub Actions runs `bun test`, typecheck, build, and smoke on every PR to
`main`. Live host checks (`contract`, `live:*`) stay manual.

Live checks against the **official** opencode binary (XDG-sandboxed; needs
provider auth + a configured model — never touches your real memory home):

```bash
bun run live:read    # system-prompt injection only
bun run live:e2e     # full write pipeline (Phase 1 + 2 + closed loop)
```

- Store/DB tests use a temp root via `OPENCODE_CODEX_MEMORY_TEST_ROOT`.
- Templates in `src/templates/*.md` are ported from codex with deliberate
  platform adaptations — never byte-copy them from upstream. Read the mapping
  `note:` in `codex-map.yaml` first; `tests/prompts.test.ts` guards the
  citation/tool/placeholder contracts.
- Every agent shipped in `opencode.json` must start its permissions with
  `"*": "deny"` and allow only the built-in opencode file tools it needs.
  Shell, network, task delegation, IDE, and MCP tools must remain denied;
  `tests/agents.test.ts` enforces this sandbox.
- On each opencode release: `bun run contract` (OpenAPI + hook surface), then
  prefer `bun run live:e2e` before bumping `@opencode-ai/plugin`.

## Commits

- Concise, factual messages (`type: summary`, matching the existing history).
- No `Co-Authored-By` trailers.
