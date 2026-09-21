import path from "node:path"
import { allMemoryRoots } from "../paths.js"
import { safeResolveUnderRoot } from "../path-guard.js"
import { MEMORIZE_AGENT_ID } from "./agents.js"

/** Pattern permissions cannot constrain paths. Wrap executors, not fail-open hooks. */
export function guardMemorySearchTools(
  editor: { update(id: string, update: (tool: any) => void): void },
  getSession: (sessionID: string) => Promise<unknown>,
): void {
  const roots = allMemoryRoots()
  for (const name of ["glob", "grep"]) {
    editor.update(name, (tool) => {
      const execute = tool.execute
      tool.execute = async (input: any, context: any) => {
        if (context.agent !== MEMORIZE_AGENT_ID) return execute(input, context)
        const response = await getSession(context.sessionID) as any
        const session = response?.data ?? response
        // Helper permissions persist across plugin reloads and select one writer
        // even during dual-write. Never fall back to the active project or version.
        const allowed = roots.filter((root) => session?.permissions?.some((rule: any) =>
          rule.action === "read" && rule.resource === root && rule.effect === "allow",
        ))
        if (allowed.length !== 1) throw new Error("memory search requires one session-scoped memory workspace")
        const root = allowed[0]
        const requested = input.path ?? "."
        if (typeof requested !== "string") throw new Error("invalid memory search path")
        const target = safeResolveUnderRoot(root, path.relative(root, path.resolve(root, requested)))
        if (name === "glob" && (path.isAbsolute(input.pattern) || /(^|[\\/,{])\.\.([\\/},]|$)/.test(input.pattern))) {
          throw new Error("glob pattern escapes memory workspace")
        }
        return execute({ ...input, path: target }, context)
      }
    })
  }
}
