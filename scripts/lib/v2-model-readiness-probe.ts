import fs from "node:fs"
import path from "node:path"
import { api, createSandbox, repoRoot, startServe, type ServeHandle } from "./harness.js"

/** Cold host + delayed provider registration, no external inference or credentials. */
export async function probeV2ModelReadiness(): Promise<{ failures: number; inferenceCalls: number }> {
  const { retryModelSelection } = await import(path.join(repoRoot(), "dist/src/v2/model-readiness.js"))
  let inferenceCalls = 0
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    inferenceCalls++
    await request.json()
    const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({
      id: "readiness-probe", object: "chat.completion.chunk", created: 1, model: "m1",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`
    return new Response(chunk({ role: "assistant", content: "OK" }, null) + chunk({}, "stop") + "data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    })
  } })
  const sandbox = createSandbox({ bare: true })
  let serve: ServeHandle | undefined
  try {
    const pluginDir = path.join(sandbox.root, "delayed-provider")
    const release = path.join(sandbox.root, "register-provider")
    fs.mkdirSync(pluginDir)
    fs.writeFileSync(path.join(pluginDir, "package.json"), JSON.stringify({ name: "delayed-provider", type: "module", main: "index.js" }))
    // Keep the catalog empty until the first selection failure, making the
    // reproduction deterministic even on slow hosts. Timeout bounds setup.
    fs.writeFileSync(path.join(pluginDir, "index.js"), `
import fs from "node:fs"
export default { id: "delayed-provider", async setup(ctx) {
  const deadline = Date.now() + 15000
  while (!fs.existsSync(${JSON.stringify(release)}) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  await ctx.provider.transform(editor => editor.update("delayed", provider => { provider.activation = "enabled" }))
} }
`)
    fs.writeFileSync(path.join(sandbox.configHome, "opencode/opencode.json"), JSON.stringify({
      plugins: [pluginDir], providers: { delayed: {
        name: "Delayed", disabled: true, package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: upstream.url.href + "v1", apiKey: "test-only" }, models: { m1: { name: "m1" } },
      } },
    }))
    serve = await startServe(sandbox, { bin: "opencode2" })
    let failures = 0
    const output = await retryModelSelection(async () => {
      const response = await api(serve!, sandbox, "POST", "/api/experimental/generate", {
        model: { providerID: "delayed", id: "m1" }, prompt: "Reply OK",
      })
      if (response.status !== 200) {
        failures++
        fs.writeFileSync(release, "ready")
        throw response.json
      }
      return response.json
    }, { providerID: "delayed", id: "m1" }, AbortSignal.timeout(20_000))
    if ((output as { data?: { text?: string } })?.data?.text !== "OK" || failures === 0 || inferenceCalls !== 1) {
      throw new Error(`model readiness probe failed: failures=${failures}, inferenceCalls=${inferenceCalls}, output=${JSON.stringify(output)}`)
    }
    return { failures, inferenceCalls }
  } finally {
    await serve?.stop()
    sandbox.cleanup()
    upstream.stop(true)
  }
}
