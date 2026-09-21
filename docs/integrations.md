# Sharing and importing memory

[Documentation home](../README.md#start-here) · [Configuration](configuration.md)

You do not need Codex CLI or Claude Code to use this plugin. If you also use
them on the same machine, these optional integrations can reuse what they
have learned. Both are off by default.

| Integration | Direction | Supported memory writer |
|---|---|---|
| Codex CLI sharing | Import, export, or both | **Memory V1 only** |
| Claude Code import | Claude Code → this plugin | Memory V1 and Memory V2 |

With dual-write enabled, Codex exchange runs through Memory V1 only;
it does not transfer the handbook into Memory V2. Claude
imports run for each active writer.

Examples on this page are **plugin options**. Put them in the
[options object in your config](configuration.md#where-to-put-options),
then restart its server. Leave background learning enabled for import and
export to run as part of consolidation.

## Sharing memory with the Codex CLI

Enable either direction or both:

```json
{
  "codex_interop": {
    "import": true,
    "export": true
  }
}
```

- **Import:** during this plugin's consolidation, durable memory from Codex is
  incorporated into the Memory V1 store with an origin tag.
- **Export:** after successful Memory V1 consolidation, validated memory is
  placed where Codex can merge it on its next consolidation pass.

No changes to Codex's config are required. Codex must already have created
its own memory workspace (`$CODEX_HOME/memories`); the plugin does not
bootstrap it. Codex's primary memory files are not rewritten in place.
Export writes an extension that Codex's consolidator can read.

### Codex options

All fields are inside `codex_interop`:

| Option | Default | Meaning |
|---|---|---|
| `import` | `false` | Bring Codex's consolidated memory into this plugin's Memory V1 workspace. |
| `export` | `false` | Offer this plugin's Memory V1 memory to Codex. |
| `codex_home` | `$CODEX_HOME`, otherwise `~/.codex` | Codex CLI's data location. |

The exchange instructions use `[from codex]` / `[from opencode]` tags and tell
each consolidator to skip re-importing the other side's content, limiting
feedback loops. Overlapping Codex and plugin memory roots disable exchange.

Check `memory_inspect` for the resolved paths and `codex_interop` status.
With `version: "v2", dual_write: false`, it reports exchange as disabled
because the Memory V1 writer is inactive.

### Stop Codex sharing

Set `import` and/or `export` back to `false`, or remove `codex_interop`, and
restart OpenCode. This stops future exchange. Already consolidated memories
remain, and existing staging copies are left on disk. The last export in
Codex remains there until Codex consolidates it away or you remove it there.

To remove local import staging too, first turn import off, then delete
`extensions/codex_import/` under the Memory V1 workspace. Keep import off or
the next pass will recreate it. A later consolidation can then remove
entries supported only by those missing imports.

## Importing memory from Claude Code

Enable import of Claude Code's project memories:

```json
{
  "claude_import": {
    "enabled": true
  }
}
```

On a later consolidation pass, durable facts from Claude's memories can join
OpenCode's own learned content. Project details retain project context;
general preferences can appear in the global summary. Nothing is written
back to Claude Code.

### Claude options

All fields are inside `claude_import`:

| Option | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Turn import on. |
| `claude_home` | `~/.claude` | Claude Code's data location. |
| `projects` | All resolvable projects | Optional allowlist of Claude project folder IDs. An empty list also means all projects. |

To find project IDs, list Claude's project directories:

```sh
ls ~/.claude/projects
```

Use those folder names, rather than your working directory paths:

```json
{
  "claude_import": {
    "enabled": true,
    "projects": ["-Users-you-Desktop-git-my-app"]
  }
}
```

Projects without a resolvable on-disk working directory are skipped. Check
the `claude_import` section of `memory_inspect` for status. Claude import can
be combined with Codex sharing; each has its own staging directory.

### Stop or narrow Claude import

To stop all further import, set `enabled: false` or remove `claude_import`,
then restart OpenCode. Already merged memory and staging copies remain.

To remove staging copies too, turn import off first, then delete
`extensions/external_agent_import/` from each memory workspace that imported
Claude data. Keep import off or a later pass will recreate them. The next
consolidation can remove knowledge supported only by those deleted inputs.

To stop importing only some projects, keep import enabled and remove their
IDs from a **nonempty** `projects` allowlist. Removing the entire list or
leaving it empty imports all projects. Dropped projects, or deleted source
memories, have their staging copies removed on the next pass. Their derived
content is cleaned up through consolidation rather than deleted instantly.

If you run another plugin that writes the same long-term memory store,
choose one writer to avoid conflicting edits. For workspace locations and
backups, see [Storage and privacy](storage-and-privacy.md).
