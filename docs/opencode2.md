# opencode2 support

This plugin runs on both hosts from a single package entry:

- opencode 1.x reads `server()` (V1 hooks, `opencode.json` → `agent` map).
- opencode2 reads `id` + `setup()` (V2 context API, `src/v2/*` adapter).

Install for opencode2:

```jsonc
// opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "opencode-codex-memory@0.6.5", "options": { "min_rollout_idle_hours": 1 } },
  ],
}
```

All V1 plugin options (`generate_memories`, `use_memories`,
`dedicated_tools`, `disable_on_external_context`, `extract_model`,
`consolidation_model`, numeric clamps, `codex_interop`, `claude_import`)
apply unchanged — option parsing is shared (`applyPluginOptions`).

## How it works

The entire memory pipeline (extraction → consolidation → injection →
citation feedback against the global `~/.local/share/opencode` workspace)
runs byte-identical on both hosts. `src/v2/shim.ts` presents a V1-shaped
client façade over the V2 plugin context, so `phase1/phase2/capture/llm`
execute the same code paths. Only genuinely missing V2 surfaces are
adapted; everything else is hook translation (`src/v2/plugin.ts`):

| V1 | V2 |
| --- | --- |
| `config` hook agent injection | `agent.transform` ensure (update creates) |
| returned `tool` map | `tool.transform` (same `tools/*` logic via adapter) |
| `chat.message` pump | `prompt` hook |
| `system.transform` injection | `context` hook (`system.push({type:"text",…})`) |
| `text.complete` + `messages.transform` citations | `context` hook record + strip |
| `tool.execute.before` pollution | `tool.execute.before` (same hook name) |
| `session.status idle` / `session.idle` pump | `session.execution.succeeded` event |
| `session.deleted` cleanup | liveness (`session.get` → NotFound) in phase 2 |
| `experimental/session` global discovery | process-local session registry |

## Deliberate V2 differences

- **No session deletion.** V2 has no remove API. Helper sessions are
  interrupted and released; their rows remain as inert, clearly titled
  (`codex-memory-*`) history. Extraction uses `generate.text` and creates
  no session at all.
- **Registry-based discovery.** `ctx` exposes no session list and raw HTTP
  is unauthenticated from plugins, so discovery reads sessions observed via
  `session.created` + the prompt hook (with `parentID` backfill to keep
  excluding subagent children). A cold boot sees sessions from admission
  on; prior extraction rows still drive consolidation.
- **Citations stripped from model context only.** V2 has no pre-persist
  hook, so `<memory-citation>` markup stays in stored history (visible in
  the UI) while the context hook removes it before every model call.
  Usage counts are exact within a process (per-message dedupe).
- **No `small_model`/`model` config defaults.** V2 exposes no config API
  to plugins, so unset `extract_model`/`consolidation_model` fall back to
  the session default. Set them explicitly to mirror V1 model routing.
- **Both agents ship; only `memorize` works.** Extraction runs sessionless
  through `generate.text`, so `memorize-extract` is provisioned hidden and
  unused (V1 likewise skips injecting unused agents).

## Sidebar status

The package's `./tui` entry adds a **Memory** section to the session sidebar.
OpenCode2 loads it automatically alongside the server plugin. `/memory-status`
(also **Show memory status** in the command palette) opens effective models,
read/write settings, import status, retry eligibility, and warnings.

- Status is global, using the same job snapshots as `memory_inspect`.
- The UI refreshes on pipeline events and reconciles every five seconds while
  loaded, including changes made by another worker; viewing it never starts jobs.
- A disconnected or unavailable server shows **Unavailable**, not stale **Idle**.
- **Last success** is shown only when the latest recorded consolidation attempt
  succeeded; `—` means no clean success timestamp is available for that attempt.
- TUI dependencies are optional peers supplied by OpenCode2; V1 loads only the
  server entry. The build compiles Solid JSX and ships the result under `dist/`.
- TUI rules learned the hard way: `setup()` must only claim slots —
  `keymap.layer` throws outside a Solid component scope, so it lives in an
  `app`-slot component; never render `<Show>` (or any conditional) with element
  children directly under `<box>` — its empty placeholder is a bare text node
  and the renderer rejects it. Use unconditional lines with placeholders.
- The TUI bundle must import only `@opencode/plugin/tui`, `solid-js`, and
  `@opentui/solid`: the CLI sandbox does not resolve `zod` or
  `@opencode/plugin/rpc`, so the status contract (`src/v2/status-rpc.ts`) is
  plain JSON Schema with a hand-written guard.

For a local wrapper, add `tui.ts` beside its `index.ts`, re-exporting the built
`dist/src/v2/tui.js` default export, then run `bun run build` in this repository.

## Verify

```bash
bun run typecheck && bun test && bun run build
bun run smoke        # V1 entry
bun run contract     # V1 host surface
bun run contract:v2  # V2 host surface (needs the opencode2 service)
```
