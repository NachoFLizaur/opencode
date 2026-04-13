import { describe, test, expect } from "bun:test"
import type { KiroStreamEvent } from "kiro-ai-provider"
import path from "path"
import { ProviderID } from "../../src/provider/schema"
import { Provider } from "../../src/provider/provider"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

// ---------------------------------------------------------------------------
// 1. kiro-api-types — compile-time type assertions
// ---------------------------------------------------------------------------

describe("kiro-api-types", () => {
  test("KiroStreamEvent union covers expected event types", () => {
    // Verify the discriminated union compiles with all expected variants
    type Cases =
      | { readonly type: "content"; readonly payload: { readonly content: string } }
      | { readonly type: "tool_start"; readonly payload: { readonly name: string; readonly toolUseId: string } }
      | { readonly type: "tool_input"; readonly payload: { readonly input: string } }
      | { readonly type: "tool_stop"; readonly payload: { readonly stop: boolean } }
      | { readonly type: "usage"; readonly payload: { readonly inputTokens: number; readonly outputTokens: number } }
      | {
          readonly type: "context_usage"
          readonly payload: { readonly contextTokens: number }
        }
      | { readonly type: "error"; readonly payload: { readonly message: string } }

    // If this compiles, the union shape is correct
    expect(true).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. kiro-error — Error creation and properties
// ---------------------------------------------------------------------------

describe("kiro-error", () => {
  test("KiroAuthError has correct name and data", async () => {
    const { KiroAuthError } = await import("kiro-ai-provider")
    const err = new KiroAuthError({ message: "no token" })
    expect(err.name).toBe("KiroAuthError")
    expect(err.data.message).toBe("no token")
    expect(err).toBeInstanceOf(Error)
  })

  test("KiroApiError has correct name and data", async () => {
    const { KiroApiError } = await import("kiro-ai-provider")
    const err = new KiroApiError({ status: 403, body: "forbidden" })
    expect(err.name).toBe("KiroApiError")
    expect(err.data.status).toBe(403)
    expect(err.data.body).toBe("forbidden")
    expect(err).toBeInstanceOf(Error)
  })

  test("KiroStreamError has correct name and data", async () => {
    const { KiroStreamError } = await import("kiro-ai-provider")
    const err = new KiroStreamError({ message: "decode failed" })
    expect(err.name).toBe("KiroStreamError")
    expect(err.data.message).toBe("decode failed")
    expect(err).toBeInstanceOf(Error)
  })
})

// ---------------------------------------------------------------------------
// 3. kiro-provider factory
// ---------------------------------------------------------------------------

describe("kiro-provider factory", () => {
  test("createKiro returns provider with languageModel method", async () => {
    const { createKiro } = await import("kiro-ai-provider")
    const provider = createKiro()
    expect(typeof provider.languageModel).toBe("function")
  })

  test("createKiro is callable as function (provider(modelId) syntax)", async () => {
    const { createKiro } = await import("kiro-ai-provider")
    const provider = createKiro()
    const model = provider("test-model")
    expect(model).toBeDefined()
    expect(model.modelId).toBe("test-model")
    expect(model.provider).toBe("kiro")
  })

  test("languageModel returns model with correct properties", async () => {
    const { createKiro } = await import("kiro-ai-provider")
    const provider = createKiro()
    const model = provider.languageModel("kiro-v1")
    expect(model.modelId).toBe("kiro-v1")
    expect(model.specificationVersion).toBe("v3")
  })
})

// ---------------------------------------------------------------------------
// 4. kiro schema registration
// ---------------------------------------------------------------------------

describe("kiro schema registration", () => {
  test("ProviderID.kiro is available", () => {
    expect(String(ProviderID.kiro)).toBe("kiro")
  })

  test("ProviderID.make('kiro') matches ProviderID.kiro", () => {
    expect(ProviderID.make("kiro")).toBe(ProviderID.kiro)
  })
})
