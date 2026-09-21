# Memory panel

[Documentation home](../README.md#start-here) · [Using memory](usage.md)

In OpenCode 2's terminal UI, open **`/memory`** (alias **`/memory-status`**) or
choose **Show memory status** from the command palette. A compact **Memory**
indicator also appears in the session sidebar.

The panel works with either memory implementation. On OpenCode 1.x or in an
interface without this panel, ask the agent to run `memory_inspect` instead.
For setup, see [Install](../README.md#install).

## Memory panel and controls

Status shows which memory version your conversation uses, learning progress,
Memory V2 readiness, settings, and warnings. It refreshes while open; checking
status does not start learning. Memory is global, so work from another window
can appear here.

| Control | What it does |
|---|---|
| **Use memories** | Turn recall on or off |
| **Learn from sessions** | Pause or resume background learning |
| **Learn from this session** | Include or exclude this conversation from future learning |
| **Consolidate now** | Process eligible sessions and update memory without waiting for the usual consolidation cooldown |

The first two toggles last until the server restarts. Use
[`use_memories` / `generate_memories` in config](configuration.md#learning-and-recall)
for persistent settings. The per-session learning setting persists.

**Consolidate now** requires learning to be enabled. Sessions must still meet
the [idle and age limits](configuration.md#frequency-and-retention); it does
not learn every conversation immediately.

If the panel shows **Unavailable**, or progress seems stuck, follow
[Troubleshooting](troubleshooting.md). To choose a different memory
implementation, use [Memory V1 and Memory V2](memory-versions.md).
