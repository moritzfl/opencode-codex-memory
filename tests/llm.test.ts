import { afterEach, describe, it, expect } from "bun:test"
import {
  parseExtraction,
  validateExtraction,
  extractViaSubagent,
  setPluginInput,
  fillTemplate,
  cleanupOldSubSessions,
  isMemorySubSession,
  SubagentTimeoutError,
} from "../src/llm.js"

describe("fillTemplate", () => {
  it("substitutes placeholders", () => {
    expect(fillTemplate("id: {{ session_id }}", { session_id: "s1" })).toBe("id: s1")
  })

  it("does not expand $-patterns in the value", () => {
    const out = fillTemplate("body: {{ transcript }}", { transcript: "price is $& and $' and $1" })
    expect(out).toBe("body: price is $& and $' and $1")
  })
})

describe("parseExtraction", () => {
  it("parses a clean JSON object", () => {
    const raw = JSON.stringify({ raw_memory: "rm", rollout_summary: "rs", rollout_slug: "slug-1" })
    const r = parseExtraction(raw)!
    expect(r.raw_memory).toBe("rm")
    expect(r.rollout_summary).toBe("rs")
    expect(r.rollout_slug).toBe("slug-1")
  })

  it("parses JSON wrapped in code fences", () => {
    const raw = "```json\n" + JSON.stringify({ raw_memory: "rm", rollout_summary: "rs", rollout_slug: "x" }) + "\n```"
    expect(parseExtraction(raw)!.raw_memory).toBe("rm")
  })

  it("parses JSON embedded in prose", () => {
    const raw = "Here is the result:\n" + JSON.stringify({ raw_memory: "rm", rollout_summary: "rs" }) + "\nDone."
    const r = parseExtraction(raw)!
    expect(r.raw_memory).toBe("rm")
    expect(r.rollout_slug).toBeNull()
  })

  it("returns null for the all-empty no-op response", () => {
    const raw = JSON.stringify({ raw_memory: "", rollout_summary: "", rollout_slug: "" })
    expect(parseExtraction(raw)).toBeNull()
  })

  it("treats a whitespace-only response as a no-op", () => {
    const raw = JSON.stringify({ raw_memory: "  \n", rollout_summary: " ", rollout_slug: "" })
    expect(parseExtraction(raw)).toBeNull()
  })

  // codex phase1: empty raw_memory OR empty rollout_summary → SucceededNoOutput
  it("returns null when only raw_memory is empty", () => {
    const raw = JSON.stringify({ raw_memory: "", rollout_summary: "rs", rollout_slug: "x" })
    expect(parseExtraction(raw)).toBeNull()
  })

  it("returns null when only rollout_summary is empty", () => {
    const raw = JSON.stringify({ raw_memory: "rm", rollout_summary: "  ", rollout_slug: "x" })
    expect(parseExtraction(raw)).toBeNull()
  })

  it("normalizes an empty slug to null", () => {
    const raw = JSON.stringify({ raw_memory: "rm", rollout_summary: "rs", rollout_slug: "" })
    expect(parseExtraction(raw)!.rollout_slug).toBeNull()
  })

  it("throws when no JSON object is present", () => {
    expect(() => parseExtraction("no json here")).toThrow()
  })

  it("throws when required fields are missing", () => {
    expect(() => parseExtraction(JSON.stringify({ rollout_summary: "rs" }))).toThrow()
  })

  it("throws when raw_memory echoes the template skeleton", () => {
    const raw = JSON.stringify({
      raw_memory: "task_outcome: <success|partial|fail|uncertain>",
      rollout_summary: "rs",
      rollout_slug: "slug",
    })
    expect(() => parseExtraction(raw)).toThrow()
  })
})

// The primary extraction path reads AssistantMessage.structured (a pre-parsed
// object) and feeds it straight to validateExtraction — no text scraping.
describe("validateExtraction", () => {
  it("accepts a well-formed structured object", () => {
    const r = validateExtraction({ raw_memory: "rm", rollout_summary: "rs", rollout_slug: "slug-1" })!
    expect(r.raw_memory).toBe("rm")
    expect(r.rollout_summary).toBe("rs")
    expect(r.rollout_slug).toBe("slug-1")
  })

  it("returns null for the all-empty no-op object", () => {
    expect(validateExtraction({ raw_memory: "", rollout_summary: "", rollout_slug: "" })).toBeNull()
  })

  it("returns null when either required field is blank", () => {
    expect(validateExtraction({ raw_memory: "rm", rollout_summary: "  ", rollout_slug: "x" })).toBeNull()
    expect(validateExtraction({ raw_memory: " ", rollout_summary: "rs", rollout_slug: "x" })).toBeNull()
  })

  it("normalizes a blank slug to null", () => {
    expect(validateExtraction({ raw_memory: "rm", rollout_summary: "rs", rollout_slug: "" })!.rollout_slug).toBeNull()
  })

  it("throws when required fields are missing or mistyped", () => {
    expect(() => validateExtraction({ rollout_summary: "rs" })).toThrow()
    expect(() => validateExtraction({ raw_memory: 5 as unknown as string, rollout_summary: "rs" })).toThrow()
  })

  it("throws when raw_memory echoes the template skeleton", () => {
    expect(() =>
      validateExtraction({ raw_memory: "task: <primary task signature>", rollout_summary: "rs", rollout_slug: "s" }),
    ).toThrow()
  })
})

describe("extractViaSubagent (structured output)", () => {
  // Stub the plugin client; capture the prompt body so we can assert the
  // json_schema format request, and control what session.prompt returns.
  function stubClient(promptResult: (body: any) => any): { getPromptBody: () => any; getCreateBody: () => any } {
    let capturedBody: any
    let capturedCreateBody: any
    const client = {
      session: {
        create: async (req: any) => {
          capturedCreateBody = req.body
          return { data: { id: "sub-1" } }
        },
        prompt: async (req: any) => {
          capturedBody = req.body
          return promptResult(req.body)
        },
        delete: async () => ({ data: {} }),
      },
      config: { get: async () => ({ data: {} }) },
    }
    setPluginInput({ client } as any)
    return {
      getPromptBody: () => capturedBody,
      getCreateBody: () => capturedCreateBody,
    }
  }
  afterEach(() => setPluginInput({ client: undefined } as any))

  it("requests json_schema format and reads the result from AssistantMessage.structured", async () => {
    const captured = stubClient(() => ({
      data: { info: { structured: { raw_memory: "rm", rollout_summary: "rs", rollout_slug: "slug" } } },
    }))
    const r = await extractViaSubagent("ses_1", "transcript", { cwd: "/x" })
    expect(r).toEqual({ raw_memory: "rm", rollout_summary: "rs", rollout_slug: "slug" })
    const body = captured.getPromptBody()
    expect(body.format?.type).toBe("json_schema")
    expect(body.format?.schema?.required).toContain("raw_memory")
    expect(captured.getCreateBody().metadata).toEqual({ "opencode-codex-memory": true })
  })

  it("falls back to parsing assistant text when structured output is absent", async () => {
    stubClient(() => ({
      data: {
        info: {},
        parts: [{ type: "text", text: JSON.stringify({ raw_memory: "rm", rollout_summary: "rs", rollout_slug: "" }) }],
      },
    }))
    const r = await extractViaSubagent("ses_2", "transcript")
    expect(r?.raw_memory).toBe("rm")
    expect(r?.rollout_slug).toBeNull()
  })

  it("treats an all-empty structured object as a no-op", async () => {
    stubClient(() => ({ data: { info: { structured: { raw_memory: "", rollout_summary: "", rollout_slug: "" } } } }))
    expect(await extractViaSubagent("ses_3", "transcript")).toBeNull()
  })

  it("rejects an HTTP-success response whose assistant message contains an error", async () => {
    stubClient(() => ({
      data: {
        info: {
          error: { name: "ProviderAuthError", data: { message: "expired key" } },
          structured: { raw_memory: "partial", rollout_summary: "partial", rollout_slug: "partial" },
        },
      },
    }))
    expect(extractViaSubagent("ses_error", "transcript")).rejects.toThrow("ProviderAuthError")
  })

  it("aborts the sub-session when the prompt times out", async () => {
    const aborted: string[] = []
    const deleted: string[] = []
    const client = {
      session: {
        create: async () => ({ data: { id: "sub-timeout" } }),
        prompt: async () => new Promise(() => {}), // never resolves
        abort: async function (this: unknown, req: { path: { id: string } }) {
          if (this !== client.session) throw new Error("abort called without its SDK receiver")
          aborted.push(req.path.id)
          return { data: {} }
        },
        delete: async (req: { path: { id: string } }) => {
          deleted.push(req.path.id)
          return { data: {} }
        },
      },
      config: { get: async () => ({ data: {} }) },
    }
    setPluginInput({ client } as any)
    // Typed, not message-matched: the abort branch keys on the class.
    await expect(extractViaSubagent("ses_timeout", "transcript", { timeoutMs: 30 })).rejects.toBeInstanceOf(
      SubagentTimeoutError,
    )
    expect(aborted).toEqual(["sub-timeout"])
    // finally still deletes
    expect(deleted).toEqual(["sub-timeout"])
  })

  it("does not abort when the failure is not a timeout", async () => {
    const aborted: string[] = []
    setPluginInput({
      client: {
        session: {
          create: async () => ({ data: { id: "sub-err" } }),
          prompt: async () => ({ data: { info: { error: { name: "ProviderAuthError" } } } }),
          abort: async (req: { path: { id: string } }) => {
            aborted.push(req.path.id)
            return { data: {} }
          },
          delete: async () => ({ data: {} }),
        },
        config: { get: async () => ({ data: {} }) },
      },
    } as any)
    await expect(extractViaSubagent("ses_err", "transcript")).rejects.toThrow("ProviderAuthError")
    // The request already settled — aborting would be a pointless extra call.
    expect(aborted).toEqual([])
  })
})

describe("cleanupOldSubSessions", () => {
  afterEach(() => setPluginInput({ client: undefined } as any))

  it("reseeds isMemorySubSession for live codex-memory-* sessions", async () => {
    // Simulate a plugin reload: Set is empty, but live sub-sessions remain.
    expect(isMemorySubSession("sub-live")).toBe(false)
    setPluginInput({
      client: {
        session: {
          list: async () => ({
            data: [
              { id: "sub-live", metadata: { "opencode-codex-memory": true }, time: { created: Date.now() } },
              { id: "sub-old", metadata: { "opencode-codex-memory": true }, time: { created: Date.now() - 120 * 60 * 1000 } },
              { id: "user-ses", title: "normal chat", time: { created: Date.now() } },
            ],
          }),
          delete: async () => ({ data: {} }),
        },
      },
    } as any)
    await cleanupOldSubSessions(90)
    expect(isMemorySubSession("sub-live")).toBe(true)
    // Old one was deleted and removed from the set.
    expect(isMemorySubSession("sub-old")).toBe(false)
    expect(isMemorySubSession("user-ses")).toBe(false)
  })

  it("never treats a user-editable title as sub-session ownership", async () => {
    const deleted: string[] = []
    setPluginInput({
      client: {
        session: {
          list: async () => ({
            data: [
              {
                id: "user-prefixed-title",
                title: "codex-memory-personal-notes",
                time: { created: Date.now() - 120 * 60 * 1000 },
              },
            ],
          }),
          delete: async (req: { path: { id: string } }) => {
            deleted.push(req.path.id)
            return { data: {} }
          },
        },
      },
    } as any)

    await cleanupOldSubSessions(90)
    expect(deleted).toEqual([])
    expect(isMemorySubSession("user-prefixed-title")).toBe(false)
  })

  it("bounds a stalled sub-session listing", async () => {
    setPluginInput({
      client: { session: { list: async () => new Promise(() => {}) } },
    } as any)

    const started = Date.now()
    await cleanupOldSubSessions(90, 20)
    expect(Date.now() - started).toBeLessThan(500)
  })
})
