/**
 * opencode2 tool registration.
 *
 * The memory tools' logic lives in tools/*.ts (V1 tool() definitions) and is
 * reused verbatim: each V1 definition already bundles {description, args
 * (Zod raw shape), execute}. Wrap that shape using the SDK's own tool.schema:
 * its Zod objects implement StandardSchema, which V2 accepts directly.
 * Keep version ownership in the SDK, then map only the result shape:
 *   V1 string | {output, metadata}  →  V2 {content, metadata}
 * Inspect additionally reports the V2 host discovery scope and fallback reason.
 */
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { memory_read, memory_search, memory_list, memory_add_note } from "../../tools/memory.js"
import { memory_inspect, memory_mode } from "../../tools/control.js"
import { pluginOptions } from "../options.js"
import { getV2DiscoveryStatus } from "./shim.js"

type CallContext = {
  sessionID: string
  messageID: string
  agent: string
  id?: string
  signal?: AbortSignal
  abort?: AbortSignal
}
type Ask = (ctx: CallContext, request: { patterns: string[]; metadata: unknown }) => Promise<void>

interface V2ToolDefinition {
  name: string
  description: string
  input: ReturnType<typeof tool.schema.object>
  /**
   * OpenCode 2 defaults plugin tools into Code Mode (`execute`). The read-path
   * prompt tells the model to call these by name. Leaving the default hides
   * them from the native tool list; models then search `execute` for a
   * `memory` namespace, miss, and skip memory.
   */
  options: { codemode: false }
  execute: (input: any, ctx: CallContext) => Promise<{ content: string | unknown[]; metadata?: unknown }>
}

function adaptTool(name: string, v1: ToolDefinition, ask?: Ask): V2ToolDefinition {
  return {
    name,
    description: v1.description,
    input: tool.schema.object(v1.args),
    options: { codemode: false },
    async execute(input: any, tctx: CallContext) {
      const v1ctx = {
        sessionID: tctx.sessionID,
        messageID: tctx.messageID,
        agent: tctx.agent,
        directory: "",
        worktree: "",
        abort: tctx.signal ?? tctx.abort ?? new AbortController().signal,
        metadata: () => {},
        ask: async (request: Parameters<Ask>[1]) => {
          if (ask) return ask(tctx, request)
          throw new Error(
            "User approval is unavailable to plugin tools on this host. Use /memory-inspect → Controls instead.",
          )
        },
      }
      const res = await v1.execute(input, v1ctx)
      if (typeof res === "string") return { content: res }
      let content = res.output ?? ""
      let metadata = res.metadata
      if (name === "memory_inspect") {
        const discovery = getV2DiscoveryStatus()
        content = [
          `v2_discovery_source: ${discovery?.source ?? "not_checked"}`,
          ...(discovery?.warning ? [`v2_discovery_warning: ${discovery.warning}`] : []),
          "",
          content,
        ].join("\n")
        metadata = { ...(metadata && typeof metadata === "object" ? metadata : {}), v2_discovery: discovery }
      }
      // V2 validates metadata as JSON before persisting Tool.Success. V1 tool
      // metadata can contain undefined optional fields (search path/since/until).
      // Use JSON serialization semantics here so successful calls can settle.
      return {
        content,
        ...(metadata === undefined ? {} : { metadata: JSON.parse(JSON.stringify(metadata)) }),
      }
    },
  }
}

const ALL_MEMORY_TOOLS: [string, ToolDefinition][] = [
  ["memory_read", memory_read],
  ["memory_search", memory_search],
  ["memory_list", memory_list],
  ["memory_add_note", memory_add_note],
  ["memory_inspect", memory_inspect],
  ["memory_mode", memory_mode],
]

const CONTROL_ONLY = new Set(["memory_inspect", "memory_mode"])

/**
 * Same gating as the V1 entry: the read/search/list/add-note tools require
 * BOTH use_memories and dedicated_tools (codex MemoriesExtension); the
 * control tools are always available. Destructive reset lives in the panel.
 */
export function buildV2Tools(ask?: Ask): V2ToolDefinition[] {
  const full = pluginOptions.use_memories && pluginOptions.dedicated_tools
  return ALL_MEMORY_TOOLS.filter(([name]) => full || CONTROL_ONLY.has(name)).map(([name, v1]) =>
    adaptTool(name, v1, ask),
  )
}
