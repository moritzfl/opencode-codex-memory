# OpenCode Codex Memory

<p align="center">
  <a href="https://www.npmjs.com/package/opencode-codex-memory">
    <img src="https://img.shields.io/npm/v/opencode-codex-memory?logo=npm&amp;label=latest" alt="Latest npm version" />
  </a>
  <a href="https://www.npmjs.com/package/opencode-codex-memory">
    <img src="https://img.shields.io/npm/dt/opencode-codex-memory?logo=npm&amp;label=downloads" alt="npm downloads" />
  </a>
</p>

Persistent memory for [OpenCode](https://opencode.ai). Your agent learns from
past sessions — your conventions, your projects, the decisions you made — and
brings useful context into new conversations automatically.

**No Codex subscription or OpenAI account required.** This plugin ports the
memory system from OpenAI's Codex and uses the models you already have in
OpenCode. Memory is stored locally as Markdown files and a small SQLite
database. Background learning makes additional calls through your configured
model providers; there is no separate memory service or MCP server.

## Install

### 1. Add the plugin for your OpenCode version

Run `opencode --version` if you are unsure which version you use. Add the entry
to your existing global `~/.config/opencode/opencode.jsonc` or `opencode.json`
(under `$XDG_CONFIG_HOME/opencode` if set). Keep your other settings and plugins.

**OpenCode 2.x**

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "opencode-codex-memory@0.8.0" }
  ]
}
```

**OpenCode 1.x** (1.18 or newer)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-codex-memory@0.8.0"]
}
```

Both examples use [**Memory V1**, the default](#choose-how-memory-learns). Pin a published package version
as shown; see [Updating the plugin](./docs/troubleshooting.md#updating-the-plugin)
for updates.

### 2. Restart OpenCode and check status

On OpenCode 2, run:

```sh
opencode service restart
```

On OpenCode 1.x, restart OpenCode. If an IDE or another app manages your
OpenCode server, restart that server too.

Start a conversation and ask **“Check my memory status.”** The agent can run
`memory_inspect` to show progress and any warnings. In OpenCode 2's terminal
UI, you can also open the [**`/memory` panel**](./docs/usage.md#memory-panel).

## Try it

Use OpenCode normally. By default, a session becomes eligible for learning
after **6 hours of inactivity**, and consolidation combines learned material
into memory. The work runs in the background while OpenCode is running;
an empty memory immediately after installation is normal.

In a later conversation, try:

- “What do you know about how I work?”
- “What was I working on in this repo last week?”
- “Remember that I deploy this project with `make release`.”

Explicit “remember this” requests save a note immediately; a later
consolidation integrates it into the summary. You can
[check progress or pause learning](./docs/usage.md) at any time.

Memory is **global across projects**. Project-specific details carry context
about where they came from, while general preferences can follow you into a
new repo. Files live under `~/.local/share/opencode/` by default. See
[Storage and privacy](./docs/storage-and-privacy.md) for the layout, model-call
privacy, backups, and relocation.

## Choose how memory learns

| | Best fit | Trade-off |
|---|---|---|
| **Memory V1** — default | You want the agent to anticipate your working style, using a searchable handbook of past lessons | Can turn a one-time request into an overly broad preference |
| **Memory V2** — opt-in | You want more cautious preferences and task history, kept in a compact summary with session recaps | May need more repetition; no separate handbook |

Both work on OpenCode 1.x and 2.x. Keep the default if it suits you, or
[compare the implementations and try Memory V2](./docs/memory-versions.md).
You can let both learn before switching, with an option to switch back.

## Start here

| I want to… | Read |
|---|---|
| Recall past work, save a note, or pause learning | [Using memory](./docs/usage.md) |
| Choose or switch memory behavior | [Memory V1 and Memory V2](./docs/memory-versions.md) |
| Set models, learning frequency, or other options | [Configuration](./docs/configuration.md) |
| Find, back up, move, or reset my data | [Storage and privacy](./docs/storage-and-privacy.md) |
| Share with Codex CLI or import Claude Code memories | [Integrations](./docs/integrations.md) |
| Fix missing memory or check an update | [Troubleshooting](./docs/troubleshooting.md) |

## Learn more and contribute

- [How memory works](./docs/how-ai-memory-works.md) — the illustrated explanation
  of learning, recall, and forgetting.
- [Changelog](./CHANGELOG.md) — release history.
- [Contributing](./CONTRIBUTING.md) — development setup and the Codex parity policy.
- [Architecture](./ARCHITECTURE.md) — implementation map and host adaptations.

## License

Apache 2.0 — the same license as [OpenAI Codex](https://github.com/openai/codex),
whose memory system this project ports. See [`LICENSE`](./LICENSE) and
[`NOTICE`](./NOTICE). Not affiliated with the Codex project.
