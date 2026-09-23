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
  version: "v1" | "v2"
  sessionVersion: "v1" | "v2"
  dualWrite: boolean
  v2ConsolidatedThreads: number
  v2Ready: boolean
  minConsolidatedThreads: number
  pipelines: {
    version: "v1" | "v2"
    stage1Count: number
    extracting: number
    phase2Status: string | null
    lastError: string | null
    /** Unix milliseconds; optional for older servers. Cooldown is not a retry. */
    phase2CooldownUntil?: number | null
    phase1RetryAt?: number | null
    phase2RetryAt?: number | null
  }[]
  useMemories: boolean
  generateMemories: boolean
  extractModel: string | null
  consolidationModel: string | null
  codexImport: boolean
  lastSuccessAt: number | null
  retryAt: number | null
  warnings: string[]
  /** Per-session read/write mode when a sessionID was supplied. */
  sessionMode: "enabled" | "disabled" | "polluted" | null
  /** Root directory of the memory workspace. */
  memoryRoot: string
  /** Estimated memory tokens injected into model requests (chars/4). */
  injected: {
    sessionTokens: number
    sessionRequests: number
    totalTokens: number
    totalRequests: number
  }
}

const INJECTED_SCHEMA = {
  type: "object",
  properties: {
    sessionTokens: { type: "number" },
    sessionRequests: { type: "number" },
    totalTokens: { type: "number" },
    totalRequests: { type: "number" },
  },
  required: ["sessionTokens", "sessionRequests", "totalTokens", "totalRequests"],
  additionalProperties: false,
} as const

export const MemoryStatusRpc = {
  id: "opencode-codex-memory",
  methods: {
    status: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          minConsolidatedThreads: { type: "integer", minimum: 1, maximum: 4096 },
        },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          activity: { type: "string", enum: [...MEMORY_STATUS_ACTIVITIES] },
          version: { type: "string", enum: ["v1", "v2"] },
          sessionVersion: { type: "string", enum: ["v1", "v2"] },
          dualWrite: { type: "boolean" },
          v2ConsolidatedThreads: { type: "integer", minimum: 0 },
          v2Ready: { type: "boolean" },
          minConsolidatedThreads: { type: "integer", minimum: 1, maximum: 4096 },
          useMemories: { type: "boolean" },
          pipelines: {
            type: "array",
            items: {
              type: "object",
              properties: {
                version: { type: "string", enum: ["v1", "v2"] },
                stage1Count: { type: "integer", minimum: 0 },
                extracting: { type: "integer", minimum: 0 },
                phase2Status: { type: ["string", "null"] },
                lastError: { type: ["string", "null"] },
                phase2CooldownUntil: { type: ["number", "null"] },
                phase1RetryAt: { type: ["number", "null"] },
                phase2RetryAt: { type: ["number", "null"] },
              },
              required: ["version", "stage1Count", "extracting", "phase2Status", "lastError"],
              additionalProperties: false,
            },
          },
          generateMemories: { type: "boolean" },
          extractModel: { type: ["string", "null"] },
          consolidationModel: { type: ["string", "null"] },
          codexImport: { type: "boolean" },
          lastSuccessAt: { type: ["number", "null"] },
          retryAt: { type: ["number", "null"] },
          warnings: { type: "array", items: { type: "string" } },
          sessionMode: { type: ["string", "null"], enum: ["enabled", "disabled", "polluted", null] },
          memoryRoot: { type: "string" },
          injected: INJECTED_SCHEMA,
        },
        required: [
          "activity",
          "version", "sessionVersion", "dualWrite", "v2ConsolidatedThreads", "v2Ready", "minConsolidatedThreads", "pipelines",
          "useMemories",
          "generateMemories",
          "extractModel",
          "consolidationModel",
          "codexImport",
          "lastSuccessAt",
          "retryAt",
          "warnings",
          "sessionMode",
          "memoryRoot",
          "injected",
        ],
        additionalProperties: false,
      },
    },
    /** Runtime-only toggle of a boolean plugin option (until server restart). */
    setOption: {
      input: {
        type: "object",
        properties: {
          key: { type: "string", enum: ["use_memories", "generate_memories"] },
          value: { type: "boolean" },
        },
        required: ["key", "value"],
        additionalProperties: false,
      },
      output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
    },
    /** Same effect as the memory_mode tool. */
    setSessionMode: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          mode: { type: "string", enum: ["enabled", "disabled"] },
        },
        required: ["sessionID", "mode"],
        additionalProperties: false,
      },
      output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
    },
    /** Run extraction + consolidation now, bypassing the success cooldown (not the lease). */
    consolidateNow: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: { status: { type: "string" } },
        required: ["status"],
        additionalProperties: false,
      },
    },
    /** Same wipe as the V1 memory_reset tool; the panel's confirm step is the approval. */
    resetMemory: {
      input: {
        type: "object",
        properties: { confirm: { type: "boolean" } },
        required: ["confirm"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { ok: { type: "boolean" }, message: { type: "string" } },
        required: ["ok", "message"],
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
  for (const key of ["useMemories", "generateMemories", "codexImport", "dualWrite", "v2Ready"] as const) {
    if (typeof value[key] !== "boolean") return false
  }
  for (const key of ["version", "sessionVersion"] as const) {
    if (value[key] !== "v1" && value[key] !== "v2") return false
  }
  if (!Number.isInteger(value.v2ConsolidatedThreads) || (value.v2ConsolidatedThreads as number) < 0) return false
  if (!Number.isInteger(value.minConsolidatedThreads) || (value.minConsolidatedThreads as number) < 1 || (value.minConsolidatedThreads as number) > 4096) return false
  if (!Array.isArray(value.pipelines) || !value.pipelines.every((pipeline) =>
    isRecord(pipeline) && (pipeline.version === "v1" || pipeline.version === "v2")
    && Number.isInteger(pipeline.stage1Count) && (pipeline.stage1Count as number) >= 0
    && Number.isInteger(pipeline.extracting) && (pipeline.extracting as number) >= 0
    && (pipeline.phase2Status === null || typeof pipeline.phase2Status === "string")
    && (pipeline.lastError === null || typeof pipeline.lastError === "string")
    && ["phase2CooldownUntil", "phase1RetryAt", "phase2RetryAt"].every((key) =>
      pipeline[key] === undefined || pipeline[key] === null || (typeof pipeline[key] === "number" && Number.isFinite(pipeline[key])),
    )
  )) return false
  for (const key of ["extractModel", "consolidationModel", "lastSuccessAt", "retryAt"] as const) {
    const v = value[key]
    if (v !== null && typeof v !== (key === "extractModel" || key === "consolidationModel" ? "string" : "number")) {
      return false
    }
  }
  if (!Array.isArray(value.warnings) || !value.warnings.every((w): w is string => typeof w === "string")) {
    return false
  }
  if (
    value.sessionMode !== null &&
    value.sessionMode !== "enabled" &&
    value.sessionMode !== "disabled" &&
    value.sessionMode !== "polluted"
  ) {
    return false
  }
  if (typeof value.memoryRoot !== "string") return false
  const injected = value.injected
  if (!isRecord(injected)) return false
  for (const key of ["sessionTokens", "sessionRequests", "totalTokens", "totalRequests"] as const) {
    if (typeof injected[key] !== "number") return false
  }
  return true
}

/** Throwing parser for tests and call sites that want a typed value. */
export function parseMemoryStatus(value: unknown): MemoryStatus {
  if (!isMemoryStatus(value)) throw new Error("invalid memory status payload")
  return value
}
