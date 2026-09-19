/**
 * Live read-path check against the official opencode release.
 *
 * XDG-sandboxed: never touches the real opencode home.
 * Needs: opencode in PATH and `.env` live credentials (API key +
 * OpenAI-compatible base URL + model). Never reads the host OpenCode DB.
 *
 *   bun run live:read
 *   OPENCODE_LIVE_KEEP=1 bun run live:read   # leave sandbox on disk
 */
import {
  MARKER,
  MARKER_LINE,
  createSandbox,
  fail,
  log,
  opencodeVersion,
  requireAuth,
  requireModels,
  runOpencode,
  semverGte,
  writeSummary,
  whichOpencode,
} from "./lib/harness.js"

async function main() {
  const models = requireModels()
  const sandbox = createSandbox({
    keep: process.argv.includes("--keep"),
    model: models.model,
    smallModel: models.smallModel,
  })
  try {
    requireAuth()
    writeSummary(sandbox, MARKER_LINE)
    const bin = whichOpencode()
    const version = opencodeVersion(bin)
    log("read", `bin ${bin} @ ${version}`)
    log("read", `sandbox ${sandbox.root}`)
    log("read", `plugin ${sandbox.pluginFileUrl}`)
    log("read", `model ${models.model}`)

    const out = runOpencode(
      sandbox,
      [
        "run",
        ...(semverGte(version, "2.0.0") ? ["--standalone"] : []),
        "--format",
        "json",
        `What do you remember from memory? If you see ${MARKER}, repeat that whole marker line exactly.`,
      ],
      { timeoutMs: 180_000 },
    )

    const combined = `${out.stdout}\n${out.stderr}`
    if (out.code !== 0 && !combined.includes(MARKER)) {
      fail("read", `opencode run exited ${out.code}\nstdout: ${out.stdout.slice(0, 1500)}\nstderr: ${out.stderr.slice(0, 1500)}`)
    }
    if (!combined.includes(MARKER)) {
      fail(
        "read",
        `marker not found in model output (injection missing or model ignored it)\nstdout: ${out.stdout.slice(0, 2000)}`,
      )
    }
    log("read", "OK — memory_summary injected and visible to the model")
    process.exit(0)
  } finally {
    sandbox.cleanup()
  }
}

main().catch((e) => {
  console.error("live:read error:", e)
  process.exit(2)
})
