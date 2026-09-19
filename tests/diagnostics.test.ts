import { describe, it, expect, beforeEach } from "bun:test"
import {
  recordDiscoveryStatus,
  getRecentDiagnostics,
  resetDiagnosticsForTest,
} from "../src/diagnostics.js"

describe("recordDiscoveryStatus", () => {
  beforeEach(() => {
    resetDiagnosticsForTest()
  })

  it("logs the first success and later count changes, not repeats", () => {
    recordDiscoveryStatus({ ok: true, count: 1 })
    recordDiscoveryStatus({ ok: true, count: 1 })
    recordDiscoveryStatus({ ok: true, count: 1 })
    expect(getRecentDiagnostics()).toEqual([
      expect.objectContaining({ kind: "discovery", message: "listed 1 session(s)" }),
    ])
    recordDiscoveryStatus({ ok: true, count: 3 })
    expect(getRecentDiagnostics().map((e) => e.message)).toEqual([
      "listed 1 session(s)",
      "listed 3 session(s)",
    ])
  })

  it("always logs discovery failures", () => {
    recordDiscoveryStatus({ ok: true, count: 1 })
    recordDiscoveryStatus({ ok: false, count: 0, error: "plugin HTTP client unavailable" })
    recordDiscoveryStatus({ ok: false, count: 0, error: "plugin HTTP client unavailable" })
    expect(getRecentDiagnostics().filter((e) => e.level === "warn")).toHaveLength(2)
  })
})
