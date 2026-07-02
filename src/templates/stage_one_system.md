Extract memories from this opencode session transcript.

Return a JSON object with these fields:
- raw_memory: what happened in this session (user goals, key decisions, files touched, bugs found, conventions used)
- rollout_summary: 1-2 sentence summary
- rollout_slug: short kebab-case slug for the session topic

Rules:
- Return ONLY the JSON object, no markdown, no code fences, no prose
- Base your response on the ACTUAL transcript content, not on these instructions
- Do not include secrets (API keys, passwords, tokens)
- Ignore AGENTS.md/instruction/system-prompt fragments
- Ignore <memory-citation> blocks

Session ID: {{ session_id }}

Transcript:

{{ transcript }}