import { afterEach, describe, expect, it } from "bun:test"

// Transcript loading and session discovery go through the plugin's
// authenticated client (official API); tests install stub clients.
function setClient(client: unknown) {
  require("../src/llm.js").setPluginInput({ client } as any)
}
afterEach(() => setClient(undefined))

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
})

const PROJECTS = [{ worktree: "/proj/a" }, { worktree: "/proj/b" }]

function discoveryClient(perProject: Record<string, unknown[] | Error>) {
  return {
    project: { list: async () => ({ data: PROJECTS }) },
    session: {
      list: async ({ query }: { query: { directory: string } }) => {
        const rows = perProject[query.directory]
        if (rows instanceof Error) throw rows
        return { data: rows ?? [] }
      },
    },
  }
}

describe("listRecentSessions", () => {
  it("merges projects, filters children and plugin sub-sessions, sorts by recency", async () => {
    setClient(
      discoveryClient({
        "/proj/a": [
          { id: "ses_old", directory: "/proj/a", title: "old work", time: { updated: 1000 } },
          { id: "ses_child", parentID: "ses_old", title: "child", time: { updated: 5000 } },
          { id: "ses_sub", title: "codex-memory-extract-x", time: { updated: 6000 } },
        ],
        "/proj/b": [{ id: "ses_new", directory: "/proj/b", title: "new work", time: { updated: 2000 } }],
      }),
    )
    const { listRecentSessions } = require("../src/capture.js")
    const rows = await listRecentSessions()
    expect(rows.map((r: any) => r.id)).toEqual(["ses_new", "ses_old"])
    expect(rows[0].directory).toBe("/proj/b")
    expect(rows[0].updated_at).toBe(2000)
  })

  it("skips a failing project but keeps the others", async () => {
    setClient(
      discoveryClient({
        "/proj/a": new Error("stale directory"),
        "/proj/b": [{ id: "ses_b", directory: "/proj/b", title: "w", time: { updated: 42 } }],
      }),
    )
    const { listRecentSessions } = require("../src/capture.js")
    const rows = await listRecentSessions()
    expect(rows.map((r: any) => r.id)).toEqual(["ses_b"])
  })

  it("is fail-safe: returns [] when project discovery fails or no client exists", async () => {
    const { listRecentSessions } = require("../src/capture.js")
    expect(await listRecentSessions()).toEqual([])
    setClient({ project: { list: async () => ({ error: { status: 500 } }) }, session: { list: async () => ({ data: [] }) } })
    expect(await listRecentSessions()).toEqual([])
  })

  it("requests project scope with root sessions only", async () => {
    let seenQuery: any = null
    setClient({
      project: { list: async () => ({ data: [{ worktree: "/proj/a" }] }) },
      session: {
        list: async ({ query }: { query: unknown }) => {
          seenQuery = query
          return { data: [] }
        },
      },
    })
    const { listRecentSessions } = require("../src/capture.js")
    await listRecentSessions()
    expect(seenQuery).toEqual({ directory: "/proj/a", scope: "project", roots: true, limit: 5000 })
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
