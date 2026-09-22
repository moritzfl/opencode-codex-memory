# Configuration

[Documentation home](../README.md#start-here)

The default setup works without plugin options. Use this page when you want
to choose background models, change learning frequency, or turn features on
and off.

## Where to put options

Edit the plugin entry in your global `~/.config/opencode/opencode.jsonc` or
`opencode.json`. These examples change the idle threshold to two hours.
Merge the change into your existing entry rather than adding the plugin twice.

### OpenCode 2.x

Options go inside the plugin object's `options` field:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-codex-memory@0.8.4",
      "options": {
        "min_rollout_idle_hours": 2
      }
    }
  ]
}
```

### OpenCode 1.x

Options are the second element of a `[package, options]` pair:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["opencode-codex-memory@0.8.4", { "min_rollout_idle_hours": 2 }]
  ]
}
```

The examples below that contain only options belong **inside that options
object**, not at the top level of OpenCode's config.

### Apply and verify changes

Restart the OpenCode server after editing its config. For OpenCode 2's shared
service, run `opencode service restart`; for OpenCode 1.x or an IDE-managed
server, restart the process that runs OpenCode.

Ask the agent to run `memory_inspect`. It reports effective values after
parsing, numeric clamping, and fallback, plus warnings about malformed or
unknown keys. Invalid plugin options produce warnings rather than preventing
OpenCode from starting.

## Choose background models

Memory learning has two jobs:

- **Extraction** reads one past session and records what is worth keeping.
  A less expensive model can handle this job.
- **Consolidation** combines those records into coherent memory. A more
  capable model is useful here.

To control both explicitly, set these plugin options. Replace the placeholders
with `provider/model` IDs available in your OpenCode setup:

```json
{
  "extract_model": "provider/your-extraction-model",
  "consolidation_model": "provider/your-consolidation-model"
}
```

If unset, consolidation uses your configured OpenCode `model`; extraction
uses OpenCode's default for its helper session. On OpenCode 1.x, an explicitly
configured `small_model` is used for extraction first. When upgrading to
OpenCode 2, set `extract_model` if you want to keep that cheaper model.

The plugin requests low reasoning effort for extraction and medium for
consolidation when supported. Full fallback rules are in the
[architecture reference](../ARCHITECTURE.md#background-model-selection).

Background learning consumes your provider quota. Enabling `dual_write` adds
a second independent learning pipeline and therefore additional model calls.

## Learning and recall

| Option | Default | Effect |
|---|---|---|
| `generate_memories` | `true` | Run background extraction and consolidation. Set to `false` to pause learning while keeping existing memory available. |
| `use_memories` | `true` | Inject the summary and make memory retrieval/note tools available. Setting this to `false` does not stop background learning. |
| `dedicated_tools` | `true` | Expose `memory_read`, `memory_search`, `memory_list`, and `memory_add_note`. See [File-based access](#file-based-access). |
| `disable_on_external_context` | `false` | Exclude sessions that used web search, fetch, or MCP tools from learning. |

To stop both learning and recall, set both `generate_memories` and
`use_memories` to `false`. To exclude just one conversation from future
extraction, use [session controls](usage.md#pause-learning-or-recall).

## Memory version

These select **Memory V1/V2**, independently of your OpenCode host version.
See [Memory V1 and Memory V2](memory-versions.md) for the comparison and
switching walkthrough.

| Option | Default | Effect |
|---|---|---|
| `version` | `"v1"` | Memory version for new sessions; also the only writer when `dual_write` is off. Accepts `"v1"` or `"v2"`. Existing sessions retain their selected memory version. |
| `dual_write` | `false` | Run both memory learning pipelines independently while sessions read their selected version. Useful for trying Memory V2 with a current Memory V1 fallback. |

## Frequency and retention

“Rollout” in option names means a past conversation or session. Numeric
options are clamped to the following integer ranges.

| Option | Default | Range | Effect |
|---|---|---|---|
| `min_rollout_idle_hours` | `6` | 1–48 | Minimum inactivity before a session is eligible for extraction. |
| `max_rollout_age_days` | `10` | 0–90 | Ignore sessions older than this during extraction. |
| `max_rollouts_per_startup` | `2` | 1–128 | Maximum sessions extracted per pass, per active memory writer. |
| `max_raw_memories_for_consolidation` | `256` | 1–4096 | Maximum extracted session records selected for one consolidation pass. Applies to both memory versions. |
| `max_unused_days` | `30` | 0–365 | Retention horizon for unused extracted session records. |

Consolidation normally has a six-hour cooldown. OpenCode 2's
[Consolidate now control](usage.md#memory-panel) can skip that
cooldown; sessions must still meet extraction eligibility rules.

## Storage and integrations

| Option | Default | Details |
|---|---|---|
| `home` | OpenCode data directory | Absolute directory for all plugin databases and memory workspaces. See [Relocating memory](storage-and-privacy.md#relocating-memory). |
| `codex_interop` | `{ "import": false, "export": false }` | Exchange consolidated memory with Codex CLI. Requires the Memory V1 writer. See [Codex CLI sharing](integrations.md#sharing-memory-with-the-codex-cli). |
| `claude_import` | `{ "enabled": false }` | Import Claude Code project memories. See [Claude Code import](integrations.md#importing-memory-from-claude-code). |

## File-based access

`dedicated_tools: false` keeps learning, summary injection, and citation
tracking working. Instead of dedicated memory tools, the agent receives
instructions to use its normal file tools and to save explicit notes under
`extensions/ad_hoc/notes/` in the selected memory workspace.

Because memory lives outside the project, file-based access may require an
OpenCode `external_directory` permission. Agents that cannot obtain that
permission cannot use this mode. Dedicated tools avoid that extra step, which
is why this plugin enables them by default even though Codex defaults them off.

`memory_inspect`, `memory_mode`, and `memory_reset` remain available with
dedicated tools disabled. Setting `use_memories: false` hides the retrieval
and note tools regardless of `dedicated_tools`.
