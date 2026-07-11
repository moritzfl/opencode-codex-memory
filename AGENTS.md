# AGENTS.md

Guidance for agents working on `opencode-codex-memory`.

## What this is

A TypeScript port of codex's memory system, packaged as a standalone opencode
plugin. Read `ARCHITECTURE.md` before changing memory behavior — it explains the
design and the load-bearing workarounds (D1–D5).

## Staying aligned with codex

This plugin mirrors codex's Rust memory implementation. Alignment is tracked, not
assumed:

- `codex-map.yaml` — provenance map: each source file → its codex origin, plus the
  codex commit last audited (`codex_ref`).
- `scripts/check-codex-drift.sh` — reports moved/renamed upstream files and any
  changes to codex memory code since `codex_ref`.

Before changing anything in the memory pipeline:

1. Find the upstream source for the file in `codex-map.yaml`.
2. Run `CODEX_REPO=/path/to/codex ./scripts/check-codex-drift.sh`.
3. If it reports drift, read the upstream diff and either port it intentionally or
   record a deliberate divergence in that mapping's `note:`.
4. Bump `codex_ref` / `codex_ref_date` once re-audited.

Do not put alignment *status* in prose (it rots). Facts live in `codex-map.yaml`;
this file only points at the procedure.

## Design invariant

Memory is **global**. Project/cwd separation exists only as a soft routing hint
inside `src/templates/consolidation.md` and the read-path prompt, mirroring codex.
Do not add schema-level, read-path, or job-level project partitioning unless codex
does it first. If you believe scoping is needed, confirm codex's current behavior
via the drift script before proposing structural changes.

## Conventions

- `./gradlew` is not used here. Dev commands: `bun install`, `bun test`,
  `bun run typecheck`, `bun run build`, `bun run smoke`.
- Store/DB tests use a temp root via `OPENCODE_CODEX_MEMORY_TEST_ROOT`.
- Templates in `src/templates/*.md` are ported from codex with deliberate
  platform adaptations (citation tags, memory-tool guidance, session metadata,
  placeholder inventory). **Never byte-copy them from codex.** Before syncing a
  template, read its mapping `note:` in `codex-map.yaml` and re-apply the listed
  adaptations; `tests/prompts.test.ts` fails on contract breaks.
- Every agent shipped in `opencode.json` must use an allowlist: `"*": "deny"`
  first, followed only by the built-in opencode file tools it requires. Never
  allow shell, network, task delegation, IDE, or MCP tools; that is the sandbox
  (D2), and `tests/agents.test.ts` enforces it.

## Packaging & releases

- Runtime assets must ship inside `dist/`: `bun run build` compiles and copies
  `src/templates/` and `opencode.json` there. Anything the plugin reads via
  `import.meta.dirname` at runtime has to exist under `dist/` in the published
  package — `bun run smoke` loads the built entry the way opencode does and
  runs automatically at prepack, gating `npm pack`/`npm publish`.
- npm versions are immutable: fix a broken release by bumping the patch
  version, never by re-publishing.
- opencode installs npm plugins once into `~/.cache/opencode/packages/<spec>/`
  and never re-resolves while `node_modules/` exists there; delete those dirs
  to pick up a new release. To test the packed artifact without publishing:
  `npm pack`, install the tarball into a scratch dir, and point a test
  config's `plugin` at the installed directory (`file://...`) — or install it
  into the cache dir and use the bare npm spec.

## Commit hygiene

- Do not add `Co-Authored-By` trailers. Keep messages concise and factual.
- Only commit/push when explicitly asked.
