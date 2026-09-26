/**
 * OpenAI Responses rejects a follow-up that still contains a function call
 * with no function_call_output ("No tool output found for function call").
 * A native memory tool can still be `running` when that follow-up is built:
 * the call is included, the result is not, and the session dies.
 *
 * The context hook runs before that request is lowered. Fill any memory tool
 * call that has no result so the provider always sees an output. Read tools
 * are executed here. Mutating tools get an error output instead of running
 * twice.
 */
import { memory_read, memory_search, memory_list } from "../../tools/memory.js"
import { memory_inspect } from "../../tools/control.js"

const READ_TOOLS = new Map<string, { execute: (args: any, ctx: any) => Promise<unknown> }>([
  ["memory_search", memory_search],
  ["memory_read", memory_read],
  ["memory_list", memory_list],
  ["memory_inspect", memory_inspect],
])

const MUTATING_TOOLS = new Set(["memory_add_note", "memory_mode"])

function parts(message: any): any[] {
  return Array.isArray(message?.content) ? message.content : []
}

function toolResultIds(messages: readonly any[]): Set<string> {
  const ids = new Set<string>()
  for (const message of messages) {
    for (const part of parts(message)) {
      if (part?.type === "tool-result" && typeof part.id === "string") ids.add(part.id)
    }
  }
  return ids
}

function outputText(result: unknown): string {
  if (typeof result === "string") return result
  if (result && typeof result === "object" && "output" in result && typeof (result as { output?: unknown }).output === "string") {
    return (result as { output: string }).output
  }
  return result == null ? "" : String(result)
}

function toolMessage(id: string, name: string, text: string) {
  const value = text.trim() ? text : "(no tool output)"
  return {
    role: "tool",
    content: [{ type: "tool-result", id, name, result: { type: "text", value } }],
  }
}

/**
 * Insert a tool result immediately after each assistant message that still
 * has an unmatched memory tool call. Returns how many results were added.
 */
export async function repairUnsettledMemoryTools(messages: any[] | undefined, sessionID = "ses_repair"): Promise<number> {
  if (!Array.isArray(messages) || messages.length === 0) return 0
  const answered = toolResultIds(messages)
  let added = 0
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if ((message?.role ?? message?.type) !== "assistant") continue
    const pending = parts(message).filter((part) =>
      part?.type === "tool-call" &&
      part.providerExecuted !== true &&
      typeof part.id === "string" &&
      typeof part.name === "string" &&
      !answered.has(part.id) &&
      (READ_TOOLS.has(part.name) || MUTATING_TOOLS.has(part.name)),
    )
    if (pending.length === 0) continue
    const content = []
    for (const part of pending) {
      answered.add(part.id)
      content.push((await toolMessageFor(part, sessionID)).content[0])
      added++
    }
    messages.splice(i + 1, 0, { role: "tool", content })
    i++
  }
  return added
}

async function toolMessageFor(part: { id: string; name: string; input?: unknown }, sessionID: string) {
  const tool = READ_TOOLS.get(part.name)
  if (!tool) {
    return toolMessage(
      part.id,
      part.name,
      `${part.name} had no result when the next request was built. Treat this call as not applied and retry it if still needed.`,
    )
  }
  try {
    const result = await tool.execute(part.input ?? {}, {
      sessionID,
      messageID: "msg_repair",
      agent: "build",
      directory: "",
      worktree: "",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {
        throw new Error("User approval is unavailable while repairing an unsettled memory tool call.")
      },
    })
    return toolMessage(part.id, part.name, outputText(result))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return toolMessage(part.id, part.name, `${part.name} error: ${message}`)
  }
}
