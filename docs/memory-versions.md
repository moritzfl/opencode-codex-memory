# Memory V1 and Memory V2

[Documentation home](../README.md#start-here) · [Configuration](configuration.md)

**Both Memory V1 and Memory V2 are direct ports from
[OpenAI Codex](https://github.com/openai/codex), which offers the same two
memory versions.** This plugin brings each version's learning and recall
behavior to OpenCode, with adaptations for OpenCode's plugin APIs.

## Which version do I need?

**Memory V1 is the default; Memory V2 is opt-in.** Both work on OpenCode 1.x
and 2.x. Choose based on how you want memory to behave.

Both versions learn from past sessions in the background, inject a small
summary, and keep their data locally. Their difference is how they turn
individual requests into long-term guidance.

| | Memory V1 — default | Memory V2 — opt-in |
|---|---|---|
| Main goal | Anticipate your working style from past tasks | Preserve task history and be more cautious about inferring standing preferences |
| What the agent reads | A summary that points to a searchable handbook (`MEMORY.md`), recaps, and skills | A summary containing the memory itself, with recaps for additional evidence |
| Standing preferences | More willing to promote task-level instructions into reusable guidance | Looks for an explicit default or evidence across distinct tasks |
| Trade-off | Can overgeneralize a one-time request | May need more repetition or clarification; no handbook to search |
| Workspace | `memories/` | `memories_v2/` |

For example, “show me a plan before editing **this**” can become a broad
planning preference in Memory V1. Memory V2 aims to retain it as a request
from that task unless you state it as a general preference or repeat it
across tasks. Neither version makes memory a guarantee of current facts.

Keep Memory V1 if its recall suits you. Consider Memory V2 if memory keeps
applying one-off instructions to unrelated work. For an illustrated explanation
of the underlying changes, see [the design comparison](how-ai-memory-works.md#two-versions-v1-and-v2).

## How reading and learning are selected

`version` chooses the default for new sessions. `dual_write` chooses whether
one or both versions learn in the background:

| Plugin options | New sessions read | Background learning writes |
|---|---|---|
| `"version": "v1", "dual_write": false` | Memory V1 | Memory V1 |
| `"version": "v1", "dual_write": true` | Memory V1 | Both versions |
| `"version": "v2", "dual_write": true` | Memory V2 | Both versions |
| `"version": "v2", "dual_write": false` | Memory V2 | Memory V2 |

This table assumes `generate_memories: true`. Each conversation keeps the
memory version selected on its first memory use, even across server restarts.
Its summary, retrieval tools, explicit notes, and citation tracking all use
that same workspace. **Start a new conversation after switching versions.**

Dual-write means both pipelines learn independently from eligible conversation
history. It adds model calls; it does not copy or convert the existing Memory
V1 handbook into Memory V2. An explicit “remember this” note is saved only to
the requesting session's selected workspace.

## Try Memory V2 with an existing Memory V1 store

### 1. Build Memory V2 while continuing to use Memory V1

Add these fields to your existing plugin options, using the
[configuration example](configuration.md#where-to-put-options):

```json
{
  "version": "v1",
  "dual_write": true
}
```

Restart OpenCode's server as described in [setup](../README.md#2-restart-opencode-and-check-status).
Continue working normally while both pipelines learn.

### 2. Check readiness and the new summary

Ask the agent to run `memory_inspect`, or open `/memory` in OpenCode 2's
terminal UI. **`v2_ready: true`** means:

- Memory V2 currently has a valid summary; and
- at least one successful Memory V2 consolidation consumed **20 distinct
  sessions** by default.

The count is the largest number of distinct sessions consumed by one
successful consolidation, not a sum across runs. Consolidating the same one
session repeatedly cannot reach 20. Pruning does not reduce this count;
resetting memory clears it.

Readiness is a progress indicator, not a quality guarantee or a switch. Read
`memories_v2/memory_summary.md` under your [memory home](storage-and-privacy.md#where-your-data-lives)
to assess the result. The `min_consolidated_threads` argument to
`memory_inspect` can change the reporting threshold (1–4096); it does not
change configuration or memory behavior.

### 3. Switch new conversations to Memory V2

Change the options to:

```json
{
  "version": "v2",
  "dual_write": true
}
```

Restart the server and start a **new conversation**. Run `memory_inspect`
there to verify `read_version: v2`. Older conversations retain their original
memory version.

### 4. Choose whether to keep both writers

Keep `dual_write: true` while evaluating Memory V2 if you want Memory V1 to
continue learning too. Once you want only Memory V2 to learn, set
`dual_write: false` and restart the server.

If you use **Codex CLI sharing**, keep the Memory V1 writer enabled for that
integration. It exchanges the Memory V1 handbook and does not import into or
export from Memory V2. [Claude Code import](integrations.md) works with either
memory writer.

## Start directly with Memory V2

If you are starting fresh or are comfortable building a new store from
eligible session history, set these plugin options:

```json
{
  "version": "v2",
  "dual_write": false
}
```

Restart the server and begin a new conversation. There is no readiness gate
that prevents using Memory V2. Its summary may initially be empty; existing
Memory V1 files are kept in their separate workspace.

## Switch back to Memory V1

Set `version: "v1"`, restart the server, and start a new conversation. Leave
`dual_write: true` if you still want both versions to learn; use `false` if
you want only Memory V1 learning.

If dual-write was off while you used Memory V2, Memory V1 did not learn during
that time. Once re-enabled, it can process sessions that are still eligible;
older sessions may be outside the extraction age window. Queued consolidation
for an inactive store resumes when its writer is enabled again.

## Shared controls and separate data

- Each version has its own workspace and extraction/job database. `memory.db`
  also holds shared session metadata, so it is still needed with Memory V2.
- Disabled/polluted session flags apply to both writers.
- Deleting a session removes its extracted records from both stores and queues
  forgetting; consolidated text is updated on a later pass.
- `memory_reset` clears **both** memory workspaces and their learned state. It
  preserves session modes and per-session memory-version selections.

See [Storage and privacy](storage-and-privacy.md) before backing up, moving,
or resetting a store.
