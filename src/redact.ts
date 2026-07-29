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
]

// Optional quotes around the key cover JSON/YAML forms that codex's bare-key
// assignment regex misses. Value boundaries are scanned instead of guessed by
// one regex so escaped strings and nested JSON remain intact.
const SECRET_ASSIGNMENT_START = /(["']?)(password|passwd|pwd|secret|api[_-]?key|token|access[_-]?token|aws_secret_access_key|aws_access_key_id)\1([ \t]*[:=][ \t]*)/gi
const JSON_PRIMITIVE = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)(?=\s*[,}\]])/i

export function redact(text: string): string {
  let out = text
  for (const { re, replacement } of REDACTIONS) {
    out = out.replace(re, replacement)
  }
  return redactAssignments(out)
}

function redactAssignments(text: string): string {
  let cursor = 0
  let out = ""
  let flowCursor = 0
  const matchedOpeners = findMatchedFlowOpeners(text)
  const flowState: FlowState = { closers: [], quote: null, escaped: false }
  SECRET_ASSIGNMENT_START.lastIndex = 0
  for (let match = SECRET_ASSIGNMENT_START.exec(text); match; match = SECRET_ASSIGNMENT_START.exec(text)) {
    advanceFlowState(text, flowCursor, match.index, flowState, matchedOpeners)
    flowCursor = match.index
    const valueStart = SECRET_ASSIGNMENT_START.lastIndex
    const value = scanAssignmentValue(
      text,
      valueStart,
      match[1],
      match[3],
      flowState.closers.length > 0,
      flowState.quote,
    )
    if (!value) continue
    out += text.slice(cursor, value.start) + value.replacement
    cursor = value.end
    SECRET_ASSIGNMENT_START.lastIndex = value.end
  }
  return out + text.slice(cursor)
}

function scanAssignmentValue(
  text: string,
  start: number,
  keyQuote: string,
  separator: string,
  flowCollection: boolean,
  enclosingQuote: string | null,
): { start: number; end: number; replacement: string } | null {
  let valueStart = start
  if (enclosingQuote) {
    const end = scanEnclosingQuote(text, valueStart, enclosingQuote)
    return end > valueStart ? { start: valueStart, end, replacement: "[REDACTED]" } : null
  }
  if (flowCollection && separator.includes(":")) {
    while (/\s/.test(text[valueStart] ?? "")) valueStart++
  }
  const first = text[valueStart]
  if (!first || first === "\r" || first === "\n") return null
  if (first === '"' || first === "'") {
    const end = scanQuoted(text, valueStart, first) ?? plainValueEnd(text, valueStart, flowCollection)
    return end > valueStart ? { start: valueStart, end, replacement: `${first}[REDACTED]${first}` } : null
  }
  if (first === "{" || first === "[") {
    const end = scanStructuredJson(text, valueStart) ?? plainValueEnd(text, valueStart, flowCollection)
    return end > valueStart ? { start: valueStart, end, replacement: '"[REDACTED]"' } : null
  }
  if (keyQuote === '"' && separator.includes(":")) {
    const primitive = JSON_PRIMITIVE.exec(text.slice(valueStart))
    if (primitive) return { start: valueStart, end: valueStart + primitive[0].length, replacement: '"[REDACTED]"' }
  }
  const end = plainValueEnd(text, valueStart, flowCollection)
  return end > valueStart ? { start: valueStart, end, replacement: '"[REDACTED]"' } : null
}

function scanEnclosingQuote(text: string, start: number, quote: string): number {
  for (let i = start; i < text.length; i++) {
    if (quote === '"' && text[i] === "\\") {
      i++
      continue
    }
    if (text[i] !== quote) continue
    if (quote === "'" && text[i + 1] === "'") {
      i++
      continue
    }
    return i
  }
  return plainValueEnd(text, start, false)
}

function scanQuoted(text: string, start: number, quote: string): number | null {
  for (let i = start + 1; i < text.length; i++) {
    if (quote === '"' && text[i] === "\\") {
      i++
      continue
    }
    if (text[i] !== quote) continue
    if (quote === "'" && text[i + 1] === "'") {
      i++
      continue
    }
    return i + 1
  }
  return null
}

function scanStructuredJson(text: string, start: number): number | null {
  const closers = [text[start] === "{" ? "}" : "]"]
  let quote: string | null = null
  for (let i = start + 1; i < text.length; i++) {
    const char = text[i]
    if (quote) {
      if (quote === '"' && char === "\\") i++
      else if (char === quote) {
        if (quote === "'" && text[i + 1] === "'") i++
        else quote = null
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === "{") closers.push("}")
    else if (char === "[") closers.push("]")
    else if (char === closers[closers.length - 1]) {
      closers.pop()
      if (closers.length === 0) return i + 1
    }
  }
  return null
}

interface FlowState {
  closers: string[]
  quote: string | null
  escaped: boolean
}

function findMatchedFlowOpeners(text: string): Set<number> {
  const matched = new Set<number>()
  const stack: Array<{ index: number; closer: string }> = []
  let quote: string | null = null
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quote) {
      if (escaped) escaped = false
      else if (quote === '"' && char === "\\") escaped = true
      else if (char === quote) {
        if (quote === "'" && text[i + 1] === "'") i++
        else quote = null
      }
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === "{") stack.push({ index: i, closer: "}" })
    else if (char === "[") stack.push({ index: i, closer: "]" })
    else if (char === stack[stack.length - 1]?.closer) {
      const opener = stack.pop()
      if (opener) matched.add(opener.index)
    }
  }
  return matched
}

function advanceFlowState(
  text: string,
  start: number,
  end: number,
  state: FlowState,
  matchedOpeners: Set<number>,
): void {
  for (let i = start; i < end; i++) {
    const char = text[i]
    if (state.quote) {
      if (state.escaped) {
        state.escaped = false
      } else if (state.quote === '"' && char === "\\") {
        state.escaped = true
      } else if (char === state.quote) {
        if (state.quote === "'" && text[i + 1] === "'") i++
        else state.quote = null
      }
      continue
    }
    if (char === '"' || char === "'") state.quote = char
    else if (char === "{" && matchedOpeners.has(i)) state.closers.push("}")
    else if (char === "[" && matchedOpeners.has(i)) state.closers.push("]")
    else if (char === state.closers[state.closers.length - 1]) state.closers.pop()
  }
}

function plainValueEnd(text: string, start: number, flowCollection: boolean): number {
  let end = text.length
  for (let i = start; i < text.length; i++) {
    const char = text[i]
    if (char === "\n") {
      end = i
      break
    }
    if (flowCollection && (char === "," || char === "}" || char === "]")) {
      end = i
      break
    }
    if (char === "#" && i > start && /\s/.test(text[i - 1])) {
      end = i
      break
    }
  }
  while (end > start && /\s/.test(text[end - 1])) end--
  return end
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
 *
 * NOTE: inert on opencode today, kept for codex parity and future-proofing.
 * opencode delivers both of these through the SYSTEM prompt, never as a user
 * text part: AGENTS.md is joined into `system[0]` and skills are a
 * `<available_skills>` catalog (skill/index.ts `fmt`), so neither shape ever
 * reaches this check. Do not treat it as an active safeguard — the structural
 * filters in capture.ts (`ignored` parts) are what actually exclude
 * non-conversation content on this platform.
 */
export function isMemoryExcludedFragment(text: string): boolean {
  return (
    matchesMarkedFragment(text, "# AGENTS.md instructions", "</INSTRUCTIONS>") ||
    matchesMarkedFragment(text, "<skill>", "</skill>")
  )
}
