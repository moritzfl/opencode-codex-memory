/**
 * opencode2 tool registration.
 *
 * The memory tools' logic lives in tools/*.ts (V1 tool() definitions) and is
 * reused verbatim: each V1 definition already bundles {description, args
 * (zod raw shape), execute}. V2 accepts any StandardSchema as input, which
 * zod v4 satisfies natively, so the adapter just re-wraps the same validate
 * + execute path and maps the result shape:
 *   V1 string | {output, metadata}  →  V2 {content, metadata}
 * Inspect additionally reports the V2 host discovery scope and fallback reason.
 */
import { z } from "zod"
import { memory_read, memory_search, memory_list, memory_add_note } from "../../tools/memory.js"
import { memory_reset, memory_inspect, memory_mode } from "../../tools/control.js"
import { pluginOptions } from "../options.js"
import { getV2DiscoveryStatus } from "./shim.js"

interface V1Tool {
  description: string
  args: Record<string, z.ZodTypeAny>
  execute: (args: any, ctx: any) => Promise<string | { output?: string; content?: unknown; metadata?: unknown }>
}

interface V2ToolDefinition {
  name: string
  description: string
  input: z.ZodTypeAny
  execute: (input: any, ctx: { sessionID: string; messageID: string; agent: string; abort?: AbortSignal }) => Promise<{ content: string | unknown[]; metadata?: unknown }>
}

function adaptTool(name: string, v1: V1Tool): V2ToolDefinition {
  return {
    name,
    description: v1.description,
    input: z.object(v1.args),
    async execute(input: any, tctx: { sessionID: string; messageID: string; agent: string; abort?: AbortSignal }) {
      const v1ctx = {
        sessionID: tctx.sessionID,
        messageID: tctx.messageID,
        agent: tctx.agent,
        directory: "",
        worktree: "",
        abort: tctx.abort instanceof AbortSignal ? tctx.abort : new AbortController().signal,
        metadata: () => {},
        ask: async () => {},
      }
      const res = await v1.execute(input, v1ctx)
      if (typeof res === "string") return { content: res }
      if (name === "memory_inspect") {
        const discovery = getV2DiscoveryStatus()
        return {
          content: [
            `v2_discovery_source: ${discovery?.source ?? "not_checked"}`,
            ...(discovery?.warning ? [`v2_discovery_warning: ${discovery.warning}`] : []),
            "",
            res.output ?? "",
          ].join("\n"),
          metadata: { ...(res.metadata && typeof res.metadata === "object" ? res.metadata : {}), v2_discovery: discovery },
        }
      }
      return { content: res.output ?? "", ...(res.metadata !== undefined ? { metadata: res.metadata } : {}) }
    },
  }
}

const ALL_MEMORY_TOOLS: [string, V1Tool][] = [
  ["memory_read", memory_read as unknown as V1Tool],
  ["memory_search", memory_search as unknown as V1Tool],
  ["memory_list", memory_list as unknown as V1Tool],
  ["memory_add_note", memory_add_note as unknown as V1Tool],
  ["memory_reset", memory_reset as unknown as V1Tool],
  ["memory_inspect", memory_inspect as unknown as V1Tool],
  ["memory_mode", memory_mode as unknown as V1Tool],
]

const CONTROL_ONLY = new Set(["memory_reset", "memory_inspect", "memory_mode"])

/**
 * Same gating as the V1 entry: the read/search/list/add-note tools require
 * BOTH use_memories and dedicated_tools (codex MemoriesExtension); the
 * control tools are always available.
 */
export function buildV2Tools(): V2ToolDefinition[] {
  const full = pluginOptions.use_memories && pluginOptions.dedicated_tools
  return ALL_MEMORY_TOOLS.filter(([name]) => full || CONTROL_ONLY.has(name)).map(([name, v1]) =>
    adaptTool(name, v1),
  )
}
