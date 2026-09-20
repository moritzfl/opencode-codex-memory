import { AsyncLocalStorage } from "node:async_hooks"
import { pluginOptions, type MemoryVersion } from "./options.js"

// Codex clones the config for each pipeline. Async-local routing gives every
// awaited filesystem/model operation the same immutable namespace, without
// mutating the process-wide read-version option while both writers run.
const scope = new AsyncLocalStorage<MemoryVersion>()

export const MEMORY_VERSIONS = ["v1", "v2"] as const

export function currentMemoryVersion(): MemoryVersion {
  return scope.getStore() ?? pluginOptions.version
}

export function withMemoryVersion<T>(version: MemoryVersion, run: () => T): T {
  return scope.run(version, run)
}

export function writeMemoryVersions(): readonly MemoryVersion[] {
  return pluginOptions.dual_write ? MEMORY_VERSIONS : [pluginOptions.version]
}
