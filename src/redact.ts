const REDACTIONS: { re: RegExp; replacement: string }[] = [
  { re: /sk-ant-[A-Za-z0-9_\-]{20,}/g, replacement: "[REDACTED:anthropic-key]" },
  { re: /sk-[A-Za-z0-9]{20,}/g, replacement: "[REDACTED:openai-key]" },
  { re: /AKIA[0-9A-Z]{16}/g, replacement: "[REDACTED:aws-key]" },
  { re: /gh[pousr]_[A-Za-z0-9]{36,}/g, replacement: "[REDACTED:github-token]" },
  { re: /xox[baprs]-[A-Za-z0-9\-]{10,}/g, replacement: "[REDACTED:slack-token]" },
  { re: /Bearer\s+[A-Za-z0-9\-\._~+\/=]{20,}/g, replacement: "Bearer [REDACTED]" },
  {
    re: /-----BEGIN [A-Z]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z]+ PRIVATE KEY-----/g,
    replacement: "[REDACTED:private-key]",
  },
  { re: /(password|passwd|pwd|secret|api[_-]?key|token|access[_-]?token)\s*[:=]\s*["']?[^\s"']{4,}["']?/gi, replacement: "$1=[REDACTED]" },
  { re: /(?:aws_secret_access_key|aws_access_key_id)\s*[:=]\s*["']?[^\s"']{4,}["']?/gi, replacement: "$1=[REDACTED]" },
]

export function redact(text: string): string {
  let out = text
  for (const { re, replacement } of REDACTIONS) {
    out = out.replace(re, replacement)
  }
  return out
}