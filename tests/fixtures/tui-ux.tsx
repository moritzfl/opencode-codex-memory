import assert from "node:assert/strict"
import { createSignal, getOwner, onCleanup } from "solid-js"
import { testRender, useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import type { KeyEvent } from "@opentui/core"
import type { KeymapLayer } from "@opencode/plugin/tui/context"
import tui from "../../src/v2/tui.js"
import type { MemoryStatus } from "../../src/v2/status-rpc.js"

const FULL_STATUS: MemoryStatus = {
  activity: "idle", version: "v1", sessionVersion: "v1", dualWrite: true,
  v2ConsolidatedThreads: 12, v2Ready: false, minConsolidatedThreads: 20,
  pipelines: [{ version: "v1", stage1Count: 12, extracting: 0, phase2Status: null, lastError: null }],
  useMemories: true, generateMemories: true, extractModel: "host/extract", consolidationModel: "host/consolidate",
  codexImport: false, lastSuccessAt: null, retryAt: null,
  warnings: ["Consolidation lease held by another process until 01:21."],
  sessionMode: "enabled", memoryRoot: "/memory/workspace",
  injected: { sessionTokens: 4200, sessionRequests: 1, totalTokens: 8400, totalRequests: 2 },
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function fixture(options: { session?: boolean; width?: number; height?: number; legacyTheme?: boolean; sidebar?: boolean } = {}) {
  const claims = new Map<string, any>()
  const layers = new Set<() => KeymapLayer>()
  const listeners = new Set<() => void>()
  const calls: Array<[string, any]> = []
  const [dialog, setDialog] = createSignal<(() => JSX.Element) | null>(null)
  const [theme, setTheme] = createSignal(options.legacyTheme ? legacyTheme() : currentTheme())
  let status = structuredClone(FULL_STATUS)
  if (options.session === false) status.sessionMode = null
  let getStatus = async (): Promise<unknown> => structuredClone(status)
  let mutate = async (method: string, input: any): Promise<unknown> => {
    if (method === "setOption") {
      if (input.key === "use_memories") status.useMemories = input.value
      else status.generateMemories = input.value
    }
    if (method === "setSessionMode") status.sessionMode = input.mode
    return method === "consolidateNow" ? { status: "started" } : method === "resetMemory" ? { ok: true, message: "done" } : { ok: true }
  }
  const requests: AbortSignal[] = []
  const rpc = {
    status: async (_input: unknown, request: { signal: AbortSignal }) => {
      requests.push(request.signal)
      return getStatus()
    },
    ...Object.fromEntries(["setOption", "setSessionMode", "consolidateNow", "resetMemory"].map((method) => [method, async (input: any) => {
      calls.push([method, input])
      return mutate(method, input)
    }])),
    events: { on: (_event: string, listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    } },
  }
  const ctx: any = {
    location: { directory: "/project" },
    data: { location: { default: () => ({ directory: "/project" }) } },
    client: { rpc: () => rpc },
    get theme() { return theme() },
    keymap: { layer: (layer: () => KeymapLayer) => {
      assert.ok(getOwner(), "keymaps must have a Solid owner")
      layers.add(layer)
      onCleanup(() => { layers.delete(layer) })
    } },
    ui: {
      slot: (claim: any) => { claims.set(claim.append, claim); return () => { claims.delete(claim.append) } },
      dialog: { show: (render: () => JSX.Element) => setDialog(() => render), clear: () => setDialog(null), set: () => {} },
      router: { current: () => options.session === false ? { type: "home" } : { type: "session", sessionID: "ses_x" } },
    },
  }
  const cleanup = await tui.setup(ctx)
  assert.equal(layers.size, 0, "setup must only claim slots")
  assert.deepEqual([...claims.keys()].sort(), ["app", "sidebar.content"])
  const enabled = (value: boolean | (() => boolean) | undefined) => typeof value === "function" ? value() : value !== false
  const rendered = await testRender(() => {
    ctx.renderer = useRenderer()
    const dimensions = useTerminalDimensions()
    // Dispatch real OpenTUI key events, enforcing the host's base/modal rule.
    const keypress = (event: KeyEvent) => {
      const bind = `${event.shift ? "shift+" : ""}${event.name}`
      if (dialog() && bind === "escape") { setDialog(null); return }
      for (const getLayer of [...layers].reverse()) {
        const layer = getLayer()
        const mode = layer.mode ?? "base"
        if (mode !== "global" && mode !== (dialog() ? "modal" : "base")) continue
        if (!enabled(layer.enabled)) continue
        const command = layer.commands?.find((command) => command.bind === bind && enabled(command.enabled))
        if (command && command.run(undefined, event) !== false) return
      }
    }
    ctx.renderer.keyInput.on("keypress", keypress)
    onCleanup(() => ctx.renderer.keyInput.off("keypress", keypress))
    claims.get("app").render({})
    return <box>
      {dialog() ? <box width={Math.min(88, dimensions().width - 2)}>{dialog()!()}</box>
        : options.sidebar ? claims.get("sidebar.content").render({ sessionID: "ses_x" }) : <text>Prompt ready</text>}
    </box>
  }, { width: options.width ?? 100, height: options.height ?? 40, kittyKeyboard: true })
  const frame = async () => {
    await rendered.flush()
    return rendered.captureCharFrame()
  }
  const open = async () => {
    const command = [...layers].flatMap((layer) => layer().commands ?? []).find((c) => c.slash?.name === "memory-inspect")!
    assert.deepEqual(command.slash, { name: "memory-inspect" })
    command.run()
    await frame()
  }
  const press = async (key: string, shift = false) => {
    rendered.mockInput.pressKey(key, { shift })
    return frame()
  }
  return {
    ...rendered, ctx, claims, layers, listeners, calls, requests, frame, open, press,
    status: () => status,
    setStatus: (patch: Partial<MemoryStatus>) => { status = { ...status, ...patch } },
    failStatus: (get: typeof getStatus) => { getStatus = get },
    restoreStatus: () => { getStatus = async () => structuredClone(status) },
    mutate: (fn: typeof mutate) => { mutate = fn },
    changed: async () => { for (const listener of listeners) listener(); await frame() },
    setTheme,
    async close() { rendered.renderer.destroy(); await cleanup?.() },
  }
}

function currentTheme() {
  return {
    text: { base: "#eeeeee", muted: "#888888", action: { primary: { base: "#111111", focused: "#111111" } },
      feedback: { error: { base: "#ff0000" }, warning: { base: "#ffff00" }, success: { base: "#00ff00" } } },
    background: { action: { primary: { focused: "#ffb380" } } },
  }
}
function legacyTheme(): any {
  return {
    text: { default: "#eeeeee", subdued: "#888888", action: { primary: { default: "#111111", focused: "#111111" } },
      feedback: { error: { default: "#ff0000" }, warning: { default: "#ffff00" }, success: { default: "#00ff00" } } },
    background: { action: { primary: { focused: "#ffb380" } } },
  }
}

async function check(name: string, run: () => Promise<void>) {
  await run()
  console.log(`ok: ${name}`)
}

await check("keyboard-only tabs, controls, session mode, wrap and cleanup", async () => {
  const f = await fixture()
  try {
    await f.open()
    assert.match(await f.frame(), /STATUS/)
    await f.press("RETURN")
    assert.equal(f.calls.length, 0, "Enter in Overview must not mutate")
    assert.match(await f.press("TAB"), /› Use memories/)
    await f.press("RETURN")
    assert.deepEqual(f.calls[0], ["setOption", { key: "use_memories", value: false }])
    assert.match(await f.frame(), /Use memories\s+Off/)
    await f.press("ARROW_DOWN")
    await f.press("ARROW_DOWN")
    await f.press(" ")
    assert.deepEqual(f.calls[1], ["setSessionMode", { sessionID: "ses_x", mode: "disabled" }])
    await f.press("END")
    await f.press("ARROW_UP")
    await f.press("RETURN")
    assert.deepEqual(f.calls[2], ["consolidateNow", {}])
    assert.match(await f.press("ARROW_DOWN"), /› Reset memory/)
    assert.match(await f.press("ARROW_DOWN"), /› Use memories/)
    assert.match(await f.press("ARROW_UP"), /› Reset memory/)
    assert.match(await f.press("HOME"), /› Use memories/)
    assert.match(await f.press("TAB", true), /STATUS/)
    assert.match(await f.press("ARROW_RIGHT"), /› Use memories/)
    assert.match(await f.press("ARROW_LEFT"), /STATUS/)
    await f.press("ESCAPE")
    assert.match(await f.frame(), /Prompt ready/)
    assert.equal(f.layers.size, 1)
    assert.equal(f.listeners.size, 0)
    assert.ok(f.requests.every((signal) => signal.aborted))
    await f.press("RETURN")
    assert.equal(f.calls.length, 3)
  } finally { await f.close() }
})

await check("busy state, duplicate prevention, server rejection and error color", async () => {
  const f = await fixture()
  try {
    await f.open()
    await f.press("TAB")
    const pending = deferred<unknown>()
    f.mutate(() => pending.promise)
    assert.match(await f.press("RETURN"), /Saving…/)
    await f.press("RETURN")
    await f.press(" ")
    assert.equal(f.calls.length, 1)
    pending.resolve({ ok: false })
    assert.match(await f.frame(), /Change failed/)
    assert.match(await f.frame(), /Use memories\s+On/)
    assert.doesNotMatch(await f.frame(), /turned off/)
    const spans = f.captureSpans().lines.flatMap((line) => line.spans)
    assert.ok(spans.some((span) => span.text.includes("Change failed") && span.fg.r > 0.9 && span.fg.g < 0.1))
    assert.match(await f.press("ARROW_LEFT"), /Failed: The server did not apply/)
  } finally { await f.close() }
})

await check("loading opens immediately, outage retains status, retry recovers, late replies ignored", async () => {
  const f = await fixture()
  try {
    const initial = deferred<unknown>()
    f.failStatus(() => initial.promise)
    await f.open()
    assert.match(await f.frame(), /Loading memory status/)
    initial.resolve(FULL_STATUS)
    assert.match(await f.frame(), /STATUS/)
    f.failStatus(async () => { throw new Error("offline") })
    await f.press("r")
    assert.match(await f.frame(), /last known status/)
    await f.press("TAB")
    await f.press("RETURN")
    assert.equal(f.calls.length, 0)
    const older = deferred<unknown>()
    f.failStatus(() => older.promise)
    await f.press("r")
    f.restoreStatus()
    f.setStatus({ useMemories: false })
    await f.press("r")
    older.resolve(FULL_STATUS)
    assert.match(await f.frame(), /Use memories\s+Off/)
    assert.doesNotMatch(await f.frame(), /Offline:/)
    await f.press("RETURN")
    assert.equal(f.calls.length, 1)
  } finally { await f.close() }
})

await check("unavailable status remains keyboard navigable and recovers", async () => {
  const f = await fixture()
  try {
    f.failStatus(async () => { throw new Error("offline") })
    await f.open()
    assert.match(await f.frame(), /Memory status unavailable/)
    await f.press("TAB")
    await f.press("RETURN")
    assert.equal(f.calls.length, 0)
    f.restoreStatus()
    assert.match(await f.press("r"), /› Use memories/)
  } finally { await f.close() }
})

await check("closing during loading aborts requests and ignores their late replies", async () => {
  const f = await fixture()
  try {
    const pending = deferred<unknown>()
    f.failStatus(() => pending.promise)
    await f.open()
    assert.match(await f.press("ESCAPE"), /Prompt ready/)
    assert.ok(f.requests.every((signal) => signal.aborted))
    assert.equal(f.listeners.size, 0)
    pending.resolve(FULL_STATUS)
    assert.match(await f.frame(), /Prompt ready/)
    assert.equal(f.layers.size, 1)
  } finally { await f.close() }
})

await check("home scope, paused learning and disabled actions", async () => {
  const f = await fixture({ session: false })
  try {
    f.setStatus({ generateMemories: false })
    await f.open()
    assert.doesNotMatch(await f.frame(), /This session/)
    await f.press("TAB")
    assert.doesNotMatch(await f.frame(), /Learn from this session/)
    await f.press("END")
    await f.press("ARROW_UP")
    assert.match(await f.press("RETURN"), /Turn on Learn from sessions first/)
    assert.equal(f.calls.length, 0)
    f.setStatus({ generateMemories: true, activity: "extracting" })
    await f.changed()
    assert.match(await f.press("RETURN"), /Already running/)
    assert.equal(f.calls.length, 0)
  } finally { await f.close() }
})

await check("successful consolidation with late recaps and unrelated extraction retries", async () => {
  const f = await fixture({ session: false })
  try {
    const now = Date.now()
    f.setStatus({
      activity: "retrying", dualWrite: false, lastSuccessAt: now - 7 * 60_000, retryAt: now + 32 * 60_000,
      pipelines: [{
        version: "v1", stage1Count: 140, extracting: 0, phase2Status: "pending", lastError: null,
        phase2CooldownUntil: now + 353 * 60_000, phase1RetryAt: now + 32 * 60_000, phase2RetryAt: null,
      }],
      warnings: ["v1: Extraction retry (2 jobs): Model unavailable: xai/grok-4.7"],
    })
    await f.open()
    const frame = await f.frame()
    assert.match(frame, /V1 recaps\s+140 stored/)
    assert.match(frame, /V1 extraction\s+Retry in 32m/)
    assert.match(frame, /V1 consolidation\s+Queued · cooldown ends in 5h 53m/)
    assert.match(frame, /Last consolidated\s+7m ago/)
    assert.match(frame, /Extraction retry \(2 jobs\)/)
    assert.match(frame, /Model unavailable: xai\/grok-4.7/)
    assert.equal(f.calls.length, 0, "viewing status must not start another run")
  } finally { await f.close() }
})

await check("reset needs a second confirmation and moving away disarms it", async () => {
  const f = await fixture()
  try {
    await f.open()
    await f.press("TAB")
    await f.press("END")
    assert.match(await f.press("RETURN"), /Press Enter again to erase all memory/)
    assert.equal(f.calls.length, 0)
    await f.press("ARROW_UP")
    assert.doesNotMatch(await f.press("ARROW_DOWN"), /press again to confirm/)
    await f.press("RETURN")
    assert.equal(f.calls.length, 0)
    await f.press("RETURN")
    assert.deepEqual(f.calls[0], ["resetMemory", { confirm: true }])
    assert.match(await f.frame(), /Memory reset complete/)
    f.mutate(async () => ({ ok: false, message: "Reset refused: memory consolidation is currently running." }))
    await f.press("RETURN")
    await f.press("RETURN")
    assert.match(await f.press("ARROW_LEFT"), /Reset refused: memory consolidation/)
  } finally { await f.close() }
})

await check("sidebar reports recall and learning independently and refreshes", async () => {
  const f = await fixture({ sidebar: true })
  try {
    assert.match(await f.frame(), /Recall on · learn on/)
    assert.match(await f.frame(), /\/memory-inspect/)
    f.setStatus({ useMemories: false })
    await f.changed()
    assert.match(await f.frame(), /Recall off · learn on/)
    f.setStatus({ generateMemories: false })
    await f.changed()
    assert.match(await f.frame(), /Recall off · learn off/)
    f.failStatus(async () => { throw new Error("offline") })
    await f.changed()
    assert.match(await f.frame(), /Unavailable/)
  } finally { await f.close() }
  assert.equal(f.listeners.size, 0)
})

await check("long action failures stay scrollable without hiding navigation", async () => {
  const f = await fixture({ width: 40, height: 16 })
  try {
    await f.open()
    await f.press("TAB")
    f.mutate(async () => { throw new Error("Detailed server failure. ".repeat(30) + "END OF ERROR") })
    await f.press("RETURN")
    assert.match(await f.frame(), /Change failed/)
    assert.match(await f.frame(), /Enter\/Space change/)
    assert.match(await f.frame(), /r refresh\s+Esc close/)
    assert.match(await f.press("ARROW_LEFT"), /Detailed server failure/)
    const top = await f.frame()
    assert.notEqual(await f.press("\u001b[6~"), top)
    assert.equal(await f.press("\u001b[5~"), top)
    let found = false
    for (let i = 0; i < 80; i++) {
      if (/END OF\s+ERROR/.test(await f.press("ARROW_DOWN"))) { found = true; break }
    }
    assert.ok(found, `full failure details must remain keyboard accessible\n${await f.frame()}`)
  } finally { await f.close() }
})

await check("paging away from a control cannot silently activate a hidden selection", async () => {
  const f = await fixture({ width: 40, height: 16 })
  try {
    await f.open()
    await f.press("TAB")
    await f.press("\u001b[6~")
    await f.press("\u001b[6~")
    assert.doesNotMatch(await f.frame(), /› Use memories/)
    assert.match(await f.press("RETURN"), /› Use memories/)
    assert.equal(f.calls.length, 0)
    await f.press("RETURN")
    assert.equal(f.calls.length, 1)
  } finally { await f.close() }
})

await check("selected control stays visible through feedback, refresh and resize", async () => {
  const f = await fixture({ width: 60, height: 20 })
  try {
    await f.open()
    await f.press("TAB")
    await f.press("END")
    await f.press("ARROW_UP")
    await f.press("RETURN")
    assert.match(await f.frame(), /› Consolidate now/)
    f.setStatus({ activity: "extracting" })
    await f.changed()
    assert.match(await f.frame(), /› Consolidate now/)
    f.resize(40, 16)
    assert.match(await f.frame(), /› Consolidate now/)
  } finally { await f.close() }
})

for (const [width, height] of [[80, 24], [60, 20], [40, 16]]) {
  await check(`scrolling and pinned navigation at ${width}x${height}`, async () => {
    const f = await fixture({ width, height })
    try {
      f.setStatus({ warnings: Array.from({ length: 12 }, (_, i) => `Warning ${i}: a long diagnostic that must wrap and remain accessible.`) })
      await f.open()
      assert.match(await f.frame(), /Overview/)
      assert.match(await f.frame(), /r refresh\s+Esc close/)
      assert.match(await f.press("END"), /prompt-cache savings/)
      assert.match(await f.press("HOME"), /Activity/)
      assert.match(await f.press("TAB"), /› Use memories/)
      assert.match(await f.press("END"), /› Reset memory/)
      assert.match(await f.frame(), /r refresh\s+Esc close/)
      assert.match(await f.press("HOME"), /› Use memories/)
      await f.press("RETURN")
      assert.match(await f.frame(), /Memory recall turned off/)
      assert.match(await f.press("END"), /› Reset memory/)
      assert.match(await f.frame(), /Enter\/Space change/)
      assert.match(await f.frame(), /r refresh\s+Esc close/)
      f.resize(100, 40)
      assert.match(await f.frame(), /Learn from this session/)
    } finally { await f.close() }
  })
}

for (const legacyTheme of [false, true]) {
  await check(`selection contrast and mouse/keyboard parity (${legacyTheme ? "old" : "current"} tokens)`, async () => {
    const f = await fixture({ legacyTheme })
    try {
      await f.open()
      const lines = (await f.frame()).split("\n")
      const y = lines.findIndex((line) => line.includes("Controls"))
      const x = lines[y]!.indexOf("Controls")
      await f.mockMouse.click(x, y)
      assert.match(await f.frame(), /› Use memories/)
      const spans = f.captureSpans().lines.flatMap((line) => line.spans)
      const selected = spans.find((span) => span.text.includes("Use memories"))!
      assert.ok(selected.fg.r < 0.1 && selected.bg.r > 0.9, "selected foreground must contrast with its background")
      const light = currentTheme()
      light.text.action.primary.focused = "#ffffff"
      light.background.action.primary.focused = "#111111"
      f.setTheme(light)
      await f.frame()
      const recolored = f.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("Use memories"))!
      assert.ok(recolored.fg.r > 0.9 && recolored.bg.r < 0.1, "theme changes must update the mounted dialog")
      const rows = (await f.frame()).split("\n")
      const row = rows.findIndex((line) => line.includes("Learn from sessions"))
      const col = rows[row]!.indexOf("Learn from sessions")
      await f.mockMouse.click(col, row, 2)
      assert.equal(f.calls.length, 0, "right-click must not change settings")
      await f.mockMouse.click(col, row)
      assert.match(await f.frame(), /› Learn from sessions\s+Off/)
      await f.press("ARROW_UP")
      assert.match(await f.frame(), /› Use memories/)
    } finally { await f.close() }
  })
}

console.log("TUI UX checks passed")
