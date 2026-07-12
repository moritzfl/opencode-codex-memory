const REDACTIONS: { re: RegExp; replacement: string }[] = [
  { re: /sk-ant-[A-Za-z0-9_\-]{20,}/g, replacement: "[REDACTED:anthropic-key]" },
  { re: /sk-[A-Za-z0-9]{20,}/g, replacement: "[REDACTED:openai-key]" },
  { re: /AKIA[0-9A-Z]{16}/g, replacement: "[REDACTED:aws-key]" },
  { re: /gh[pousr]_[A-Za-z0-9]{36,}/g, replacement: "[REDACTED:github-token]" },
  { re: /xox[baprs]-[A-Za-z0-9\-]{10,}/g, replacement: "[REDACTED:slack-token]" },
  // Case-insensitive with a 16-char floor, matching codex's sanitizer.
  { re: /bearer\s+[A-Za-z0-9\-\._~+\/=]{16,}/gi, replacement: "Bearer [REDACTED]" },
  {
    re: /-----BEGIN [A-Z]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z]+ PRIVATE KEY-----/g,
    replacement: "[REDACTED:private-key]",
  },
  // Optional quotes around the KEY cover JSON/YAML forms like
  // "password": "value" — codex's SECRET_ASSIGNMENT_REGEX misses those (it
  // allows a quote only before the value); this is a deliberate superset.
  { re: /["']?(password|passwd|pwd|secret|api[_-]?key|token|access[_-]?token)["']?\s*[:=]\s*["']?[^\s"']{4,}["']?/gi, replacement: "$1=[REDACTED]" },
  { re: /["']?(aws_secret_access_key|aws_access_key_id)["']?\s*[:=]\s*["']?[^\s"']{4,}["']?/gi, replacement: "$1=[REDACTED]" },
]

export function redact(text: string): string {
  let out = text
  for (const { re, replacement } of REDACTIONS) {
    out = out.replace(re, replacement)
  }
  return out
}

function matchesMarkedFragment(text: string, startMarker: string, endMarker: string): boolean {
  const trimmed = text.trim()
  return (
    trimmed.slice(0, startMarker.length).toLowerCase() === startMarker.toLowerCase() &&
    trimmed.slice(-endMarker.length).toLowerCase() === endMarker.toLowerCase()
  )
}

/**
 * Mirrors codex is_memory_excluded_contextual_user_fragment (phase1.rs):
 * injected AGENTS.md instruction blocks and <skill> payloads inside user
 * content are contextual boilerplate, not conversation — they must not be
 * mined for memories.
 */
export function isMemoryExcludedFragment(text: string): boolean {
  return (
    matchesMarkedFragment(text, "# AGENTS.md instructions", "</INSTRUCTIONS>") ||
    matchesMarkedFragment(text, "<skill>", "</skill>")
  )
}