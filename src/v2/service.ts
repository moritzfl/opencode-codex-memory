/**
 * The supported OpenCode 2 connection boundary.
 *
 * Server plugins do not receive the complete public client. `ctx` is the
 * documented plugin API; global session list is missing there, so we talk
 * HTTP via `@opencode/client` (a runtime dependency so the plugin cache
 * actually installs it). Discovery reads XDG `service.json` (never
 * Service.ensure() / Service.discover() — those still probe /api/health,
 * which 2.0.5 404s). GET /api/status pid must match this process.
 */

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"

export interface V2ServiceEndpoint {
  url: string
  auth?: { type: "basic"; username: string; password: string }
}

export interface V2ServiceStatus {
  version: string
  pid: number
}

export interface V2ServiceClient {
  session: Record<string, (input?: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>>
  message?: Record<string, (input?: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>>
  config?: Record<string, (input?: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>>
  generate?: {
    text: (input: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>
  }
  /** Test/legacy only. Production probes /api/status, not this. */
  health?: { get: (options?: { signal?: AbortSignal }) => Promise<unknown> }
}

export interface V2ServiceDependencies {
  service: {
    discover: () => Promise<V2ServiceEndpoint | undefined>
    headers: (endpoint: V2ServiceEndpoint) => Record<string, string> | undefined
  }
  make: (options: { baseUrl: string; headers?: Record<string, string> }) => V2ServiceClient
  probe?: (endpoint: V2ServiceEndpoint, signal?: AbortSignal) => Promise<V2ServiceStatus>
}

let testDependencies: V2ServiceDependencies | null = null
let clientPromise: Promise<V2ServiceClient | null> | null = null
let lastFailure: string | null = null
const SERVICE_REQUEST_TIMEOUT_MS = 3_000

/** Test seam: replace discovery without changing the production connection path. */
export function setV2ServiceDependenciesForTest(dependencies: V2ServiceDependencies | null): void {
  testDependencies = dependencies
  clientPromise = null
}

/** Forget a cached endpoint after a service restart or failed request. */
export function invalidateOwnService(): void {
  clientPromise = null
  lastFailure = null
}

/** Last discoverOwnService failure, if ownServiceClient returned null. */
export function lastServiceFailure(): string | null {
  return lastFailure
}

/** Auth headers for the registered local service. */
export function serviceHeaders(endpoint: V2ServiceEndpoint): Record<string, string> | undefined {
  return Service.headers(endpoint)
}

export function parseReadyStatus(body: unknown): V2ServiceStatus | null {
  const record = unwrapStatusRecord(body)
  if (!record) return null
  const pid = record.pid
  const version = record.version
  if (typeof pid !== "number" || !Number.isFinite(pid) || typeof version !== "string" || version.length === 0) {
    return null
  }
  if ("healthy" in record && record.healthy !== true) return null
  return { pid, version }
}

function unwrapStatusRecord(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object") return null
  const record = body as Record<string, unknown>
  if (record.data && typeof record.data === "object" && !Array.isArray(record.data)) {
    return record.data as Record<string, unknown>
  }
  return record
}

async function withServiceTimeout<T>(request: Promise<T>, timeoutMs: number, controller?: AbortController): Promise<T> {
  request.catch(() => {})
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller?.abort()
          reject(new Error(`OpenCode service request timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function registrationPath(): string {
  return join(process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state"), "opencode", "service.json")
}

export async function readRegisteredEndpoint(file = registrationPath()): Promise<V2ServiceEndpoint | undefined> {
  const text = await readFile(file, "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  let info: unknown
  try {
    info = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!info || typeof info !== "object") return undefined
  const record = info as Record<string, unknown>
  if (typeof record.url !== "string" || record.url.length === 0) return undefined
  const password = record.password
  return {
    url: record.url,
    ...(typeof password === "string" && password.length > 0
      ? { auth: { type: "basic" as const, username: "opencode", password } }
      : {}),
  }
}

async function fetchJson(
  url: URL,
  headers: Record<string, string> | undefined,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const response = await fetch(url, { headers, signal })
  const text = await response.text()
  let body: unknown
  if (!text) body = undefined
  else {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  return { ok: response.ok, status: response.status, body }
}

export async function fetchServiceStatus(
  endpoint: V2ServiceEndpoint,
  headers: Record<string, string> | undefined,
  signal?: AbortSignal,
): Promise<V2ServiceStatus> {
  const statusRes = await fetchJson(new URL("/api/status", endpoint.url), headers, signal)
  const fromStatus = parseReadyStatus(statusRes.body)
  if (fromStatus) return fromStatus
  if (!statusRes.ok) throw new Error(`GET /api/status ${String(statusRes.status)}`)
  const healthRes = await fetchJson(new URL("/api/health", endpoint.url), headers, signal)
  const fromHealth = parseReadyStatus(healthRes.body)
  if (fromHealth) return fromHealth
  throw new Error("registered OpenCode service is not healthy")
}

function productionDependencies(): V2ServiceDependencies {
  return {
    service: {
      discover: () => readRegisteredEndpoint(),
      headers: serviceHeaders,
    },
    make: (options) => OpenCode.make(options) as unknown as V2ServiceClient,
    probe: (endpoint, signal) => fetchServiceStatus(endpoint, serviceHeaders(endpoint), signal),
  }
}

async function probeEndpoint(
  deps: V2ServiceDependencies,
  endpoint: V2ServiceEndpoint,
  client: V2ServiceClient,
  signal?: AbortSignal,
): Promise<V2ServiceStatus> {
  if (deps.probe) return deps.probe(endpoint, signal)
  if (client.health?.get) {
    const raw = await client.health.get({ signal })
    const parsed = parseReadyStatus(raw)
    if (parsed) return parsed
    throw new Error("registered OpenCode service is not healthy")
  }
  return fetchServiceStatus(endpoint, deps.service.headers(endpoint), signal)
}

/**
 * Find a ready, registered OpenCode service without starting or replacing one.
 * A missing service is a normal unavailable result; a PID mismatch is a
 * safety failure because it would make global memory operate on another host.
 */
export async function discoverOwnService(
  dependencies?: V2ServiceDependencies,
  timeoutMs = SERVICE_REQUEST_TIMEOUT_MS,
): Promise<{ endpoint: V2ServiceEndpoint; client: V2ServiceClient; health: V2ServiceStatus } | null> {
  const deps = dependencies ?? testDependencies ?? productionDependencies()
  const endpoint = await withServiceTimeout(deps.service.discover(), timeoutMs)
  if (!endpoint) return null
  const client = deps.make({ baseUrl: endpoint.url, headers: deps.service.headers(endpoint) })
  const controller = new AbortController()
  const health = await withServiceTimeout(probeEndpoint(deps, endpoint, client, controller.signal), timeoutMs, controller)
  if (health.pid !== process.pid) {
    throw new Error(`registered OpenCode service PID ${String(health.pid)} does not match plugin host PID ${process.pid}`)
  }
  return { endpoint, client, health }
}

/** Resolve the registered client once per live service; never start a service. */
export async function ownServiceClient(): Promise<V2ServiceClient | null> {
  if (!clientPromise) {
    const request = discoverOwnService()
      .then((found) => {
        lastFailure = found ? null : "no registered OpenCode 2 service.json"
        return found?.client ?? null
      })
      .catch((err) => {
        lastFailure = err instanceof Error ? err.message : String(err)
        console.warn("[opencode-codex-memory] registered OpenCode service unavailable:", err)
        return null
      })
    clientPromise = request
    const result = await request
    if (!result) clientPromise = null
    return result
  }
  return clientPromise
}
