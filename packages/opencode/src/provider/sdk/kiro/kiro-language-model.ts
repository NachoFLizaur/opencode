import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider"
import { getToken } from "./kiro-auth"
import { translate } from "./kiro-translate"
import { decodeEventStream } from "./kiro-eventstream"
import { KiroAuthError, KiroApiError } from "./kiro-error"
import type { KiroStreamEvent, KiroToolSpec } from "./kiro-api-types"

const THINKING_TOOL: KiroToolSpec = {
  toolSpecification: {
    name: "thinking",
    description:
      "Internal reasoning tool for working through complex problems. Use for multi-step planning, analyzing constraints, debugging, evaluating trade-offs, or synthesizing information before acting. Do not use for simple lookups or straightforward tasks.",
    inputSchema: {
      json: {
        type: "object",
        properties: {
          thought: {
            type: "string",
            description: "Your step-by-step reasoning process",
          },
        },
        required: ["thought"],
      },
    },
  },
}

function readable(
  body: ReadableStream<Uint8Array>,
): ReadableStream<KiroStreamEvent> {
  return new ReadableStream({
    async start(controller) {
      for await (const event of decodeEventStream(body)) {
        controller.enqueue(event)
      }
      controller.close()
    },
  })
}

function transform(context: number): TransformStream<
  KiroStreamEvent,
  LanguageModelV3StreamPart
> {
  const tools = new Map<string, { name: string; input: string }>()
  const usage: LanguageModelV3Usage = {
    inputTokens: { total: 0, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 0, text: undefined, reasoning: undefined },
  }
  const state = { text: false, started: false }

  return new TransformStream({
    transform(event, controller) {
      if (!state.started) {
        state.started = true
        controller.enqueue({ type: "stream-start", warnings: [] })
      }

      switch (event.type) {
        case "content": {
          if (!state.text) {
            state.text = true
            controller.enqueue({ type: "text-start", id: "txt-0" })
          }
          controller.enqueue({
            type: "text-delta",
            id: "txt-0",
            delta: event.payload.content,
          })
          return
        }
        case "tool_start": {
          if (state.text) {
            state.text = false
            controller.enqueue({ type: "text-end", id: "txt-0" })
          }
          tools.set(event.payload.toolUseId, {
            name: event.payload.name,
            input: event.payload.input ?? "",
          })
          controller.enqueue({
            type: "tool-input-start",
            id: event.payload.toolUseId,
            toolName: event.payload.name,
          })
          if (event.payload.input) {
            controller.enqueue({
              type: "tool-input-delta",
              id: event.payload.toolUseId,
              delta: event.payload.input,
            })
          }
          return
        }
        case "tool_input": {
          const entries = [...tools.entries()]
          const last = entries[entries.length - 1]
          if (!last) return
          last[1].input += event.payload.input
          controller.enqueue({
            type: "tool-input-delta",
            id: last[0],
            delta: event.payload.input,
          })
          return
        }
        case "tool_stop": {
          const entries = [...tools.entries()]
          const last = entries[entries.length - 1]
          if (!last) return
          controller.enqueue({
            type: "tool-input-end",
            id: last[0],
          })
          controller.enqueue({
            type: "tool-call",
            toolCallId: last[0],
            toolName: last[1].name,
            input: last[1].input,
          })
          return
        }
        case "usage": {
          if (event.payload.inputTokens !== undefined)
            usage.inputTokens.total = event.payload.inputTokens
          if (event.payload.outputTokens !== undefined)
            usage.outputTokens.total = event.payload.outputTokens
          return
        }
        case "context_usage": {
          const pct = event.payload.contextUsagePercentage ?? event.payload.contextTokens ?? 0
          usage.inputTokens.total = Math.round((pct / 100) * context)
          usage.outputTokens.total = usage.outputTokens.total || 1
          return
        }
        case "error": {
          controller.enqueue({ type: "error", error: event.payload.message })
          return
        }
      }
    },
    flush(controller) {
      if (state.text) {
        controller.enqueue({ type: "text-end", id: "txt-0" })
      }
      const reason: LanguageModelV3FinishReason =
        { unified: tools.size > 0 ? "tool-calls" : "stop", raw: undefined }
      controller.enqueue({
        type: "finish",
        finishReason: reason,
        usage,
      })
    },
  })
}

export class KiroLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const
  readonly provider: string
  readonly modelId: string
  readonly defaultObjectGenerationMode = undefined
  readonly supportedUrls: Record<string, RegExp[]> = {}
  private conversationId = crypto.randomUUID()

  constructor(
    modelId: string,
    private readonly config: {
      readonly provider: string
      readonly fetch?: typeof globalThis.fetch
      readonly context?: number
      readonly region?: string
    },
  ) {
    this.provider = config.provider
    this.modelId = modelId
  }

  private callApi(
    token: string,
    state: ReturnType<typeof translate>,
  ): Promise<Response> {
    const endpoint = `https://q.${this.config.region ?? "us-east-1"}.amazonaws.com`
    return (this.config.fetch ?? globalThis.fetch)(
      `${endpoint}/generateAssistantResponse`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "aws-sdk-js/1.0.27 ua/2.1 os/darwin lang/js api/codewhispererstreaming#1.0.27 m/E Kiro-opencode",
          "x-amz-user-agent": "aws-sdk-js/1.0.27 Kiro-opencode",
          "x-amzn-codewhisperer-optout": "true",
          "x-amzn-kiro-agent-mode": "vibe",
          "amz-sdk-invocation-id": crypto.randomUUID(),
          "amz-sdk-request": "attempt=1; max=3",
        },
        body: JSON.stringify({ conversationState: state }),
      },
    )
  }

  async doStream(
    options: LanguageModelV3CallOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV3["doStream"]>>> {
    const token = await getToken()
    if (!token)
      throw new KiroAuthError({ message: "No Kiro auth token available" })

    const translated = translate({
      prompt: options.prompt,
      modelId: this.modelId,
      conversationId: this.conversationId,
      tools: options.tools?.filter(
        (t): t is Extract<typeof t, { type: "function" }> =>
          t.type === "function",
      ),
    })

    const ctx = translated.currentMessage.userInputMessage.userInputMessageContext
    const tools = ctx?.tools ?? []
    const state = {
      ...translated,
      currentMessage: {
        userInputMessage: {
          ...translated.currentMessage.userInputMessage,
          userInputMessageContext: {
            ...ctx,
            tools:
              (options.providerOptions?.kiro as Record<string, unknown>)?.thinking === true &&
              tools.every((t) => t.toolSpecification.name !== "thinking")
                ? [...tools, THINKING_TOOL]
                : tools,
          },
        },
      },
    }

    const response = await this.callApi(token, state)

    if (!response.ok) {
      const text = await response.text()
      throw new KiroApiError({ status: response.status, body: text })
    }

    const stream = readable(response.body!).pipeThrough(
      transform(this.config.context ?? 200_000),
    )

    return {
      stream,
      request: { body: JSON.stringify({ conversationState: state }) },
      response: {
        headers: Object.fromEntries(response.headers.entries()),
      },
    }
  }

  async doGenerate(
    options: LanguageModelV3CallOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV3["doGenerate"]>>> {
    const result = await this.doStream(options)
    const content: Array<LanguageModelV3Content> = []
    const parts: Array<string> = []
    const tools = new Map<
      string,
      { name: string; input: string }
    >()
    const usage: LanguageModelV3Usage = {
      inputTokens: { total: 0, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 0, text: undefined, reasoning: undefined },
    }
    const state = { reason: { unified: "stop", raw: undefined } as LanguageModelV3FinishReason }

    const reader = result.stream.getReader()
    const read = (): Promise<void> =>
      reader.read().then(({ done, value }) => {
        if (done) return
        switch (value.type) {
          case "text-delta":
            parts.push(value.delta)
            break
          case "tool-input-start":
            tools.set(value.id, { name: value.toolName, input: "" })
            break
          case "tool-input-delta": {
            const tool = tools.get(value.id)
            if (tool) tool.input += value.delta
            break
          }
          case "tool-call":
            break
          case "finish":
            usage.inputTokens = value.usage.inputTokens
            usage.outputTokens = value.usage.outputTokens
            state.reason = value.finishReason
            break
        }
        return read()
      })

    await read()

    const text = parts.join("")
    if (text.length > 0) {
      content.push({ type: "text", text })
    }

    for (const [id, tool] of tools) {
      content.push({
        type: "tool-call",
        toolCallId: id,
        toolName: tool.name,
        input: tool.input,
      })
    }

    return {
      content,
      finishReason: state.reason,
      usage,
      warnings: [],
      request: result.request,
      response: {
        headers: result.response?.headers,
      },
    }
  }
}
