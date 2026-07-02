/**
 * Integration test harness against a real opencode instance.
 *
 * This is NOT run automatically by `bun test`.
 * It requires:
 *   - official opencode installed and in PATH
 *   - the plugin path configured in ~/.config/opencode/opencode.json
 *   - a writable ~/.local/share/opencode/memories directory
 *
 * Usage:
 *   bun run tests/integration.ts
 *
 * The harness:
 *   1. Writes a known memory_summary.md
 *   2. Runs `opencode run "What do you remember?"` and captures output
 *   3. Verifies the memory content appears in the response
 *   4. Cleans up
 *
 * If the harness cannot start opencode or the memory is not injected,
 * it exits with a non-zero code and prints diagnostics.
 */

import { spawnSync } from "child_process"
import fs from "fs"
import path from "path"
import os from "os"

const MEMORY_DIR = path.join(os.homedir(), ".local", "share", "opencode", "memories")
const SUMMARY_FILE = path.join(MEMORY_DIR, "memory_summary.md")
const TEST_CONTENT = "INTEGRATION-TEST-MARKER-42: user loves pineapple on pizza"

function ensureMemoryDir() {
  fs.mkdirSync(MEMORY_DIR, { recursive: true })
}

function writeTestSummary() {
  fs.writeFileSync(SUMMARY_FILE, TEST_CONTENT + "\n", { flag: "w" })
}

function restoreSummary(original: string | null) {
  if (original === null) {
    try { fs.unlinkSync(SUMMARY_FILE) } catch {}
  } else {
    fs.writeFileSync(SUMMARY_FILE, original, { flag: "w" })
  }
}

function runOpencode(prompt: string): { stdout: string; stderr: string; code: number } {
  const result = spawnSync("opencode", ["run", prompt], {
    encoding: "utf8",
    timeout: 30000,
    env: process.env,
  })
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    code: result.status ?? 1,
  }
}

function main() {
  console.log("[integration] checking opencode binary...")
  const which = spawnSync("which", ["opencode"], { encoding: "utf8" })
  if (!which.stdout?.trim()) {
    console.error("[integration] opencode not found in PATH")
    process.exit(2)
  }

  ensureMemoryDir()
  const original = fs.existsSync(SUMMARY_FILE) ? fs.readFileSync(SUMMARY_FILE, "utf8") : null

  console.log("[integration] writing test memory_summary.md")
  writeTestSummary()

  console.log("[integration] running opencode run...")
  const out = runOpencode("What do you remember from memory? Reply with the marker if you see it.")

  restoreSummary(original)

  const combined = out.stdout + "\n" + out.stderr
  if (combined.includes("INTEGRATION-TEST-MARKER-42")) {
    console.log("[integration] SUCCESS: memory content was injected and visible to the model")
    process.exit(0)
  } else {
    console.error("[integration] FAILURE: marker not found in output")
    console.error("stdout:", out.stdout.slice(0, 2000))
    console.error("stderr:", out.stderr.slice(0, 2000))
    process.exit(1)
  }
}

main()