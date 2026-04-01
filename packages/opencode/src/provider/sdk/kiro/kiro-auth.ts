import path from "path"
import os from "os"

interface KiroTokenFile {
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiresAt: string
  readonly region: string
  readonly clientId?: string
  readonly clientSecret?: string
  readonly clientIdHash?: string
  readonly authMethod?: string
  readonly provider?: string
}

const TOKEN_PATH = path.join(os.homedir(), ".aws", "sso", "cache", "kiro-auth-token.json")

const BUFFER_MS = 300_000

function resolve(token: KiroTokenFile): Promise<{ clientId: string; clientSecret: string } | undefined> {
  if (token.clientId) return Promise.resolve({ clientId: token.clientId, clientSecret: token.clientSecret ?? "" })
  if (!token.clientIdHash) return Promise.resolve(undefined)
  const ref = path.join(os.homedir(), ".aws", "sso", "cache", `${token.clientIdHash}.json`)
  return Bun.file(ref)
    .json()
    .then((data: { clientId: string; clientSecret: string }) => ({ clientId: data.clientId, clientSecret: data.clientSecret }))
    .catch(() => undefined)
}

const cache: { current: KiroTokenFile | undefined; expires: number } = {
  current: undefined,
  expires: 0,
}

function read(): Promise<KiroTokenFile | undefined> {
  const file = Bun.file(TOKEN_PATH)
  return file
    .exists()
    .then((found) => (found ? file.text().then((text) => JSON.parse(text) as KiroTokenFile) : undefined))
    .catch(() => undefined)
}

function write(token: KiroTokenFile): Promise<void> {
  return Bun.write(TOKEN_PATH, JSON.stringify(token, null, 2))
    .then(() => {})
    .catch(() => {})
}

function refresh(token: KiroTokenFile): Promise<KiroTokenFile | undefined> {
  const url = `https://oidc.${token.region}.amazonaws.com/token`
  return resolve(token).then((client) => {
    if (!client) return undefined
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grantType: "refresh_token",
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        refreshToken: token.refreshToken,
      }),
    })
      .then((response) => {
        if (!response.ok) return undefined
        return response.json() as Promise<{
          accessToken: string
          refreshToken?: string
          expiresIn: number
        }>
      })
      .then((body) => {
        if (!body) return undefined
        const next: KiroTokenFile = {
          accessToken: body.accessToken,
          refreshToken: body.refreshToken ?? token.refreshToken,
          expiresAt: new Date(Date.now() + body.expiresIn * 1000).toISOString(),
          region: token.region,
          clientId: token.clientId,
          clientSecret: token.clientSecret,
          clientIdHash: token.clientIdHash,
          authMethod: token.authMethod,
          provider: token.provider,
        }
        write(next)
        return next
      })
      .catch(() => undefined)
  })
}

export function getToken(): Promise<string | undefined> {
  if (cache.current && Date.now() < cache.expires) return Promise.resolve(cache.current.accessToken)

  return read().then((token) => {
    if (!token) return undefined

    const expiry = new Date(token.expiresAt).getTime()

    if (Date.now() < expiry - BUFFER_MS) {
      cache.current = token
      cache.expires = expiry - BUFFER_MS
      return token.accessToken
    }

    return refresh(token).then((refreshed) => {
      if (!refreshed) return undefined
      cache.current = refreshed
      cache.expires = new Date(refreshed.expiresAt).getTime() - BUFFER_MS
      return refreshed.accessToken
    })
  })
}

export function hasToken(): Promise<boolean> {
  return Bun.file(TOKEN_PATH).exists()
}
