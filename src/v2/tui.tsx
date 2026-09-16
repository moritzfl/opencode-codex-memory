import { Plugin } from "@opencode/plugin/tui"
import { createSignal, onCleanup, For } from "solid-js"
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

function remaining(time: number | null | undefined, now: number): string {
  if (time == null) return "—"
  const minutes = Math.max(0, Math.ceil((time - now) / 60_000))
  if (minutes < 1) return "in <1m"
  if (minutes < 60) return `in ${minutes}m`
  if (minutes < 1440) return `in ${Math.floor(minutes / 60)}h ${minutes % 60}m`
  return `in ${Math.floor(minutes / 1440)}d`
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

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

async function fetchStatus(rpc: RpcClient, context: TuiContext, sessionID?: string): Promise<MemoryStatus> {
  const result = await rpc.status(
    sessionID ? { sessionID } : {},
    {
      location: context.location ?? context.data.location.default(),
      signal: AbortSignal.timeout(5_000),
    },
  )
  // The RPC client is untyped for plain JSON-schema definitions.
  if (!isMemoryStatus(result)) throw new Error("invalid memory status payload")
  return result
}

type Row = { label: string; value: string; tone?: "ok" | "warn" | "muted" }

function statusRows(s: MemoryStatus, now: number): Row[] {
  return [
    { label: "Activity", value: labels[s.activity] },
    { label: "Read memories", value: s.useMemories ? "On" : "Off", tone: s.useMemories ? "ok" : "muted" },
    { label: "Write memories", value: s.generateMemories ? "On" : "Off", tone: s.generateMemories ? "ok" : "muted" },
    ...(s.sessionMode
      ? [
          {
            label: "This session",
            value: s.sessionMode === "enabled" ? "Learning" : s.sessionMode === "disabled" ? "Not learning" : "Excluded (external context)",
            tone: (s.sessionMode === "enabled" ? "ok" : "muted") as Row["tone"],
          },
        ]
      : []),
    { label: "Last consolidated", value: s.lastSuccessAt == null ? "Never" : elapsed(s.lastSuccessAt, now) },
    ...(s.retryAt == null ? [] : [{ label: "Next retry", value: remaining(s.retryAt, now), tone: "warn" as const }]),
  ]
}

function usageRows(s: MemoryStatus): Row[] {
  const inj = s.injected
  const per = inj.sessionRequests > 0
    ? Math.round(inj.sessionTokens / inj.sessionRequests)
    : inj.totalRequests > 0
      ? Math.round(inj.totalTokens / inj.totalRequests)
      : 0
  return [
    { label: "Block size", value: per ? `~${formatTokens(per)} tokens / request` : "—" },
    { label: "This session", value: `~${formatTokens(inj.sessionTokens)} tokens · ${inj.sessionRequests} req` },
    { label: "Since start", value: `~${formatTokens(inj.totalTokens)} tokens · ${inj.totalRequests} req` },
  ]
}

function configRows(s: MemoryStatus): Row[] {
  return [
    { label: "Extraction", value: s.extractModel ?? "Host default" },
    { label: "Consolidation", value: s.consolidationModel ?? "Host default" },
    { label: "Codex import", value: s.codexImport ? "On" : "Off", tone: s.codexImport ? "ok" : "muted" },
    { label: "Location", value: s.memoryRoot },
  ]
}

const TABS = ["Overview", "Controls"] as const
type Tab = (typeof TABS)[number]

type Control = {
  id: string
  title: string
  hint: string
  /** Toggle state; undefined for one-shot actions. */
  on?: boolean
  enabled: boolean
  run: () => void
}

/**
 * /memory dialog. Tabs switch by mouse click or left/right. Controls: ↑/↓ move, Enter or
 * click toggles/runs. Esc closes (host-owned).
 */
function MemoryDialog(context: TuiContext, sessionID: string | undefined, initial: MemoryStatus | null) {
  const rpc = context.client.rpc(MemoryStatusRpc)
  const [status, setStatus] = createSignal<MemoryStatus | null>(initial)
  const [tab, setTab] = createSignal<Tab>("Overview")
  const [cursor, setCursor] = createSignal(0)
  const [notice, setNotice] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const now = () => Date.now()

  const refresh = async () => {
    try {
      setStatus(await fetchStatus(rpc, context, sessionID))
    } catch {
      setStatus(null)
    }
  }
  const unsubscribe = rpc.events.on("changed", () => void refresh())
  const timer = setInterval(() => void refresh(), 30_000)
  onCleanup(() => {
    clearInterval(timer)
    unsubscribe()
  })

  const call = async (method: string, input: Record<string, unknown>, done: string) => {
    if (busy()) return
    setBusy(true)
    try {
      await (rpc as any)[method](input, {
        location: context.location ?? context.data.location.default(),
        signal: AbortSignal.timeout(5_000),
      })
      setNotice(done)
      await refresh()
    } catch (err) {
      setNotice(`Failed: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const controls = (): Control[] => {
    const s = status()
    if (!s) return []
    const list: Control[] = [
      {
        id: "read",
        title: "Use memories",
        hint: "Inject the memory summary into every model request",
        on: s.useMemories,
        enabled: true,
        run: () => void call("setOption", { key: "use_memories", value: !s.useMemories }, s.useMemories ? "Memories are no longer injected." : "Memories are injected again."),
      },
      {
        id: "learn",
        title: "Learn from sessions",
        hint: "Background extraction and consolidation of finished conversations",
        on: s.generateMemories,
        enabled: true,
        run: () => void call("setOption", { key: "generate_memories", value: !s.generateMemories }, s.generateMemories ? "Learning paused." : "Learning resumed."),
      },
    ]
    if (sessionID) {
      const learning = s.sessionMode !== "disabled" && s.sessionMode !== "polluted"
      list.push({
        id: "session",
        title: "Learn from this session",
        hint: s.sessionMode === "polluted"
          ? "Auto-excluded: this session pulled in external context"
          : "Whether this conversation may be extracted into memory",
        on: learning,
        enabled: true,
        run: () => void call("setSessionMode", { sessionID, mode: learning ? "disabled" : "enabled" }, learning ? "This session will not be learned from." : "This session will be learned from."),
      })
    }
    const running = s.activity === "consolidating" || s.activity === "extracting"
    list.push({
      id: "now",
      title: "Consolidate now",
      hint: running ? "Already running" : s.generateMemories ? "Extract idle sessions and rebuild the summary, skipping the 6h cooldown" : "Turn on learning first",
      enabled: s.generateMemories && !running,
      run: () => void call("consolidateNow", {}, "Consolidation started in the background."),
    })
    return list
  }

  const activate = (i: number) => {
    const c = controls()[i]
    if (c && c.enabled) c.run()
  }
  const move = (d: number) => {
    const n = controls().length
    if (n === 0) return
    setCursor((cursor() + d + n) % n)
  }

  context.keymap.layer(() => ({
    enabled: () => true,
    commands: [
      { title: "Previous tab", bind: "left", run: () => { setTab(TABS[(TABS.indexOf(tab()) + TABS.length - 1) % TABS.length]!) } },
      { title: "Next tab", bind: "right", run: () => { setTab(TABS[(TABS.indexOf(tab()) + 1) % TABS.length]!) } },
    ],
  }))

  // Keyboard control navigation is only claimed on the Controls tab.
  context.keymap.layer(() => ({
    enabled: () => tab() === "Controls",
    commands: [
      { title: "Previous control", bind: "up", run: () => move(-1) },
      { title: "Next control", bind: "down", run: () => move(1) },
      { title: "Toggle control", bind: "return", run: () => activate(cursor()) },
      { title: "Toggle control", bind: "space", run: () => activate(cursor()) },
    ],
  }))

  const th = context.theme as any
  const text = themeColor(th, ["text", "default"], ["text"])
  const muted = themeColor(th, ["text", "subdued"], ["textMuted"], ["text"])
  const ok = themeColor(th, ["text", "feedback", "success"], ["text"])
  const warn = themeColor(th, ["text", "feedback", "warning"], ["text"])
  const err = themeColor(th, ["text", "feedback", "error"], ["text"])
  const accent = themeColor(th, ["text", "action", "primary"], ["text"])
  const selectedBg = themeColor(th, ["background", "action", "primary", "$focused"], ["background", "action", "primary", "focused"])
  const toneColor = (t: Row["tone"]) => (t === "ok" ? ok : t === "warn" ? warn : t === "muted" ? muted : text)

  const LABEL_W = 18
  const Rows = (props: { rows: Row[] }) => (
    <For each={props.rows}>
      {(r) => (
        <text fg={toneColor(r.tone)}>
          <span style={{ fg: muted }}>{r.label.padEnd(LABEL_W)}</span>
          {r.value}
        </text>
      )}
    </For>
  )
  // Spacing lives on <box>: marginTop on <text> overdraws the neighbours.
  const Section = (props: { title: string }) => (
    <box marginTop={1}>
      <text fg={muted}>
        <b>{props.title.toUpperCase()}</b>
      </text>
    </box>
  )
  const Note = (props: { fg: unknown; children: string }) => (
    <box marginTop={1}>
      <text fg={props.fg as any}>{props.children}</text>
    </box>
  )

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" gap={2}>
        <For each={TABS}>
          {(t) => (
            <box
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={tab() === t ? selectedBg : undefined}
              onMouseDown={() => setTab(t)}
            >
              <text fg={tab() === t ? text : muted}>
                {tab() === t ? <b>{t}</b> : t}
              </text>
            </box>
          )}
        </For>
      </box>

      {/* No <Show>: its empty placeholder is a bare text node under <box>. */}
      <box flexDirection="column">
        {status() === null ? (
          <Note fg={err}>Memory status unavailable — is the server plugin loaded?</Note>
        ) : tab() === "Overview" ? (
          <box flexDirection="column">
            <Section title="Status" />
            <Rows rows={statusRows(status()!, now())} />
            <Section title="Context usage" />
            <Rows rows={usageRows(status()!)} />
            <Section title="Setup" />
            <Rows rows={configRows(status()!)} />
            {status()!.warnings.length > 0 ? (
              <box flexDirection="column">
                <Section title="Attention" />
                <For each={status()!.warnings}>{(w) => <text fg={warn}>{`! ${w}`}</text>}</For>
              </box>
            ) : (
              <box />
            )}
            <Note fg={muted}>Token figures are chars/4 estimates; the block is re-sent each request and normally served from the prompt cache.</Note>
          </box>
        ) : (
          <box flexDirection="column" marginTop={1}>
            <For each={controls()}>
              {(c, i) => {
                const selected = () => cursor() === i()
                const fgTitle = () => (!c.enabled ? muted : text)
                const indicator = () =>
                  c.on === undefined ? "▸" : c.on ? "●" : "○"
                const indicatorFg = () => (!c.enabled ? muted : c.on === undefined ? accent : c.on ? ok : muted)
                const state = () => (c.on === undefined ? "" : c.on ? "On" : "Off")
                return (
                  <box
                    flexDirection="column"
                    paddingLeft={1}
                    paddingRight={1}
                    backgroundColor={selected() ? selectedBg : undefined}
                    onMouseDown={() => {
                      setCursor(i())
                      activate(i())
                    }}
                  >
                    <text fg={fgTitle()}>
                      <span style={{ fg: indicatorFg() }}>{indicator()}</span>
                      {selected() ? <b>{` ${c.title.padEnd(26)}`}</b> : ` ${c.title.padEnd(26)}`}
                      <span style={{ fg: c.on ? ok : muted }}>{state()}</span>
                    </text>
                    <text fg={muted}>{`  ${c.hint}`}</text>
                  </box>
                )
              }}
            </For>
            <Note fg={muted}>Global settings last until the server restarts; edit opencode.json to make them permanent.</Note>
          </box>
        )}
      </box>

      <Note fg={ok}>{notice()}</Note>
      <Note fg={muted}>
        {tab() === "Controls" ? "↑↓ move · enter toggle · click a tab or control · esc close" : "click a tab · esc close · ask the assistant for memory_inspect for raw diagnostics"}
      </Note>
    </box>
  )
}

function StatusPanel(context: TuiContext, sessionID?: string) {
  const rpc = context.client.rpc(MemoryStatusRpc)
  const [status, setStatus] = createSignal<MemoryStatus>()
  const [unavailable, setUnavailable] = createSignal(false)

  const refresh = async () => {
    try {
      setStatus(await fetchStatus(rpc, context, sessionID))
      setUnavailable(false)
    } catch {
      setUnavailable(true)
    }
  }

  const unsubscribe = rpc.events.on("changed", () => void refresh())
  // Reconcile missed events (e.g. options changed by memory_mode / reload).
  const timer = setInterval(() => void refresh(), 30_000)
  onCleanup(() => {
    clearInterval(timer)
    unsubscribe()
  })
  void refresh()

  // Enabled/disabled only; activity and diagnostics live in /memory.
  const title = () => {
    if (unavailable()) return "Unavailable"
    const s = status()
    if (!s) return "Loading…"
    return s.useMemories ? "Enabled" : "Disabled"
  }
  const color = () => {
    if (unavailable()) return themeColor(context.theme, ["text", "feedback", "error"], ["text"])
    if (status()?.useMemories) return themeColor(context.theme, ["text", "feedback", "success"], ["text"])
    return themeColor(context.theme, ["text", "subdued"], ["textMuted"], ["text"])
  }
  const muted = () => themeColor(context.theme, ["text", "subdued"], ["textMuted"], ["text"])
  const heading = () => themeColor(context.theme, ["text", "default"], ["text"])

  // Status only; details live in /memory-status. No <Show>: its empty
  // placeholder is a bare text node under <box>, which the renderer rejects.
  return (
    <box flexDirection="column">
      <text fg={heading()}>Memory</text>
      <text fg={color()}>● {title()}</text>
      <text fg={muted()}>{"  /memory"}</text>
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
        title: "Memory",
        description: "Memory status and controls",
        group: "Memory",
        palette: true,
        slash: { name: "memory", aliases: ["memory-status"] },
        run: async () => {
          const rpc = context.client.rpc(MemoryStatusRpc)
          const route = context.ui.router.current()
          const sessionID = route.type === "session" ? route.sessionID : undefined
          let initial: MemoryStatus | null = null
          try {
            initial = await fetchStatus(rpc, context, sessionID)
          } catch {
            initial = null
          }
          context.ui.dialog.show(() => MemoryDialog(context, sessionID, initial))
          context.ui.dialog.set({ size: "medium" })
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
    const offSidebar = registerSlot(context, "sidebar.content", (input: { sessionID?: string } | undefined) =>
      StatusPanel(context, input?.sessionID),
    )
    const offApp = registerSlot(context, "app", () => KeymapLayer(context))
    return () => {
      offSidebar()
      offApp()
    }
  },
})
