import path from "path"
import os from "os"
import { xdgData } from "xdg-basedir"

const MEMORY_DIR_NAME = "memories"
const MEMORY_DB_NAME = "memory.db"

const OVERRIDE_ENV = "OPENCODE_CODEX_MEMORY_TEST_ROOT"
const OPENCODE_APP_DIR = "opencode"

/**
 * Memory lives under opencode's data dir, mirroring codex's
 * `<codex_home>/memories` (codex-rs `find_codex_home` + `from_codex_home`) but
 * with the opencode-specific home. opencode resolves its data dir as
 * `path.join(xdgData, "opencode")` via the `xdg-basedir` lib
 * (packages/core/src/global.ts), so we reuse the SAME lib to stay byte-identical
 * across platforms and `XDG_DATA_HOME` overrides. opencode does not surface this
 * directory through the plugin API (`/path` gives home/config/state/worktree/
 * directory, not data), so it must be recomputed here.
 *
 * `OPENCODE_CODEX_MEMORY_TEST_ROOT` is our `CODEX_HOME` analog: an explicit
 * override that wins outright (tests + the write-pipeline sandbox).
 */
function dataRoot(): string {
  const override = process.env[OVERRIDE_ENV]
  if (override) return override
  // xdgData = XDG_DATA_HOME || ~/.local/share (identical on every platform).
  // The `??` mirrors xdg-basedir's own guard for a missing home directory.
  const base = xdgData ?? path.join(os.homedir(), ".local", "share")
  return path.join(base, OPENCODE_APP_DIR)
}

export function memoryRoot(): string {
  return path.join(dataRoot(), MEMORY_DIR_NAME)
}

export function memoryDbPath(): string {
  return path.join(dataRoot(), MEMORY_DB_NAME)
}

export function memorySummaryPath(): string {
  return path.join(memoryRoot(), "memory_summary.md")
}