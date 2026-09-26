# Troubleshooting

[Documentation home](../README.md#start-here)

Start by asking the agent to run **`memory_inspect`**. In OpenCode 2's
terminal UI, **`/memory-inspect`** shows the same underlying status.
These checks are read-only; opening status does not start learning.

## Memory has not appeared yet

An empty store immediately after installation is normal. By default,
sessions need six hours of inactivity, extraction processes up to two
sessions per pass, and consolidation has its own six-hour cooldown.
OpenCode must be running for background work to happen. Sessions with
nothing durable to retain can produce no output.

In `memory_inspect`, check:

| Field | What it tells you |
|---|---|
| `read_version`, `memory_root` | Which memory version and workspace this conversation uses |
| `pipeline_v1`, `pipeline_v2` | Progress for each memory store present |
| `stage1_outputs`, `stage1_jobs` | How much extraction has completed and whether jobs are waiting or failing |
| `phase2_status`, `phase2_last_error` | Whether consolidation has run, is waiting, or failed |
| `discovery` | Whether the plugin could find past conversations |
| `v2_discovery_source`, `v2_discovery_warning` | OpenCode 2 listing source: `service`/`context` for global discovery, `observed` for a limited fallback, or `not_checked`; the warning includes the failure reason |
| `config_warnings`, effective options | What configuration actually took effect |
| `agent_config` and agent health | Whether memory helpers have the required setup and permissions |

To try a shorter wait, set the plugin option `min_rollout_idle_hours: 1`
(the minimum) and restart the server. On OpenCode 2, **Consolidate now** skips
the consolidation cooldown but still respects session eligibility.

## Common symptoms

| Symptom | Check or action |
|---|---|
| Config changed, but behavior did not | Verify the options are inside the plugin entry and restart the server, including a shared or IDE-managed server. Inspect effective values and warnings. |
| Switched to Memory V2, but still see Memory V1 | Start a new conversation. Existing sessions keep the memory version selected on their first memory use, even across restarts. |
| No `MEMORY.md` in `memories_v2/` | Expected: Memory V2 uses a summary and recaps, without a handbook. |
| Memory V2 summary starts with `v1` | That first line is the summary **file-format marker**, not the selected memory behavior. Check `read_version` instead. |
| `v2_ready` stays false | Memory V2 needs a valid summary and one successful consolidation consuming at least 20 distinct sessions by default. See [readiness](memory-versions.md#2-check-readiness-and-the-new-summary). |
| `discovery` failed or the panel says **Unavailable** | Check OpenCode's server as described below. Existing memory can still be recalled. |
| `discovery` says `ok`, but `v2_discovery_source` is `observed` | Only this process's observed sessions were listed. Check `v2_discovery_warning` for the global discovery failure; the memory panel also reports it. |
| Extraction errors mention rate limits or usage limits | Check `provider_capacity_backoff` and retry times. Capacity errors retry after about an hour when quota returns; `other_exhausted` indicates other exhausted failures. |
| Consolidation never completes | Read `phase2_last_error` and agent health. Failed artifacts leave workspace changes for a later retry. |
| Codex sharing stopped after switching memory versions | Codex exchange needs the Memory V1 writer. Memory V2-only learning disables it; see [Integrations](integrations.md). |
| Retrieval tools are missing, or the agent says they are not in this runtime | Check `use_memories` and `dedicated_tools`. On OpenCode 2 they are normal tools, not tools inside `execute`. Maintenance tools remain available. Restart the server after upgrading the plugin. |

## Check OpenCode's server

On **OpenCode 2**, check and, if needed, restart the shared service:

```sh
opencode service status
opencode service restart
```

If an IDE manages a separate OpenCode server, restart that server after a
plugin/config change. Without a registered service, learning can be limited
to conversations seen by that server; existing memory can still be recalled.

On **OpenCode 1.x**, restart OpenCode and confirm that you are using a
[supported version](../README.md#install). Check `memory_inspect` for any
remaining discovery errors.

The plugin runs inside OpenCode's Bun process. You do not need to install or
launch it as a standalone Node application.

## Updating the plugin

1. Check the [npm release](https://www.npmjs.com/package/opencode-codex-memory)
   and [changelog](../CHANGELOG.md).
2. Change only the package pin in your existing plugin entry, for example
   `opencode-codex-memory@0.9.2`. Keep your options.
3. Restart the OpenCode server and check memory status.

OpenCode caches installed package specs. A bare `opencode-codex-memory`
entry does not reliably refresh itself to the latest release. Use an explicit
published version; an unpublished pin causes installation to fail.

An optional helper command is available at
[`commands/update-plugins.md`](commands/update-plugins.md). Copy it to
`~/.config/opencode/commands/update-plugins.md` on OpenCode 2, or
`~/.config/opencode/command/update-plugins.md` on OpenCode 1.x, then run
`/update-plugins`. It checks all pinned npm plugins and asks before editing.
This command is a separate convenience file, not installed with the plugin.

Updating the plugin release is separate from selecting **Memory V2**.
For that change, use the [memory-version guide](memory-versions.md).
