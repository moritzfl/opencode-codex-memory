import { afterEach, beforeEach, describe, expect, it } from "bun:test"

// Transcript loading and session discovery go through the plugin's
// authenticated client (official API); tests install stub clients.
function setClient(client: unknown) {
  require("../src/llm.js").setPluginInput({ client } as any)
}
beforeEach(() => {
  require("../src/capture.js").resetDiscoveryCacheForTest()
})
afterEach(() => {
  setClient(undefined)
  require("../src/capture.js").resetDiscoveryCacheForTest()
})

const API_ROWS = [
  {
    info: { role: "user" },
    parts: [{ type: "text", text: "api question" }],
  },
  {
    info: { role: "assistant" },
    parts: [
      { type: "reasoning", text: "api chain of thought" },
      { type: "text", text: "api answer" },
      { type: "tool", tool: "bash", state: { input: { command: "ls" }, output: "api-file.txt" } },
      { type: "step-start" },
    ],
  },
]

function messagesClient(rows: unknown) {
  return { session: { messages: async () => ({ data: rows }) } }
}

describe("loadTranscript", () => {
  it("maps one entry per part with the message role", async () => {
    setClient(messagesClient(API_ROWS))
    const { loadTranscript } = require("../src/capture.js")
    const msgs = await loadTranscript("ses_1")
    expect(msgs.length).toBe(5)
    expect(msgs.find((m: any) => m.role === "user").text).toBe("api question")
    expect(msgs.find((m: any) => m.type === "tool").text).toContain("[tool: bash]")
    expect(msgs.find((m: any) => m.type === "tool").text).toContain("api-file.txt")
  })

  it("excludes reasoning and step parts like codex's rollout policy (Reasoning => false)", async () => {
    setClient(messagesClient(API_ROWS))
    const { loadTranscript } = require("../src/capture.js")
    const msgs = await loadTranscript("ses_1")
    // Reasoning parts carry `text`, but must not contribute transcript content.
    expect(msgs.find((m: any) => m.type === "reasoning").text).toBeUndefined()
    expect(msgs.find((m: any) => m.type === "step-start").text).toBeUndefined()
  })

  // ToolStateError has no `output` — only `error`. codex keeps failed calls
  // (rollout policy FunctionCallOutput => true) and failures are high-signal.
  it("keeps the error text of a failed tool call", async () => {
    setClient(
      messagesClient([
        {
          info: { role: "assistant" },
          parts: [
            {
              type: "tool",
              tool: "bash",
              state: { status: "error", input: { command: "migrate" }, error: "exit 1: relation does not exist" },
            },
          ],
        },
      ]),
    )
    const { loadTranscript } = require("../src/capture.js")
    const msgs = await loadTranscript("ses_err")
    expect(msgs[0].text).toContain("[tool: bash]")
    expect(msgs[0].text).toContain("migrate")
    expect(msgs[0].text).toContain("relation does not exist")
  })

  // opencode drops these when building model messages (session/message-v2.ts),
  // so the assistant never saw them — they are not conversation.
  it("skips text parts flagged ignored", async () => {
    setClient(
      messagesClient([
        {
          info: { role: "user" },
          parts: [
            { type: "text", text: "visible ask", ignored: false },
            { type: "text", text: "client-only chatter", ignored: true },
          ],
        },
      ]),
    )
    const { loadTranscript } = require("../src/capture.js")
    const msgs = await loadTranscript("ses_ignored")
    const texts = msgs.map((m: any) => m.text)
    expect(texts).toContain("visible ask")
    expect(texts).not.toContain("client-only chatter")
  })

  // A swallowed error here used to surface as an empty transcript, which
  // phase 1 records as a successful no-output extraction — erasing memory.
  it("throws on API error responses instead of returning an empty transcript", async () => {
    setClient({ session: { messages: async () => ({ error: { status: 500 } }) } })
    const { loadTranscript } = require("../src/capture.js")
    expect(loadTranscript("ses_1")).rejects.toThrow(/session.messages failed/)
  })

  it("throws when the API call itself rejects", async () => {
    setClient({ session: { messages: async () => { throw new Error("boom") } } })
    const { loadTranscript } = require("../src/capture.js")
    expect(loadTranscript("ses_1")).rejects.toThrow("boom")
  })

  it("throws when no client is available", async () => {
    const { loadTranscript } = require("../src/capture.js")
    expect(loadTranscript("ses_1")).rejects.toThrow(/plugin client unavailable/)
  })

  it("returns [] for a genuinely empty session", async () => {
    setClient(messagesClient([]))
    const { loadTranscript } = require("../src/capture.js")
    expect(await loadTranscript("ses_1")).toEqual([])
  })

  it("passes an abort signal to session.messages", async () => {
    let signal: AbortSignal | undefined
    setClient({
      session: {
        messages: async (req: { signal?: AbortSignal }) => {
          signal = req.signal
          return { data: API_ROWS }
        },
      },
    })
    const { loadTranscript } = require("../src/capture.js")
    await loadTranscript("ses_1")
    expect(signal).toBeDefined()
  })
})

function discoveryClient(rows: unknown[] | Error, capture?: { query?: unknown; url?: string; signal?: AbortSignal }) {
  return {
    _client: {
      get: async (opts: { url: string; query?: unknown; signal?: AbortSignal }) => {
        if (capture) {
          capture.url = opts.url
          capture.query = opts.query
          capture.signal = opts.signal
        }
        if (rows instanceof Error) throw rows
        return { data: rows }
      },
    },
  }
}

describe("listRecentSessions", () => {
  it("filters children and plugin sub-sessions, sorts by recency", async () => {
    setClient(
      discoveryClient([
        { id: "ses_new", directory: "/proj/b", title: "new work", time: { updated: 2000 } },
        { id: "ses_old", directory: "/proj/a", title: "old work", time: { updated: 1000 } },
        { id: "ses_child", parentID: "ses_old", title: "child", time: { updated: 5000 } },
        { id: "ses_sub", title: "codex-memory-extract-x", time: { updated: 6000 } },
      ]),
    )
    const { listRecentSessions } = require("../src/capture.js")
    const rows = await listRecentSessions()
    expect(rows.map((r: any) => r.id)).toEqual(["ses_new", "ses_old"])
    expect(rows[0].directory).toBe("/proj/b")
    expect(rows[0].updated_at).toBe(2000)
  })

  it("is fail-safe: returns [] when discovery fails or no client exists", async () => {
    const { listRecentSessions } = require("../src/capture.js")
    expect(await listRecentSessions()).toEqual([])
    setClient(discoveryClient(new Error("stale")))
    expect(await listRecentSessions()).toEqual([])
    setClient({
      _client: {
        get: async () => ({ error: { status: 500 } }),
      },
    })
    expect(await listRecentSessions()).toEqual([])
  })

  it("calls experimental.session.list with roots, limit, and empty directory (global)", async () => {
    const seen: { query?: unknown; url?: string; signal?: AbortSignal } = {}
    setClient(discoveryClient([], seen))
    const { listRecentSessions } = require("../src/capture.js")
    await listRecentSessions(42)
    expect(seen.url).toBe("/experimental/session")
    // directory:"" suppresses the SDK client's project-scope injection so
    // listGlobal is host-wide (memory is global).
    expect(seen.query).toEqual({ roots: true, limit: 42, directory: "" })
    expect(seen.signal).toBeDefined()
  })

  it("coalesces repeated discovery calls within the cache window", async () => {
    let hits = 0
    setClient({
      _client: {
        get: async () => {
          hits++
          return {
            data: [{ id: "ses_a", directory: "/p", time: { updated: 1 } }],
          }
        },
      },
    })
    const { listRecentSessions } = require("../src/capture.js")
    const a = await listRecentSessions()
    const b = await listRecentSessions()
    expect(hits).toBe(1)
    expect(a).toEqual(b)
    expect(a[0].id).toBe("ses_a")
  })
})

describe("buildTranscript", () => {
  it("excludes developer-role messages (codex sanitize_response_item_for_memories)", async () => {
    setClient(
      messagesClient([
        ...API_ROWS,
        { info: { role: "developer" }, parts: [{ type: "text", text: "injected developer instructions" }] },
      ]),
    )
    delete require.cache[require.resolve("../src/phase1.js")]
    const { buildTranscript } = require("../src/phase1.js")
    const transcript = await buildTranscript("ses_1")
    expect(transcript).toContain("api answer")
    expect(transcript).not.toContain("injected developer instructions")
  })
})
