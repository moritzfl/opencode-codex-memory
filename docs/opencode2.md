# OpenCode 2

The same package runs on OpenCode 1.x and OpenCode 2. Memory still lives in
`~/.local/share/opencode/` and uses the same options. Pin the version — OpenCode
installs a plugin spec once and does not follow “latest”.

## Install

In your OpenCode 2 config (`opencode.jsonc` or equivalent):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "opencode-codex-memory@0.7.0", "options": { "min_rollout_idle_hours": 1 } },
  ],
}
```

OpenCode 1.x keeps the older `"plugin": ["opencode-codex-memory@0.7.0"]` form.

All V1 options apply unchanged: `generate_memories`, `use_memories`,
`dedicated_tools`, `disable_on_external_context`, `extract_model`,
`consolidation_model`, the numeric clamps, `codex_interop`, and `claude_import`.

## What you get

On OpenCode 2 the session sidebar grows a **Memory** section. `/memory-status`
(also **Show memory status** in the command palette) opens the same snapshot
`memory_inspect` uses: effective models, read/write settings, import status,
retry eligibility, and warnings.

- Status is global. Another window’s work shows up here.
- The panel refreshes on its own while it is open. Opening it does not start
  extraction or consolidation.
- **Use memories** / **Learn from sessions** / **Learn from this session**
  toggle injection and whether sessions are eligible.
- **Consolidate now** extracts idle sessions and rebuilds the summary, skipping
  the usual 6-hour cooldown. Turn learning on first. It runs in the background.
- If the OpenCode 2 service is missing or not this process, the panel shows
  **Unavailable**, not a stale Idle. **Last success** is only a clean
  consolidation timestamp; `—` means there isn’t one for that attempt.

## Where it differs from 1.x

Same memories, not the same host. These are the limits that show up in use:

**Background learning needs this app’s local service.** The plugin lists
sessions through the documented HTTP client (`@opencode/client`, bundled)
against the OpenCode 2 instance that registered itself for this process.
A plain `opencode serve` talking to some other host will not see those sessions,
so extraction across projects will not run there. Injection of an already-built
summary still works.

**Citation blocks can stay in the saved transcript** so the sidebar can render
them. They are stripped before the next model call. OpenCode 1.x removes them
before the reply is stored.

**Set `extract_model` and `consolidation_model` if you care which models run
in the background.** OpenCode 2 has no `small_model`. Unset extraction uses the
session default; consolidation uses the configured `model` when present.

**Helper work still cannot edit your repo.** OpenCode 2 registers the memory
agents in the project you have open, so those short-lived sessions are created
there. Their file tools are allowlisted only under the memory folder.

Full 1.x install and configuration: [README](../README.md).
