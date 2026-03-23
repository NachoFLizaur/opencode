import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { Installation } from "@/installation"
import { setTimeout as sleep } from "node:timers/promises"
import path from "path"
import os from "os"

const OIDC_ENDPOINT = "https://oidc.us-east-1.amazonaws.com"
const BUILDER_ID_URL = "https://view.awsapps.com/start"
const SCOPES = [
  "codewhisperer:completions",
  "codewhisperer:analysis",
  "codewhisperer:conversations",
  "codewhisperer:transformations",
  "codewhisperer:taskassist",
]
const GRANT_TYPES = ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"]
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
const POLLING_MARGIN_MS = 3000
const TOKEN_PATH = path.join(os.homedir(), ".aws", "sso", "cache", "kiro-auth-token.json")
const CLIENT_PATH = path.join(os.homedir(), ".aws", "sso", "cache", "kiro-client-registration.json")
const USER_AGENT = "aws-sdk-js/1.0.27 ua/2.1 os/darwin lang/js api/codewhispererstreaming#1.0.27 m/E Kiro-opencode"
const USER_AGENT_SHORT = "aws-sdk-js/1.0.27 Kiro-opencode"

function read<T>(filepath: string): Promise<T | undefined> {
  const file = Bun.file(filepath)
  return file
    .exists()
    .then((found) => (found ? file.text().then((text) => JSON.parse(text) as T) : undefined))
    .catch(() => undefined)
}

function write(filepath: string, data: unknown): Promise<void> {
  return Bun.write(filepath, JSON.stringify(data, null, 2))
    .then(() => {})
    .catch(() => {})
}

function mkdir(dir: string): Promise<void> {
  return import("fs/promises")
    .then((fs) => fs.mkdir(dir, { recursive: true }).then(() => {}))
    .catch(() => {})
}

export async function KiroAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: "kiro",
      async loader(getAuth) {
        const info = await getAuth()
        if (!info || info.type !== "oauth") return {}

        return {
          async fetch(request: RequestInfo | URL, init?: RequestInit) {
            const token = await read<{ accessToken: string }>(TOKEN_PATH)
            if (!token) return fetch(request, init)

            const headers: Record<string, string> = {
              ...(init?.headers as Record<string, string>),
              Authorization: `Bearer ${token.accessToken}`,
              "User-Agent": USER_AGENT,
              "x-amz-user-agent": USER_AGENT_SHORT,
              "x-amzn-codewhisperer-optout": "true",
            }

            return fetch(request, {
              ...init,
              headers,
            })
          },
        }
      },
      methods: [
        {
          type: "oauth" as const,
          label: "Login with Kiro",
          prompts: [
            {
              type: "select" as const,
              key: "authType",
              message: "Select Kiro authentication type",
              options: [
                { label: "AWS Builder ID", value: "builder-id", hint: "Free" },
                { label: "IAM Identity Center", value: "idc", hint: "Enterprise" },
              ],
            },
            {
              type: "text" as const,
              key: "startUrl",
              message: "Enter your SSO start URL",
              placeholder: "https://d-xxxxxxxxxx.awsapps.com/start",
              when: { key: "authType", op: "eq" as const, value: "idc" },
            },
          ],
          async authorize(inputs = {} as Record<string, string>) {
            const url =
              inputs.authType === "idc" ? inputs.startUrl : BUILDER_ID_URL

            const registration = await fetch(`${OIDC_ENDPOINT}/client/register`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "User-Agent": `opencode/${Installation.VERSION}`,
              },
              body: JSON.stringify({
                clientName: "opencode-kiro",
                clientType: "public",
                scopes: SCOPES,
                grantTypes: GRANT_TYPES,
                issuerUrl: url,
              }),
            })

            if (!registration.ok) {
              throw new Error("Failed to register OIDC client")
            }

            const client = (await registration.json()) as {
              clientId: string
              clientSecret: string
              clientIdIssuedAt: number
              clientSecretExpiresAt: number
            }

            const device = await fetch(`${OIDC_ENDPOINT}/device_authorization`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "User-Agent": `opencode/${Installation.VERSION}`,
              },
              body: JSON.stringify({
                clientId: client.clientId,
                clientSecret: client.clientSecret,
                startUrl: url,
              }),
            })

            if (!device.ok) {
              throw new Error("Failed to start device authorization")
            }

            const auth = (await device.json()) as {
              verificationUri: string
              verificationUriComplete: string
              userCode: string
              deviceCode: string
              interval: number
              expiresIn: number
            }

            return {
              url: auth.verificationUriComplete,
              instructions: `Enter code: ${auth.userCode}`,
              method: "auto" as const,
              async callback() {
                const delay = { ms: auth.interval }

                while (true) {
                  const response = await fetch(`${OIDC_ENDPOINT}/token`, {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      "User-Agent": `opencode/${Installation.VERSION}`,
                    },
                    body: JSON.stringify({
                      clientId: client.clientId,
                      clientSecret: client.clientSecret,
                      grantType: DEVICE_GRANT,
                      deviceCode: auth.deviceCode,
                    }),
                  })

                  if (response.ok) {
                    const tokens = (await response.json()) as {
                      accessToken: string
                      refreshToken: string
                      expiresIn: number
                      tokenType: string
                    }

                    const expires = new Date(Date.now() + tokens.expiresIn * 1000)

                    await mkdir(path.dirname(TOKEN_PATH))

                    await write(TOKEN_PATH, {
                      accessToken: tokens.accessToken,
                      refreshToken: tokens.refreshToken,
                      expiresAt: expires.toISOString(),
                      region: "us-east-1",
                      clientId: client.clientId,
                      clientSecret: client.clientSecret,
                    })

                    await write(CLIENT_PATH, {
                      clientId: client.clientId,
                      clientSecret: client.clientSecret,
                      clientIdIssuedAt: client.clientIdIssuedAt,
                      clientSecretExpiresAt: client.clientSecretExpiresAt,
                    })

                    return {
                      type: "success" as const,
                      refresh: tokens.refreshToken,
                      access: tokens.accessToken,
                      expires: expires.getTime(),
                    }
                  }

                  const error = (await response.json().catch(() => ({}))) as {
                    error?: string
                    error_description?: string
                  }

                  if (error.error === "authorization_pending") {
                    await sleep(delay.ms * 1000 + POLLING_MARGIN_MS)
                    continue
                  }

                  if (error.error === "slow_down") {
                    delay.ms = delay.ms + 5
                    await sleep(delay.ms * 1000 + POLLING_MARGIN_MS)
                    continue
                  }

                  if (error.error) return { type: "failed" as const }

                  await sleep(delay.ms * 1000 + POLLING_MARGIN_MS)
                  continue
                }
              },
            }
          },
        },
      ],
    },
  }
}
