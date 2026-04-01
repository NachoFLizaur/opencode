import { getToken } from "./kiro-auth"

const ENDPOINT = "https://q.us-east-1.amazonaws.com"

export function getQuota(): Promise<
  { currentUsage: number; usageLimit: number; subscriptionTitle: string } | undefined
> {
  return getToken().then((token) => {
    if (!token) return undefined
    return fetch(
      `${ENDPOINT}/getUsageLimits?origin=AI_EDITOR&resourceType=AGENTIC_REQUEST`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent":
            "aws-sdk-js/1.0.27 ua/2.1 os/darwin lang/js api/codewhispererstreaming#1.0.27 m/E Kiro-opencode",
          "x-amz-user-agent": "aws-sdk-js/1.0.27 Kiro-opencode",
          "x-amzn-codewhisperer-optout": "true",
          "x-amzn-kiro-agent-mode": "vibe",
        },
      },
    )
      .then((response) => {
        if (!response.ok) return undefined
        return response.json() as Promise<{
          subscriptionInfo: {
            subscriptionTitle: string
          }
          usageBreakdownList: Array<{
            currentUsage: number
            currentUsageWithPrecision: number
            usageLimit: number
            usageLimitWithPrecision: number
          }>
        }>
      })
      .then((body) => {
        if (!body) return undefined
        const item = body.usageBreakdownList[0]
        if (!item) return undefined
        return {
          currentUsage: item.currentUsageWithPrecision ?? item.currentUsage,
          usageLimit: item.usageLimitWithPrecision ?? item.usageLimit,
          subscriptionTitle: body.subscriptionInfo.subscriptionTitle
            .toLowerCase()
            .replace(/\b\w/g, (c) => c.toUpperCase()),
        }
      })
      .catch(() => undefined)
  })
}
