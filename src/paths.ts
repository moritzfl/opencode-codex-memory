import path from "path"
import os from "os"

const MEMORY_DIR_NAME = "memories"
const MEMORY_DB_NAME = "memory.db"

export function memoryRoot(): string {
  return path.join(os.homedir(), ".local", "share", "opencode", MEMORY_DIR_NAME)
}

export function memoryDbPath(): string {
  return path.join(os.homedir(), ".local", "share", "opencode", MEMORY_DB_NAME)
}

export function opencodeDbPath(): string {
  return path.join(os.homedir(), ".local", "share", "opencode", "opencode.db")
}

export function memorySummaryPath(): string {
  return path.join(memoryRoot(), "memory_summary.md")
}