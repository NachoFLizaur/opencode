import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { authenticate, getToken } from "kiro-ai-provider"

const BUILDER_ID_URL = "https://view.awsapps.com/start"
const USER_AGENT = "aws-sdk-js/1.0.27 ua/2.1 os/darwin lang/js api/codewhispererstreaming#1.0.27 m/E Kiro-opencode"
const USER_AGENT_SHORT = "aws-sdk-js/1.0.27 Kiro-opencode"

export async function KiroAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: "kiro",
      async loader(getAuth) {
        const info = await getAuth()
        if (!info || info.type !== "oauth") return {}

        return {
          async fetch(request: RequestInfo | URL, init?: RequestInit) {
            const token = await getToken()
            if (!token) return fetch(request, init)

            return fetch(request, {
              ...init,
              headers: {
                ...(init?.headers as Record<string, string>),
                Authorization: `Bearer ${token}`,
                "User-Agent": USER_AGENT,
                "x-amz-user-agent": USER_AGENT_SHORT,
                "x-amzn-codewhisperer-optout": "true",
              },
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
              message: "Enter your SSO start URL (defaults to $AWS_SSO_START_URL if set)",
              placeholder: "https://d-xxxxxxxxxx.awsapps.com/start",
              when: { key: "authType", op: "eq" as const, value: "idc" },
            },
            {
              type: "text" as const,
              key: "region",
              message: "Enter your AWS SSO region (defaults to $AWS_SSO_REGION if set)",
              placeholder: "us-east-1",
              when: { key: "authType", op: "eq" as const, value: "idc" },
            },
          ],
          async authorize(inputs = {} as Record<string, string>) {
            const url =
              inputs.authType === "idc" ? (inputs.startUrl || process.env.AWS_SSO_START_URL) : BUILDER_ID_URL
            const region =
              inputs.authType === "idc"
                ? (inputs.region || process.env.AWS_SSO_REGION || "us-east-1")
                : "us-east-1"

            const { promise: pending, resolve } = Promise.withResolvers<{ url: string; code: string }>()

            const auth = authenticate({
              startUrl: url,
              region,
              onVerification: (verify, code) => resolve({ url: verify, code }),
            })

            const verification = await pending

            return {
              url: verification.url,
              instructions: verification.code,
              method: "auto" as const,
              callback: () =>
                auth
                  .then((result) => ({
                    type: "success" as const,
                    refresh: result.refreshToken,
                    access: result.accessToken,
                    expires: Date.now() + 3600000,
                  }))
                  .catch(() => ({ type: "failed" as const })),
            }
          },
        },
      ],
    },
  }
}
