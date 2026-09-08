import { Plugin } from "@opencode/plugin/tui"
import { createSignal, onCleanup } from "solid-js"
import { MemoryStatusRpc, isMemoryStatus, type MemoryStatus } from "./status-rpc.js"

const labels: Record<MemoryStatus["activity"], string> = {
  idle: "Idle",
  extracting: "Extracting",
  consolidating: "Consolidating",
  retrying: "Waiting to retry",
  error: "Needs attention",
  read_only: "Read only",
  disabled: "Disabled",
  stopping: "Stopping",
}

type TuiContext = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]
type RpcClient = ReturnType<TuiContext["client"]["rpc"]>

function elapsed(time: number | null | undefined, now: number): string {
  if (time == null) return "—"
  const minutes = Math.max(0, Math.floor((now - time) / 60_000))
  if (minutes === 0) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`
  return `${Math.floor(minutes / 1440)}d ago`
}

/**
 * Dual-arity slot registration. Early V2 previews exposed
 * `ui.slot(name, render)`; current previews take a single options object.
 * Branch on arity so either host works.
 */
function registerSlot(context: TuiContext, name: string, render: (input: any) => unknown): () => void {
  const slot = context.ui.slot as unknown as (...args: unknown[]) => unknown
  const claim =
    slot.length <= 1 ? { append: name, render } : undefined
  const dispose = claim ? slot(claim) : (slot as (n: string, r: unknown) => unknown)(name, render)
  return typeof dispose === "function" ? (dispose as () => void) : () => {}
}

/**
 * Defensive theme lookup. Current previews expose a nested theme
 * (`text.feedback.error.default`); earlier ones used flat keys. Resolve to a
 * leaf color, tolerating either shape.
 */
function themeColor(theme: unknown, ...paths: readonly (readonly string[])[]): any {
  for (const path of paths) {
    let cursor: unknown = theme
    for (const key of path) {
      if (cursor === null || typeof cursor !== "object") {
        cursor = undefined
        break
      }
      cursor = (cursor as Record<string, unknown>)[key]
    }
    if (cursor !== null && typeof cursor === "object" && "default" in (cursor as Record<string, unknown>)) {
      cursor = (cursor as Record<string, unknown>).default
    }
    if (cursor !== undefined && cursor !== null) return cursor
  }
  return undefined
}

async function fetchStatus(rpc: RpcClient, context: TuiContext): Promise<MemoryStatus> {
  const result = await rpc.status(
    {},
    {
      location: context.location ?? context.data.location.default(),
      signal: AbortSignal.timeout(5_000),
    },
  )
  // The RPC client is untyped for plain JSON-schema definitions.
  if (!isMemoryStatus(result)) throw new Error("invalid memory status payload")
  return result
}

function formatDetails(current: MemoryStatus): string {
  return [
    `Status: ${labels[current.activity]}`,
    "Scope: Global",
    `Use memories: ${current.useMemories ? "Enabled" : "Disabled"}`,
    `Generate memories: ${current.generateMemories ? "Enabled" : "Disabled"}`,
    `Extraction: ${current.extractModel ?? "Host default"}`,
    `Consolidation: ${current.consolidationModel ?? "Host default"}`,
    `Codex import: ${current.codexImport ? "Enabled" : "Disabled"}`,
    `Last successful consolidation: ${current.lastSuccessAt == null ? "Not recorded for the latest attempt" : new Date(current.lastSuccessAt).toLocaleString()}`,
    ...(current.retryAt == null ? [] : [`Retry eligible: ${new Date(current.retryAt).toLocaleString()}`]),
    ...current.warnings,
    "",
    "Use memory_inspect for full diagnostics.",
  ].join("\n")
}

function StatusPanel(context: TuiContext) {
  const rpc = context.client.rpc(MemoryStatusRpc)
  const [status, setStatus] = createSignal<MemoryStatus>()
  const [unavailable, setUnavailable] = createSignal(false)
  const [now, setNow] = createSignal(Date.now())

  const refresh = async () => {
    try {
      setStatus(await fetchStatus(rpc, context))
      setUnavailable(false)
    } catch {
      setUnavailable(true)
    } finally {
      setNow(Date.now())
    }
  }

  const unsubscribe = rpc.events.on("changed", () => void refresh())
  // Reconcile missed events, cross-process jobs, and relative timestamps.
  const timer = setInterval(() => void refresh(), 5_000)
  onCleanup(() => {
    clearInterval(timer)
    unsubscribe()
  })
  void refresh()

  const title = () => (unavailable() ? "Unavailable" : status() ? labels[status()!.activity] : "Loading…")
  const color = () => {
    if (unavailable() || status()?.activity === "error") {
      return themeColor(context.theme, ["text", "feedback", "error"], ["text"])
    }
    if (status()?.activity === "retrying") {
      return themeColor(context.theme, ["text", "feedback", "warning"], ["text"])
    }
    if (status()?.activity === "extracting" || status()?.activity === "consolidating") {
      return themeColor(context.theme, ["text", "status", "running"], ["text"])
    }
    return themeColor(context.theme, ["text", "subdued"], ["textMuted"], ["text"])
  }
  const muted = () => themeColor(context.theme, ["text", "subdued"], ["textMuted"], ["text"])
  const heading = () => themeColor(context.theme, ["text", "default"], ["text"])

  // No <Show>: its empty placeholder is a bare text node under <box>,
  // which the renderer rejects. Unconditional lines with placeholders instead.
  const scopeLine = () => "  Scope        Global"
  const successLine = () => `  Last success ${status() ? elapsed(status()?.lastSuccessAt, now()) : "…"}` as string
  const importLine = () =>
    `  Codex import ${status() ? (status()!.codexImport ? "Enabled" : "Disabled") : "…"}` as string

  return (
    <box flexDirection="column">
      <text fg={heading()}>Memory</text>
      <text fg={color()}>● {title()}</text>
      <text fg={muted()}>{scopeLine()}</text>
      <text fg={muted()}>{successLine()}</text>
      <text fg={muted()}>{importLine()}</text>
      <text fg={muted()}>{"  /memory-status"}</text>
    </box>
  )
}

function KeymapLayer(context: TuiContext) {
  // keymap.layer must be invoked from a Solid component scope: its cleanup is
  // owned by this component and released automatically on unmount.
  context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "opencode-codex-memory.status",
        title: "Show memory status",
        group: "Memory",
        palette: true,
        slash: { name: "memory-status" },
        run: async () => {
          const rpc = context.client.rpc(MemoryStatusRpc)
          let message: string
          try {
            message = formatDetails(await fetchStatus(rpc, context))
          } catch {
            message = "Memory status is unavailable. Check that the server memory plugin is enabled and connected."
          }
          await context.ui.dialog.alert({ title: "Memory status", message })
        },
      },
    ],
  }))
  return null
}

export default Plugin.define({
  id: "opencode-codex-memory.tui",
  setup(context) {
    // setup() itself must stay free of Solid-scoped APIs: only slot claims
    // here, everything reactive lives in the slot components above.
    const offSidebar = registerSlot(context, "sidebar.content", () => StatusPanel(context))
    const offApp = registerSlot(context, "app", () => KeymapLayer(context))
    return () => {
      offSidebar()
      offApp()
    }
  },
})
