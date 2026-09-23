# Using memory

[Documentation home](../README.md#start-here)

After [installation](../README.md#install), use OpenCode normally. The plugin
learns in the background and makes past context available to later
conversations. You can steer it with ordinary requests.

## What to expect after installation

Memory takes time to build:

1. A session becomes eligible for **extraction** after six hours of inactivity
   by default. Sessions older than ten days are skipped by default.
2. Extraction records useful information from eligible sessions. A conversation
   with nothing durable to retain can produce no memory.
3. **Consolidation** combines extracted records and explicit notes into the
   files used for recall. It normally has a six-hour cooldown.
4. Later model requests receive the updated summary automatically.

The pipeline runs while OpenCode is running, triggered by conversation
activity and idle events. It is not a separate scheduled service that keeps
learning after OpenCode stops. See [Configuration](configuration.md#frequency-and-retention)
to adjust the thresholds.

## Recall past work

Try asking:

- “What do you know about how I work?”
- “What was I working on in this repo last week?”
- “How did we fix the deployment issue last time?”

The agent receives a compact summary and can look up supporting memory files
when useful. Memory V1 uses a handbook and recaps; Memory V2 primarily uses
the summary and follows recap pointers for more detail. See
[Memory V1 and Memory V2](memory-versions.md) if you want to choose between them.

Memory is historical context. The agent is instructed to verify facts that
may have changed when verification is useful, and to distinguish recalled
information from currently confirmed behavior.

## Save or correct a note

Say “Remember that I deploy this project with `make release`.” With the default
tools enabled, the agent saves a small note using `memory_add_note`; the next
consolidation integrates it into memory. This is useful even before automatic
learning has processed your first session.

For a correction, be explicit: “Update your memory: we now use `bun test`, not
`npm test`, in this repo.” The correction is recorded as a note for the
consolidator. It does not rewrite the summary immediately.

Notes go to the current conversation's selected memory version. During
dual-write, they are not copied directly to the other workspace. See
[reading and learning selection](memory-versions.md#how-reading-and-learning-are-selected).

## Check progress

Ask “Check my memory status” to have the agent run **`memory_inspect`**. It
shows the current session's memory version, both pipelines' progress when
present, effective options, resolved storage paths, recent errors, and config
warnings. Checking status does not start learning.

### Memory panel

In **OpenCode 2's terminal UI**, open **`/memory-inspect`**
or choose **Inspect memory** from the command palette. A compact
**Memory** indicator also appears in the sidebar. The panel works with both
memory implementations and refreshes while open. Because memory is global,
work from another window can appear here too.

The recap count is the **total stored**, not a count of unconsolidated sessions.
Extraction and consolidation have separate status rows. **Queued** can appear
right after a successful consolidation if another extraction finishes after
the run's input snapshot. The panel shows when the six-hour consolidation
cooldown ends; the next activity or idle event can then start another run.
**Retry** indicates a failed attempt, with extraction errors shown under
**Attention**, and is separate from that normal cooldown.

The panel is fully keyboard-accessible:

| Key | Action |
|---|---|
| `Tab` / `Shift+Tab`, or `←` / `→` | Switch Overview and Controls |
| `↑` / `↓` | Scroll Overview or select a control |
| `Enter` / `Space` | Toggle the selected setting or run the selected action |
| `Home` / `End` | Jump to the first or last control, or the top or bottom of Overview |
| `PgUp` / `PgDn` | Scroll a page |
| `r` | Refresh status or retry a failed connection |
| `Esc` | Close the panel and return to the prompt |

Tabs and controls also respond to left-clicks. Long content scrolls; the tabs
and keyboard hints stay visible in smaller terminals. While a change is being
applied, its control shows **Saving…** or **Starting…**. A lost connection keeps
the last known status visible and pauses controls until a refresh succeeds.

The panel offers the [learning and recall controls](#pause-learning-or-recall)
below, plus **Consolidate now**. This processes eligible sessions and updates
memory without waiting for the usual consolidation cooldown. Learning must be
enabled, and sessions must still meet the [idle and age limits](configuration.md#frequency-and-retention).

**Reset memory** erases all learned memory and notes, like `memory_reset`.
Press Enter once to arm it and again to confirm; moving the selection cancels.
OpenCode 2 cannot ask you to approve a plugin tool call, so the agent does not
get a reset tool there.

On OpenCode 1.x or an interface without the panel, use `memory_inspect`.
If the panel shows **Unavailable**, see [Troubleshooting](troubleshooting.md).

## Pause learning or recall

Learning from a conversation and using existing memory are separate controls:

| Goal | Control |
|---|---|
| Exclude this conversation from future extraction | Ask the agent to use `memory_mode` with `mode: "disabled"`. On OpenCode 2, turn off **Learn from this session**. |
| Allow this conversation to be learned again | Use `memory_mode` with `mode: "enabled"`, or turn **Learn from this session** back on. Re-enabling a session excluded for external context needs your approval (OpenCode 1.x) or the panel toggle (OpenCode 2). |
| Pause background learning globally | Set the plugin option `generate_memories: false`. OpenCode 2 also has a runtime **Learn from sessions** toggle. |
| Stop injecting and looking up existing memory | Set `use_memories: false`. OpenCode 2 also has a runtime **Use memories** toggle. |
| Stop both learning and recall | Set both `generate_memories` and `use_memories` to `false`. |

The two global panel toggles last until the server restarts. Use the
[configuration file](configuration.md) for persistent settings. Per-session
learning modes persist across restarts and apply to both memory writers.

Disabling a session controls future extraction; it does not immediately erase
already consolidated information or hide existing memory from the conversation.
For data removal, see [Editing, deleting, and resetting](storage-and-privacy.md#editing-deleting-and-resetting).

## Tools the agent can use

You normally describe what you want rather than calling tools yourself.

| Tool | Purpose |
|---|---|
| `memory_read` | Read a file in the selected memory workspace |
| `memory_search` | Search memory text, including time-scoped session recall |
| `memory_list` | List files and directories in memory |
| `memory_add_note` | Record something you explicitly asked to remember |
| `memory_inspect` | Inspect status, configuration, and errors without changing memory |
| `memory_mode` | Set a session's learning eligibility (`enabled`, `disabled`, or `polluted`) |
| `memory_reset` | Clear learned memory in both versions after you approve it (OpenCode 1.x; on OpenCode 2 use **Reset memory** in the panel) |

The first four depend on `use_memories` and `dedicated_tools`; the maintenance
tools remain available. See [File-based access](configuration.md#file-based-access)
if you prefer ordinary file tools.

If learning or recall seems stuck, start with [Troubleshooting](troubleshooting.md).
