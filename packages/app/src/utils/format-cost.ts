const CREDIT_PROVIDERS = new Set(["kiro"])

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

export function formatCost(cost: number, providerID?: string) {
  if (providerID && CREDIT_PROVIDERS.has(providerID))
    return usd.format(cost).replace("$", "") + " credits"
  return usd.format(cost)
}
