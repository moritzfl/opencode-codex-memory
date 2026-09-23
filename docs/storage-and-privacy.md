# Storage and privacy

[Documentation home](../README.md#start-here)

Memory is stored on your machine as Markdown files and plugin-owned SQLite
databases. You can inspect it with ordinary file tools. This page covers the
data layout, backups, relocation, removal, and what reaches your model provider.

## Where your data lives

The default memory home is `$XDG_DATA_HOME/opencode` when `XDG_DATA_HOME` is
set, otherwise `~/.local/share/opencode`. The same resolution applies on
macOS, Linux, and Windows.

```text
~/.local/share/opencode/
├── memory.db                    # Memory V1 jobs/extracts + shared session metadata
├── memories/                    # Memory V1 workspace
│   ├── memory_summary.md        # compact summary supplied to the agent
│   ├── MEMORY.md                # searchable handbook
│   ├── rollout_summaries/       # published session recaps
│   ├── skills/                  # reusable procedures
│   └── extensions/              # explicit notes and optional imports
├── memory_v2.db                 # Memory V2 jobs/extracts
└── memories_v2/                 # Memory V2 workspace
    ├── memory_summary.md        # the memory itself, with recap pointers
    ├── rollout_summaries/       # published session recaps
    └── extensions/              # explicit notes and supported imports
```

Memory V2 files are used when that version is enabled; you do not need both
workspaces to start with the default Memory V1. Both can also contain working
files, an internal `.git/` for change tracking, and additional skills or
extension resources. Explicit notes live under `extensions/ad_hoc/notes/`.

**Memory V2 still needs `memory.db`** because it holds shared session modes
and memory-version selections. Do not remove it just because you selected
`version: "v2"`. The plugin accesses OpenCode's conversations through the
host API, not by opening OpenCode's own database.

Ask the agent to run `memory_inspect` to see the actual `home`, `memory_root`,
`jobs_db`, and `session_meta_db` paths for your setup. A conversation opened
before a [memory-version switch](memory-versions.md) can still use its original
workspace.

## One global memory across projects

Each memory version has one global store, shared across your projects. That
lets preferences and useful procedures follow you into a new repo. Project
paths and task context help the agent distinguish project-specific details;
they are routing hints, not hard storage boundaries.

This follows Codex's design. A preference such as “use table-driven tests” may
apply across many repositories, and worktrees or monorepos make rigid
per-directory boundaries awkward. The trade-off is that unrelated project
details can occasionally surface. See the
[design explanation](how-ai-memory-works.md#design-trade-offs-worth-learning-from)
for more context.

## Backup and restore

The databases and workspaces belong together. Restoring only Markdown or
only a database can leave learned content, job state, and change history out
of sync.

1. Stop every OpenCode server using this memory home, including any shared
   background service or IDE-managed process.
2. Copy the plugin's files into a dated backup: `memory.db`, `memories/`,
   and, when present, `memory_v2.db` and `memories_v2/`.
3. Include hidden workspace files, especially `.git/`, and any SQLite
   `-wal` or `-shm` sidecar files for both databases.
4. Start OpenCode again.

If you use a dedicated `home`, back up that whole directory. Backing up the
entire default OpenCode data directory also includes memory, but includes
OpenCode's other data too.

To restore, stop the same servers, replace the plugin files with the complete
matching backup, and then restart. Avoid merging a backup into an active
workspace or mixing files from different backup dates.

## Relocating memory

The plugin chooses its home in this order (first match wins):

1. The **`home` plugin option**.
2. **`OPENCODE_CODEX_MEMORY_HOME`**, if `home` is unset.
3. The default OpenCode data directory described above.

Either explicit setting pins only memory to that location; subsequent
changes to `XDG_DATA_HOME` do not move it. Use an absolute path; `~` expands
to your home directory. Project-relative paths are not accepted.

Set this inside your [plugin options](configuration.md#where-to-put-options):

```json
{
  "home": "/path/to/opencode-memory"
}
```

Setting `home` does not move existing data. To preserve it:

1. Stop all OpenCode servers using the old home.
2. Copy all plugin databases, sidecars, and workspaces listed under
   [Backup and restore](#backup-and-restore) into the new directory.
3. Set `home` and restart OpenCode.
4. Ask the agent to run `memory_inspect` and verify the resolved paths.

For a sandbox mount, mount the dedicated home at the **same absolute path**
inside the sandbox. Use `home` instead of symlinking `memories/` or
`memories_v2/`; the plugin refuses symlinked memory roots.

## Editing, deleting, and resetting

You can read and edit memory files yourself. Consolidation uses workspace
changes to incorporate edits and remove knowledge whose supporting evidence
has disappeared. These updates happen on a later consolidation pass, not
instantly throughout every file. For everyday corrections,
[ask the agent to save a correction note](usage.md#save-or-correct-a-note).

Ask the agent to run **`memory_reset`** when you want to start over; OpenCode
asks you to approve it. On OpenCode 2, use **Reset memory** in the
[memory panel](usage.md#memory-panel) instead. Reset clears learned state and **both Memory V1 and Memory V2
workspaces**, including their internal Git history. It preserves session
learning modes and per-session memory-version selections. It does not delete
OpenCode conversations or memories in Codex CLI or Claude Code.

Reset can refuse to run while consolidation is active or when a memory root
is a symlink. Check the reported reason before retrying. If learning remains
enabled, eligible conversations can later be learned again; enabled imports
can also bring external memories back.

## What is sent to a model?

Local storage does not mean offline processing. Background extraction sends
filtered conversation content to your extraction model, and consolidation
uses your selected model to update memory. The summary and any retrieved
memory become context for ordinary OpenCode replies. These calls use your
existing OpenCode providers and credentials; the plugin has no credentials
or remote memory service of its own.

- **Redaction:** transcripts and extracted records pass through secret
  redaction for API keys, tokens, passwords, and private keys. Explicit notes
  are stored as dictated; manually written memory is not a substitute for
  keeping secrets out of notes.
- **Restricted learning agents:** the extractor receives its transcript inline
  and can only return structured output. The consolidator can use file tools
  within the memory workspace. Shell, network, IDE, and MCP tools are denied
  to the learning agents.
- **External context:** sessions using web search, fetch, or MCP tools remain
  eligible by default. Set `disable_on_external_context: true` if you want
  those sessions excluded from learning.

Codex CLI sharing and Claude Code import are optional and off by default.
Their file exchanges are described under [Integrations](integrations.md).
