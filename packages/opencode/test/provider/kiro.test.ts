import { test, expect, describe } from "bun:test"

import { ProviderV2 } from "@opencode-ai/core/provider"
import * as ProviderTransform from "../../src/provider/transform"

// 1. Schema registration
test("ProviderID.kiro resolves to 'kiro'", () => {
  expect(String(ProviderV2.ID.kiro)).toBe("kiro")
})

// 2. SDK import and factory
test("createKiroAcp is exported from kiro-acp-ai-provider", async () => {
  const mod = await import("kiro-acp-ai-provider")
  expect(typeof mod.createKiroAcp).toBe("function")
})

test("verifyAuth is exported from kiro-acp-ai-provider", async () => {
  const mod = await import("kiro-acp-ai-provider")
  expect(typeof mod.verifyAuth).toBe("function")
})

// 3. Transform mapping — sdkKey maps "kiro-acp-ai-provider" → "kiro"
describe("ProviderTransform.providerOptions - kiro sdkKey mapping", () => {
  const model = {
    id: "kiro/claude-sonnet-4",
    providerID: "kiro",
    api: {
      id: "claude-sonnet-4",
      url: "https://kiro.dev",
      npm: "kiro-acp-ai-provider",
    },
    name: "Claude Sonnet 4",
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0.001, output: 0.002, cache: { read: 0.0001, write: 0.0002 } },
    limit: { context: 200_000, output: 8192 },
    status: "active",
    options: {},
    headers: {},
  } as any

  test("uses 'kiro' key for providerOptions", () => {
    const result = ProviderTransform.providerOptions(model, { thinking: { type: "enabled" } })
    expect(result).toEqual({ kiro: { thinking: { type: "enabled" } } })
  })
})

// 4. Auth plugin structure
test("KiroACPAuthPlugin returns correct structure", async () => {
  const { KiroACPAuthPlugin } = await import("../../src/plugin/kiro-acp")
  const hooks = await KiroACPAuthPlugin({} as any)
  expect(hooks.auth).toBeDefined()
  expect(hooks.auth!.provider).toBe("kiro")
  expect(hooks.auth!.methods.length).toBeGreaterThan(0)
  expect(hooks.auth!.methods[0].type).toBe("oauth")
  expect(typeof hooks.auth!.methods[0].authorize).toBe("function")
})
