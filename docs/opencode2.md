# opencode2 support

This plugin runs on both hosts from a single package entry:

- opencode 1.x reads `server()` (V1 hooks, `opencode.json` → `agent` map).
  If 1.x also invokes `setup`, it is a no-op unless the argument is a V2
  `Plugin.Context` (`session.hook` + `location.directory`).
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

The memory pipeline (extraction → consolidation → injection → citation
feedback against the global `~/.local/share/opencode` workspace) runs the
same V1 modules on both hosts. `src/v2/shim.ts` presents a V1-shaped client
façade over the V2 plugin context, so `phase1/phase2/capture/llm` execute
the same code paths. Missing V2 surfaces are adapted in `src/v2/*`; a few
shared files also gained dual-format parsers (citation XML + fence). Hook
translation (`src/v2/plugin.ts`):

| V1 | V2 |
| --- | --- |
| `config` hook agent injection | `agent.transform` ensure (update creates) |
| returned `tool` map | `tool.transform` (same `tools/*` logic via adapter) |
| `chat.message` pump | `prompt` hook |
| `system.transform` injection | `context` hook (`system.push({type:"text",…})`) with a V2-only fenced citation overlay |
| `text.complete` + `messages.transform` citations | `session.text.ended` durable accounting + `context`/`compaction`/`generate` strip |
| `tool.execute.before` pollution | `tool.execute.before` (same hook name) |
| `session.status idle` / `session.idle` pump | `session.execution.succeeded` event |
| `session.deleted` cleanup | `session.deleted` event → same `handleSessionDeleted` as V1; helpers via public `session.remove` |
| `experimental/session` global discovery | authenticated public `session.list` with cursor pagination |
| V1 `session.messages` | authenticated public `message.list` (full persisted history) |

## Deliberate V2 differences

- **Registered service is required for global reads.** V2 reads the XDG
  `service.json` registration (never `Service.ensure()`, never 2.0.3
  `Service.discover()` which still probes `/api/health`). It preserves
  basic-auth headers and accepts the endpoint only when `GET /api/status`
  reports this process's PID (`version` + `pid`; 2.0.5 `/api/health` is
  404). Legacy JSON `/api/health` `{healthy:true,pid,version}` still
  counts. If no matching service is registered, global discovery reports
  unavailable — including plain `opencode serve` talking to another host.
- **Global discovery is complete.** The adapter follows public
  `session.list` cursors and uses public `session.message.list` for full persisted
  history. Helper sessions are excluded by durable metadata and the cleanup
  sweep reclaims them after a restart; `session.context` is not used for
  transcript capture.
- **Agents are location-scoped.** V2 provisions the agents in the active
  plugin location and creates helper sessions in that same location. The
  consolidation agent's read/edit/search/glob permissions are allowlisted
  only under the memory workspace; all other actions remain denied. A global
  OpenCode plugin install therefore provisions the agents as each active
  location loads the plugin.
- **Citations are accounted durably.** `session.text.ended` is the primary
  hook because it contains the completed text after durable commit. A SQLite
  reconciliation table deduplicates `(assistant message, cited session)`
  pairs across duplicate events, context calls, and process restarts. The
  `context`, `compaction`, and `generate` hooks strip citation markup before
  the next model call; retained markup in persisted history is harmless and
  can be rendered by the TUI. V1 still instructs XML citations; V2 overlays
  the fenced form used by the sidebar renderer.
- **Config and models are explicit.** V2 adapts public config documents for
  the shared resolver. V2 configs do not provide V1's `small_model` field;
  unset `extract_model` uses the session default, while
  `consolidation_model` uses the configured `model` when present. Set both
  plugin options explicitly for deterministic routing. Extraction cancel
  uses the public client's `generate.text(input, { signal })` when the
  registered service is available; otherwise it races the host AbortSignal.
  Helper delete succeeds only after `session.remove` plus a confirmed 404.
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
  `./server` entry and does not import V2 runtime dependencies. The build
  compiles Solid JSX and ships the result under `dist/`.
- TUI rules learned the hard way: `setup()` must only claim slots —
  `keymap.layer` throws outside a Solid component scope, so it lives in an
  `app`-slot component; never render `<Show>` (or any conditional) with element
  children directly under `<box>` — its empty placeholder is a bare text node
  and the renderer rejects it. Use unconditional lines with placeholders.
- The TUI bundle must import only `@opencode/plugin/tui`, `solid-js`, and
  `@opentui/solid` (not `@opentui/core`): the CLI sandbox does not resolve
  `zod`, `@opencode/plugin/rpc`, or core. Status RPC (`src/v2/status-rpc.ts`)
  is plain JSON Schema with a hand-written guard. Citation fences render as
  ordinary code blocks.

For a local wrapper, add `tui.ts` beside its `index.ts`, re-exporting the built
`dist/src/v2/tui.js` default export, then run `bun run build` in this repository.

## Verify

```bash
bun run typecheck && bun test && bun run build
bun run smoke        # V1 entry
bun run contract     # V1 host surface
bun run contract:v2  # V2 host surface (needs the opencode2 service)
```
