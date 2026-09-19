import path from "path"
import os from "os"
import { xdgData } from "xdg-basedir"

const MEMORY_DIR_NAME = "memories"
const MEMORY_DB_NAME = "memory.db"

const TEST_ROOT_ENV = "OPENCODE_CODEX_MEMORY_TEST_ROOT"
const HOME_ENV = "OPENCODE_CODEX_MEMORY_HOME"
const OPENCODE_APP_DIR = "opencode"

/** Plugin-option override of the memory home (parent of memory.db + memories/). */
let configuredHome: string | undefined

export type MemoryHomeSource = "test" | "option" | "env" | "default"

/**
 * Memory lives under a dedicated home, mirroring codex's
 * `<codex_home>/memories` (codex-rs `find_codex_home` + `from_codex_home`) but
 * with an opencode-specific default. opencode resolves its data dir as
 * `path.join(xdgData, "opencode")` via the `xdg-basedir` lib
 * (packages/core/src/global.ts), so we reuse the SAME lib to stay byte-identical
 * across platforms and `XDG_DATA_HOME` overrides. opencode does not surface this
 * directory through the plugin API (`/path` gives home/config/state/worktree/
 * directory, not data), so it must be recomputed here.
 *
 * User-facing precedence (first match). `home` / OPENCODE_CODEX_MEMORY_HOME
 * pin this plugin's files and do NOT follow OpenCode's data dir or XDG_DATA_HOME:
 *   1. plugin option `home` — always enforced when set
 *   2. `OPENCODE_CODEX_MEMORY_HOME` — same pin if `home` is unset
 *   3. OpenCode data dir (`$XDG_DATA_HOME/opencode` or `~/.local/share/opencode`)
 *
 * Tests only: `OPENCODE_CODEX_MEMORY_TEST_ROOT` wins over all of the above
 * (write-pipeline sandbox + unit tests). Not a user relocation knob.
 *
 * (1) and (2) exist so a sandbox can mount `memory.db` + `memories/` without
 * the rest of OpenCode's local database. They are not Codex knobs.
 */
export function resolveHomePath(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  let expanded = trimmed
  if (trimmed === "~") expanded = os.homedir()
  else if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    expanded = path.join(os.homedir(), trimmed.slice(2))
  }
  if (!path.isAbsolute(expanded)) return null
  return path.normalize(expanded)
}

export function setConfiguredHome(home: string | undefined): void {
  configuredHome = home
}

export function dataRoot(): string {
  const testRoot = process.env[TEST_ROOT_ENV]
  if (testRoot) return testRoot
  if (configuredHome) return configuredHome
  const envHome = process.env[HOME_ENV]
  if (envHome) {
    const resolved = resolveHomePath(envHome)
    if (resolved) return resolved
  }
  // xdgData = XDG_DATA_HOME || ~/.local/share (identical on every platform).
  // The `??` mirrors xdg-basedir's own guard for a missing home directory.
  const base = xdgData ?? path.join(os.homedir(), ".local", "share")
  return path.join(base, OPENCODE_APP_DIR)
}

export function memoryHomeSource(): MemoryHomeSource {
  if (process.env[TEST_ROOT_ENV]) return "test"
  if (configuredHome) return "option"
  const envHome = process.env[HOME_ENV]
  if (envHome && resolveHomePath(envHome)) return "env"
  return "default"
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
