import { describe, expect, it } from "bun:test"
import {
  catalogVariantKeys,
  enabledVariantKeys,
  nearestReasoningVariant,
} from "../src/reasoning-variant.js"

describe("nearestReasoningVariant", () => {
  it("keeps an exact match", () => {
    expect(nearestReasoningVariant("low", ["low", "medium", "high"])).toBe("low")
    expect(nearestReasoningVariant("medium", ["low", "medium", "high"])).toBe("medium")
  })

  it("picks the closest listed effort", () => {
    expect(nearestReasoningVariant("low", ["high", "max"])).toBe("high")
    expect(nearestReasoningVariant("medium", ["high", "max"])).toBe("high")
    expect(nearestReasoningVariant("medium", ["none", "high"])).toBe("high")
    expect(nearestReasoningVariant("low", ["none", "minimal"])).toBe("minimal")
  })

  it("breaks distance ties toward higher effort", () => {
    expect(nearestReasoningVariant("medium", ["low", "high", "max"])).toBe("high")
    expect(nearestReasoningVariant("low", ["none", "high"])).toBe("high")
  })

  it("ignores non-ladder names such as custom picker variants", () => {
    expect(nearestReasoningVariant("low", ["fast xhigh", "thinking"])).toBeUndefined()
    expect(nearestReasoningVariant("medium", ["fast xhigh", "high"])).toBe("high")
  })

  it("returns undefined when nothing is listed", () => {
    expect(nearestReasoningVariant("low", [])).toBeUndefined()
  })
})

describe("enabledVariantKeys", () => {
  it("drops disabled variants", () => {
    expect(enabledVariantKeys({ low: { disabled: true }, high: { reasoningEffort: "high" } })).toEqual(["high"])
  })
})

describe("catalogVariantKeys", () => {
  const catalog = {
    all: [
      {
        id: "xai",
        models: {
          "grok-4.6": { variants: { low: {}, medium: {}, high: {}, xhigh: {}, "fast xhigh": {} } },
        },
      },
      {
        id: "ollama-cloud",
        models: {
          "deepseek-v4-flash": { variants: { high: {}, max: {} } },
          "empty-efforts": { variants: {} },
          "stripped": { name: "no variants field" },
        },
      },
    ],
  }

  it("reads variant keys for a known model", () => {
    expect(catalogVariantKeys(catalog, "xai", "grok-4.6")).toEqual(["low", "medium", "high", "xhigh", "fast xhigh"])
    expect(catalogVariantKeys(catalog, "ollama-cloud", "deepseek-v4-flash")).toEqual(["high", "max"])
  })

  it("treats an empty variants object as known-empty", () => {
    expect(catalogVariantKeys(catalog, "ollama-cloud", "empty-efforts")).toEqual([])
  })

  it("returns undefined when the catalog cannot answer", () => {
    expect(catalogVariantKeys(catalog, "ollama-cloud", "stripped")).toBeUndefined()
    expect(catalogVariantKeys(catalog, "missing", "nope")).toBeUndefined()
    expect(catalogVariantKeys(null, "xai", "grok-4.6")).toBeUndefined()
  })
})
