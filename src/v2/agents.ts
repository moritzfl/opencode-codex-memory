/**
 * opencode2 agent provisioning.
 *
 * V1 ships memorize/memorize-extract via the config hook (opencode.json
 * `agent` map). V2 has no config hook, but agent.transform's update() creates
 * a missing agent in the active plugin location, so setup() ensures them here
 * instead. Helper sessions must run in that same location because V2 agent
 * registration is location-scoped.
 *
 * Both agents ship for parity, with the V1 prompts verbatim. `memorize` does
 * consolidation work; `memorize-extract` is hidden and unused — extraction
 * runs through generate.text (inherently tool-less, no session, no agent),
 * and V1 skips injecting unused agents for the same reason. Keeping the
 * hidden definition preserves the health snapshot both agents report into.
 */
import path from "path"
import { memoryRoot } from "../paths.js"
import { pluginOptions } from "../options.js"
import { recordAgentConfig } from "../agent-health.js"

export const MEMORIZE_AGENT_ID = "memorize"
export const MEMORIZE_EXTRACT_AGENT_ID = "memorize-extract"

export const MEMORIZE_SYSTEM =
  "You are a memory consolidation agent. Read the workspace diff file and update MEMORY.md, memory_summary.md, and skills/ under the memory workspace only. Do not read or edit project source files outside that memory root. Keep memory_summary.md under 10000 chars (2500 tokens). Prune stale entries. Do not access the network."

export const MEMORIZE_EXTRACT_SYSTEM =
  "You are a memory extraction agent. The session transcript is provided inline in the prompt. Extract raw_memory, rollout_summary, and rollout_slug as JSON. Exclude AGENTS.md/instruction content. Redact secrets."

export const MEMORIZE_DESCRIPTION = "Memory consolidation agent (opencode-codex-memory)"
export const MEMORIZE_EXTRACT_DESCRIPTION = "Memory extraction agent (opencode-codex-memory)"

export interface V2AgentDefinition {
  description: string
  mode: "subagent"
  hidden?: boolean
  system: string
  permissions: { action: string; resource: string; effect: "allow" | "deny" | "ask" }[]
}

/** V2-native memorize definition (V2 action names: edit covers write/patch). */
export function buildMemorizeAgent(): V2AgentDefinition {  return {
    description: MEMORIZE_DESCRIPTION,
    mode: "subagent",
    system: MEMORIZE_SYSTEM,
    permissions: [
      { action: "*", resource: "*", effect: "deny" },
      { action: "read", resource: path.join(memoryRoot(), "*"), effect: "allow" },
      { action: "edit", resource: path.join(memoryRoot(), "*"), effect: "allow" },
      { action: "glob", resource: path.join(memoryRoot(), "*"), effect: "allow" },
      { action: "grep", resource: path.join(memoryRoot(), "*"), effect: "allow" },
      // Memories live outside every project: without this grant the wildcard
      // deny blocks consolidation from touching the memory workspace (same
      // role as external_directory in the V1 definition).
      { action: "external_directory", resource: path.join(memoryRoot(), "*"), effect: "allow" },
    ],
  }
}

/**
 * Hidden extraction definition. Unused at runtime (extraction goes through
 * generate.text), kept for parity with the V1 bundle and the health
 * snapshot. deny-all: V2 has no StructuredOutput-capture concept, and the
 * sessionless generate path needs no tools at all.
 */
export function buildMemorizeExtractAgent(): V2AgentDefinition {
  return {
    description: MEMORIZE_EXTRACT_DESCRIPTION,
    mode: "subagent",
    hidden: true,
    system: MEMORIZE_EXTRACT_SYSTEM,
    permissions: [{ action: "*", resource: "*", effect: "deny" }],
  }
}

interface AgentEditorLike {
  get(id: string): { description?: string; mode?: string; system?: string; permissions?: unknown } | undefined
  update(id: string, update: (agent: Record<string, unknown>) => void): void
}

/**
 * V2 agent definition converted back to the V1 permission-map shape so the
 * shared agent-health snapshot (surfaced by memory_inspect) keeps working.
 */
export function toV1AgentDefinition(def: V2AgentDefinition, agentId?: string): Record<string, unknown> {
  const permission: Record<string, unknown> = {}
  for (const rule of def.permissions) {
    if (rule.action === "*") {
      permission["*"] = rule.effect
      continue
    }
    if (rule.action === "external_directory") {
      const cur = (permission.external_directory ?? {}) as Record<string, unknown>
      cur[rule.resource] = rule.effect
      permission.external_directory = cur
      continue
    }
    if (rule.action === "edit") {
      // V1 names write/patch separately from edit.
      permission.edit = rule.effect
      permission.write = rule.effect
      continue
    }
    permission[rule.action] = rule.effect
  }
  if (agentId === MEMORIZE_EXTRACT_AGENT_ID) {
    // The V1 bundle allows the synthetic StructuredOutput capture tool so
    // json_schema extraction works; V2 needs no tools for the sessionless
    // generate path, but health validates the V1 bundle semantics.
    permission.StructuredOutput = "allow"
  }
  return { mode: def.mode, prompt: def.system, description: def.description, permission }
}

export function shippedV1AgentForHealth(): Record<string, unknown> {
  return {
    [MEMORIZE_AGENT_ID]: toV1AgentDefinition(buildMemorizeAgent(), MEMORIZE_AGENT_ID),
    [MEMORIZE_EXTRACT_AGENT_ID]: toV1AgentDefinition(buildMemorizeExtractAgent(), MEMORIZE_EXTRACT_AGENT_ID),
  }
}

/**
 * Ensure both sub-agents exist. A user-defined agent of the same name
 * always wins (mirrors injectAgentDefinitions). Records health for
 * memory_inspect in both cases.
 */
export async function ensureV2Agents(ctx: {
  agent: {
    transform(cb: (editor: AgentEditorLike) => void): Promise<unknown>
    get(input: unknown): Promise<unknown>
  }
}): Promise<void> {
  const shipped: [string, V2AgentDefinition][] = [
    [MEMORIZE_AGENT_ID, buildMemorizeAgent()],
    [MEMORIZE_EXTRACT_AGENT_ID, buildMemorizeExtractAgent()],
  ]
  if (!pluginOptions.generate_memories) {
    recordAgentConfig({ agent: {} }, false, shippedV1AgentForHealth())
    return
  }
  const effective: Record<string, unknown> = {}
  const missing: [string, V2AgentDefinition][] = []
  for (const [id, def] of shipped) {
    let existing: unknown = null
    try {
      const res = (await ctx.agent.get({ agentID: id })) as { data?: unknown } | undefined
      existing = res && typeof res === "object" && "data" in res ? (res as { data: unknown }).data : res
    } catch {
      existing = null
    }
    if (existing && typeof existing === "object") {
      // Present (ours or a user override): never overwrite, just record health.
      const cur = existing as Record<string, unknown>
      effective[id] = {
        mode: cur.mode,
        prompt: cur.system,
        description: cur.description,
        permission: v2PermissionsToV1Map(cur.permissions),
      }
    } else {
      missing.push([id, def])
    }
  }
  if (missing.length > 0) {
    await ctx.agent.transform((editor) => {
      for (const [id, def] of missing) {
        editor.update(id, (agent) => {
          agent.description = def.description
          agent.mode = def.mode
          if (def.hidden !== undefined) agent.hidden = def.hidden
          agent.system = def.system
          agent.permissions = def.permissions.map((r) => ({ ...r }))
        })
      }
    })
    for (const [id, def] of missing) {
      effective[id] = toV1AgentDefinition(def, id)
    }
  }
  recordAgentConfig({ agent: effective }, true, shippedV1AgentForHealth())
}

function v2PermissionsToV1Map(permissions: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!Array.isArray(permissions)) return out
  for (const rule of permissions as { action?: unknown; resource?: unknown; effect?: unknown }[]) {
    if (typeof rule?.action !== "string") continue
    if (rule.action === "*") {
      out["*"] = rule.effect
      continue
    }
    if (rule.action === "external_directory" && typeof rule.resource === "string") {
      const cur = (out.external_directory ?? {}) as Record<string, unknown>
      cur[rule.resource] = rule.effect
      out.external_directory = cur
      continue
    }
    if (rule.action === "edit") {
      out.edit = rule.effect
      out.write = rule.effect
    } else {
      out[rule.action] = rule.effect
    }
  }
  return out
}
