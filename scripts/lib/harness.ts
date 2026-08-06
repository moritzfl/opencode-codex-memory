/**
 * Shared XDG sandbox + opencode serve helpers for live integration tests.
 * Never touches the real ~/.local/share/opencode or ~/.config/opencode trees.
 */
import { spawn, spawnSync, type ChildProcess } from "child_process"
import fs from "fs"
import net from "net"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import { Database } from "bun:sqlite"

export const MARKER = "INTEGRATION-TEST-MARKER-42"
export const MARKER_LINE = `${MARKER}: user loves pineapple on pizza`

export type HostModels = { model?: string; smallModel?: string }

export type Sandbox = {
  root: string
  dataHome: string
  configHome: string
  cacheHome: string
  stateHome: string
  project: string
  /** XDG_DATA_HOME/opencode — also OPENCODE_CODEX_MEMORY_TEST_ROOT */
  opencodeData: string
  memories: string
  password: string
  pluginFileUrl: string
  env: NodeJS.ProcessEnv
  keep: boolean
  cleanup: () => void
}

export type ServeHandle = {
  baseUrl: string
  port: number
  stop: () => Promise<void>
  logPath: string
}

export function repoRoot(): string {
  return path.resolve(import.meta.dirname, "../..")
}

export function whichOpencode(): string {
  const fromEnv = process.env.OPENCODE_BIN?.trim()
  if (fromEnv) return fromEnv
  const result = Bun.spawnSync(["which", "opencode"], { stdout: "pipe", stderr: "pipe" })
  const p = result.stdout.toString().trim()
  if (result.exitCode !== 0 || !p) {
    throw new Error("opencode not found in PATH (set OPENCODE_BIN to override)")
  }
  return p
}

export function opencodeVersion(bin = whichOpencode()): string {
  const result = Bun.spawnSync([bin, "--version"], { stdout: "pipe", stderr: "pipe" })
  const text = (result.stdout.toString() + result.stderr.toString()).trim()
  const m = text.match(/(\d+\.\d+\.\d+)/)
  if (!m) throw new Error(`could not parse opencode version from: ${text}`)
  return m[1]!
}

export function parseSemver(v: string): [number, number, number] {
  const m = v.trim().match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!m) throw new Error(`invalid semver: ${v}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

export function semverGte(a: string, b: string): boolean {
  const aa = parseSemver(a)
  const bb = parseSemver(b)
  for (let i = 0; i < 3; i++) {
    if (aa[i]! > bb[i]!) return true
    if (aa[i]! < bb[i]!) return false
  }
  return true
}

export function resolveHostModels(): HostModels {
  const model = process.env.OPENCODE_LIVE_MODEL?.trim() || undefined
  const smallModel = process.env.OPENCODE_LIVE_SMALL_MODEL?.trim() || undefined
  if (model || smallModel) return { model, smallModel }

  const candidates = [
    path.join(os.homedir(), ".config", "opencode", "opencode.json"),
    path.join(os.homedir(), ".opencode", "opencode.json"),
  ]
  for (const p of candidates) {
    try {
      const j = JSON.parse(fs.readFileSync(p, "utf8")) as {
        model?: string
        small_model?: string
      }
      if (j.model || j.small_model) {
        return { model: j.model, smallModel: j.small_model }
      }
    } catch {
      // try next
    }
  }
  return {}
}

export function realAuthPath(): string {
  if (process.env.OPENCODE_LIVE_AUTH?.trim()) return process.env.OPENCODE_LIVE_AUTH.trim()
  return path.join(os.homedir(), ".local", "share", "opencode", "auth.json")
}

export function ensureBuilt(): void {
  const entry = path.join(repoRoot(), "dist", "src", "index.js")
  if (!fs.existsSync(entry)) {
    const r = Bun.spawnSync(["bun", "run", "build"], {
      cwd: repoRoot(),
      stdout: "inherit",
      stderr: "inherit",
    })
    if (r.exitCode !== 0) throw new Error("bun run build failed")
  }
  if (!fs.existsSync(entry)) throw new Error(`build entry missing: ${entry}`)
}

export type CreateSandboxOpts = {
  keep?: boolean
  model?: string
  smallModel?: string
  pluginOptions?: Record<string, unknown>
  /** Skip writing plugin into config (contract checks that only need bare host). */
  bare?: boolean
}

export function createSandbox(opts: CreateSandboxOpts = {}): Sandbox {
  ensureBuilt()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ocm-live-"))
  const dataHome = path.join(root, "data")
  const configHome = path.join(root, "config")
  const cacheHome = path.join(root, "cache")
  const stateHome = path.join(root, "state")
  const project = path.join(root, "project")
  const opencodeData = path.join(dataHome, "opencode")
  const memories = path.join(opencodeData, "memories")
  const password = `ocm-${process.pid}-${Date.now().toString(36)}`

  fs.mkdirSync(memories, { recursive: true })
  fs.mkdirSync(path.join(configHome, "opencode"), { recursive: true })
  fs.mkdirSync(cacheHome, { recursive: true })
  fs.mkdirSync(stateHome, { recursive: true })
  fs.mkdirSync(project, { recursive: true })
  fs.writeFileSync(path.join(project, "README.md"), "# live test project\n")

  const pluginFileUrl = pathToFileURL(repoRoot()).href
  const models = {
    model: opts.model ?? resolveHostModels().model,
    smallModel: opts.smallModel ?? resolveHostModels().smallModel,
  }

  const pluginOptions = {
    min_rollout_idle_hours: 1,
    max_rollouts_per_startup: 8,
    ...(opts.pluginOptions ?? {}),
  }

  const config: Record<string, unknown> = {}
  if (models.model) config.model = models.model
  if (models.smallModel) config.small_model = models.smallModel
  if (!opts.bare) {
    config.plugin = [[pluginFileUrl, pluginOptions]]
  }
  fs.writeFileSync(
    path.join(configHome, "opencode", "opencode.json"),
    JSON.stringify(config, null, 2) + "\n",
  )

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_DATA_HOME: dataHome,
    XDG_CONFIG_HOME: configHome,
    XDG_CACHE_HOME: cacheHome,
    XDG_STATE_HOME: stateHome,
    OPENCODE_CODEX_MEMORY_TEST_ROOT: opencodeData,
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_SERVER_USERNAME: "opencode",
    // Drop host instance env that would attach to a foreign server.
    OPENCODE: undefined,
    OPENCODE_PID: undefined,
  }
  // Bun/node keep undefined as string "undefined" if assigned that way — delete.
  delete env.OPENCODE
  delete env.OPENCODE_PID
  delete env.OPENCODE_PRINT_LOGS

  const keep = opts.keep === true || process.env.OPENCODE_LIVE_KEEP === "1"
  const cleanup = () => {
    if (keep) {
      console.error(`[harness] keeping sandbox: ${root}`)
      return
    }
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }

  return {
    root,
    dataHome,
    configHome,
    cacheHome,
    stateHome,
    project,
    opencodeData,
    memories,
    password,
    pluginFileUrl,
    env,
    keep,
    cleanup,
  }
}

export function copyAuth(sandbox: Sandbox): boolean {
  const src = realAuthPath()
  if (!fs.existsSync(src)) return false
  fs.mkdirSync(sandbox.opencodeData, { recursive: true })
  fs.copyFileSync(src, path.join(sandbox.opencodeData, "auth.json"))
  return true
}

export function requireAuth(sandbox: Sandbox): void {
  if (!copyAuth(sandbox)) {
    throw new Error(
      `no auth.json at ${realAuthPath()} — live tests need provider credentials (or set OPENCODE_LIVE_AUTH)`,
    )
  }
}

export function requireModels(models: HostModels = resolveHostModels()): {
  model: string
  smallModel: string
} {
  if (!models.model) {
    throw new Error(
      "no model configured — set OPENCODE_LIVE_MODEL or model in ~/.config/opencode/opencode.json",
    )
  }
  return {
    model: models.model,
    smallModel: models.smallModel ?? models.model,
  }
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.unref()
    s.on("error", reject)
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address()
      if (!addr || typeof addr === "string") {
        s.close()
        reject(new Error("could not bind ephemeral port"))
        return
      }
      const port = addr.port
      s.close((err) => (err ? reject(err) : resolve(port)))
    })
  })
}

export async function startServe(
  sandbox: Sandbox,
  opts: { port?: number; bin?: string; extraArgs?: string[] } = {},
): Promise<ServeHandle> {
  const bin = opts.bin ?? whichOpencode()
  const port = opts.port ?? (await freePort())
  const logPath = path.join(sandbox.root, "serve.log")
  const logFd = fs.openSync(logPath, "w")
  const child: ChildProcess = spawn(
    bin,
    ["serve", "--hostname", "127.0.0.1", "--port", String(port), ...(opts.extraArgs ?? [])],
    {
      cwd: sandbox.project,
      env: sandbox.env,
      stdio: ["ignore", logFd, logFd],
      detached: false,
    },
  )
  fs.closeSync(logFd)

  const baseUrl = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 60_000
  let lastErr = ""
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `opencode serve exited early (code ${child.exitCode}):\n${tail(logPath, 40)}`,
      )
    }
    try {
      const res = await fetch(`${baseUrl}/global/health`, {
        headers: basicAuth(sandbox),
      })
      if (res.ok) break
      lastErr = `HTTP ${res.status}`
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
    }
    await sleep(150)
  }
  if (Date.now() >= deadline) {
    await stopChild(child)
    throw new Error(`opencode serve health timeout (${lastErr}):\n${tail(logPath, 40)}`)
  }

  return {
    baseUrl,
    port,
    logPath,
    stop: async () => {
      await stopChild(child)
    },
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  child.kill("SIGTERM")
  const deadline = Date.now() + 10_000
  while (child.exitCode === null && Date.now() < deadline) {
    await sleep(50)
  }
  if (child.exitCode === null) {
    try {
      child.kill("SIGKILL")
    } catch {
      // ignore
    }
  }
}

export function basicAuth(sandbox: Sandbox): Record<string, string> {
  const token = Buffer.from(`opencode:${sandbox.password}`).toString("base64")
  return { Authorization: `Basic ${token}` }
}

export type ApiResult = {
  status: number
  json: unknown
  text: string
}

export async function api(
  serve: ServeHandle,
  sandbox: Sandbox,
  method: string,
  apiPath: string,
  body?: unknown,
  query: Record<string, string | undefined> = {},
): Promise<ApiResult> {
  const url = new URL(apiPath, serve.baseUrl)
  if (!url.searchParams.has("directory")) {
    url.searchParams.set("directory", sandbox.project)
  }
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) url.searchParams.set(k, v)
  }
  const res = await fetch(url, {
    method,
    headers: {
      ...basicAuth(sandbox),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: res.status, json, text }
}

export async function createSession(
  serve: ServeHandle,
  sandbox: Sandbox,
  title: string,
): Promise<string> {
  const res = await api(serve, sandbox, "POST", "/session", { title })
  if (res.status >= 300) throw new Error(`createSession failed: ${res.status} ${res.text}`)
  const id = (res.json as { id?: string })?.id
  if (!id) throw new Error(`createSession: no id in ${res.text}`)
  return id
}

export async function promptSession(
  serve: ServeHandle,
  sandbox: Sandbox,
  sessionId: string,
  text: string,
  opts: { agent?: string; timeoutMs?: number } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 180_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const url = new URL(`/session/${sessionId}/message`, serve.baseUrl)
    url.searchParams.set("directory", sandbox.project)
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        ...basicAuth(sandbox),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...(opts.agent ? { agent: opts.agent } : {}),
        parts: [{ type: "text", text }],
      }),
    })
    const body = await res.text()
    if (!res.ok) throw new Error(`prompt failed: ${res.status} ${body.slice(0, 500)}`)
    return extractAssistantText(body)
  } finally {
    clearTimeout(timer)
  }
}

function extractAssistantText(body: string): string {
  try {
    const j = JSON.parse(body) as {
      parts?: Array<{ type?: string; text?: string }>
      info?: { role?: string }
    }
    // POST /message returns { info, parts } for the assistant turn.
    if (Array.isArray(j.parts)) {
      return j.parts
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text!)
        .join("\n")
    }
  } catch {
    // fall through
  }
  return body
}

export function runOpencode(
  sandbox: Sandbox,
  args: string[],
  opts: { timeoutMs?: number; cwd?: string } = {},
): { stdout: string; stderr: string; code: number } {
  const bin = whichOpencode()
  const result = spawnSync(bin, args, {
    cwd: opts.cwd ?? sandbox.project,
    env: sandbox.env,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 120_000,
  })
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    code: result.status ?? 1,
  }
}

export function openSandboxDb(dbPath: string): Database {
  return new Database(dbPath, { readonly: false, create: false, strict: false })
}

export function memoryDbPath(sandbox: Sandbox): string {
  return path.join(sandbox.opencodeData, "memory.db")
}

export function opencodeDbPath(sandbox: Sandbox): string {
  return path.join(sandbox.opencodeData, "opencode.db")
}

export function sqlAll<T extends Record<string, unknown>>(
  dbPath: string,
  query: string,
  params: unknown[] = [],
): T[] {
  if (!fs.existsSync(dbPath)) return []
  const db = new Database(dbPath, { readonly: true, strict: false })
  try {
    return db.prepare(query).all(...params) as T[]
  } finally {
    db.close()
  }
}

export function sqlRun(dbPath: string, query: string, params: unknown[] = []): void {
  const db = new Database(dbPath, { readonly: false, create: false, strict: false })
  try {
    db.run("PRAGMA busy_timeout=5000")
    db.prepare(query).run(...params)
  } finally {
    db.close()
  }
}

/** Backdate top-level work sessions so they clear min_rollout_idle_hours. */
export function backdateSessions(sandbox: Sandbox, hours = 2): number {
  const dbPath = opencodeDbPath(sandbox)
  if (!fs.existsSync(dbPath)) return 0
  const db = new Database(dbPath, { readonly: false, strict: false })
  try {
    db.run("PRAGMA busy_timeout=5000")
    const delta = hours * 3600 * 1000
    const r = db
      .prepare(
        `UPDATE session
         SET time_updated = time_updated - ?
         WHERE parent_id IS NULL
           AND title NOT LIKE 'codex-memory-%'`,
      )
      .run(delta)
    return Number(r.changes ?? 0)
  } finally {
    db.close()
  }
}

export function clearPhase2Job(sandbox: Sandbox): void {
  const dbPath = memoryDbPath(sandbox)
  if (!fs.existsSync(dbPath)) return
  sqlRun(
    dbPath,
    `DELETE FROM memory_jobs
     WHERE kind = 'memory_consolidate_global' AND job_key = 'global'`,
  )
}

export function writeSummary(sandbox: Sandbox, content: string): void {
  fs.mkdirSync(sandbox.memories, { recursive: true })
  fs.writeFileSync(path.join(sandbox.memories, "memory_summary.md"), content.endsWith("\n") ? content : content + "\n")
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export async function waitFor(
  label: string,
  fn: () => boolean | Promise<boolean>,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 300_000
  const intervalMs = opts.intervalMs ?? 2_000
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await sleep(intervalMs)
  }
  throw new Error(`timeout waiting for ${label} after ${timeoutMs}ms`)
}

export function tail(file: string, lines = 30): string {
  try {
    const text = fs.readFileSync(file, "utf8")
    return text.split("\n").slice(-lines).join("\n")
  } catch {
    return `(no log at ${file})`
  }
}

export function log(step: string, msg: string): void {
  console.log(`[${step}] ${msg}`)
}

export function fail(step: string, msg: string): never {
  console.error(`[${step}] FAIL — ${msg}`)
  process.exit(1)
}
