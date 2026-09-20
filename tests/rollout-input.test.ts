import { describe, expect, it } from "bun:test"
import { serializeTieredInput } from "../src/rollout-input.js"
import { loadTranscript } from "../src/capture.js"
import { setPluginInput } from "../src/llm.js"

describe("serializeTieredInput", () => {
  it("keeps actual question-tool answers with their questions ahead of tool noise", async () => {
    setPluginInput({ client: { session: { messages: async () => ({ data: [{ info: { role: "assistant" }, parts: [
      { type: "tool", tool: "question", state: { input: { questions: [{ question: "Which package manager?" }] }, output: 'User has answered your questions: "Which package manager?"="bun". You can now continue with the user\'s answers in mind.' } },
      { type: "tool", tool: "shell", state: { output: "noise".repeat(10_000) } },
    ] }] }) } } } as any)
    try {
      const out = serializeTieredInput(await loadTranscript("ses_question"), 500)
      expect(out).toContain("[human user]")
      expect(out).toContain("Assistant question:")
      expect(out).toContain("Which package manager?")
      expect(out).toContain('="bun"')
    } finally {
      setPluginInput({ client: undefined } as any)
    }
  })

  it("keeps human evidence when tools would blow the budget", () => {
    const out = serializeTieredInput(
      [
        { type: "text", role: "user", text: "please use bun" },
        { type: "tool", role: "assistant", text: "x".repeat(50_000) },
        { type: "text", role: "assistant", text: "done" },
      ],
      2_000,
    )
    expect(out).toContain("[human user]")
    expect(out).toContain("please use bun")
    expect(out).toContain("[assistant final]")
    expect(out).toContain("done")
    expect(out.length).toBeLessThanOrEqual(2_000)
  })

  it("inserts omission markers when a middle tier is dropped", () => {
    const out = serializeTieredInput(
      [
        { type: "text", role: "user", text: "ask" },
        { type: "tool", role: "assistant", text: "noise".repeat(100) },
        { type: "text", role: "assistant", text: "done" },
      ],
      200,
    )
    expect(out).toContain("[human user]")
    expect(out).toContain("[... response items omitted ...]")
  })

  it("bounds multibyte evidence and keeps tool tails without splitting UTF-8", () => {
    const out = serializeTieredInput([
      { type: "text", role: "user", text: "Preserve unicode identifiers" },
      { type: "tool", role: "assistant", text: "😀".repeat(10_000) + "REGRESSION_PASSED" },
    ], 20_000)
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(20_000)
    expect(out).not.toContain("\uFFFD")
    expect(out).toContain("REGRESSION_PASSED")
    expect(out).toContain("Preserve unicode identifiers")
  })

  it("caps tool rows", () => {
    const out = serializeTieredInput(
      [{ type: "tool", role: "assistant", text: "t".repeat(20_000) }],
      50_000,
    )
    expect(out).toContain("[tool]")
    expect(out.length).toBeLessThan(12_000)
  })

  it("labels rows and keeps chronological order of selected items", () => {
    const out = serializeTieredInput([
      { type: "text", role: "user", text: "first" },
      { type: "text", role: "assistant", text: "second" },
      { type: "text", role: "user", text: "third" },
    ])
    expect(out.indexOf("first")).toBeLessThan(out.indexOf("second"))
    expect(out.indexOf("second")).toBeLessThan(out.indexOf("third"))
  })

  it("drops AGENTS.md user fragments and substitutes image placeholders", () => {
    const out = serializeTieredInput([
      {
        type: "text",
        role: "user",
        text: "# AGENTS.md instructions for /tmp\n\n<INSTRUCTIONS>\nbody\n</INSTRUCTIONS>",
      },
      { type: "image", role: "user", text: "" },
      { type: "text", role: "user", text: "real ask" },
    ])
    expect(out).not.toContain("AGENTS.md")
    expect(out).toContain("[image omitted]")
    expect(out).toContain("real ask")
  })
})
