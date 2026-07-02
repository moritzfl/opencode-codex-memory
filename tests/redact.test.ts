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

  it("leaves non-secret text intact", () => {
    expect(redact("hello world")).toBe("hello world")
  })
})