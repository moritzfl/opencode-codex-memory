import { describe, it, expect } from "bun:test"
import { redact } from "../src/redact.js"

describe("redact", () => {
  it("redacts OpenAI keys", () => {
    expect(redact("key=sk-" + "a".repeat(30))).toContain("[REDACTED:openai-key]")
  })

  it("redacts Anthropic keys", () => {
    expect(redact("sk-ant-" + "a".repeat(30))).toContain("[REDACTED:anthropic-key]")
  })

  it("redacts AWS access keys", () => {
    expect(redact("AKIA" + "ABCDEFGH12345678IJ")).toContain("[REDACTED:aws-key]")
  })

  it("redacts GitHub tokens", () => {
    const tok = "ghp_" + "a".repeat(36)
    expect(redact(tok)).toContain("[REDACTED:github-token]")
  })

  it("redacts Bearer tokens", () => {
    expect(redact("Authorization: Bearer abc123" + "x".repeat(30))).toContain("Bearer [REDACTED]")
  })

  it("redacts private keys", () => {
    const pk = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIJBAL\n-----END RSA PRIVATE KEY-----"
    expect(redact(pk)).toBe("[REDACTED:private-key]")
  })

  it("redacts password assignments", () => {
    expect(redact('password: "supersecret123"')).toBe('password: "[REDACTED]"')
  })

  it("redacts quoted keys in JSON tool payloads", () => {
    expect(redact('{"password":"hunter2secret"}')).not.toContain("hunter2secret")
    expect(redact('{"api_key": "abcd1234efgh"}')).not.toContain("abcd1234efgh")
    expect(redact("'token': 'abcd1234efgh'")).not.toContain("abcd1234efgh")
    expect(redact('"access-token"="abcd1234efgh"')).not.toContain("abcd1234efgh")
  })

  // codex replaces with $1$2$3, keeping key + separator + opening quote so the
  // surrounding document stays parseable; the port matches that shape.
  it("preserves the separator and quoting so redacted JSON stays valid", () => {
    const out = redact('{"password":"hunter2secret"}')
    expect(out).toBe('{"password":"[REDACTED]"}')
    expect(() => JSON.parse(out)).not.toThrow()
    expect(JSON.parse(out).password).toBe("[REDACTED]")
  })

  it("keeps JSON valid when secret values are unquoted primitives", () => {
    for (const value of ["123456", "true", "null"]) {
      const out = redact(`{"password":${value},"safe":"ok"}`)
      expect(() => JSON.parse(out)).not.toThrow()
      expect(JSON.parse(out)).toEqual({ password: "[REDACTED]", safe: "ok" })
    }
  })

  it("keeps YAML structure after redacting an unquoted value", () => {
    expect(redact("password: 123456\nsafe: ok")).toBe('password: "[REDACTED]"\nsafe: ok')
    expect(redact("password: abcdef;ghijkl")).toBe('password: "[REDACTED]"')
    expect(redact("password: abc def ghi # keep this comment")).toBe(
      'password: "[REDACTED]" # keep this comment',
    )
    expect(redact("password:\nsafe: ok")).toBe("password:\nsafe: ok")
    expect(redact("{password: hunter2, safe: ok}")).toBe('{password: "[REDACTED]", safe: ok}')
    expect(redact("{\n  password: hunter2,\n  safe: ok\n}")).toBe(
      '{\n  password: "[REDACTED]",\n  safe: ok\n}',
    )
    expect(redact("{ broken\npassword: abc,def")).toBe('{ broken\npassword: "[REDACTED]"')
    expect(redact("[ broken\npassword:\nsafe: ok")).toBe("[ broken\npassword:\nsafe: ok")
  })

  it("redacts a complete JSON string containing escaped quotes", () => {
    const out = redact(String.raw`{"password":"abc\"defghijkl","safe":"ok"}`)
    expect(out).toBe('{"password":"[REDACTED]","safe":"ok"}')
    expect(() => JSON.parse(out)).not.toThrow()
    expect(out).not.toContain("defghijkl")
  })

  it("preserves safe fields around nested structured secret values", () => {
    for (const value of ['{"nested":{"value":"x"}}', '["x",{"y":1}]']) {
      const input = `{"password":${value},"safe":"ok"}`
      const out = redact(input)
      expect(() => JSON.parse(out)).not.toThrow()
      expect(JSON.parse(out)).toEqual({ password: "[REDACTED]", safe: "ok" })
    }
  })

  it("redacts pretty-printed JSON values after a newline", () => {
    const input = '{\n  "password":\n    "hunter2",\n  "safe": "ok"\n}'
    const out = redact(input)
    expect(JSON.parse(out)).toEqual({ password: "[REDACTED]", safe: "ok" })
  })

  it("tracks YAML single quotes while scanning nested flow values", () => {
    expect(redact("{password: {value: 'abc}def'}, safe: ok}")).toBe(
      '{password: "[REDACTED]", safe: ok}',
    )
  })

  it("preserves embedded tool payload structure around a nested secret", () => {
    expect(redact('[tool: demo] {"password":{"nested":"x"},"safe":"ok"}')).toBe(
      '[tool: demo] {"password":"[REDACTED]","safe":"ok"}',
    )
  })

  it("redacts aws credential assignments with the key name preserved", () => {
    const out = redact('aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG"')
    expect(out).not.toContain("wJalrXUtnFEMI")
    expect(out).toBe('aws_secret_access_key = "[REDACTED]"')
    const json = redact('"aws_access_key_id": "AKIAIOSFODNN7EXAMPLE"')
    expect(json).not.toContain("AKIAIOSFODNN7EXAMPLE")
    expect(json).toBe('"aws_access_key_id": "[REDACTED]"')
  })

  it("leaves non-secret text intact", () => {
    expect(redact("hello world")).toBe("hello world")
  })
})
describe("redact Bearer case-insensitivity", () => {
  it("redacts lowercase bearer tokens with 16+ chars like codex", () => {
    const { redact } = require("../src/redact.js")
    expect(redact("authorization: bearer abcdef1234567890")).not.toContain("abcdef1234567890")
  })
})

describe("isMemoryExcludedFragment", () => {
  it("excludes AGENTS.md instruction blocks and skill payloads", () => {
    const { isMemoryExcludedFragment } = require("../src/redact.js")
    expect(isMemoryExcludedFragment("# AGENTS.md instructions\nstuff\n</INSTRUCTIONS>")).toBe(true)
    expect(isMemoryExcludedFragment("  <skill>\npayload\n</skill>  ")).toBe(true)
    expect(isMemoryExcludedFragment("# agents.md INSTRUCTIONS\nstuff\n</instructions>")).toBe(true)
    expect(isMemoryExcludedFragment("normal user message")).toBe(false)
    expect(isMemoryExcludedFragment("# AGENTS.md instructions but no end marker")).toBe(false)
  })
})
