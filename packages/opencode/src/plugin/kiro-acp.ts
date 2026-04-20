import type { Hooks, PluginInput } from "@opencode-ai/plugin"

export async function KiroACPAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: "kiro",
      methods: [
        {
          type: "oauth" as const,
          label: "Kiro CLI Login",
          async authorize() {
            const { verifyAuth } = await import("kiro-acp-ai-provider")
            const status = verifyAuth()

            if (!status.installed)
              throw new Error(
                "kiro-cli is not installed. Install it from https://kiro.dev/docs/cli/",
              )

            // Already authenticated — return immediately
            if (status.authenticated) {
              return {
                url: "",
                instructions: "",
                method: "auto" as const,
                async callback() {
                  return readToken(status.tokenPath)
                },
              }
            }

            // Not authenticated — launch kiro-cli auth login and poll
            const { execFile } = await import("node:child_process")
            const child = execFile("kiro-cli", ["login"])

            return {
              url: "",
              instructions:
                "Complete Kiro authentication in the browser window that just opened. Waiting for login...",
              method: "auto" as const,
              async callback() {
                // Poll until authenticated (kiro-cli auth login runs in background)
                const maxWait = 120_000
                const start = Date.now()
                while (Date.now() - start < maxWait) {
                  await new Promise((r) => setTimeout(r, 2000))
                  const check = verifyAuth()
                  if (check.authenticated) {
                    child.kill()
                    return readToken(check.tokenPath)
                  }
                }
                child.kill()
                throw new Error(
                  "Kiro authentication timed out. Run `kiro-cli auth login` manually.",
                )
              },
            }
          },
        },
      ],
    },
  }
}

async function readToken(tokenPath: string | undefined) {
  if (tokenPath) {
    try {
      const { readFileSync } = await import("node:fs")
      const raw = JSON.parse(readFileSync(tokenPath, "utf8"))
      return {
        type: "success" as const,
        refresh: "",
        access: raw.accessToken || "authenticated",
        expires: raw.expiresAt
          ? new Date(raw.expiresAt).getTime()
          : Date.now() + 3600000,
      }
    } catch {
      return { type: "failed" as const }
    }
  }
  return {
    type: "success" as const,
    refresh: "",
    access: "authenticated",
    expires: Date.now() + 3600000,
  }
}
