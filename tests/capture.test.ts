import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "fs"
import path from "path"
import os from "os"

const TEST_ROOT = path.join(os.tmpdir(), `opencode-codex-memory-capture-${process.pid}-${Date.now()}`)

beforeEach(() => {
  fs.mkdirSync(TEST_ROOT, { recursive: true })
  process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT = TEST_ROOT
  const db = new Database(path.join(TEST_ROOT, "opencode.db"))
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, time_updated INTEGER, directory TEXT, parent_id TEXT, title TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
  `)
  db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?)").run("ses_1", 1000, "/tmp/proj", null, "some work")
  db.prepare("INSERT INTO message VALUES (?, ?)").run("msg_a", JSON.stringify({ role: "assistant" }))
  const insertPart = db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?)")
  insertPart.run("prt_1", "msg_a", "ses_1", 1, JSON.stringify({ type: "reasoning", text: "chain of thought" }))
  insertPart.run("prt_2", "msg_a", "ses_1", 2, JSON.stringify({ type: "text", text: "visible answer" }))
  insertPart.run(
    "prt_3",
    "msg_a",
    "ses_1",
    3,
    JSON.stringify({ type: "tool", tool: "bash", state: { input: { command: "ls" }, output: "file.txt" } }),
  )
  db.close()
})
afterEach(() => {
  delete process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT
  try {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true })
  } catch {}
})

// The module caches its DB handle; a fresh copy is needed to exercise
// open/query failures against this test's own opencode.db.
function freshCapture() {
  delete require.cache[require.resolve("../src/capture.js")]
  return require("../src/capture.js")
}

describe("loadTranscript", () => {
  it("excludes reasoning parts like codex's rollout policy (Reasoning => false)", () => {
    const { loadTranscript } = freshCapture()
    const msgs = loadTranscript("ses_1")
    expect(msgs.length).toBe(3)
    const reasoning = msgs.find((m: any) => m.type === "reasoning")
    // Reasoning parts carry `text`, but must not contribute transcript content.
    expect(reasoning.text).toBeUndefined()
    expect(msgs.find((m: any) => m.type === "text").text).toBe("visible answer")
    expect(msgs.find((m: any) => m.type === "tool").text).toContain("[tool: bash]")
  })

  // A swallowed DB error used to surface as an empty transcript, which phase 1
  // records as a successful no-output extraction — silently erasing memory.
  it("throws on schema errors instead of returning an empty transcript", () => {
    const db = new Database(path.join(TEST_ROOT, "opencode.db"))
    db.exec("DROP TABLE part")
    db.close()
    const { loadTranscript } = freshCapture()
    expect(() => loadTranscript("ses_1")).toThrow()
  })

  it("throws when opencode.db cannot be opened", () => {
    fs.rmSync(path.join(TEST_ROOT, "opencode.db"))
    const { loadTranscript } = freshCapture()
    expect(() => loadTranscript("ses_1")).toThrow(/cannot open opencode.db/)
  })
})

describe("listRecentSessions", () => {
  it("is fail-safe: returns [] on schema errors so the pass is skipped without claims", () => {
    const db = new Database(path.join(TEST_ROOT, "opencode.db"))
    db.exec("DROP TABLE session")
    db.close()
    const { listRecentSessions } = freshCapture()
    expect(listRecentSessions()).toEqual([])
  })
})
