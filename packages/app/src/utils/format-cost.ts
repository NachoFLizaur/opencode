const CREDIT_PROVIDERS = new Set(["kiro"])

export function formatCost(cost: number, providerID?: string, locale?: string) {
  const formatter = new Intl.NumberFormat(locale ?? "en-US", {
    style: "currency",
    currency: "USD",
  })
  if (providerID && CREDIT_PROVIDERS.has(providerID))
    return formatter.format(cost).replace("$", "") + " credits"
  return formatter.format(cost)
}
