import { afterEach, describe, it, expect } from "bun:test"
import { beginPluginShutdown, resetPluginLifecycle } from "../src/lifecycle.js"
import {
  parseExtraction,
  validateExtraction,
  extractViaSubagent,
  consolidateViaSubagent,
  setPluginInput,
  fillTemplate,
  cleanupOldSubSessions,
  isMemorySubSession,
  resolveExtractionModel,
  setConfigGetTimeoutForTest,
  setStaleDeleteBatchTimeoutForTest,
  setSubSessionCreateTimeoutForTest,
  SubagentTimeoutError,
  SubagentCancelledError,
  SubagentShutdownError,
} from "../src/llm.js"
import { SCAN_LIMIT } from "../src/store.js"

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

describe("sub-agent model resolution", () => {
  afterEach(() => {
    setConfigGetTimeoutForTest()
    setPluginInput({ client: undefined } as any)
  })

  it("does not cache a transient config error", async () => {
    let calls = 0
    setPluginInput({
      client: {
        config: {
          get: async () => ++calls === 1
            ? { error: { message: "temporary" } }
            : { data: { small_model: "healthy/model" } },
        },
      },
    } as any)
    expect(await resolveExtractionModel()).toBeUndefined()
    expect(await resolveExtractionModel()).toBe("healthy/model")
    expect(calls).toBe(2)
  })

  it("bounds and aborts a stalled config lookup", async () => {
    let signal: AbortSignal | undefined
    setPluginInput({
      client: {
        config: {
          get: async (opts: { signal?: AbortSignal }) => {
            signal = opts.signal
            return new Promise(() => {})
          },
        },
      },
    } as any)
    setConfigGetTimeoutForTest(20)
    expect(await resolveExtractionModel()).toBeUndefined()
    expect(signal?.aborted).toBe(true)
  })

  it("coalesces lookups and ignores a stale client response", async () => {
    let resolveOld!: (value: unknown) => void
    let oldCalls = 0
    setPluginInput({
      client: {
        config: {
          get: async () => {
            oldCalls++
            return new Promise((resolve) => { resolveOld = resolve })
          },
        },
      },
    } as any)
    const oldA = resolveExtractionModel()
    const oldB = resolveExtractionModel()
    await Promise.resolve()
    expect(oldCalls).toBe(1)

    setPluginInput({
      client: { config: { get: async () => ({ data: { small_model: "new/model" } }) } },
    } as any)
    expect(await resolveExtractionModel()).toBe("new/model")
    resolveOld({ data: { small_model: "old/model" } })
    expect(await oldA).toBeUndefined()
    expect(await oldB).toBeUndefined()
    expect(await resolveExtractionModel()).toBe("new/model")
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
  afterEach(() => {
    setPluginInput({ client: undefined } as any)
    setSubSessionCreateTimeoutForTest()
  })

  it("requests json_schema format and reads the result from AssistantMessage.structured", async () => {
    const captured = stubClient(() => ({
      data: { info: { structured: { raw_memory: "rm", rollout_summary: "rs", rollout_slug: "slug" } } },
    }))
    const r = await extractViaSubagent("ses_1", "transcript", { cwd: "/x" })
    expect(r).toEqual({ raw_memory: "rm", rollout_summary: "rs", rollout_slug: "slug" })
    const body = captured.getPromptBody()
    expect(body.format?.type).toBe("json_schema")
    expect(body.format?.schema?.required).toContain("raw_memory")
    expect(body.variant).toBe("low")
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

  it("bounds a stalled session.create", async () => {
    let createSignal: AbortSignal | undefined
    setPluginInput({
      client: {
        session: {
          create: async (req: { signal?: AbortSignal }) => {
            createSignal = req.signal
            return new Promise(() => {})
          },
        },
        config: { get: async () => ({ data: {} }) },
      },
    } as any)
    setSubSessionCreateTimeoutForTest(20)
    await expect(extractViaSubagent("ses_create_hang", "transcript")).rejects.toThrow("session.create timed out")
    expect(createSignal?.aborted).toBe(true)
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

  it("does not let a stalled abort hide the original prompt timeout", async () => {
    let abortSignal: AbortSignal | undefined
    const deleted: string[] = []
    setPluginInput({
      client: {
        session: {
          create: async () => ({ data: { id: "sub-stalled-abort" } }),
          prompt: async () => new Promise(() => {}),
          abort: async (req: { signal?: AbortSignal }) => {
            abortSignal = req.signal
            return new Promise(() => {})
          },
          delete: async (req: { path: { id: string } }) => {
            deleted.push(req.path.id)
            return { data: {} }
          },
        },
        config: { get: async () => ({ data: {} }) },
      },
    } as any)

    await expect(extractViaSubagent("ses_stalled_abort", "transcript", { timeoutMs: 20 })).rejects.toBeInstanceOf(
      SubagentTimeoutError,
    )
    expect(abortSignal?.aborted).toBe(true)
    await Promise.resolve()
    expect(deleted).toEqual(["sub-stalled-abort"])
  })

  it("cancels extract on plugin dispose via pluginShutdownSignal", async () => {
    resetPluginLifecycle()
    const aborted: string[] = []
    const deleted: string[] = []
    setPluginInput({
      client: {
        session: {
          create: async () => ({ data: { id: "sub-extract-dispose" } }),
          prompt: async () => {
            beginPluginShutdown()
            return new Promise(() => {})
          },
          abort: async (req: { path: { id: string } }) => {
            aborted.push(req.path.id)
            return { data: {} }
          },
          delete: async (req: { path: { id: string } }) => {
            deleted.push(req.path.id)
            return { data: {} }
          },
        },
        config: { get: async () => ({ data: {} }) },
      },
    } as any)

    await expect(extractViaSubagent("ses_dispose", "transcript")).rejects.toBeInstanceOf(SubagentCancelledError)
    expect(aborted).toEqual(["sub-extract-dispose"])
    expect(deleted).toEqual(["sub-extract-dispose"])
    resetPluginLifecycle()
  })
})

describe("memory sub-session directory", () => {
  afterEach(() => setPluginInput({ client: undefined } as any))

  it("anchors sub-sessions on the memory root, not a possibly-deleted project cwd", async () => {
    const { memoryRoot } = await import("../src/paths.js")
    const seen: Array<{ query?: { directory?: string } }> = []
    setPluginInput({
      directory: "/private/tmp/oc space test-missing-definitely",
      client: {
        session: {
          create: async (req: { query?: { directory?: string } }) => {
            seen.push(req)
            return { data: { id: "sub-dir" } }
          },
          prompt: async () => ({ data: { info: {}, parts: [{ type: "text", text: "done" }] } }),
          delete: async () => ({ data: {} }),
        },
        config: { get: async () => ({ data: {} }) },
      },
    } as any)
    await consolidateViaSubagent("/tmp/does-not-matter", "phase2_workspace_diff.md")
    expect(seen).toHaveLength(1)
    expect(seen[0].query?.directory).toBe(memoryRoot())
  })

  it("pins consolidation reasoning to variant medium", async () => {
    let variant: string | undefined
    setPluginInput({
      client: {
        session: {
          create: async () => ({ data: { id: "sub-variant" } }),
          prompt: async (req: { body: { variant?: string } }) => {
            variant = req.body.variant
            return { data: { info: {}, parts: [{ type: "text", text: "done" }] } }
          },
          delete: async () => ({ data: {} }),
        },
        config: { get: async () => ({ data: {} }) },
      },
    } as any)
    await consolidateViaSubagent("/tmp/does-not-matter", "phase2_workspace_diff.md")
    expect(variant).toBe("medium")
  })
})

describe("consolidateViaSubagent shutdown (codex phase2.rs shutdown-before-finish)", () => {
  afterEach(() => setPluginInput({ client: undefined } as any))

  function stubConsolidationClient(deleteImpl: () => Promise<any>, promptImpl?: () => Promise<any>) {
    setPluginInput({
      client: {
        session: {
          create: async () => ({ data: { id: "sub-consolidate" } }),
          prompt: promptImpl ?? (async () => ({ data: { info: {}, parts: [{ type: "text", text: "done" }] } })),
          delete: deleteImpl,
        },
        config: { get: async () => ({ data: {} }) },
      },
    } as any)
  }

  it("resolves only after the sub-session is closed", async () => {
    const order: string[] = []
    stubConsolidationClient(async () => {
      order.push("delete")
      return { data: {} }
    })
    await consolidateViaSubagent("/tmp/does-not-matter", "phase2_workspace_diff.md")
    order.push("returned")
    expect(order).toEqual(["delete", "returned"])
  })

  it("throws SubagentShutdownError when the delete call fails", async () => {
    stubConsolidationClient(async () => ({ error: { message: "boom" } }))
    await expect(consolidateViaSubagent("/tmp/does-not-matter", "phase2_workspace_diff.md")).rejects.toBeInstanceOf(
      SubagentShutdownError,
    )
  })

  it("bounds a stalled consolidation-session delete", async () => {
    stubConsolidationClient(async () => new Promise(() => {}))
    const started = Date.now()
    await expect(consolidateViaSubagent("/tmp/does-not-matter", "phase2_workspace_diff.md")).rejects.toBeInstanceOf(
      SubagentShutdownError,
    )
    expect(Date.now() - started).toBeLessThan(11_000)
  }, 12_000)

  it("refreshes configured model defaults when the plugin client changes", async () => {
    const seen: string[] = []
    const install = (smallModel: string) => setPluginInput({
      client: {
        session: {
          create: async () => ({ data: { id: `sub-${smallModel}` } }),
          prompt: async (req: any) => {
            seen.push(`${req.body.model.providerID}/${req.body.model.modelID}`)
            return { data: { info: { structured: { raw_memory: "rm", rollout_summary: "rs", rollout_slug: "" } } } }
          },
          delete: async () => ({ data: {} }),
        },
        config: { get: async () => ({ data: { small_model: smallModel } }) },
      },
    } as any)

    install("provider/first")
    await extractViaSubagent("ses_first", "transcript")
    install("provider/second")
    await extractViaSubagent("ses_second", "transcript")
    expect(seen).toEqual(["provider/first", "provider/second"])
  })

  it("lets a failed shutdown outrank the prompt failure", async () => {
    stubConsolidationClient(
      async () => {
        throw new Error("delete exploded")
      },
      async () => ({ data: { info: { error: { name: "ProviderAuthError" } } } }),
    )
    // codex returns early on shutdown failure regardless of the agent status:
    // an agent that may still be alive must keep the lease, not fail the job.
    await expect(consolidateViaSubagent("/tmp/does-not-matter", "phase2_workspace_diff.md")).rejects.toBeInstanceOf(
      SubagentShutdownError,
    )
  })

  it("still surfaces the prompt failure when the shutdown succeeds", async () => {
    stubConsolidationClient(
      async () => ({ data: {} }),
      async () => ({ data: { info: { error: { name: "ProviderAuthError" } } } }),
    )
    await expect(consolidateViaSubagent("/tmp/does-not-matter", "phase2_workspace_diff.md")).rejects.toThrow(
      "ProviderAuthError",
    )
  })

  it("aborts and closes the consolidation session when its owner cancels", async () => {
    const calls: string[] = []
    const controller = new AbortController()
    setPluginInput({
      client: {
        session: {
          create: async () => ({ data: { id: "sub-consolidate-cancel" } }),
          prompt: async () => new Promise(() => {}),
          abort: async (req: { path: { id: string } }) => {
            calls.push(`abort:${req.path.id}`)
            return { data: {} }
          },
          delete: async (req: { path: { id: string } }) => {
            calls.push(`delete:${req.path.id}`)
            return { data: {} }
          },
        },
        config: { get: async () => ({ data: {} }) },
      },
    } as any)

    const running = consolidateViaSubagent(
      "/tmp/does-not-matter",
      "phase2_workspace_diff.md",
      undefined,
      controller.signal,
    )
    await Promise.resolve()
    controller.abort()
    await expect(running).rejects.toBeInstanceOf(SubagentCancelledError)
    expect(calls).toEqual(["abort:sub-consolidate-cancel", "delete:sub-consolidate-cancel"])
  })
})

function cleanupListClient(
  sessions: unknown[],
  extras?: {
    delete?: (req: { path: { id: string } }) => Promise<unknown>
    get?: () => Promise<unknown>
    hangList?: boolean
    seen?: { url?: string; query?: unknown }
    list?: (opts: { url?: string; query?: Record<string, unknown> }) => Promise<unknown>
  },
) {
  return {
    _client: {
      get: extras?.list ?? (extras?.hangList
        ? async () => new Promise(() => {})
        : async (opts: { url?: string; query?: unknown }) => {
            if (extras?.seen) {
              extras.seen.url = opts.url
              extras.seen.query = opts.query
            }
            return { data: sessions }
          }),
    },
    session: {
      delete: extras?.delete ?? (async () => ({ data: {} })),
      get: extras?.get ?? (async () => ({ error: { name: "NotFound" }, response: { status: 404 } })),
    },
  }
}

describe("cleanupOldSubSessions", () => {
  afterEach(() => {
    setStaleDeleteBatchTimeoutForTest()
    setPluginInput({ client: undefined } as any)
  })

  it("reseeds isMemorySubSession for live codex-memory-* sessions", async () => {
    // Simulate a plugin reload: Set is empty, but live sub-sessions remain.
    expect(isMemorySubSession("sub-live")).toBe(false)
    const seen: { url?: string; query?: unknown } = {}
    setPluginInput({
      client: cleanupListClient(
        [
          { id: "sub-live", title: "codex-memory-consolidate", metadata: { "opencode-codex-memory": true }, time: { created: Date.now() } },
          { id: "sub-old", title: "codex-memory-extract-ses_old123", metadata: { "opencode-codex-memory": true }, time: { created: Date.now() - 120 * 60 * 1000 } },
          { id: "user-ses", title: "normal chat", time: { created: Date.now() } },
        ],
        { seen },
      ),
    } as any)
    await cleanupOldSubSessions(90)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(seen.url).toBe("/experimental/session")
    expect(seen.query).toEqual({
      roots: true,
      limit: SCAN_LIMIT,
      directory: "",
      search: "codex-memory-",
    })
    expect(isMemorySubSession("sub-live")).toBe(true)
    // Old one was deleted and removed from the set.
    expect(isMemorySubSession("sub-old")).toBe(false)
    expect(isMemorySubSession("user-ses")).toBe(false)
  })

  it("reseeds legacy sub-sessions without allowing their titles to authorize deletion", async () => {
    const deleted: string[] = []
    setPluginInput({
      client: cleanupListClient(
        [
          {
            id: "legacy-live",
            title: "codex-memory-extract-ses_legacy123",
            time: { created: Date.now() - 120 * 60 * 1000 },
          },
        ],
        {
          delete: async (req: { path: { id: string } }) => {
            deleted.push(req.path.id)
            return { data: {} }
          },
        },
      ),
    } as any)

    await cleanupOldSubSessions(90)
    expect(isMemorySubSession("legacy-live")).toBe(true)
    expect(deleted).toEqual([])
  })

  it("does not block startup on stale sub-session deletion", async () => {
    setPluginInput({
      client: cleanupListClient(
        [
          {
            id: "stale-delete",
            title: "codex-memory-consolidate",
            metadata: { "opencode-codex-memory": true },
            time: { created: Date.now() - 120 * 60 * 1000 },
          },
        ],
        { delete: async () => new Promise(() => {}) },
      ),
    } as any)

    const started = Date.now()
    await cleanupOldSubSessions(90)
    expect(Date.now() - started).toBeLessThan(500)
    expect(isMemorySubSession("stale-delete")).toBe(true)
  })

  it("keeps ownership when stale sub-session deletion fails", async () => {
    setPluginInput({
      client: cleanupListClient(
        [
          {
            id: "failed-delete",
            title: "codex-memory-consolidate",
            metadata: { "opencode-codex-memory": true },
            time: { created: Date.now() - 120 * 60 * 1000 },
          },
        ],
        { delete: async () => ({ error: { message: "busy" } }) },
      ),
    } as any)

    await cleanupOldSubSessions(90)
    await Promise.resolve()
    expect(isMemorySubSession("failed-delete")).toBe(true)
  })

  it("keeps ownership when OpenCode reports deletion success but the session survives", async () => {
    setPluginInput({
      client: cleanupListClient(
        [
          {
            id: "false-success-delete",
            title: "codex-memory-consolidate",
            metadata: { "opencode-codex-memory": true },
            time: { created: Date.now() - 120 * 60 * 1000 },
          },
        ],
        {
          delete: async () => ({ data: true, response: { status: 200 } }),
          get: async () => ({ data: { id: "false-success-delete" }, response: { status: 200 } }),
        },
      ),
    } as any)

    await cleanupOldSubSessions(90)
    await Promise.resolve()
    await Promise.resolve()
    expect(isMemorySubSession("false-success-delete")).toBe(true)
  })

  it("does not claim or delete user forks that copied plugin metadata", async () => {
    const deleted: string[] = []
    setPluginInput({
      client: cleanupListClient(
        [
          {
            id: "forked-memory-session",
            title: "codex-memory-consolidate (fork #1)",
            metadata: { "opencode-codex-memory": true },
            time: { created: Date.now() - 120 * 60 * 1000 },
          },
        ],
        {
          delete: async (req: { path: { id: string } }) => {
            deleted.push(req.path.id)
            return { data: true }
          },
        },
      ),
    } as any)

    await cleanupOldSubSessions(90)
    expect(deleted).toEqual([])
    expect(isMemorySubSession("forked-memory-session")).toBe(false)
  })

  it("never treats a user-editable title as sub-session ownership", async () => {
    const deleted: string[] = []
    setPluginInput({
      client: cleanupListClient(
        [
          {
            id: "user-prefixed-title",
            title: "codex-memory-personal-notes",
            time: { created: Date.now() - 120 * 60 * 1000 },
          },
        ],
        {
          delete: async (req: { path: { id: string } }) => {
            deleted.push(req.path.id)
            return { data: {} }
          },
        },
      ),
    } as any)

    await cleanupOldSubSessions(90)
    expect(deleted).toEqual([])
    expect(isMemorySubSession("user-prefixed-title")).toBe(false)
  })

  it("bounds a stalled sub-session listing", async () => {
    setPluginInput({
      client: cleanupListClient([], { hangList: true }),
    } as any)

    const started = Date.now()
    await cleanupOldSubSessions(90, 20)
    expect(Date.now() - started).toBeLessThan(500)
  })

  it("paginates through sessions tied at the page boundary", async () => {
    const now = Date.now()
    const firstPage = Array.from({ length: SCAN_LIMIT }, (_, i) => ({
      id: `paged-live-${i}`,
      title: "codex-memory-consolidate",
      metadata: { "opencode-codex-memory": true },
      time: { created: now, updated: 1 },
    }))
    const queries: Record<string, unknown>[] = []
    const deleted: string[] = []
    setPluginInput({
      client: cleanupListClient([], {
        list: async (opts) => {
          queries.push(opts.query ?? {})
          if (opts.query?.cursor === undefined || opts.query?.limit === SCAN_LIMIT) {
            return { data: firstPage }
          }
          return {
            data: [
              ...firstPage,
              {
                  id: "paged-old",
                  title: "codex-memory-consolidate",
                  metadata: { "opencode-codex-memory": true },
                  time: { created: now - 120 * 60 * 1000, updated: 1 },
              },
            ],
          }
        },
        delete: async (req) => {
          deleted.push(req.path.id)
          return { data: {} }
        },
      }),
    } as any)

    await cleanupOldSubSessions(90)
    await Promise.resolve()
    await Promise.resolve()
    expect(queries).toHaveLength(3)
    expect(queries[0]).toMatchObject({ search: "codex-memory-" })
    expect(queries[1]).toMatchObject({ cursor: 2, limit: SCAN_LIMIT, search: "codex-memory-" })
    expect(queries[2]).toMatchObject({ cursor: 2, limit: SCAN_LIMIT * 2, search: "codex-memory-" })
    expect(deleted).toContain("paged-old")
  })

  it("limits concurrent stale-helper deletions", async () => {
    const now = Date.now()
    let active = 0
    let maxActive = 0
    let completed = 0
    const sessions = Array.from({ length: 20 }, (_, i) => ({
      id: `stale-batch-${i}`,
      title: "codex-memory-consolidate",
      metadata: { "opencode-codex-memory": true },
      time: { created: now - 120 * 60 * 1000, updated: now - i },
    }))
    setPluginInput({
      client: cleanupListClient(sessions, {
        delete: async () => {
          active++
          maxActive = Math.max(maxActive, active)
          await new Promise((resolve) => setTimeout(resolve, 1))
          active--
          completed++
          return { data: {} }
        },
      }),
    } as any)

    await cleanupOldSubSessions(90)
    for (let i = 0; i < 50 && completed < sessions.length; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    expect(completed).toBe(sessions.length)
    expect(maxActive).toBeLessThanOrEqual(8)
  })

  it("bounds the detached stale-helper deletion batch", async () => {
    let calls = 0
    const now = Date.now()
    const sessions = Array.from({ length: 20 }, (_, i) => ({
      id: `stale-hung-${i}`,
      title: "codex-memory-consolidate",
      metadata: { "opencode-codex-memory": true },
      time: { created: now - 120 * 60 * 1000, updated: now - i },
    }))
    setPluginInput({
      client: cleanupListClient(sessions, {
        delete: async () => {
          calls++
          return new Promise(() => {})
        },
      }),
    } as any)
    setStaleDeleteBatchTimeoutForTest(20)

    await cleanupOldSubSessions(90)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const stoppedAt = calls
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(stoppedAt).toBeLessThanOrEqual(8)
    expect(calls).toBe(stoppedAt)
  })
})
