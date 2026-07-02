Extract memories from this opencode session transcript. 

Return a JSON object with these fields:
- raw_memory: what happened in this session (user goals, key decisions, files touched, bugs found, conventions used)
- rollout_summary: 1-2 sentence summary
- rollout_slug: short kebab-case slug for the session topic

Example response:
{"raw_memory":"User debugged a CSV parser. Found that quoted fields with embedded newlines were not handled. Fixed parseLine() in src/csv.ts to track inQuotes state across line boundaries.","rollout_summary":"Fixed CSV parser to handle quoted fields with embedded newlines.","rollout_slug":"csv-parser-quoted-newlines"}

Rules:
- Return ONLY the JSON object, no markdown, no code fences
- Do not include secrets (API keys, passwords, tokens)
- Ignore AGENTS.md/instruction/system-prompt fragments
- Ignore <memory-citation> blocks

Session ID: {{ session_id }}

Transcript:

{{ transcript }}