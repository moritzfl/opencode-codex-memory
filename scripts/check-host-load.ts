/**
 * Load the built plugin on OpenCode 1.18.x and 2.x (XDG-sandboxed).
 *
 * OPENCODE_V1_BIN — 1.18.x binary (required)
 * OPENCODE_BIN    — 2.x binary (default: opencode on PATH)
 */
import { spawn, type ChildProcess } from "child_process"
import fs from "fs"
import path from "path"
import {
  basicAuth,
  createSandbox,
  createSession,
  freePort,
  repoRoot,
  type Sandbox,
  type ServeHandle,
} from "./lib/harness.ts"

const V1_BIN = process.env.OPENCODE_V1_BIN?.trim() || ""
const V2_BIN = process.env.OPENCODE_BIN?.trim() || "opencode"

const LOAD_ERRORS = [
  "failed to load plugin",
  "failed to load tui plugin",
  "unable to load",
  "Plugin export is not a function",
  "must default export an object with tui()",
  "must default export an object with server()",
  "Cannot find package '@opencode/plugin'",
]

function fail(msg: string): never {
  console.error(`host-load: FAIL — ${msg}`)
  process.exit(1)
}

function note(ok: boolean, msg: string) {
  if (ok) console.log(`[ok] ${msg}`)
  else fail(msg)
}

function versionOf(bin: string): string {
  const r = Bun.spawnSync([bin, "--version"], { stdout: "pipe", stderr: "pipe" })
  const text = (r.stdout.toString() + r.stderr.toString()).trim()
  const m = text.match(/(\d+\.\d+\.\d+)/)
  if (!m) fail(`could not parse version from ${bin}: ${text}`)
  return m[1]!
}

function stopChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve()
    child.kill("SIGTERM")
    const t = setTimeout(() => {
      try {
        child.kill("SIGKILL")
      } catch {
      }
    }, 8_000)
    child.on("close", () => {
      clearTimeout(t)
      resolve()
    })
  })
}

async function waitHealth(baseUrl: string, sandbox: Sandbox, deadline: number): Promise<void> {
  let last = ""
  while (Date.now() < deadline) {
    for (const p of ["/global/health", "/api/status"]) {
      try {
        const res = await fetch(`${baseUrl}${p}`, {
          signal: AbortSignal.timeout(1500),
          headers: basicAuth(sandbox),
        })
        const text = await res.text()
        last = `${p} ${res.status} ${text.slice(0, 120)}`
        if (!res.ok) continue
        let json: any = null
        try {
          json = JSON.parse(text)
        } catch {
        }
        if (p === "/global/health" && (json?.healthy === true || typeof json?.version === "string")) return
        if (p === "/api/status" && typeof json?.pid === "number" && typeof json?.version === "string") return
        if (res.ok && json) return
      } catch (e) {
        last = e instanceof Error ? e.message : String(e)
      }
    }
    await Bun.sleep(150)
  }
  throw new Error(`health timeout (${last})`)
}

function logHas(text: string, needles: string[]) {
  const lower = text.toLowerCase()
  return needles.filter((n) => lower.includes(n.toLowerCase()))
}

function assertNoLoadError(id: string, text: string) {
  const hits = logHas(text, LOAD_ERRORS)
  if (hits.length) fail(`${id} load error (${hits.join(", ")}):\n${text.slice(-4000)}`)
}

function assertMemoryDb(id: string, sandbox: Sandbox, extra = "") {
  const memoryDb = path.join(sandbox.opencodeData, "memory.db")
  const memoryWal = path.join(sandbox.opencodeData, "memory.db-wal")
  if (fs.existsSync(memoryDb) || fs.existsSync(memoryWal)) {
    note(true, `${id} created memory.db (plugin init ran)`)
    return
  }
  const files = fs.existsSync(sandbox.opencodeData)
    ? fs.readdirSync(sandbox.opencodeData).join(",")
    : "(missing data dir)"
  fail(`${id} did not create memory.db (data: ${files})${extra}`)
}

async function collect(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = ""
    child.stdout?.on("data", (d) => {
      out += d.toString()
    })
    child.stderr?.on("data", (d) => {
      out += d.toString()
    })
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs)
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, out })
    })
  })
}

async function probeV1(bin: string): Promise<void> {
  const ver = versionOf(bin)
  console.log(`\n== opencode-1.18  bin=${bin}  version=${ver}`)
  note(ver.startsWith("1.18."), "opencode-1.18 is 1.18.x")

  const sandbox = createSandbox({ bare: true, keep: false })
  const options = {
    min_rollout_idle_hours: 1,
    max_rollouts_per_startup: 8,
    generate_memories: false,
    use_memories: true,
  }
  fs.writeFileSync(
    path.join(sandbox.configHome, "opencode", "opencode.json"),
    JSON.stringify({ plugin: [[sandbox.pluginFileUrl, options]] }, null, 2) + "\n",
  )
  sandbox.env.OPENCODE_PRINT_LOGS = "1"
  sandbox.env.OPENCODE_LOG_LEVEL = "DEBUG"

  const port = await freePort()
  const logPath = path.join(sandbox.root, "serve.log")
  const logFd = fs.openSync(logPath, "w")
  const child = spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs", "--log-level", "DEBUG"], {
    cwd: sandbox.project,
    env: sandbox.env,
    stdio: ["ignore", logFd, logFd],
  })
  fs.closeSync(logFd)
  const baseUrl = `http://127.0.0.1:${port}`
  try {
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        await waitHealth(baseUrl, sandbox, Date.now() + 400)
        break
      } catch {
        await Bun.sleep(150)
      }
    }
    if (child.exitCode !== null) {
      fail(`opencode-1.18 serve exited ${child.exitCode}:\n${fs.readFileSync(logPath, "utf8").slice(-4000)}`)
    }
    await waitHealth(baseUrl, sandbox, Date.now() + 15_000)
    note(true, `opencode-1.18 serve healthy on ${baseUrl}`)
    const serve: ServeHandle = { baseUrl, port, logPath, stop: async () => {} }
    const id = await createSession(serve, sandbox, "host-load")
    console.log(`[opencode-1.18 session] ${id}`)
    await Bun.sleep(1_500)
    const serveLog = fs.readFileSync(logPath, "utf8")
    assertNoLoadError("opencode-1.18", serveLog)
    note(true, "opencode-1.18 serve log has no plugin load failure")
    assertMemoryDb("opencode-1.18", sandbox)
  } finally {
    await stopChild(child)
    sandbox.cleanup()
  }
}

async function probeV2(bin: string): Promise<void> {
  const ver = versionOf(bin)
  console.log(`\n== opencode-2  bin=${bin}  version=${ver}`)
  note(ver.startsWith("2."), "opencode-2 is 2.x")

  const sandbox = createSandbox({ bare: true, keep: false })
  const entry = path.join(repoRoot(), "dist", "src", "index.js")
  const plugDir = path.join(sandbox.project, ".opencode", "plugins")
  fs.mkdirSync(plugDir, { recursive: true })
  // 2.x `plugins: [{ package: file://... }]` is not auto-installed by `serve`/`run`.
  // Local `.opencode/plugins` is the host's file-plugin path and imports our built entry.
  fs.writeFileSync(path.join(plugDir, "codex-memory.js"), `export { default } from ${JSON.stringify(entry)}\n`)
  sandbox.env.OPENCODE_PRINT_LOGS = "1"
  sandbox.env.OPENCODE_LOG_LEVEL = "debug"
  sandbox.env.PWD = sandbox.project

  const child = spawn(
    bin,
    ["run", "--standalone", "--print-logs", "--log-level", "debug", "--title", "host-load", "pong"],
    { cwd: sandbox.project, env: sandbox.env, stdio: ["ignore", "pipe", "pipe"] },
  )
  try {
    const { out } = await collect(child, 45_000)
    assertNoLoadError("opencode-2", out)
    note(true, "opencode-2 log has no plugin load failure")
    note(/loading plugin/.test(out), "opencode-2 logged loading plugin")
    note(/v2\/plugin\.js/.test(out) || /opencode-codex-memory/.test(out), "opencode-2 imported the V2 adapter")
    assertMemoryDb("opencode-2", sandbox, `\n${out.slice(-2000)}`)
  } finally {
    await stopChild(child)
    sandbox.cleanup()
  }
}

const smoke = Bun.spawnSync(["bun", "run", "smoke"], {
  cwd: repoRoot(),
  stdout: "inherit",
  stderr: "inherit",
})
note(smoke.exitCode === 0, "bun run smoke")

if (!V1_BIN) fail("set OPENCODE_V1_BIN to an OpenCode 1.18.x binary")
await probeV1(V1_BIN)
await probeV2(V2_BIN)
console.log("\nhost-load: OK — smoke + 1.18.x + 2.x all loaded")
