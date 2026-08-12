import fs from "fs"
import path from "path"
import { memoryRoot } from "./paths.js"

const AGENT_NAMES = ["memorize", "memorize-extract"] as const
type AgentName = (typeof AGENT_NAMES)[number]

const REQUIRED_ALLOWS: Record<AgentName, string[]> = {
  memorize: ["read", "edit", "write", "glob", "grep"],
  "memorize-extract": ["StructuredOutput"],
}

const SAFE_ALLOWS: Record<AgentName, Set<string>> = {
  memorize: new Set(["read", "edit", "write", "glob", "grep", "external_directory"]),
  "memorize-extract": new Set(["StructuredOutput"]),
}

export interface AgentHealthEntry {
  source: "shipped" | "user_override" | "missing"
  healthy: boolean
  issues: string[]
}

export interface AgentHealthSnapshot {
  observed: boolean
  generationEnabled: boolean | null
  agents: Record<AgentName, AgentHealthEntry>
}

const initialEntry = (): AgentHealthEntry => ({ source: "missing", healthy: false, issues: ["config hook has not run"] })

let snapshot: AgentHealthSnapshot = {
  observed: false,
  generationEnabled: null,
  agents: {
    memorize: initialEntry(),
    "memorize-extract": initialEntry(),
  },
}

export function loadBundledAgentDefinitions(): Record<string, unknown> {
  const raw = fs.readFileSync(path.join(import.meta.dirname, "..", "opencode.json"), "utf8")
  return (JSON.parse(raw) as { agent?: Record<string, unknown> }).agent ?? {}
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function hasNonDenyAction(value: unknown): boolean {
  const rules = asRecord(value)
  return rules ? Object.values(rules).some((action) => action !== "deny") : value !== "deny"
}

/** Structural compare — config reload re-parses shipped defs into new objects. */
function definitionsEqual(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

function permissionIssues(name: AgentName, definition: unknown): string[] {
  const issues: string[] = []
  const record = asRecord(definition)
  if (record?.mode !== "subagent") issues.push("agent mode must be 'subagent'")
  const permission = asRecord(record?.permission)
  if (!permission) {
    issues.push("missing permission map")
    return issues
  }

  const keys = Object.keys(permission)
  if (keys[0] !== "*") issues.push("permission wildcard '*' must be the first rule")
  if (permission["*"] !== "deny") issues.push("permission wildcard '*' must be 'deny'")

  for (const toolName of REQUIRED_ALLOWS[name]) {
    if (permission[toolName] !== "allow") {
      issues.push(`required permission '${toolName}: allow' is missing`)
    }
  }

  for (const [toolName, value] of Object.entries(permission)) {
    if (toolName === "*") continue
    if (!SAFE_ALLOWS[name].has(toolName)) {
      if (hasNonDenyAction(value)) issues.push(`unexpected permission '${toolName}' must be denied`)
    }
  }

  if (name === "memorize") {
    const external = asRecord(permission.external_directory)
    const expectedPath = path.join(memoryRoot(), "*")
    if (external?.[expectedPath] !== "allow") {
      issues.push(`consolidator must allow external_directory '${expectedPath}'`)
    }
    if (external) {
      for (const [grantedPath, action] of Object.entries(external)) {
        if (grantedPath === expectedPath) continue
        if (hasNonDenyAction(action)) {
          issues.push(`consolidator must deny extra external_directory '${grantedPath}'`)
        }
      }
    }
  } else if (permission.external_directory !== undefined) {
    issues.push("extractor must not have external_directory access")
  }

  return issues
}

function inspectAgent(name: AgentName, definition: unknown, source: AgentHealthEntry["source"]): AgentHealthEntry {
  const issues = permissionIssues(name, definition)
  return { source, healthy: issues.length === 0, issues }
}

/** Record the effective agent config after the plugin config hook runs. */
export function recordAgentConfig(
  config: { agent?: Record<string, unknown> },
  generationEnabled: boolean,
  shipped: Record<string, unknown>,
): void {
  const configured = asRecord(config.agent)
  const agents = {} as Record<AgentName, AgentHealthEntry>
  for (const name of AGENT_NAMES) {
    const definition = configured?.[name]
    const source =
      definition === undefined
        ? "missing"
        : definitionsEqual(shipped[name], definition)
          ? "shipped"
          : "user_override"
    agents[name] = inspectAgent(name, definition, source)
    if (!generationEnabled && definition === undefined) {
      agents[name] = { source: "missing", healthy: true, issues: ["generation disabled; agent not injected"] }
    }
  }
  snapshot = { observed: true, generationEnabled, agents }
}

export function getAgentHealth(): AgentHealthSnapshot {
  return {
    observed: snapshot.observed,
    generationEnabled: snapshot.generationEnabled,
    agents: {
      memorize: { ...snapshot.agents.memorize, issues: [...snapshot.agents.memorize.issues] },
      "memorize-extract": { ...snapshot.agents["memorize-extract"], issues: [...snapshot.agents["memorize-extract"].issues] },
    },
  }
}

/** Test seam and boot boundary. */
export function resetAgentHealth(): void {
  snapshot = {
    observed: false,
    generationEnabled: null,
    agents: {
      memorize: initialEntry(),
      "memorize-extract": initialEntry(),
    },
  }
}
