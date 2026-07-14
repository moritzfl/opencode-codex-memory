# opencode-codex-memory

Persistent memory for [opencode](https://opencode.ai). Your agent remembers what
it learned in past sessions — your conventions, your projects, the decisions you
made — and brings that context into new conversations automatically.

It's a single plugin. No core changes, no MCP server, no separate process, no
cloud service. Everything stays on your machine under
`~/.local/share/opencode/`.

Despite the name: **no codex subscription or OpenAI account is needed.** This
project ports the memory *design* from OpenAI's codex to opencode. It works out
of the box with zero extra configuration and uses whatever models you already
have set up in opencode.

## Why

By default every opencode session starts from zero. You re-explain your build
commands, your code style, and the quirks of each repo over and over.

opencode-codex-memory closes that loop:

- **It learns in the background.** Once a session has been idle for a while
  (default 6 h), a later background pass reviews the transcript and extracts
  durable facts — preferences, project structure, what worked and what didn't.
- **It consolidates.** Periodically it merges those notes into a compact,
  searchable memory, pruning what's stale.
- **It remembers at the right time.** A short summary is injected into the system
  prompt, and the agent can search the full memory on demand when a task looks
  related to past work.
- **It self-corrects.** When the agent actually uses a memory it cites the source,
  so useful memories rank higher over time and unused ones fade.

The result: opencode gets more useful the more you use it, without you managing
anything.

## Install

1. Add the plugin to your `~/.config/opencode/opencode.json`:

   ```json
   {
     "plugin": ["opencode-codex-memory"]
   }
   ```

   (While developing locally, point it at an absolute path to your checkout
   instead of the package name.)

2. That's it. The memory workspace is created on first use. Installing the
   plugin is the opt-in: background learning and summary injection are active
   immediately (codex ships the same system behind a default-off feature flag
   with a consent prompt; a standalone memory plugin *is* the consent).

Requires only opencode (official release). Git is bundled (`isomorphic-git`) —
no `git` binary or any other external tool needed.

The two restricted sub-agents that do the background learning (`memorize`,
`memorize-extract`) register themselves automatically while background learning
is enabled. To choose which models
they use, set the `extract_model` / `consolidation_model` plugin options (see
[Configuration](#configuration)) — don't override the agents for that. Defining
an agent with the same name in your own config is only for advanced tweaks
(e.g. permissions); your definition then replaces the shipped one. If you
override `memorize`, keep an `external_directory` allow for
`~/.local/share/opencode/memories/*` (e.g.
`"external_directory": { "$HOME/.local/share/opencode/memories/*": "allow" }`
after the wildcard deny) — the memory folder lives outside your project, and
without that grant opencode blocks the consolidator's file access.

## Try it

Just use opencode normally. Sessions that have been idle for a few hours get
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

## Where your data lives

```
~/.local/share/opencode/
├── memory.db                       # the plugin's own database (opencode's data is only accessed via its API)
└── memories/
    ├── memory_summary.md           # compact summary injected into the system prompt
    ├── MEMORY.md                   # searchable index of everything learned
    ├── rollout_summaries/          # one recap per past session
    ├── skills/                     # reusable procedures discovered over time
    └── extensions/ad_hoc/notes/    # things you explicitly asked it to remember
```

It's all plain files and a local SQLite database. Read them, edit them, delete
them — it's yours. (The `memories/` folder also holds a few working files and
an internal `.git/` the plugin uses for change tracking; `memory_reset` wipes
those too.)

## Privacy & safety

- **Local only.** Nothing is sent anywhere except through your existing opencode
  provider, using your existing credentials. The plugin holds no keys of its own.
- **Secrets are redacted** (API keys, tokens, private keys, passwords) from
  session transcripts and extracted memories before anything is written or sent
  to a model. Notes you explicitly dictate ("remember that ...") are stored as
  you said them.
- **The learning agents are sandboxed** — the extraction agent has no tools at
  all (the transcript is handed to it inline), and the consolidation agent gets
  only file tools plus access to the memory folder. Shell, network, IDE, and
  MCP tools are denied for both.
- **Reset is safe.** `memory_reset` refuses to run if the memory folder is a
  symlink, so it can't be tricked into deleting something else.
- **Web/MCP sessions:** by default, sessions that used web search, fetch, or MCP
  tools are still eligible for memory (matching codex). If you'd rather exclude
  them so scraped or external content can't enter your memory, set
  `disable_on_external_context: true`.

## Configuration

Optional plugin options (all have sensible defaults). Names and defaults match
codex's `[memories]` config so the two stay easy to compare:

| Option | Default | Meaning |
|---|---|---|
| `generate_memories` | `true` | Turn the background learning pipeline on/off |
| `use_memories` | `true` | Inject the memory summary into the system prompt |
| `dedicated_tools` | `true` | Expose the `memory_read`/`memory_search`/`memory_list`/`memory_add_note` tools |
| `disable_on_external_context` | `false` | Exclude sessions that used web/MCP tools from memory |
| `extract_model` | opencode `small_model`, else see below | Model used for per-session extraction |
| `consolidation_model` | opencode `model`, else see below | Model used for consolidation |
| `max_raw_memories_for_consolidation` | `256` | How many raw memories feed each consolidation pass |
| `max_rollout_age_days` | `10` | Ignore sessions older than this for extraction |
| `min_rollout_idle_hours` | `6` | How long a session must be idle before it's eligible |
| `max_rollouts_per_startup` | `2` | Max sessions extracted per pass |
| `max_unused_days` | `30` | Prune memories unused for this long |

To set options, turn the plugin entry into a `[name, options]` pair:

```json
{
  "plugin": [
    ["opencode-codex-memory", { "disable_on_external_context": true, "min_rollout_idle_hours": 2 }]
  ]
}
```

See the [opencode plugin docs](https://opencode.ai/docs/plugins/) for details.

Numeric options are clamped to codex's valid ranges; unknown option keys are
ignored with a warning. Setting `use_memories: false` also hides the memory
tools, matching codex's extension gating.

Model selection mirrors codex's cheap-extraction / capable-consolidation
split using opencode's own concepts: when `extract_model` is unset, the
`small_model` from your `opencode.json` is used (codex uses `gpt-5.4-mini`);
when `consolidation_model` is unset, your main `model` is used (codex uses
`gpt-5.4`). If neither is configured, the learning sub-agents fall back to
their own agent-level `model` (if you defined one), else the provider default.
(opencode's *automatic* small-model pick is internal to opencode and not
exposed to plugins — set `small_model` explicitly to get the cheap extraction
path.)

The full precedence per phase: plugin option (`extract_model` /
`consolidation_model`) → opencode config (`small_model` / `model`) → a `model`
on your own `memorize-extract`/`memorize` agent definition, if you overrode
one → the provider's default model. Note that the first two pass the model
explicitly, so they win over an agent-level `model`.

> Note: `dedicated_tools` defaults to `true` here (codex defaults it to `false`).
> This is the one intentional default difference — the tools are a core part of a
> standalone memory plugin. Everything else matches codex's defaults.
>
> Turning `dedicated_tools` off keeps background learning, summary injection,
> and citation tracking working. The injected guidance switches to codex's
> file-based mode — the agent reads the memory files with its normal file
> tools and writes "remember this" notes directly into
> `extensions/ad_hoc/notes/`. Caveat: the memory folder lives outside your
> project, so opencode raises an `external_directory` permission prompt the
> first time an agent touches it (allow-always covers later access); agents
> whose permissions deny that ask cannot use file-based mode. The dedicated
> tools have no such friction — that's why they are the default. The
> maintenance tools (`memory_reset`, `memory_inspect`, `memory_mode`) stay
> available either way.

## Under the hood

opencode-codex-memory is a faithful port of the memory system from OpenAI's codex.

One design choice is worth calling out, because it shapes everything else: **memory
is global.** There's a single store for all your work, not one per project. That's
not an accident of the port — it's codex's own hard-won shape. codex *started* with
per-project memory (a separate bucket per directory, plus a user scope) and
**deliberately removed it** in early 2026, collapsing everything into one global
root for simplicity: one store, one lock, one consolidation pass. Project awareness
didn't disappear — it moved out of storage and into the prompt, as soft "this looks
like it belongs to that project" hints rather than hard partitions. This port
mirrors that exactly.

If you want to understand the design, the trade-offs, or contribute, see
[`ARCHITECTURE.md`](./ARCHITECTURE.md). Contributor guidance lives in
[`CONTRIBUTING.md`](./CONTRIBUTING.md) and [`AGENTS.md`](./AGENTS.md) —
in short: this repo exists to port codex's memory system to opencode, and
PRs that break that parity will be rejected.

## License

Apache 2.0 — the same license as [OpenAI Codex](https://github.com/openai/codex),
whose memory system this project ports. See [`LICENSE`](./LICENSE) and
[`NOTICE`](./NOTICE). Not affiliated with the codex project.
