import { Plugin } from "@opencode/plugin/tui"
import type { MouseEvent, ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
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
 * V2 renamed default/subdued tokens to base/muted. Only return color leaves:
 * passing a token group to OpenTUI silently loses colors and contrast.
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
    if (cursor !== null && typeof cursor === "object") {
      const token = cursor as Record<string, unknown>
      cursor = token.base ?? token.default ?? cursor
    }
    if (typeof cursor === "string" || (cursor !== null && typeof cursor === "object" && "r" in cursor)) return cursor
  }
  return undefined
}

function colors(context: TuiContext) {
  return {
    get text() { return themeColor(context.theme, ["text", "base"], ["text", "default"], ["text"]) },
    get muted() { return themeColor(context.theme, ["text", "muted"], ["text", "subdued"], ["textMuted"]) },
    get ok() { return themeColor(context.theme, ["text", "feedback", "success"], ["success"]) },
    get warn() { return themeColor(context.theme, ["text", "feedback", "warning"], ["warning"]) },
    get error() { return themeColor(context.theme, ["text", "feedback", "error"], ["error"]) },
    get selectedText() { return themeColor(context.theme, ["text", "action", "primary", "focused"], ["text", "action", "primary", "$focused"], ["text", "action", "primary"]) },
    get selectedBg() { return themeColor(context.theme, ["background", "action", "primary", "focused"], ["background", "action", "primary", "$focused"]) },
  }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

async function fetchStatus(rpc: RpcClient, context: TuiContext, sessionID?: string, signal?: AbortSignal): Promise<MemoryStatus> {
  const result = await rpc.status(
    sessionID ? { sessionID } : {},
    {
      location: context.location ?? context.data.location.default(),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000),
    },
  )
  // The RPC client is untyped for plain JSON-schema definitions.
  if (!isMemoryStatus(result)) throw new Error("invalid memory status payload")
  return result
}

/** Keep the last good snapshot on disconnect; ignore late replies and abort on close. */
function watchStatus(rpc: RpcClient, context: TuiContext, sessionID?: string) {
  const [status, setStatus] = createSignal<MemoryStatus | null>(null)
  const [unavailable, setUnavailable] = createSignal(false)
  const [refreshing, setRefreshing] = createSignal(false)
  const [updatedAt, setUpdatedAt] = createSignal(Date.now())
  const lifetime = new AbortController()
  let revision = 0
  const refresh = async () => {
    const request = ++revision
    setRefreshing(true)
    try {
      const next = await fetchStatus(rpc, context, sessionID, lifetime.signal)
      if (lifetime.signal.aborted || request !== revision) return
      setStatus(next)
      setUpdatedAt(Date.now())
      setUnavailable(false)
    } catch {
      if (!lifetime.signal.aborted && request === revision) setUnavailable(true)
    } finally {
      if (!lifetime.signal.aborted && request === revision) setRefreshing(false)
    }
  }
  const unsubscribe = rpc.events.on("changed", () => void refresh())
  const timer = setInterval(() => void refresh(), 30_000)
  onCleanup(() => {
    lifetime.abort()
    clearInterval(timer)
    unsubscribe()
  })
  void refresh()
  return { status, unavailable, refreshing, updatedAt, refresh, signal: lifetime.signal }
}

type Row = { label: string; value: string; tone?: "ok" | "warn" | "muted" }

function pipelineRows(s: MemoryStatus, now: number): Row[] {
  return s.pipelines.flatMap((pipeline): Row[] => {
    const version = pipeline.version.toUpperCase()
    const paused = !s.generateMemories || (!s.dualWrite && pipeline.version !== s.version)
    const extractionRetry = pipeline.phase1RetryAt != null && pipeline.phase1RetryAt > now
    const consolidationRetry = pipeline.phase2RetryAt != null && pipeline.phase2RetryAt > now
    const cooldown = pipeline.phase2CooldownUntil != null && pipeline.phase2CooldownUntil > now
    const consolidation = pipeline.phase2Status === "pending" ? "Queued"
      : pipeline.phase2Status === "failed" ? "Retry due" : "Idle"
    return [
      { label: `${version} recaps`, value: `${pipeline.stage1Count} stored`, tone: "muted" },
      {
        label: `${version} extraction`,
        value: pipeline.extracting ? `Running (${pipeline.extracting})` : paused ? "Paused"
          : extractionRetry ? `Retry ${remaining(pipeline.phase1RetryAt, now)}` : "Idle",
        tone: extractionRetry && !paused ? "warn" : "muted",
      },
      {
        label: `${version} consolidation`,
        value: pipeline.phase2Status === "running" ? "Running" : paused ? "Paused"
          : consolidationRetry ? `Retry ${remaining(pipeline.phase2RetryAt, now)}`
          : cooldown ? `${consolidation} · cooldown ends ${remaining(pipeline.phase2CooldownUntil, now)}`
          : pipeline.phase2Status === "pending" ? "Queued · next activity" : consolidation,
        tone: pipeline.lastError ? "warn" : "muted",
      },
    ]
  })
}

function statusRows(s: MemoryStatus, now: number): Row[] {
  return [
    { label: "Activity", value: labels[s.activity] },
    { label: "Memory version", value: `${s.sessionVersion} (default ${s.version})` },
    { label: "Learning pipelines", value: s.dualWrite ? "v1 + v2" : s.version },
    { label: "V2 readiness", value: `${s.v2Ready ? "Ready" : "Warming"} · ${s.v2ConsolidatedThreads}/${s.minConsolidatedThreads} sessions`, tone: s.v2Ready ? "ok" : "muted" },
    ...pipelineRows(s, now),
    { label: "Use memories", value: s.useMemories ? "On" : "Off", tone: s.useMemories ? "ok" : "muted" },
    { label: "Learn from sessions", value: s.generateMemories ? "On" : "Off", tone: s.generateMemories ? "ok" : "muted" },
    ...(s.sessionMode
      ? [
          {
            label: "This session",
            value: s.sessionMode === "enabled" ? (s.generateMemories ? "Eligible for learning" : "Eligible (learning paused)") : s.sessionMode === "disabled" ? "Not learning" : "Excluded (external context)",
            tone: (s.sessionMode === "enabled" && s.generateMemories ? "ok" : "muted") as Row["tone"],
          },
        ]
      : []),
    { label: "Last consolidated", value: s.lastSuccessAt == null ? "Never" : elapsed(s.lastSuccessAt, now) },
    ...(s.retryAt == null ? [] : [{ label: "Next retry", value: remaining(s.retryAt, now), tone: "warn" as const }]),
  ]
}

function usageRows(s: MemoryStatus, sessionID?: string): Row[] {
  const inj = s.injected
  const per = inj.sessionRequests > 0
    ? Math.round(inj.sessionTokens / inj.sessionRequests)
    : inj.totalRequests > 0
      ? Math.round(inj.totalTokens / inj.totalRequests)
      : 0
  return [
    { label: "Block size", value: per ? `~${formatTokens(per)} tokens / request` : "—" },
    ...(sessionID ? [{ label: "This session", value: `~${formatTokens(inj.sessionTokens)} tokens · ${inj.sessionRequests} req` }] : []),
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

/** /memory-inspect is a modal: navigation stays here until the host closes it. */
function MemoryDialog(context: TuiContext, sessionID?: string) {
  const rpc = context.client.rpc(MemoryStatusRpc)
  const { status, unavailable, refreshing, updatedAt, refresh, signal } = watchStatus(rpc, context, sessionID)
  const dimensions = useTerminalDimensions()
  const color = colors(context)
  const [tab, setTab] = createSignal<Tab>("Overview")
  const [cursor, setCursor] = createSignal(0)
  const [notice, setNotice] = createSignal<{ message: string; tone: "ok" | "warn" | "error" } | null>(null)
  const [busy, setBusy] = createSignal<string | null>(null)
  // Reset is irreversible: the first activation arms it, the second runs it.
  const [armed, setArmed] = createSignal(false)
  let scroll: ScrollBoxRenderable | undefined

  const call = async (id: string, method: "setOption" | "setSessionMode" | "consolidateNow" | "resetMemory", input: Record<string, unknown>, done: string) => {
    if (busy() || unavailable()) return
    setBusy(id)
    setNotice(null)
    try {
      const result = await rpc[method](input, {
        location: context.location ?? context.data.location.default(),
        signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
      })
      if (signal.aborted) return
      const reply = result as { ok?: boolean; status?: string; message?: string } | null
      if (method === "consolidateNow" ? reply?.status !== "started" : reply?.ok !== true) {
        throw new Error(reply?.message ?? "The server did not apply the request. Refresh and try again.")
      }
      setNotice({ message: done, tone: "ok" })
      await refresh()
    } catch (error) {
      if (signal.aborted) return
      setNotice({ message: `Failed: ${error instanceof Error ? error.message : String(error)}`, tone: "error" })
      // A timeout can happen after the server applied a change. Reconcile it.
      await refresh()
    } finally {
      if (!signal.aborted) setBusy(null)
    }
  }

  const controls = (): Control[] => {
    const s = status()
    if (!s) return []
    const list: Control[] = [
      {
        id: "read",
        title: "Use memories",
        hint: "Use the summary and memory lookup tools in conversations.",
        on: s.useMemories,
        enabled: true,
        run: () => void call("read", "setOption", { key: "use_memories", value: !s.useMemories }, s.useMemories ? "Memory recall turned off." : "Memory recall turned on."),
      },
      {
        id: "learn",
        title: "Learn from sessions",
        hint: "Learn from eligible idle conversations in the background.",
        on: s.generateMemories,
        enabled: true,
        run: () => void call("learn", "setOption", { key: "generate_memories", value: !s.generateMemories }, s.generateMemories ? "Learning paused." : "Learning resumed."),
      },
    ]
    if (sessionID) {
      const learning = s.sessionMode !== "disabled" && s.sessionMode !== "polluted"
      list.push({
        id: "session",
        title: "Learn from this session",
        hint: s.sessionMode === "polluted"
          ? "Auto-excluded after external context. Toggle to allow learning again."
          : !s.generateMemories
            ? "Global learning is paused; this session preference is saved."
            : "Allow future learning from this conversation. Saved across restarts.",
        on: learning,
        enabled: true,
        run: () => void call("session", "setSessionMode", { sessionID, mode: learning ? "disabled" : "enabled" }, learning ? "This session is excluded from future learning." : "This session is eligible when global learning is on."),
      })
    }
    const running = s.activity === "consolidating" || s.activity === "extracting"
      || s.pipelines.some((pipeline) => pipeline.extracting > 0 || pipeline.phase2Status === "running")
    list.push({
      id: "now",
      title: "Consolidate now",
      hint: running ? "Already running. Progress appears in Overview."
        : s.activity === "stopping" ? "The memory service is stopping."
          : s.generateMemories ? "Process eligible sessions now, bypassing the consolidation cooldown."
            : "Turn on Learn from sessions first.",
      enabled: s.generateMemories && !running && s.activity !== "stopping",
      run: () => void call("now", "consolidateNow", {}, "Background run requested. See Overview for progress."),
    })
    list.push({
      id: "reset",
      title: armed() ? "Reset memory — press again to confirm" : "Reset memory",
      hint: armed()
        ? "Erases all learned memories, notes, and history. This cannot be undone. Moving the selection cancels."
        : running ? "Wait for the running extraction or consolidation to finish."
          : "Erase all learned memories and notes for every project. Session preferences are kept.",
      enabled: !running,
      run: () => {
        if (!armed()) {
          setArmed(true)
          setNotice({ message: "Press Enter again to erase all memory.", tone: "warn" })
          return
        }
        setArmed(false)
        void call("reset", "resetMemory", { confirm: true }, "Memory reset complete.")
      },
    })
    return list
  }

  const activate = (i: number) => {
    if (busy() || unavailable()) return
    const c = controls()[i]
    if (!c) return
    const row = scroll?.content.findDescendantById(`memory-control-${c.id}`)
    if (row && scroll && (row.y < scroll.viewport.y || row.y >= scroll.viewport.y + scroll.viewport.height)) {
      // After paging or wheel scrolling, reveal the selection before acting.
      select(i)
      return
    }
    if (c.enabled) c.run()
    else setNotice({ message: c.hint, tone: "warn" })
  }
  const select = (i: number) => {
    if (i !== cursor()) setArmed(false)
    setCursor(i)
    const control = controls()[i]
    if (!control || !scroll) return
    const id = `memory-control-${control.id}`
    const row = scroll.content.findDescendantById(id)
    // OpenTUI's nearest-edge helper does not move an equal-height child, and
    // an oversized row must expose its title rather than only its description.
    if (row && row.height >= scroll.viewport.height) scroll.scrollBy(row.y - scroll.viewport.y)
    else scroll.scrollChildIntoView(id)
  }
  const move = (d: number) => {
    if (tab() === "Overview") {
      scroll?.scrollBy(d)
      return
    }
    const n = controls().length
    if (n === 0) return
    select((cursor() + d + n) % n)
  }
  const switchTab = (next: Tab) => {
    setArmed(false)
    setTab(next)
    setCursor(0)
    scroll?.scrollTo(0)
  }
  const changeTab = (d: number) => switchTab(TABS[(TABS.indexOf(tab()) + d + TABS.length) % TABS.length]!)
  const edge = (last: boolean) => {
    if (tab() === "Controls" && controls().length) select(last ? controls().length - 1 : 0)
    else scroll?.scrollTo(last ? scroll.scrollHeight : 0)
  }
  const click = (action: () => void) => (event: MouseEvent) => {
    if (event.button !== 0 || context.renderer.getSelection()?.getSelectedText()) return
    event.stopPropagation()
    action()
  }

  // The SDK defaults to "base"; the host pushes "modal" while a dialog is open.
  // Component ownership removes this layer on close, so keys never leak into the prompt.
  context.keymap.layer(() => ({
    mode: "modal",
    commands: [
      ...["left", "shift+tab"].map((bind) => ({ title: "Previous memory tab", bind, run: () => changeTab(-1) })),
      ...["right", "tab"].map((bind) => ({ title: "Next memory tab", bind, run: () => changeTab(1) })),
      { title: "Move up", bind: "up", run: () => move(-1) },
      { title: "Move down", bind: "down", run: () => move(1) },
      { title: "First item", bind: "home", run: () => edge(false) },
      { title: "Last item", bind: "end", run: () => edge(true) },
      { title: "Scroll up", bind: "pageup", run: () => { scroll?.scrollBy(-1, "viewport") } },
      { title: "Scroll down", bind: "pagedown", run: () => { scroll?.scrollBy(1, "viewport") } },
      { title: "Refresh memory status", bind: "r", run: () => { void refresh() } },
      ...["return", "space"].map((bind) => ({
        title: "Change selected control", bind,
        run: () => { if (tab() === "Controls") activate(cursor()) },
      })),
    ],
  }))

  const toneColor = (t: Row["tone"]) => (t === "ok" ? color.ok : t === "warn" ? color.warn : t === "muted" ? color.muted : color.text)

  const Rows = (props: { rows: Row[] }) => (
    <For each={props.rows}>
      {(r) => (
        <box flexDirection={dimensions().width < 60 ? "column" : "row"} flexShrink={0}>
          <text width={dimensions().width < 60 ? undefined : 21} flexShrink={0} fg={color.muted}>{r.label}</text>
          <text flexGrow={1} flexShrink={1} fg={toneColor(r.tone)} wrapMode="word">{r.value}</text>
        </box>
      )}
    </For>
  )
  // Spacing lives on <box>: marginTop on <text> overdraws the neighbours.
  const Section = (props: { title: string }) => (
    <box marginTop={1} flexShrink={0}>
      <text fg={color.muted}>
        <b>{props.title.toUpperCase()}</b>
      </text>
    </box>
  )
  const Note = (props: { fg: unknown; children: string }) => (
    <box marginTop={1} flexShrink={0}>
      <text fg={props.fg as any} wrapMode="word">{props.children}</text>
    </box>
  )

  return (
    <box
      flexDirection="column" paddingLeft={1} paddingRight={1} paddingBottom={1}
      height={Math.min(tab() === "Overview" ? 34 : sessionID ? 25 : 22, Math.max(8, dimensions().height - 2))}
    >
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <text fg={color.text}><b>Memory</b></text>
        <box flexDirection="row" gap={2}>
          <text fg={color.muted} onMouseUp={click(() => { void refresh() })}>{refreshing() ? "Refreshing…" : "r refresh"}</text>
          <text fg={color.muted} onMouseUp={click(() => context.ui.dialog.clear())}>Esc close</text>
        </box>
      </box>
      <box flexDirection="row" gap={2} marginTop={1} flexShrink={0}>
        <For each={TABS}>
          {(t) => (
            <box
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={tab() === t ? color.selectedBg : undefined}
              onMouseUp={click(() => switchTab(t))}
            >
              <text fg={tab() === t ? color.selectedText : color.muted}>
                {tab() === t ? <b>{t}</b> : t}
              </text>
            </box>
          )}
        </For>
      </box>

      {unavailable() ? (
        <box marginTop={1} flexShrink={0}>
          <text fg={color.error} wrapMode="word">
            {status() ? "Offline: last known status. Press r to retry." : "Memory status unavailable. Press r to retry."}
          </text>
        </box>
      ) : <box />}

      {/* No <Show>: its empty placeholder is a bare text node under <box>. */}
      <scrollbox
        ref={(value) => { scroll = value }} flexGrow={1} flexShrink={1} minHeight={0} scrollX={false}
        onSizeChange={() => queueMicrotask(() => {
          // Wait for resized row geometry before restoring keyboard focus.
          if (!signal.aborted && tab() === "Controls") select(cursor())
        })}
      >
        {status() === null ? (
          <Note fg={color.muted}>{refreshing() ? "Loading memory status…" : "No status received."}</Note>
        ) : tab() === "Overview" ? (
          <box flexDirection="column">
            {notice()?.tone === "error" ? <Note fg={color.error}>{notice()!.message}</Note> : <box />}
            <Section title="Status" />
            <Rows rows={statusRows(status()!, updatedAt())} />
            {status()!.warnings.length > 0 ? (
              <box flexDirection="column" flexShrink={0}>
                <Section title="Attention" />
                <For each={status()!.warnings}>{(w) => <text fg={color.warn} wrapMode="word">{`! ${w}`}</text>}</For>
              </box>
            ) : <box />}
            <Section title="Context usage" />
            <Rows rows={usageRows(status()!, sessionID)} />
            <Section title="Setup" />
            <Rows rows={configRows(status()!)} />
            <Note fg={color.muted}>Memory is global across projects. Token figures are chars/4 estimates; prompt-cache savings depend on the provider.</Note>
          </box>
        ) : (
          <box flexDirection="column" marginTop={1}>
            <For each={controls()}>
              {(c, i) => {
                const selected = () => cursor() === i()
                const disabled = () => !c.enabled || unavailable() || busy() !== null
                const fg = () => selected() ? color.selectedText : disabled() ? color.muted : color.text
                const state = () => busy() === c.id ? (c.id === "now" ? "Starting…" : c.id === "reset" ? "Resetting…" : "Saving…")
                  : c.id === "reset" && armed() ? "Confirm"
                  : c.on === undefined ? (c.enabled ? "Run" : "Unavailable") : c.on ? "On" : "Off"
                return (
                  <box
                    id={`memory-control-${c.id}`}
                    flexDirection="column"
                    flexShrink={0}
                    paddingLeft={1}
                    paddingRight={1}
                    backgroundColor={selected() ? color.selectedBg : undefined}
                    onMouseUp={click(() => {
                      select(i())
                      activate(i())
                    })}
                  >
                    <box flexDirection="row" gap={1}>
                      <text fg={fg()} flexShrink={0}>{selected() ? "›" : " "}</text>
                      <text fg={fg()} flexGrow={1} flexShrink={1} wrapMode="word">
                        {selected() ? <b>{c.title}</b> : c.title}
                      </text>
                      <text fg={selected() ? color.selectedText : c.on && !disabled() ? color.ok : color.muted} flexShrink={0}>{state()}</text>
                    </box>
                    <box paddingLeft={2}>
                      <text fg={selected() ? color.selectedText : color.muted} wrapMode="word">{c.hint}</text>
                    </box>
                  </box>
                )
              }}
            </For>
            <Note fg={color.muted}>The first two toggles affect all projects until the server restarts. Set plugin options in opencode.json(c) to keep them.</Note>
          </box>
        )}
      </scrollbox>

      {!unavailable() && (busy() || notice()) ? (
        <box marginTop={1} flexShrink={0}>
          <text fg={busy() ? color.muted : notice()?.tone === "error" ? color.error : notice()?.tone === "warn" ? color.warn : color.ok} wrapMode="word">
            {busy() ? "Applying change…" : notice()?.tone === "error"
              ? tab() === "Overview" ? "Change failed. Details above." : "Change failed. See Overview for details."
              : notice()!.message}
          </text>
        </box>
      ) : <box />}
      <box flexDirection="column" marginTop={1} flexShrink={0}>
        <text fg={color.muted}>←→/Tab tabs · ↑↓ {tab() === "Controls" ? "select" : "scroll"}</text>
        <text fg={color.muted}>{tab() === "Controls" ? "Enter/Space change" : "PgUp/PgDn page · Home/End ends"}</text>
      </box>
    </box>
  )
}

function StatusPanel(context: TuiContext, sessionID?: string) {
  const rpc = context.client.rpc(MemoryStatusRpc)
  const { status, unavailable } = watchStatus(rpc, context, sessionID)
  const palette = colors(context)

  // Distinguish recall and learning: either can be enabled without the other.
  const title = () => {
    if (unavailable()) return "Unavailable"
    const s = status()
    if (!s) return "Loading…"
    return `Recall ${s.useMemories ? "on" : "off"} · learn ${s.generateMemories ? "on" : "off"}`
  }
  const color = () => {
    if (unavailable()) return palette.error
    if (status()?.useMemories || status()?.generateMemories) return palette.ok
    return palette.muted
  }

  // Status only; details live in /memory-inspect. No <Show>: its empty
  // placeholder is a bare text node under <box>, which the renderer rejects.
  return (
    <box flexDirection="column">
      <text fg={palette.text}>Memory</text>
      <text fg={color()}>● {title()}</text>
      <text fg={palette.muted}>{"  /memory-inspect"}</text>
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
        title: "Inspect memory",
        description: "Memory status and controls",
        group: "Memory",
        palette: true,
        slash: { name: "memory-inspect" },
        run: () => {
          const route = context.ui.router.current()
          const sessionID = route.type === "session" ? route.sessionID : undefined
          context.ui.dialog.show(() => MemoryDialog(context, sessionID))
          context.ui.dialog.set({ size: "large", centered: true })
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
