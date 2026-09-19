import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  liveModelId,
  liveProviderConfig,
  requireAuth,
  requireModels,
  resolveLiveEnv,
  type LiveEnv,
} from "../scripts/lib/harness.js"

const LIVE_KEYS = [
  "OPENCODE_LIVE_API_KEY",
  "OPENCODE_LIVE_BASE_URL",
  "OPENCODE_LIVE_MODEL",
  "OPENCODE_LIVE_SMALL_MODEL",
] as const

const prev: Record<string, string | undefined> = {}

function clearLiveEnv(): void {
  for (const key of LIVE_KEYS) delete process.env[key]
}

describe("live env auth", () => {
  beforeEach(() => {
    for (const key of LIVE_KEYS) prev[key] = process.env[key]
    clearLiveEnv()
  })
  afterEach(() => {
    clearLiveEnv()
    for (const key of LIVE_KEYS) {
      if (prev[key] === undefined) delete process.env[key]
      else process.env[key] = prev[key]
    }
  })

  it("strips a provider prefix from OPENCODE_LIVE_MODEL", () => {
    expect(liveModelId("deepseek-v4-flash")).toBe("deepseek-v4-flash")
    expect(liveModelId("ollama-cloud/deepseek-v4-flash")).toBe("deepseek-v4-flash")
  })

  it("builds an OpenAI-compatible live provider without embedding the API key", () => {
    const live: LiveEnv = {
      apiKey: "sk-secret",
      baseUrl: "https://ollama.com/v1",
      model: "live/deepseek-v4-flash",
      smallModel: "live/deepseek-v4-flash",
      modelId: "deepseek-v4-flash",
      smallModelId: "deepseek-v4-flash",
    }
    const json = JSON.stringify(liveProviderConfig(live))
    expect(json).not.toContain("sk-secret")
    expect(json).toContain("https://ollama.com/v1")
    expect(json).toContain("@opencode/ai/providers/openai-compatible")
    expect(json).toContain("{env:OPENCODE_LIVE_API_KEY}")
    expect(json).toContain("deepseek-v4-flash")
  })

  it("resolveLiveEnv maps env to live/<model>", () => {
    process.env.OPENCODE_LIVE_API_KEY = "sk-test"
    process.env.OPENCODE_LIVE_BASE_URL = "http://127.0.0.1:14621/v1/"
    process.env.OPENCODE_LIVE_MODEL = "ollama-cloud/deepseek-v4-flash"
    const live = resolveLiveEnv()
    expect(live?.baseUrl).toBe("http://127.0.0.1:14621/v1")
    expect(live?.model).toBe("live/deepseek-v4-flash")
    expect(live?.smallModel).toBe("live/deepseek-v4-flash")
    expect(requireModels()).toEqual({
      model: "live/deepseek-v4-flash",
      smallModel: "live/deepseek-v4-flash",
    })
    expect(requireAuth().modelId).toBe("deepseek-v4-flash")
  })

  it("requireAuth fails closed when env is missing", () => {
    expect(() => requireAuth()).toThrow(/OPENCODE_LIVE_API_KEY/)
    expect(resolveLiveEnv()).toBeNull()
  })
})
