/**
 * opencode2 entry point (re-exported through the package main for
 * single-entry dual-host support: V1 reads server(), V2 reads id+setup()).
 */
import { Plugin } from "@opencode/plugin"
import { setup } from "./plugin.js"

export default Plugin.define({
  id: "opencode-codex-memory",
  setup,
})
