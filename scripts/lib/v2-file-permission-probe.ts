import fs from "node:fs"
import path from "node:path"
import { api, type Sandbox, type ServeHandle } from "./harness.js"

/** Run native file executors through a test-only command, without a model. */
export function installFilePermissionProbe(sandbox: Sandbox): void {
  const dir = path.join(sandbox.root, "file-permission-probe")
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "file-permission-probe", type: "module", main: "index.js" }))
  fs.writeFileSync(path.join(dir, "index.js"), `
import fs from "node:fs"
export default {
  id: "file-permission-probe",
  async setup(ctx) {
    const tools = {}
    await ctx.tool.transform(editor => {
      for (const name of ["read", "write"]) tools[name] = editor.get(name)?.execute
    })
    await ctx.command.transform(editor => editor.add({
      name: "file-permission-probe",
      async execute({ sessionID, prompt }) {
        const input = JSON.parse(prompt.text)
        const results = []
        for (const probe of input.probes) {
          try {
            if (!tools[probe.tool]) throw new Error("Missing native executor: " + probe.tool)
            await tools[probe.tool](probe.input, {
              sessionID, agent: "build", messageID: "msg_permissionprobe", id: "call_permissionprobe",
              signal: new AbortController().signal, progress: async () => {},
            })
            results.push({ ok: true })
          } catch (error) {
            results.push({ ok: false, error: String(error) })
          }
        }
        fs.writeFileSync(input.output, JSON.stringify(results))
      },
    }))
  },
}
`)
  const configPath = path.join(sandbox.configHome, "opencode", "opencode.json")
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"))
  config.plugins = [dir]
  fs.writeFileSync(configPath, JSON.stringify(config))
}

export async function probeFilePermissions(
  serve: ServeHandle, sandbox: Sandbox, sessionID: string, directory: string,
  probes: { tool: "read" | "write"; input: { path: string; content?: string } }[],
): Promise<{ ok: boolean; error?: string }[]> {
  const output = path.join(sandbox.root, "file-probe-result.json")
  fs.rmSync(output, { force: true })
  const response = await api(serve, sandbox, "POST", `/api/session/${sessionID}/command`, {
    name: "file-permission-probe", text: JSON.stringify({ probes, output }),
  }, { directory })
  if (response.status !== 204) throw new Error(`file probe HTTP ${response.status}: ${response.text}`)
  return JSON.parse(fs.readFileSync(output, "utf8"))
}
