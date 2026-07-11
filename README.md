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

- **It learns in the background.** After a session goes idle, the plugin reviews
  the transcript and extracts durable facts — preferences, project structure,
  what worked and what didn't.
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
   immediately (codex ships the same system behind an experimental flag with a
   consent prompt; a standalone memory plugin *is* the consent).

Requires only opencode (official release). Git is bundled (`isomorphic-git`) —
no `git` binary or any other external tool needed.

The two restricted sub-agents that do the background learning (`memorize`,
`memorize-extract`) register themselves automatically. To customize one — e.g.
pin a cheaper model for extraction — define an agent with the same name in your
own config; your definition wins and the plugin leaves it alone.

## Try it

Just use opencode normally. After a session goes idle, the plugin reviews it in
the background and starts building memory — you don't have to do anything. Come
back for a later session and ask something like *"what do you know about how I
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
├── memory.db                       # the plugin's own database (never touches opencode's)
└── memories/
    ├── memory_summary.md           # compact summary injected into the system prompt
    ├── MEMORY.md                   # searchable index of everything learned
    ├── rollout_summaries/          # one recap per past session
    ├── skills/                     # reusable procedures discovered over time
    └── extensions/ad_hoc/notes/    # things you explicitly asked it to remember
```

It's all plain files and a local SQLite database. Read them, edit them, delete
them, or check them into a private repo — it's yours.

## Privacy & safety

- **Local only.** Nothing is sent anywhere except through your existing opencode
  provider, using your existing credentials. The plugin holds no keys of its own.
- **Secrets are redacted** (API keys, tokens, private keys, passwords) before any
  memory is written or sent to a model.
- **The learning agents are sandboxed** — they cannot run shell commands or reach
  the network.
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
| `extract_model` | opencode `small_model`, else current model | Model used for per-session extraction |
| `consolidation_model` | opencode `model`, else current model | Model used for consolidation |
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
`gpt-5.4`). If neither is configured, both fall back to the session's default
model. (opencode's *automatic* small-model pick is internal to opencode and
not exposed to plugins — set `small_model` explicitly to get the cheap
extraction path.)

> Note: `dedicated_tools` defaults to `true` here (codex defaults it to `false`).
> This is the one intentional default difference — the tools are a core part of a
> standalone memory plugin. Everything else matches codex's defaults.

## Under the hood

opencode-codex-memory is a faithful port of the memory system from OpenAI's codex.
If you want to understand the design, the trade-offs, or contribute, see
[`ARCHITECTURE.md`](./ARCHITECTURE.md). Contributor guidance lives in
[`CONTRIBUTING.md`](./CONTRIBUTING.md) and [`AGENTS.md`](./AGENTS.md) —
in short: this repo exists to port codex's memory system to opencode, and
PRs that break that parity will be rejected.

## License

Apache 2.0 — the same license as [OpenAI Codex](https://github.com/openai/codex),
whose memory system this project ports. See [`LICENSE`](./LICENSE) and
[`NOTICE`](./NOTICE). Not affiliated with the codex project.
