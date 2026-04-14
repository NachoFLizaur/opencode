import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal } from "solid-js"

const id = "internal:sidebar-context"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const cost = createMemo(() => msg().reduce((sum, item) => sum + (item.role === "assistant" ? item.cost : 0), 0))
  const [quota, setQuota] = createSignal<{ currentUsage: number; usageLimit: number; subscriptionTitle: string } | undefined>()
  props.api.client.global.provider
    .quota()
    .then((x) => x.data && setQuota(x.data))
    .catch(() => {})

  const last = createMemo(() =>
    msg().findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0),
  )

  const state = createMemo(() => {
    const l = last()
    if (!l) {
      return {
        tokens: 0,
        percent: null,
      }
    }

    const tokens =
      l.tokens.input + l.tokens.output + l.tokens.reasoning + l.tokens.cache.read + l.tokens.cache.write
    const model = props.api.state.provider.find((item) => item.id === l.providerID)?.models[l.modelID]
    return {
      tokens,
      percent: model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : null,
    }
  })

  return (
    <box>
      <text fg={theme().text}>
        <b>Context</b>
      </text>
      <text fg={theme().textMuted}>{state().tokens.toLocaleString()} tokens</text>
      <text fg={theme().textMuted}>{state().percent ?? 0}% used</text>
      <text fg={theme().textMuted}>
        {quota() && last()?.providerID === "kiro"
          ? `${quota()!.subscriptionTitle}: ${quota()!.currentUsage.toLocaleString()}/${quota()!.usageLimit.toLocaleString()} credits`
          : money.format(cost())}{" "}
        spent
      </text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
