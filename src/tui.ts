/**
 * Dual-host `./tui` entry.
 *
 * OpenCode 1.18.29+ (and 1.18.30) resolves `exports["./tui"]` and requires
 * `default.tui()` — `readV1Plugin(..., "tui")` in strict mode. The Memory
 * sidebar is OpenCode 2-only (`src/v2/tui.tsx`) and must not load until a
 * V2 host calls setup(): the V2 TUI SDK is an optional peer and is missing
 * on 1.x, so a static import there is "failed to load plugin".
 */
const PLUGIN_ID = "opencode-codex-memory.tui"

type PluginSetup = (() => void | Promise<void>) | void

async function setup(ctx: unknown): Promise<PluginSetup> {
  const { default: plugin } = await import("./v2/tui.js")
  const fn = (plugin as { setup?: (context: unknown) => Promise<PluginSetup> | PluginSetup }).setup
  if (typeof fn !== "function") return
  return fn(ctx)
}

/** OpenCode 1.x TUI host: keep the package loadable. No sidebar on 1.x. */
async function tui(): Promise<void> {}

export default {
  id: PLUGIN_ID,
  setup,
  tui,
}
