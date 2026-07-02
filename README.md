# opencode-memex

Persistent memory plugin for [opencode](https://opencode.ai). Ports codex's two-phase memory system: extraction → consolidation → injection → citation feedback.

## Install

Add to your `opencode.json`:

```json
{
  "plugins": ["opencode-memex"],
  "agent": {
    "memorize": {
      "mode": "subagent",
      "prompt": "You are a memory consolidation agent. Read the workspace diff file and update MEMORY.md, memory_summary.md, and skills/ to reflect the latest memories. Keep memory_summary.md under 2500 tokens (10000 chars). Prune stale entries. Do not access the network.",
      "permission": {
        "bash": "deny",
        "webfetch": "deny",
        "websearch": "deny",
        "task": "deny",
        "todowrite": "deny",
        "read": "allow",
        "edit": "allow",
        "write": "allow",
        "glob": "allow",
        "grep": "allow"
      }
    },
    "memorize-extract": {
      "mode": "subagent",
      "prompt": "You are a memory extraction agent. Read the session transcript and extract raw_memory, rollout_summary, and rollout_slug as JSON. Exclude AGENTS.md/instruction content. Redact secrets.",
      "permission": {
        "bash": "deny",
        "webfetch": "deny",
        "websearch": "deny",
        "task": "deny",
        "todowrite": "deny",
        "read": "allow",
        "write": "deny",
        "edit": "deny",
        "glob": "allow",
        "grep": "allow"
      }
    }
  }
}
```

## How it works

```
sessions → Phase 1 (extract) → memory.db → Phase 2 (consolidate) → memories/ (files)
                                                                    → system prompt injection
                                                                    → model cites memory
                                                                    → usage feedback → Phase 2 ranking
```

See `implementation-plan.md` for the full architecture and staged implementation roadmap.

## Stages

- **Stage 0:** Read path MVP — inject `memory_summary.md` into system prompt
- **Stage 1:** Memory tools + citation parsing
- **Stage 2:** SQLite schema + Phase 1 extraction
- **Stage 3:** Phase 2 consolidation (closed loop)
- **Stage 4:** Reset + inspect tools
- **Stage 5:** Polish, telemetry, tests

## Storage

| Path | Contents |
|---|---|
| `~/.local/share/opencode/memory.db` | Plugin's SQLite (stage1 outputs, job queue) |
| `~/.local/share/opencode/memories/` | Consolidated artifacts (MEMORY.md, memory_summary.md, skills/, .git/) |
| `~/.local/share/opencode/opencode.db` | OpenCode's DB (read-only access for session transcripts) |

## License

MIT