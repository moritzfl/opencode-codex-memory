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

describe("loadTranscript", () => {
  it("excludes reasoning parts like codex's rollout policy (Reasoning => false)", () => {
    const { loadTranscript } = require("../src/capture.js")
    const msgs = loadTranscript("ses_1")
    expect(msgs.length).toBe(3)
    const reasoning = msgs.find((m: any) => m.type === "reasoning")
    // Reasoning parts carry `text`, but must not contribute transcript content.
    expect(reasoning.text).toBeUndefined()
    expect(msgs.find((m: any) => m.type === "text").text).toBe("visible answer")
    expect(msgs.find((m: any) => m.type === "tool").text).toContain("[tool: bash]")
  })
})
