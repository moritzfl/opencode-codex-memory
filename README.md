# OpenCode Codex Memory

<p align="center">
  <a href="https://www.npmjs.com/package/opencode-codex-memory">
    <img src="https://img.shields.io/npm/v/opencode-codex-memory?logo=npm&amp;label=latest" alt="Latest npm version" />
  </a>
  <a href="https://www.npmjs.com/package/opencode-codex-memory">
    <img src="https://img.shields.io/npm/dt/opencode-codex-memory?logo=npm&amp;label=downloads" alt="npm downloads" />
  </a>
</p>

Persistent memory for [OpenCode](https://opencode.ai): your agent remembers what
it learned in past sessions — your conventions, your projects, the decisions you
made — and brings that context into new conversations automatically.

Despite the name: **no Codex subscription or OpenAI account is needed.** This
project is a faithful port of the memory system in OpenAI's Codex. It works out
of the box with zero extra configuration and uses whatever models you already
have set up in OpenCode.

See the [changelog](./CHANGELOG.md) for release history.

**Local-first by design.** Memory is plain markdown files plus a small SQLite
database on your own machine — no memory service to sign up for, no MCP server,
no separate process, no sync. Installing it is one line in your `opencode.json`;
from there everything lives under `~/.local/share/opencode/`, so you can read it,
grep it, edit it, or delete it like anything else you own. Nothing leaves your
machine beyond the model calls OpenCode already makes.

If you *do* also use the Codex CLI or Claude Code on the same machine: the
plugin can bring their memories in (and, for Codex, push ours back). Off by
default — see [Sharing memory with the Codex CLI](#sharing-memory-with-the-codex-cli)
and [Importing memory from Claude Code](#importing-memory-from-claude-code).

## Why

By default every OpenCode session starts from zero. You re-explain your build
commands, your code style, and the quirks of each repo over and over.

This plugin closes that loop. It reviews finished sessions in the
background, keeps what's durable — your preferences, how a repo is built, what
worked and what didn't — and puts that context back in front of the agent in
later conversations. You don't manage any of it; OpenCode just gets more useful
the more you use it.

If you want the mental model before the details, jump to
[How it works](#how-it-works).

## Install

**1. Add the plugin** to your `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["opencode-codex-memory@0.6.3"]
}
```

Pin the version — OpenCode installs a plugin spec once and never re-resolves
it, so a bare `"opencode-codex-memory"` is not "always latest". Check
[npm](https://www.npmjs.com/package/opencode-codex-memory) for the current
version.

**2. That's it.** The memory workspace is created on first use; background
learning starts immediately.

Requires OpenCode 1.18 or newer. Models and other options: see
[Configuration](#configuration).

### Installation hints

To bump pins, copy
[`docs/commands/update-plugins.md`](./docs/commands/update-plugins.md) to
`~/.config/opencode/command/update-plugins.md` and run `/update-plugins`.
This command is not part of the plugin package — nothing about it is
installed with the plugin. It works for every pinned plugin in your config,
not just this one.

## Try it

Just use OpenCode normally. Sessions that have been idle for a few hours get
reviewed in the background and memory starts building up — you don't have to do
anything. Come back the next day and ask something like *"what do you know about how I
work?"* or *"what was I doing in this repo?"* and the agent draws on what it
learned. The more you use it, the more it knows.

You can also steer it in plain language, mid-conversation:

- *"remember that I deploy this project with `make release`"* → saved as a note.
- *"what was I working on in this repo last week?"* → time-scoped recall.
- *"reset my memory"* → wipes it and starts over.

Want to prime it before the first session has a chance to be learned? You can
drop a starter summary in yourself — it's just a file:

```bash
mkdir -p ~/.local/share/opencode/memories
echo 'I prefer TypeScript strict mode and 2-space indentation.' \
  > ~/.local/share/opencode/memories/memory_summary.md
```

## How it works

You don't need to know any of this to use the plugin. The design is Codex's,
ported as-is, and it does what any memory system has to do: decide what's worth
keeping, write it down so it can be found again, surface the right piece at the
right moment, and forget what stopped being useful.

Think of it as three jobs: two background writers and one reader. **Nothing here
runs while you're waiting for a reply** — an assistant that stops to take notes
mid-answer would be slower and more expensive, so the learning happens after the
fact, on transcripts of conversations that are already over.

**Phase 1 — read one finished session, write notes about it.** Once a
conversation has been idle long enough that it's clearly done (default 6 h), the
plugin fetches that transcript, strips secrets out of it, and hands it to a
cheap model with one question: *what from this is worth keeping?* The answer
comes back as structured data — a detailed note plus a short recap of the
session — and lands in a local SQLite database. One session in, one record out.
Sessions are independent, so this part is easy to parallelize and to retry when
it fails.

**Phase 2 — merge all those notes into one memory.** Every few hours at most
(and only one run at a time across all your OpenCode windows), a second pass
takes the most relevant per-session notes and rewrites the actual memory files:
`MEMORY.md` as the full index, `memory_summary.md` as the short version, and
`skills/` for procedures worth repeating. This is where the interesting work
happens — ten similar observations collapse into one rule, contradictions get
resolved, and notes nothing ever used age out. Forgetting is a feature: memory
that only grows is memory that stops being useful.

The split exists because the two halves have opposite needs. Phase 1 is
per-session and can run many at once; phase 2 touches the single shared memory,
so it has to be serialized. Keeping them apart means one slow or failing session
extraction can't corrupt or block the shared store.

**The read path — actually remembering.** Every turn, the short summary is
appended to the system prompt (capped at ~2500 tokens, so the cost is small and
predictable). That's the always-on layer. When a task looks related to past
work, the agent goes further and searches the full memory itself with the
`memory_*` tools — the equivalent of "I've seen this before, let me look it up"
rather than carrying everything around all the time.

**The feedback loop.** When the agent uses a memory, it cites it. The citation
is recorded and then stripped before it reaches your screen, and those usage
counts feed back into phase 2's ranking. Memories that keep proving useful get
kept and sharpened; memories nothing has touched in a month drop out. The system
finds out which of its own notes were worth writing.

## Where your data lives

```
~/.local/share/opencode/
├── memory.db                       # the plugin's own database (OpenCode's data is only accessed via its API)
└── memories/
    ├── memory_summary.md           # compact summary injected into the system prompt
    ├── MEMORY.md                   # searchable index of everything learned
    ├── rollout_summaries/          # one recap per past session
    ├── skills/                     # reusable procedures discovered over time
    └── extensions/ad_hoc/notes/    # things you explicitly asked it to remember
```

The location follows OpenCode's own data directory — `$XDG_DATA_HOME/opencode`
when that's set, otherwise `~/.local/share/opencode` (same resolution on macOS,
Linux, and Windows).

It's all plain files and a local SQLite database. Read them, edit them, delete
them — it's yours. (The `memories/` folder also holds a few working files and
an internal `.git/` the plugin uses for change tracking; `memory_reset` wipes
those too.)

### Backup and restore

Back up the whole OpenCode data directory while OpenCode is stopped. The
SQLite database and `memories/` workspace are a pair: restoring only one can
leave job state, Git baseline, and memory files out of sync. Include hidden
files, especially `memories/.git/`, and SQLite sidecars such as `memory.db-wal`
or `memory.db-shm` when present.

The directory is `$XDG_DATA_HOME/opencode` when `XDG_DATA_HOME` is set,
otherwise `~/.local/share/opencode`. Copy that whole directory to a dated
backup location. To restore, stop OpenCode, replace the current `opencode/`
data directory with the backup copy, then start OpenCode again. Do not restore
while OpenCode is running or copy only `memory.db` or only `memories/`.

## Privacy & safety

- **Local only.** There is no remote storage option to enable, by accident or
  otherwise: Codex keeps memory storage behind a backend interface whose only
  implementation today is the local filesystem, and this port implements that
  path and nothing else. Nothing is sent anywhere except through your existing
  OpenCode provider, using your existing credentials; the plugin holds no keys
  of its own.
- **Secrets are redacted** (API keys, tokens, private keys, passwords) from
  session transcripts and extracted memories before anything is written or sent
  to a model. Notes you explicitly dictate ("remember that ...") are stored as
  you said them.
- **The learning agents are sandboxed** — the extraction agent can't touch your
  filesystem (the transcript is handed to it inline; it only emits its structured
  result), and the consolidation agent gets only file tools plus access to the
  memory folder. Shell, network, IDE, and MCP tools are denied for both.
- **Reset is safe.** `memory_reset` refuses to run if the memory folder is a
  symlink, so it can't be tricked into deleting something else.
- **Web/MCP sessions:** by default, sessions that used web search, fetch, or MCP
  tools are still eligible for memory (matching Codex). If you'd rather exclude
  them so scraped or external content can't enter your memory, set
  `disable_on_external_context: true`.

## Configuration

Optional plugin options (all have sensible defaults). Names and defaults match
Codex's `[memories]` config so the two stay easy to compare:

| Option | Default | Meaning |
|---|---|---|
| `generate_memories` | `true` | Turn the background learning pipeline on/off |
| `use_memories` | `true` | Inject the memory summary into the system prompt |
| `dedicated_tools` | `true` | Expose the `memory_read`/`memory_search`/`memory_list`/`memory_add_note` tools |
| `disable_on_external_context` | `false` | Exclude sessions that used web/MCP tools from memory |
| `extract_model` | OpenCode `small_model`, else see below | Model used for per-session extraction |
| `consolidation_model` | OpenCode `model`, else see below | Model used for consolidation |
| `max_raw_memories_for_consolidation` | `256` | How many raw memories feed each consolidation pass |
| `max_rollout_age_days` | `10` | Ignore sessions older than this for extraction |
| `min_rollout_idle_hours` | `6` | How long a session must be idle before it's eligible |
| `max_rollouts_per_startup` | `2` | Max sessions extracted per pass |
| `max_unused_days` | `30` | Prune memories unused for this long |
| `codex_interop` | `{ "import": false, "export": false }` | Two-way memory exchange with a local Codex CLI (see below) |
| `claude_import` | `{ "enabled": false }` | One-way import of Claude Code project memories (see below) |

To set options, turn the plugin entry into a `[name, options]` pair:

```json
{
  "plugin": [
    ["opencode-codex-memory@0.6.3", { "disable_on_external_context": true, "min_rollout_idle_hours": 2 }]
  ]
}
```

See the [OpenCode plugin docs](https://opencode.ai/docs/plugins/) for details.

Numeric options are clamped to Codex's valid ranges; unknown option keys are
ignored with a warning. Setting `use_memories: false` also hides the memory
tools, matching Codex's extension gating.

**Verifying your configuration:** the plugin never hard-fails on bad options.
To check what actually took effect, ask the agent to run `memory_inspect` — it
echoes the effective options (after parsing and clamping), lists warnings for
unknown or malformed keys (typos included), and shows the resolved Codex
interop state. A mistyped option shows up there twice: as a warning, and as
the default value appearing where you expected your setting.

Model selection mirrors Codex's cheap-extraction / capable-consolidation
split using OpenCode's own concepts: when `extract_model` is unset, the
`small_model` from your `opencode.json` is used (Codex uses `gpt-5.4-mini`);
when `consolidation_model` is unset, your main `model` is used (Codex uses
`gpt-5.4`). If neither is configured, the learning sub-agents fall back to
their own agent-level `model` (if you defined one), else the provider default.
(OpenCode's *automatic* small-model pick is internal to OpenCode and not
exposed to plugins — set `small_model` explicitly to get the cheap extraction
path.)

The full precedence per phase: plugin option (`extract_model` /
`consolidation_model`) → OpenCode config (`small_model` / `model`) → a `model`
on your own `memorize-extract`/`memorize` agent definition, if you overrode
one → the provider's default model. Note that the first two pass the model
explicitly, so they win over an agent-level `model`.

> Note: `dedicated_tools` defaults to `true` here (Codex defaults it to `false`).
> This is the one intentional default difference — the tools are a core part of a
> standalone memory plugin. Everything else matches Codex's defaults.
>
> Turning `dedicated_tools` off keeps background learning, summary injection,
> and citation tracking working. The injected guidance switches to Codex's
> file-based mode — the agent reads the memory files with its normal file
> tools and writes "remember this" notes directly into
> `extensions/ad_hoc/notes/`. Caveat: the memory folder lives outside your
> project, so OpenCode raises an `external_directory` permission prompt the
> first time an agent touches it (allow-always covers later access); agents
> whose permissions deny that ask cannot use file-based mode. The dedicated
> tools have no such friction — that's why they are the default. The
> maintenance tools (`memory_reset`, `memory_inspect`, `memory_mode`) stay
> available either way.

### Sharing memory with the Codex CLI

If you use OpenCode and the Codex CLI on the same machine, turn this on so each
side can pick up what the other already learned. **Either or both directions.**
Off by default; no changes to Codex's own config are required.

**Enable both directions:**

```json
{
  "plugin": [
    [
      "opencode-codex-memory@0.6.3",
      { "codex_interop": { "import": true, "export": true } }
    ]
  ]
}
```

- **Import:** on each consolidation pass here, durable memory from Codex is
  merged into this plugin's store (tagged so you can tell it came from Codex).
- **Export:** after a successful consolidation here, this plugin's memory is
  offered to Codex; Codex merges it on *its* next consolidation pass.

**Options** (all under `codex_interop`):

| Option | Default | Meaning |
| --- | --- | --- |
| `import` | `false` | Bring Codex's consolidated memory into OpenCode. |
| `export` | `false` | Offer this plugin's consolidated memory to Codex. |
| `codex_home` | `$CODEX_HOME`, else `~/.codex` | Where the Codex CLI keeps its data. Set this if you use a non-default location. |

**Notes**

- Export only runs once Codex has created its own memory workspace
  (`$CODEX_HOME/memories`). Until then, import/export quietly do nothing for
  the missing side.
- Codex's own files are never rewritten in place — export only adds a side
  channel Codex already knows how to read.
- Both sides tag origin (`[from codex]` / `[from opencode]`) and skip the other
  tag on re-import, so the same facts don't bounce back and forth.
- Safe to combine with `claude_import`. Check status with `memory_inspect`
  (`codex_interop:` section).

**Turning it off**

Setting `import` / `export` back to `false` (or removing `codex_interop`) only
stops further sync. Already merged memory stays in this plugin's store, and any
staging copies stay on disk (harmless while import is off). The last export left
in Codex stays until Codex consolidates it away or you remove it there.

To drop the local staging copies too: turn import off first, then delete
`extensions/codex_import/` under the plugin memory directory (see
[Where your data lives](#where-your-data-lives)). Leave import off — if you turn
it back on, the next pass will recreate them from Codex. After a deletion, the
next consolidation can treat the missing files as a signal to drop entries that
only came from that import.

### Importing memory from Claude Code

If you use Claude Code as well as OpenCode, turn this on so OpenCode can learn
from the project memories Claude already keeps on your machine. **One-way only**
(Claude → OpenCode); nothing is written back into Claude. Off by default.

**Enable everything Claude has:**

```json
{
  "plugin": [
    ["opencode-codex-memory@0.6.3", { "claude_import": { "enabled": true } }]
  ]
}
```

After the next consolidation pass, durable facts from Claude's memories show up
in this plugin's memory the same way OpenCode's own extractions do. Project-specific
detail stays labeled by project; broadly useful preferences can land in the
global summary.

**Options** (all under `claude_import`):

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Turn the importer on. |
| `claude_home` | `~/.claude` | Where Claude Code stores its data. Set this if you use a non-default location. |
| `projects` | all projects | Optional allowlist of Claude project ids to import (see below). |

**Limit to specific projects:**

Claude names each project with an opaque id (a folder under
`~/.claude/projects/`), not the path you work in. List those folder names:

```json
{
  "plugin": [
    [
      "opencode-codex-memory@0.6.3",
      {
        "claude_import": {
          "enabled": true,
          "projects": ["-Users-you-Desktop-git-my-app"]
        }
      }
    ]
  ]
}
```

Find the ids on your machine:

```bash
ls ~/.claude/projects
```

- Omit `projects` (or leave it empty) to import every Claude project the plugin
  can place on disk.
- Add or remove ids anytime while import is **on**. Dropping an id (or deleting
  that project's memory in Claude) stops syncing it and removes the staging
  copy on the next pass so consolidation can drop derived entries. Memory
  already merged into the main store is not instantly deleted; the consolidator
  cleans it up when it next runs.
- Turning `enabled` off (see below) does **not** prune anything.

**Turning it off**

Setting `enabled` to `false` (or removing `claude_import`) only stops further
import. Already merged memory stays in this plugin's store, and staging copies
stay on disk (harmless while import is off).

To drop the local staging copies too: turn import off first, then delete
`extensions/external_agent_import/` under the plugin memory directory (see
[Where your data lives](#where-your-data-lives)). Leave import off — if you turn
it back on, the next pass will recreate them from Claude. After a deletion, the
next consolidation can treat the missing files as a signal to drop entries that
only came from that import.

To stop importing *some* projects without turning the feature off: shrink
`projects` (or delete that memory in Claude) and let the next pass run. That
only affects the Claude import channel.

**Notes**

- Safe to combine with `codex_interop` (Codex sharing uses a separate channel).
- If you also run another OpenCode plugin that *writes* Claude-style memory,
  pick one writer — two systems updating the same long-term store will fight.
- Check status anytime with `memory_inspect` (`claude_import:` section).

## Why one global memory?

There's a single store for everything you do, not one per project — and that's
the design choice most likely to surprise you, so it's worth explaining where it
came from.

Codex *started* with per-project memory: a separate bucket per directory, plus a
user-level scope on top. It **deliberately removed that** in early 2026 and
collapsed everything into one global root — one store, one lock, one
consolidation pass — for simplicity.

Simplicity is easy to underrate here — until you try to draw the boundaries
yourself. Scoping forces a question that often has no good answer: which project does
"prefers table-driven tests" belong to? Monorepos, worktrees, and sibling repos
of the same stack all blur the line, and the most valuable lessons — the ones
about how *you* work — belong to no project at all. Per-scope stores also each
consolidate over a thinner slice of evidence than the whole.

Project awareness didn't disappear; it moved out of storage and into the prompt.
Memories carry the project they came from, and the consolidator is told to keep
per-project detail separable — soft "this looks like it belongs to that project"
hints rather than hard partitions. You get the cross-project transfer (your
conventions follow you into a new repo on day one) while project-specific facts
stay recognizable as such.

The cost is real: with one store, an unrelated project's details can surface in
the summary. Codex judged that cheaper than the alternative, and this port
mirrors that decision rather than layering scoping back on top.

## Troubleshooting

When memory does not seem to build, ask the agent to run **`memory_inspect`**.
It reports:

- stage-1 job counts, failure classes (`backoff` / `provider_capacity` / `other_exhausted`), and recent extraction errors
- active provider/model quota backoffs and their retry times
- phase-2 status / last error / cooldown
- last session-discovery outcome
- effective options (after clamping) and config warnings
- effective memory-agent health, including user overrides and required permissions
- a short eligibility reminder (`min_rollout_idle_hours`, default **6h**)

Common causes:

| Symptom | Likely cause |
|---|---|
| No stage-1 outputs yet | Sessions must stay idle ≥ `min_rollout_idle_hours` (default 6). For a quick local check, set `"min_rollout_idle_hours": 1`. |
| Discovery failed | Host API/`experimental/session` unavailable; inspect shows the error. Retry after restarting OpenCode. |
| Pin stuck on old version | OpenCode freezes bare package specs; pin an explicit version and bump it (see Install). |
| Consolidation never runs | Check `phase2_status` and `phase2_last_error` in inspect; failed artifacts keep the workspace diff for the next run. |
| `stage1_error` mentions usage/rate limit | Temporary provider quota. Inspect shows `provider_capacity` or `backoff`; those jobs retry after about an hour once quota returns. Permanent holes are `other_exhausted`. |

Install target: this package runs **inside OpenCode** (Bun). You do not need to
install it as a standalone Node app; OpenCode resolves the plugin into its own
package cache.

## Contributing

The port follows Codex closely: same two-phase pipeline, same on-disk artifacts,
same prompts (adapted only where OpenCode differs). If you want the full design
and the trade-offs, see [`ARCHITECTURE.md`](./ARCHITECTURE.md); contributor
guidance lives in [`CONTRIBUTING.md`](./CONTRIBUTING.md) and
[`AGENTS.md`](./AGENTS.md) — in short: this repo exists to port Codex's memory
system to OpenCode, and PRs that break that parity will be rejected.

CI runs `bun test`, typecheck, build, and the packaging smoke test on every PR.

## License

Apache 2.0 — the same license as [OpenAI Codex](https://github.com/openai/codex),
whose memory system this project ports. See [`LICENSE`](./LICENSE) and
[`NOTICE`](./NOTICE). Not affiliated with the Codex project.
