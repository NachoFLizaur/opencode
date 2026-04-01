import type {
  LanguageModelV3Prompt,
  LanguageModelV3TextPart,
  LanguageModelV3ToolCallPart,
  LanguageModelV3ToolResultPart,
  LanguageModelV3FunctionTool,
} from "@ai-sdk/provider"
import type {
  KiroAssistantResponseMessage,
  KiroConversationState,
  KiroHistoryMessage,
  KiroToolResult,
  KiroToolSpec,
} from "./kiro-api-types"

function tools(
  input: ReadonlyArray<LanguageModelV3FunctionTool>,
): ReadonlyArray<KiroToolSpec> {
  return input.map((tool) => ({
    toolSpecification: {
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: { json: tool.inputSchema as Record<string, unknown> },
    },
  }))
}

function text(
  parts: ReadonlyArray<{ type: string; text?: string }>,
): string {
  return parts
    .filter((p): p is LanguageModelV3TextPart => p.type === "text")
    .map((p) => p.text)
    .join("\n")
}

function output(result: LanguageModelV3ToolResultPart["output"]): string {
  if (!result) return "(no output)"
  switch (result.type) {
    case "text":
    case "error-text":
      return result.value
    case "json":
    case "error-json":
      return JSON.stringify(result.value)
    case "execution-denied":
      return result.reason ?? "(execution denied)"
    case "content":
      return result.value
        .filter((v): v is { type: "text"; text: string } => v.type === "text")
        .map((v) => v.text)
        .join("\n")
  }
}

function history(
  prompt: LanguageModelV3Prompt,
  model: string,
): ReadonlyArray<KiroHistoryMessage> {
  const prefix = prompt
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n")

  return prompt
    .filter((m) => m.role !== "system")
    .flatMap((msg): ReadonlyArray<KiroHistoryMessage> => {
      switch (msg.role) {
        case "user":
          return [
            {
              userInputMessage: {
                content: text(msg.content),
                modelId: model,
                origin: "AI_EDITOR",
              },
            },
          ]
        case "assistant": {
          const content = text(
            msg.content.filter(
              (p): p is LanguageModelV3TextPart => p.type === "text",
            ),
          )
          const calls = msg.content.filter(
            (p): p is LanguageModelV3ToolCallPart => p.type === "tool-call",
          )

          const message: KiroAssistantResponseMessage = calls.length > 0
            ? {
                content: content || "(empty)",
                toolUses: calls.map((c) => ({
                  name: c.toolName,
                  input:
                    typeof c.input === "string"
                      ? JSON.parse(c.input)
                      : (c.input ?? {}),
                  toolUseId: c.toolCallId,
                })),
              }
            : { content: content || "(empty)" }

          return [{ assistantResponseMessage: message }]
        }
        case "tool":
          return [{
            userInputMessage: {
              content: " ",
              modelId: model,
              origin: "AI_EDITOR",
              userInputMessageContext: {
                toolResults: msg.content
                  .filter((r): r is LanguageModelV3ToolResultPart => r.type === "tool-result")
                  .map((r) => ({
                    toolUseId: r.toolCallId,
                    content: [{ text: output(r.output) }],
                    status: (r.output?.type === "error-text" || r.output?.type === "error-json" ? "error" : "success") as "success" | "error",
                  })),
              },
            },
          }]
      }
    })
    .map((msg, idx) => {
      if (idx !== 0) return msg
      if (!prefix) return msg
      if (!("userInputMessage" in msg)) return msg
      return {
        userInputMessage: {
          ...msg.userInputMessage,
          content: prefix + "\n" + msg.userInputMessage.content,
        },
      }
    })
}

export function translate(input: {
  readonly prompt: LanguageModelV3Prompt
  readonly modelId: string
  readonly tools?: ReadonlyArray<LanguageModelV3FunctionTool>
  readonly conversationId?: string
}): KiroConversationState {
  const system = input.prompt.filter((m) => m.role === "system")
  const rest = input.prompt.filter((m) => m.role !== "system")
  const trailing = count(rest, (m) => m.role === "tool")
  const has = trailing > 0

  const toolResults: ReadonlyArray<KiroToolResult> = has
    ? rest
        .slice(rest.length - trailing)
        .filter((m): m is Extract<typeof m, { role: "tool" }> => m.role === "tool")
        .flatMap((m) =>
          m.content
            .filter((r): r is LanguageModelV3ToolResultPart => r.type === "tool-result")
            .map(
              (r): KiroToolResult => ({
                toolUseId: r.toolCallId,
                content: [{ text: output(r.output) }],
                status: r.output?.type === "error-text" || r.output?.type === "error-json" ? "error" : "success",
              }),
            ),
        )
    : []

  const hist = has
    ? rest.slice(0, rest.length - trailing)
    : rest.slice(0, -1)

  const last = has
    ? undefined
    : rest.findLast((m) => m.role === "user")

  const content = last ? text(last.content) : " "

  const prefix = system
    .map((m) => m.content)
    .join("\n")

  const current = hist.length === 0 && prefix
    ? prefix + "\n" + content
    : content

  const ctx: Record<string, unknown> = {}
  if (input.tools?.length) ctx.tools = tools(input.tools)
  if (toolResults.length) ctx.toolResults = toolResults
  const userInputMessageContext = Object.keys(ctx).length
    ? (ctx as { tools?: ReadonlyArray<KiroToolSpec>; toolResults?: ReadonlyArray<KiroToolResult> })
    : undefined

  return {
    conversationId: input.conversationId ?? crypto.randomUUID(),
    currentMessage: {
      userInputMessage: {
        content: current,
        modelId: input.modelId,
        origin: "AI_EDITOR",
        userInputMessageContext,
      },
    },
    history: history([...system, ...hist], input.modelId),
    chatTriggerType: "MANUAL",
  }
}

function count<T>(
  arr: ReadonlyArray<T>,
  predicate: (item: T) => boolean,
): number {
  const count = arr.reduceRight(
    (acc, item) => (acc.done ? acc : predicate(item) ? { ...acc, n: acc.n + 1 } : { ...acc, done: true }),
    { n: 0, done: false },
  )
  return count.n
}
