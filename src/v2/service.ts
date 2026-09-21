/**
 * The supported OpenCode 2 connection boundary.
 *
 * Server plugins do not receive the complete public client. `ctx` is the
 * documented plugin API; global session list is missing there, so we talk
 * HTTP via `@opencode/client` (a runtime dependency so the plugin cache
 * actually installs it). Discovery reads XDG `service.json` (never
 * Service.ensure() / Service.discover() — the bundled client probes the
 * removed /api/health route). Probe /api/info, with legacy route fallbacks.
 * A different local service PID is accepted only on loopback.
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
  /** Test/legacy only. Production probes readiness over HTTP, not this. */
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
let cachedClient: V2ServiceClient | null = null
let lastFailure: string | null = null
const SERVICE_REQUEST_TIMEOUT_MS = 3_000

/** Test seam: replace discovery without changing the production connection path. */
export function setV2ServiceDependenciesForTest(dependencies: V2ServiceDependencies | null): void {
  testDependencies = dependencies
  invalidateOwnService()
}

/** Forget a cached endpoint after a service restart or failed request. */
export function invalidateOwnService(): void {
  clientPromise = null
  cachedClient = null
  lastFailure = null
}

/** Last discoverOwnService failure, if ownServiceClient returned null. */
export function lastServiceFailure(): string | null {
  return lastFailure
}

function connectionFailed(error: unknown): boolean {
  let failed = false
  const seen = new Set<unknown>()
  for (let current = error as any; current && !seen.has(current); current = current.cause ?? current.error) {
    seen.add(current)
    if (current.name === "AbortError") return false
    const status = current.status ?? current.statusCode ?? current.response?.status
    if (status === 401 || status === 403 || current.reason === "Transport") failed = true
    if (/ECONNREFUSED|ECONNRESET|EPIPE|ENOTFOUND|ETIMEDOUT|fetch failed|unauthori[sz]ed/i.test(
      [current.code, current.type, current._tag, current.name, current.message].join(" "),
    )) failed = true
  }
  return failed
}

/** Invalidate broken endpoints for the next call. Never replay mutations or generation. */
export async function serviceRequest<T>(client: V2ServiceClient, request: () => Promise<T>): Promise<T> {
  const invalidate = (error: unknown) => {
    if (client === cachedClient && connectionFailed(error)) {
      invalidateOwnService()
      lastFailure = error instanceof Error ? error.message : "registered OpenCode service connection failed"
    }
  }
  try {
    const result = await request()
    invalidate((result as { error?: unknown } | null | undefined)?.error)
    return result
  } catch (error) {
    invalidate(error)
    throw error
  }
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
  // Current hosts expose /api/info; older 2.x hosts used /api/status or
  // /api/health. Only a missing route permits fallback: auth/server failures
  // and an explicitly unready response must not look like a healthy service.
  for (const route of ["/api/info", "/api/status", "/api/health"]) {
    const response = await fetchJson(new URL(route, endpoint.url), headers, signal)
    if (response.status === 404) continue
    if (!response.ok) throw new Error(`GET ${route} ${response.status}`)
    const ready = parseReadyStatus(response.body)
    if (ready) return ready
    throw new Error(`registered OpenCode service is not healthy (GET ${route})`)
  }
  throw new Error("registered OpenCode service has no readiness endpoint (/api/info, /api/status, /api/health returned 404)")
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

/** Local loopback only — IDE `serve --port 0` shares opencode.db with `--service`. */
export function isLoopbackEndpointUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1"
  } catch {
    return false
  }
}

/**
 * Find a ready, registered OpenCode service without starting or replacing one.
 * A missing service is a normal unavailable result. A PID mismatch on a
 * non-loopback URL is a safety failure (would operate on another host).
 * Loopback PID mismatch is the IDE isolated-serve case: same machine, shared
 * session database, so global list/get/messages still go through that service.
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
    if (!isLoopbackEndpointUrl(endpoint.url)) {
      throw new Error(`registered OpenCode service PID ${String(health.pid)} does not match plugin host PID ${process.pid}`)
    }
    console.warn(
      `[opencode-codex-memory] registered OpenCode service PID ${String(health.pid)} is a different local process than plugin host PID ${process.pid}; using it for global session list`,
    )
  }
  return { endpoint, client, health }
}

/** Resolve the registered client once per live service; never start a service. */
export async function ownServiceClient(): Promise<V2ServiceClient | null> {
  if (!clientPromise) {
    const request = discoverOwnService()
      .then((found) => {
        if (clientPromise === request) {
          cachedClient = found?.client ?? null
          lastFailure = found ? null : "no registered OpenCode 2 service.json"
        }
        return found?.client ?? null
      })
      .catch((err) => {
        if (clientPromise === request) lastFailure = err instanceof Error ? err.message : String(err)
        console.warn("[opencode-codex-memory] registered OpenCode service unavailable:", err)
        return null
      })
    clientPromise = request
    const result = await request
    if (!result && clientPromise === request) clientPromise = null
    return result
  }
  return clientPromise
}
