# opencode-memex — development log

## 2026-07-02: project scaffold

- Initialized project at `/Users/moritz/Desktop/git/opencode-memex`
- Moved `implementation-plan.md` from codex repo
- Created package.json, tsconfig.json, .gitignore, README.md
- Created source structure:
  - `src/index.ts` — plugin entry with `experimental.chat.system.transform`, `event`, `dispose`, `tool` hooks
  - `src/paths.ts` — path helpers (memoryRoot, memoryDbPath, opencodeDbPath, memorySummaryPath)
  - `src/token.ts` — token estimate (chars/4) + truncate utility
  - `src/source.ts` — read memory_summary.md, cache by mtime, render read_path.md template, inject into system prompt
  - `src/templates/read_path.md` — system prompt fragment (adapted from codex)
- Created test structure:
  - `tests/token.test.ts` — unit tests for token estimation
  - `tests/paths.test.ts` — unit tests for path helpers
- Created empty dirs: `tools/`, `src/templates/`

## Next: Stage 0 completion

Stage 0 is scaffolded but not yet functional. To complete it:
1. Install dependencies: `bun install`
2. Verify the plugin loads in opencode
3. Write a `memory_summary.md` by hand and verify injection works
4. Then proceed to Stage 1 (tools + citations) per implementation-plan.md