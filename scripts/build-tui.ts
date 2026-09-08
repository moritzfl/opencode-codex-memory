import solid from "@opentui/solid/bun-plugin"

const result = await Bun.build({
  entrypoints: ["./src/v2/tui.tsx"],
  outdir: "./dist/src/v2",
  target: "bun",
  format: "esm",
  packages: "external",
  plugins: [solid],
})
if (!result.success) throw new AggregateError(result.logs, "TUI build failed")
// tsc emits preserved JSX for declarations; only the Solid-compiled JS ships.
await Bun.file("./dist/src/v2/tui.jsx").delete()
