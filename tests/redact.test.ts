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
    expect(redact('password: "supersecret123"')).toMatch(/password=\[REDACTED\]/)
  })

  it("redacts quoted keys in JSON tool payloads", () => {
    expect(redact('{"password":"hunter2secret"}')).not.toContain("hunter2secret")
    expect(redact('{"api_key": "abcd1234efgh"}')).not.toContain("abcd1234efgh")
    expect(redact("'token': 'abcd1234efgh'")).not.toContain("abcd1234efgh")
    expect(redact('"access-token"="abcd1234efgh"')).not.toContain("abcd1234efgh")
  })

  it("redacts aws credential assignments with the key name preserved", () => {
    const out = redact('aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG"')
    expect(out).not.toContain("wJalrXUtnFEMI")
    expect(out).toContain("aws_secret_access_key=[REDACTED]")
    const json = redact('"aws_access_key_id": "AKIAIOSFODNN7EXAMPLE"')
    expect(json).not.toContain("AKIAIOSFODNN7EXAMPLE")
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
