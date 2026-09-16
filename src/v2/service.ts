/**
 * The supported OpenCode 2 connection boundary.
 *
 * Server plugins do not receive the complete public client. The registered
 * local service does: Service.discover() is read-only, Service.headers()
 * preserves authentication, and the health PID proves the client points at
 * this host rather than an unrelated OpenCode process.
 */

export interface V2ServiceEndpoint {
  url: string
  auth?: { type: "basic"; username: string; password: string }
}

export interface V2ServiceClient {
  health: { get: (options?: { signal?: AbortSignal }) => Promise<unknown> }
  session: Record<string, (input?: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>>
  message?: Record<string, (input?: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>>
  config?: Record<string, (input?: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>>
}

export interface V2ServiceDependencies {
  service: {
    discover: () => Promise<V2ServiceEndpoint | undefined>
    headers: (endpoint: V2ServiceEndpoint) => Record<string, string> | undefined
  }
  make: (options: { baseUrl: string; headers?: Record<string, string> }) => V2ServiceClient
}

let testDependencies: V2ServiceDependencies | null = null
let clientPromise: Promise<V2ServiceClient | null> | null = null
const SERVICE_REQUEST_TIMEOUT_MS = 1_000

/** Test seam: replace discovery without changing the production connection path. */
export function setV2ServiceDependenciesForTest(dependencies: V2ServiceDependencies | null): void {
  testDependencies = dependencies
  clientPromise = null
}

/** Forget a cached endpoint after a service restart or failed request. */
export function invalidateOwnService(): void {
  clientPromise = null
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

async function productionDependencies(): Promise<V2ServiceDependencies> {
  const [{ Service }, { OpenCode }] = await Promise.all([
    import("@opencode/client/service"),
    import("@opencode/client"),
  ])
  return {
    service: {
      discover: () => Service.discover(),
      headers: (endpoint) => Service.headers(endpoint),
    },
    make: (options) => OpenCode.make(options) as unknown as V2ServiceClient,
  }
}

/**
 * Find a ready, registered OpenCode service without starting or replacing one.
 * A missing service is a normal unavailable result; a PID mismatch is a
 * safety failure because it would make global memory operate on another host.
 */
export async function discoverOwnService(
  dependencies?: V2ServiceDependencies,
  timeoutMs = SERVICE_REQUEST_TIMEOUT_MS,
): Promise<{ endpoint: V2ServiceEndpoint; client: V2ServiceClient; health: { version: string; pid: number } } | null> {
  const deps = dependencies ?? testDependencies ?? (await productionDependencies())
  const endpoint = await withServiceTimeout(deps.service.discover(), timeoutMs)
  if (!endpoint) return null
  const client = deps.make({ baseUrl: endpoint.url, headers: deps.service.headers(endpoint) })
  const controller = new AbortController()
  const health = (await withServiceTimeout(client.health.get({ signal: controller.signal }), timeoutMs, controller)) as {
    healthy?: unknown
    version?: unknown
    pid?: unknown
  }
  if (health?.healthy !== true) throw new Error("registered OpenCode service is not healthy")
  if (typeof health?.pid !== "number" || health.pid !== process.pid) {
    throw new Error(`registered OpenCode service PID ${String(health?.pid)} does not match plugin host PID ${process.pid}`)
  }
  if (typeof health.version !== "string") throw new Error("registered OpenCode service returned no version")
  return { endpoint, client, health: { version: health.version, pid: health.pid } }
}

/** Resolve the registered client once per live service; never start a service. */
export async function ownServiceClient(): Promise<V2ServiceClient | null> {
  if (!clientPromise) {
    const request = discoverOwnService().then((found) => found?.client ?? null).catch((err) => {
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
