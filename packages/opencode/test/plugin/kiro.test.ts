import { describe, expect, spyOn, test } from "bun:test"
import * as fs from "fs/promises"
import os from "os"
import path from "path"
import { KiroAuthPlugin } from "../../src/plugin/kiro"

const token = path.join(os.homedir(), ".aws", "sso", "cache", "kiro-auth-token.json")
const client = path.join(os.homedir(), ".aws", "sso", "cache", "kiro-client-registration.json")

function fetches() {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []

  const spy = spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit | BunFetchRequestInit,
  ) => {
    const url = String(input)
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
    calls.push({ url, body })

    if (url.endsWith("/client/register")) {
      return Response.json({
        clientId: "cid",
        clientSecret: "sec",
        clientIdIssuedAt: 1,
        clientSecretExpiresAt: 2,
      })
    }

    if (url.endsWith("/device_authorization")) {
      return Response.json({
        verificationUri: "https://device.example.com",
        verificationUriComplete: "https://device.example.com/complete",
        userCode: "ABCD-EFGH",
        deviceCode: "dev",
        interval: 1,
        expiresIn: 600,
      })
    }

    if (url.endsWith("/token")) {
      return Response.json({
        accessToken: "acc",
        refreshToken: "ref",
        expiresIn: 3600,
        tokenType: "Bearer",
      })
    }

    throw new Error(`Unexpected fetch: ${url}`)
  }) as unknown as typeof fetch)

  return { calls, spy }
}

async function method() {
  const hooks = await KiroAuthPlugin({} as never)
  const auth = hooks.auth
  if (!auth) throw new Error("Missing Kiro auth hook")
  const item = auth.methods[0]
  if (item.type !== "oauth" || !item.authorize) throw new Error("Missing Kiro oauth method")
  return item
}

describe("plugin.kiro", () => {
  test("shows IDC region select plus custom prompt", async () => {
    const item = await method()
    const prompts = item.prompts

    expect(prompts?.map((x) => x.key)).toEqual(["authType", "startUrl", "region", "regionCustom"])

    if (!prompts || prompts[2].type !== "select" || prompts[3].type !== "text") {
      throw new Error("Missing Kiro region prompts")
    }

    expect(prompts[2]).toMatchObject({
      key: "region",
      when: { key: "authType", op: "eq", value: "idc" },
    })
    expect(prompts[2].options.map((x) => x.value)).toEqual(["ap-northeast-1", "us-east-1", "eu-central-1", "custom"])
    expect(prompts[3]).toMatchObject({
      key: "regionCustom",
      when: { key: "region", op: "eq", value: "custom" },
    })
  })

  test("uses selected custom IDC region for oidc flow and saved token", async () => {
    const item = await method()
    const { calls, spy } = fetches()
    const dir = spyOn(fs, "mkdir").mockImplementation(async () => undefined)
    const writes: Array<{ file: string; body: string }> = []
    const write = spyOn(Bun, "write").mockImplementation(async (file, data) => {
      writes.push({ file: String(file), body: String(data) })
      return 0
    })

    try {
      const auth = await item.authorize({
        authType: "idc",
        startUrl: "https://example.awsapps.com/start",
        region: "custom",
        regionCustom: "ap-northeast-1",
      })

      if (auth.method !== "auto") throw new Error("Unexpected Kiro auth method")

      expect(auth.url).toBe("https://device.example.com/complete")

      const result = await auth.callback()
      expect(result).toMatchObject({
        type: "success",
        access: "acc",
        refresh: "ref",
      })
    } finally {
      spy.mockRestore()
      dir.mockRestore()
      write.mockRestore()
    }

    expect(calls.map((x) => x.url)).toEqual([
      "https://oidc.ap-northeast-1.amazonaws.com/client/register",
      "https://oidc.ap-northeast-1.amazonaws.com/device_authorization",
      "https://oidc.ap-northeast-1.amazonaws.com/token",
    ])
    expect(calls[0].body.issuerUrl).toBe("https://example.awsapps.com/start")
    expect(calls[1].body.startUrl).toBe("https://example.awsapps.com/start")
    expect(calls[2].body.grantType).toBe("urn:ietf:params:oauth:grant-type:device_code")

    const saved = writes.find((x) => x.file === token)
    expect(saved).toBeDefined()
    expect(JSON.parse(saved!.body)).toMatchObject({
      accessToken: "acc",
      refreshToken: "ref",
      region: "ap-northeast-1",
      clientId: "cid",
      clientSecret: "sec",
    })
    expect(writes.find((x) => x.file === client)).toBeDefined()
  })

  test("keeps Builder ID on us-east-1", async () => {
    const item = await method()
    const { calls, spy } = fetches()

    try {
      await item.authorize({ authType: "builder-id" })
    } finally {
      spy.mockRestore()
    }

    expect(calls.map((x) => x.url)).toEqual([
      "https://oidc.us-east-1.amazonaws.com/client/register",
      "https://oidc.us-east-1.amazonaws.com/device_authorization",
    ])
    expect(calls[0].body.issuerUrl).toBe("https://view.awsapps.com/start")
    expect(calls[1].body.startUrl).toBe("https://view.awsapps.com/start")
  })
})
