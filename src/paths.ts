import path from "path"
import os from "os"

const MEMORY_DIR_NAME = "memories"
const MEMORY_DB_NAME = "memory.db"

const OVERRIDE_ENV = "OPENCODE_CODEX_MEMORY_TEST_ROOT"

function dataRoot(): string {
  const override = process.env[OVERRIDE_ENV]
  if (override) return override
  return path.join(os.homedir(), ".local", "share", "opencode")
}

export function memoryRoot(): string {
  return path.join(dataRoot(), MEMORY_DIR_NAME)
}

export function memoryDbPath(): string {
  return path.join(dataRoot(), MEMORY_DB_NAME)
}

export function opencodeDbPath(): string {
  return path.join(dataRoot(), "opencode.db")
}

export function memorySummaryPath(): string {
  return path.join(memoryRoot(), "memory_summary.md")
}