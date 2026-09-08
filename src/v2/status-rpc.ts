/**
 * Shared server↔TUI wire contract for the memory sidebar status.
 *
 * Dependency-free on purpose: the TUI bundle runs in the CLI sandbox, where
 * only `@opencode/plugin/tui` (+ rendering peers) is guaranteed to resolve.
 * `Rpc.define` is a runtime passthrough (validation only), so a plain object
 * with JSON Schema nodes is an equivalent portable definition.
 */
export const MEMORY_STATUS_ACTIVITIES = [
  "idle",
  "extracting",
  "consolidating",
  "retrying",
  "error",
  "read_only",
  "disabled",
  "stopping",
] as const

export type MemoryStatusActivity = (typeof MEMORY_STATUS_ACTIVITIES)[number]

export interface MemoryStatus {
  activity: MemoryStatusActivity
  useMemories: boolean
  generateMemories: boolean
  extractModel: string | null
  consolidationModel: string | null
  codexImport: boolean
  lastSuccessAt: number | null
  retryAt: number | null
  warnings: string[]
}

export const MemoryStatusRpc = {
  id: "opencode-codex-memory",
  methods: {
    status: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: {
          activity: { type: "string", enum: [...MEMORY_STATUS_ACTIVITIES] },
          useMemories: { type: "boolean" },
          generateMemories: { type: "boolean" },
          extractModel: { type: ["string", "null"] },
          consolidationModel: { type: ["string", "null"] },
          codexImport: { type: "boolean" },
          lastSuccessAt: { type: ["number", "null"] },
          retryAt: { type: ["number", "null"] },
          warnings: { type: "array", items: { type: "string" } },
        },
        required: [
          "activity",
          "useMemories",
          "generateMemories",
          "extractModel",
          "consolidationModel",
          "codexImport",
          "lastSuccessAt",
          "retryAt",
          "warnings",
        ],
        additionalProperties: false,
      },
    },
  },
  events: {
    changed: { schema: { type: "object", properties: {}, additionalProperties: false } },
  },
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Runtime guard for the untyped RPC client result (no zod in the TUI bundle). */
export function isMemoryStatus(value: unknown): value is MemoryStatus {
  if (!isRecord(value)) return false
  if (
    typeof value.activity !== "string" ||
    !(MEMORY_STATUS_ACTIVITIES as readonly string[]).includes(value.activity)
  ) {
    return false
  }
  for (const key of ["useMemories", "generateMemories", "codexImport"] as const) {
    if (typeof value[key] !== "boolean") return false
  }
  for (const key of ["extractModel", "consolidationModel", "lastSuccessAt", "retryAt"] as const) {
    const v = value[key]
    if (v !== null && typeof v !== (key === "extractModel" || key === "consolidationModel" ? "string" : "number")) {
      return false
    }
  }
  return (
    Array.isArray(value.warnings) && value.warnings.every((w): w is string => typeof w === "string")
  )
}

/** Throwing parser for tests and call sites that want a typed value. */
export function parseMemoryStatus(value: unknown): MemoryStatus {
  if (!isMemoryStatus(value)) throw new Error("invalid memory status payload")
  return value
}
