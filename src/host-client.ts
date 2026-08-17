/**
 * Narrow adapters for host SDK surfaces where the generated OpenAPI types lag
 * the server (see BACKLOG "opencode release ritual"). Keep every intentional
 * cast in this file so grepping for `as any` in pipeline code stays clean and
 * each cast can be dropped when `types.gen.d.ts` catches up.
 *
 * Current gaps (as of @opencode-ai/plugin ~1.18.10):
 * - session.create body: metadata + title typing
 * - session.prompt body: `format` (json_schema) omitted from PromptInput
 * - AssistantMessage.info.structured: structured extraction result
 * - client._client.get: experimental routes (no experimental.* namespace on V1)
 * - mcp.status: present on host client, weakly typed in plugin package
 */

import type { PluginInput } from "@opencode-ai/plugin"

export type HostHttpGet = (opts: {
  url: string
  query?: Record<string, unknown>
  signal?: AbortSignal
}) => Promise<{ error?: unknown; data?: unknown }>

/** Hey-api transport on PluginInput.client for routes the V1 surface lags on. */
export function pluginHttpGet(client: PluginInput["client"] | null | undefined): HostHttpGet | null {
  const http = (client as { _client?: { get?: unknown } } | null | undefined)?._client
  if (!http || typeof http.get !== "function") return null
  return http.get.bind(http) as HostHttpGet
}

/**
 * Host-wide session list. The SDK injects `directory` from
 * x-opencode-directory on every GET; a truthy value makes the experimental
 * handler filter to that instance's project. Pass `directory:""` so rewrite
 * does not re-inject and the handler sees a falsy value → listGlobal.
 * Used by discovery and helper-session cleanup (memory is global).
 */
export async function hostListSessionsGlobal(
  client: PluginInput["client"] | null | undefined,
  opts: { limit: number; signal?: AbortSignal },
): Promise<{ error?: unknown; data?: unknown }> {
  const get = pluginHttpGet(client)
  if (!get) throw new Error("plugin HTTP client unavailable")
  return get({
    url: "/experimental/session",
    query: { roots: true, limit: opts.limit, directory: "" },
    signal: opts.signal,
  })
}

/** Attach a no-op catch so a raced-away promise cannot become unhandled. */
export function ignoreLateRejection(promise: Promise<unknown>): void {
  void promise.catch(() => {})
}

export async function withHostTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  abort?: AbortController,
): Promise<T> {
  ignoreLateRejection(promise)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort?.abort()
          reject(new Error(`${label} timed out after ${ms}ms`))
        }, ms)
        timer.unref?.()
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export interface SessionCreateBody {
  title?: string
  metadata?: Record<string, unknown>
}

/** session.create with metadata (SDK body type is incomplete). */
export async function hostSessionCreate(
  client: PluginInput["client"],
  opts: { directory: string; body: SessionCreateBody; signal?: AbortSignal },
): Promise<{ error?: unknown; data?: { id?: string } }> {
  return client.session.create({
    query: { directory: opts.directory },
    body: opts.body as never,
    ...(opts.signal ? { signal: opts.signal } : {}),
  } as never) as Promise<{ error?: unknown; data?: { id?: string } }>
}

export interface HostPromptBody {
  agent: string
  system?: string
  model?: { providerID: string; modelID: string }
  format?: Record<string, unknown>
  parts: { type: "text"; text: string }[]
}

/** session.prompt including `format` for json_schema structured output. */
export async function hostSessionPrompt(
  client: PluginInput["client"],
  opts: { sessionId: string; body: HostPromptBody },
): Promise<{ error?: unknown; data?: unknown }> {
  return client.session.prompt({
    path: { id: opts.sessionId },
    body: {
      agent: opts.body.agent,
      ...(opts.body.system ? { system: opts.body.system } : {}),
      ...(opts.body.model ? { model: opts.body.model } : {}),
      ...(opts.body.format ? { format: opts.body.format } : {}),
      parts: opts.body.parts,
    } as never,
  } as never) as Promise<{ error?: unknown; data?: unknown }>
}

/** Read AssistantMessage.structured when the host captured json_schema output. */
export function hostStructuredOutput(data: unknown): Record<string, unknown> | null {
  const structured = (data as { info?: { structured?: unknown } } | null | undefined)?.info?.structured
  if (structured && typeof structured === "object" && !Array.isArray(structured)) {
    return structured as Record<string, unknown>
  }
  return null
}

export async function hostMcpStatus(
  client: PluginInput["client"] | null,
  signal?: AbortSignal,
): Promise<{ error?: unknown; data?: unknown } | null> {
  if (!client) return null
  const mcp = (client as { mcp?: { status?: (opts: { signal?: AbortSignal }) => Promise<unknown> } }).mcp
  if (typeof mcp?.status !== "function") return null
  return (await mcp.status({ signal })) as { error?: unknown; data?: unknown }
}

/** session.messages — weakly typed parts; centralize the cast. */
export async function hostSessionMessages(
  client: PluginInput["client"] | null | undefined,
  sessionId: string,
  signal?: AbortSignal,
): Promise<{ error?: unknown; data?: unknown }> {
  if (!client || typeof client.session?.messages !== "function") {
    throw new Error("plugin client unavailable; cannot load transcript")
  }
  return client.session.messages({
    path: { id: sessionId },
    ...(signal ? { signal } : {}),
  }) as Promise<{ error?: unknown; data?: unknown }>
}

export function hostPartType(part: unknown): string {
  return typeof (part as { type?: unknown })?.type === "string" ? (part as { type: string }).type : "unknown"
}

export async function hostSessionDeletionConfirmed(
  client: PluginInput["client"],
  id: string,
  timeoutMs: number,
): Promise<boolean> {
  const session = client.session as {
    get?: (opts: { path: { id: string }; signal?: AbortSignal }) => Promise<{ response?: { status?: number } }>
  }
  if (typeof session?.get !== "function") return false
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const res = await Promise.race([
      session.get({ path: { id }, signal: controller.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error(`session.get timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      }),
    ])
    return res?.response?.status === 404
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}
