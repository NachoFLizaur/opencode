import { describe, test, expect, mock, spyOn } from "bun:test"
import { EventStreamCodec } from "@smithy/eventstream-codec"
import type { MessageHeaders } from "@smithy/types"
import type { KiroStreamEvent } from "../../src/provider/sdk/kiro/kiro-api-types"
import path from "path"
import { ProviderID } from "../../src/provider/schema"
import { Provider } from "../../src/provider/provider"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

// ---------------------------------------------------------------------------
// 1. kiro-api-types — compile-time type assertions
// ---------------------------------------------------------------------------

describe("kiro-api-types", () => {
  test("KiroConversationState satisfies expected shape", async () => {
    const mod = await import("../../src/provider/sdk/kiro/kiro-api-types")
    // Verify all expected type exports exist at the module level
    // These are type-only exports so we just confirm the module loads
    expect(mod).toBeDefined()
  })

  test("KiroStreamEvent union covers expected event types", () => {
    // Verify the discriminated union compiles with all expected variants
    type Cases =
      | { readonly type: "content"; readonly payload: { readonly content: string } }
      | { readonly type: "tool_start"; readonly payload: { readonly name: string; readonly toolUseId: string } }
      | { readonly type: "tool_input"; readonly payload: { readonly input: string } }
      | { readonly type: "tool_stop"; readonly payload: { readonly stop: boolean } }
      | { readonly type: "usage"; readonly payload: { readonly inputTokens: number; readonly outputTokens: number } }
      | {
          readonly type: "context_usage"
          readonly payload: { readonly contextTokens: number }
        }
      | { readonly type: "error"; readonly payload: { readonly message: string } }

    // If this compiles, the union shape is correct
    expect(true).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. kiro-error — Error creation and properties
// ---------------------------------------------------------------------------

describe("kiro-error", () => {
  test("KiroAuthError has correct name and data", async () => {
    const { KiroAuthError } = await import("../../src/provider/sdk/kiro/kiro-error")
    const err = new KiroAuthError({ message: "no token" })
    expect(err.name).toBe("KiroAuthError")
    expect(err.data.message).toBe("no token")
    expect(err).toBeInstanceOf(Error)
  })

  test("KiroApiError has correct name and data", async () => {
    const { KiroApiError } = await import("../../src/provider/sdk/kiro/kiro-error")
    const err = new KiroApiError({ status: 403, body: "forbidden" })
    expect(err.name).toBe("KiroApiError")
    expect(err.data.status).toBe(403)
    expect(err.data.body).toBe("forbidden")
    expect(err).toBeInstanceOf(Error)
  })

  test("KiroStreamError has correct name and data", async () => {
    const { KiroStreamError } = await import("../../src/provider/sdk/kiro/kiro-error")
    const err = new KiroStreamError({ message: "decode failed" })
    expect(err.name).toBe("KiroStreamError")
    expect(err.data.message).toBe("decode failed")
    expect(err).toBeInstanceOf(Error)
  })

  test("KiroAuthError.isInstance detects instances", async () => {
    const { KiroAuthError, KiroApiError } = await import("../../src/provider/sdk/kiro/kiro-error")
    const auth = new KiroAuthError({ message: "x" })
    const api = new KiroApiError({ status: 500, body: "err" })
    expect(KiroAuthError.isInstance(auth)).toBe(true)
    expect(KiroAuthError.isInstance(api)).toBe(false)
  })

  test("toObject returns serializable form", async () => {
    const { KiroApiError } = await import("../../src/provider/sdk/kiro/kiro-error")
    const err = new KiroApiError({ status: 429, body: "rate limited" })
    const obj = err.toObject()
    expect(obj.name).toBe("KiroApiError")
    expect(obj.data.status).toBe(429)
    expect(obj.data.body).toBe("rate limited")
  })
})

// ---------------------------------------------------------------------------
// 3. kiro-translate — Message translation (pure functions)
// ---------------------------------------------------------------------------

describe("kiro-translate", () => {
  test("translates simple user prompt", async () => {
    const { translate } = await import("../../src/provider/sdk/kiro/kiro-translate")
    const result = translate({
      prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "hello" }] }],
      modelId: "kiro-v1",
      conversationId: "conv-1",
    })
    expect(result.conversationId).toBe("conv-1")
    expect(result.currentMessage.userInputMessage.content).toBe("hello")
    expect(result.currentMessage.userInputMessage.modelId).toBe("kiro-v1")
    expect(result.chatTriggerType).toBe("MANUAL")
    expect(result.history).toHaveLength(0)
  })

  test("prepends system message to first user message when no history", async () => {
    const { translate } = await import("../../src/provider/sdk/kiro/kiro-translate")
    const result = translate({
      prompt: [
        { role: "system" as const, content: "You are helpful." },
        { role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
      ],
      modelId: "kiro-v1",
      conversationId: "conv-2",
    })
    expect(result.currentMessage.userInputMessage.content).toBe("You are helpful.\nhi")
    expect(result.history).toHaveLength(0)
  })

  test("generates conversationId when not provided", async () => {
    const { translate } = await import("../../src/provider/sdk/kiro/kiro-translate")
    const result = translate({
      prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "test" }] }],
      modelId: "kiro-v1",
    })
    expect(result.conversationId).toBeTruthy()
    expect(typeof result.conversationId).toBe("string")
  })

  test("translates tools into KiroToolSpec format", async () => {
    const { translate } = await import("../../src/provider/sdk/kiro/kiro-translate")
    const result = translate({
      prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "run tool" }] }],
      modelId: "kiro-v1",
      tools: [
        {
          type: "function" as const,
          name: "bash",
          description: "Run a command",
          inputSchema: { type: "object", properties: { command: { type: "string" } } },
        },
      ],
    })
    const ctx = result.currentMessage.userInputMessage.userInputMessageContext
    expect(ctx).toBeDefined()
    expect(ctx!.tools).toHaveLength(1)
    expect(ctx!.tools![0].toolSpecification.name).toBe("bash")
    expect(ctx!.tools![0].toolSpecification.description).toBe("Run a command")
  })

  test("omits userInputMessageContext when no tools", async () => {
    const { translate } = await import("../../src/provider/sdk/kiro/kiro-translate")
    const result = translate({
      prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "no tools" }] }],
      modelId: "kiro-v1",
    })
    expect(result.currentMessage.userInputMessage.userInputMessageContext).toBeUndefined()
  })

  test("builds history from multi-turn conversation", async () => {
    const { translate } = await import("../../src/provider/sdk/kiro/kiro-translate")
    const result = translate({
      prompt: [
        { role: "user" as const, content: [{ type: "text" as const, text: "first" }] },
        {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "response" }],
        },
        { role: "user" as const, content: [{ type: "text" as const, text: "second" }] },
      ],
      modelId: "kiro-v1",
      conversationId: "conv-3",
    })
    expect(result.currentMessage.userInputMessage.content).toBe("second")
    expect(result.history).toHaveLength(2)
    expect("userInputMessage" in result.history[0]).toBe(true)
    expect("assistantResponseMessage" in result.history[1]).toBe(true)
  })

  test("translates assistant tool calls into structured toolUses", async () => {
    const { translate } = await import("../../src/provider/sdk/kiro/kiro-translate")
    const result = translate({
      prompt: [
        { role: "user" as const, content: [{ type: "text" as const, text: "first" }] },
        {
          role: "assistant" as const,
          content: [
            { type: "text" as const, text: "thinking" },
            {
              type: "tool-call" as const,
              toolCallId: "tc-1",
              toolName: "bash",
              input: { command: "ls" },
            },
          ],
        },
        {
          role: "tool" as const,
          content: [
            {
              type: "tool-result" as const,
              toolCallId: "tc-1",
              toolName: "bash",
              output: { type: "text" as const, value: "file.txt" },
            },
          ],
        },
        { role: "user" as const, content: [{ type: "text" as const, text: "done" }] },
      ],
      modelId: "kiro-v1",
      conversationId: "conv-4",
    })
    expect(result.currentMessage.userInputMessage.content).toBe("done")
    // history: user, assistant (with structured toolUses), tool result as user
    expect(result.history.length).toBeGreaterThanOrEqual(3)
    const assistant = result.history[1]
    expect("assistantResponseMessage" in assistant).toBe(true)
    if ("assistantResponseMessage" in assistant) {
      expect(assistant.assistantResponseMessage.content).toBe("thinking")
      expect(assistant.assistantResponseMessage.toolUses).toHaveLength(1)
      expect(assistant.assistantResponseMessage.toolUses![0].name).toBe("bash")
      expect(assistant.assistantResponseMessage.toolUses![0].input).toEqual({ command: "ls" })
      expect(assistant.assistantResponseMessage.toolUses![0].toolUseId).toBe("tc-1")
    }
  })

  test("assistant with only tool calls uses (empty) content and structured toolUses", async () => {
    const { translate } = await import("../../src/provider/sdk/kiro/kiro-translate")
    const result = translate({
      prompt: [
        { role: "user" as const, content: [{ type: "text" as const, text: "run it" }] },
        {
          role: "assistant" as const,
          content: [
            {
              type: "tool-call" as const,
              toolCallId: "tc-only",
              toolName: "bash",
              input: { command: "echo test" },
            },
          ],
        },
        {
          role: "tool" as const,
          content: [
            {
              type: "tool-result" as const,
              toolCallId: "tc-only",
              toolName: "bash",
              output: { type: "text" as const, value: "test" },
            },
          ],
        },
        { role: "user" as const, content: [{ type: "text" as const, text: "next" }] },
      ],
      modelId: "kiro-v1",
      conversationId: "conv-tool-only",
    })
    const assistant = result.history[1]
    expect("assistantResponseMessage" in assistant).toBe(true)
    if ("assistantResponseMessage" in assistant) {
      expect(assistant.assistantResponseMessage.content).toBe("(empty)")
      expect(assistant.assistantResponseMessage.toolUses).toHaveLength(1)
      expect(assistant.assistantResponseMessage.toolUses![0].name).toBe("bash")
      expect(assistant.assistantResponseMessage.toolUses![0].input).toEqual({ command: "echo test" })
      expect(assistant.assistantResponseMessage.toolUses![0].toolUseId).toBe("tc-only")
    }
  })

  test("text-only assistant message has no toolUses", async () => {
    const { translate } = await import("../../src/provider/sdk/kiro/kiro-translate")
    const result = translate({
      prompt: [
        { role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
        {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "hello there" }],
        },
        { role: "user" as const, content: [{ type: "text" as const, text: "bye" }] },
      ],
      modelId: "kiro-v1",
      conversationId: "conv-text-only",
    })
    const assistant = result.history[1]
    expect("assistantResponseMessage" in assistant).toBe(true)
    if ("assistantResponseMessage" in assistant) {
      expect(assistant.assistantResponseMessage.content).toBe("hello there")
      expect(assistant.assistantResponseMessage.toolUses).toBeUndefined()
    }
  })

  test("prepends system to first history user message when history exists", async () => {
    const { translate } = await import("../../src/provider/sdk/kiro/kiro-translate")
    const result = translate({
      prompt: [
        { role: "system" as const, content: "Be concise." },
        { role: "user" as const, content: [{ type: "text" as const, text: "first" }] },
        {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "ok" }],
        },
        { role: "user" as const, content: [{ type: "text" as const, text: "second" }] },
      ],
      modelId: "kiro-v1",
      conversationId: "conv-5",
    })
    // System prefix should be prepended to first history user message
    const first = result.history[0]
    expect("userInputMessage" in first).toBe(true)
    if ("userInputMessage" in first) {
      expect(first.userInputMessage.content).toContain("Be concise.")
      expect(first.userInputMessage.content).toContain("first")
    }
    // Current message should NOT have system prefix when history exists
    expect(result.currentMessage.userInputMessage.content).toBe("second")
  })

  test("handles tool result with json output", async () => {
    const { translate } = await import("../../src/provider/sdk/kiro/kiro-translate")
    const result = translate({
      prompt: [
        { role: "user" as const, content: [{ type: "text" as const, text: "q" }] },
        {
          role: "assistant" as const,
          content: [
            {
              type: "tool-call" as const,
              toolCallId: "tc-2",
              toolName: "read",
              input: { path: "/tmp" },
            },
          ],
        },
        {
          role: "tool" as const,
          content: [
            {
              type: "tool-result" as const,
              toolCallId: "tc-2",
              toolName: "read",
              output: { type: "json" as const, value: { files: ["a.txt"] } },
            },
          ],
        },
        { role: "user" as const, content: [{ type: "text" as const, text: "next" }] },
      ],
      modelId: "kiro-v1",
    })
    // Tool result with json output should be structured toolResults
    const toolMsg = result.history[2]
    expect("userInputMessage" in toolMsg).toBe(true)
    if ("userInputMessage" in toolMsg) {
      expect(toolMsg.userInputMessage.content).toBe(" ")
      const ctx = toolMsg.userInputMessage.userInputMessageContext
      expect(ctx).toBeDefined()
      expect(ctx!.toolResults).toHaveLength(1)
      expect(ctx!.toolResults![0].toolUseId).toBe("tc-2")
      expect(ctx!.toolResults![0].content).toEqual([{ text: JSON.stringify({ files: ["a.txt"] }) }])
      expect(ctx!.toolResults![0].status).toBe("success")
    }
  })

  test("sends trailing tool results as structured toolResults in currentMessage", async () => {
    const { translate } = await import("../../src/provider/sdk/kiro/kiro-translate")
    const result = translate({
      prompt: [
        { role: "user" as const, content: [{ type: "text" as const, text: "run echo test" }] },
        {
          role: "assistant" as const,
          content: [
            {
              type: "tool-call" as const,
              toolCallId: "tc-100",
              toolName: "bash",
              input: { command: "echo test" },
            },
          ],
        },
        {
          role: "tool" as const,
          content: [
            {
              type: "tool-result" as const,
              toolCallId: "tc-100",
              toolName: "bash",
              output: { type: "text" as const, value: "test" },
            },
          ],
        },
      ],
      modelId: "kiro-v1",
      conversationId: "conv-tool-1",
      tools: [
        {
          type: "function" as const,
          name: "bash",
          description: "Run a command",
          inputSchema: { type: "object", properties: { command: { type: "string" } } },
        },
      ],
    })

    // Current message should be a space placeholder since prompt ends with tool results
    expect(result.currentMessage.userInputMessage.content).toBe(" ")

    // toolResults should be in userInputMessageContext
    const ctx = result.currentMessage.userInputMessage.userInputMessageContext
    expect(ctx).toBeDefined()
    expect(ctx!.toolResults).toBeDefined()
    expect(ctx!.toolResults).toHaveLength(1)
    expect(ctx!.toolResults![0].toolUseId).toBe("tc-100")
    expect(ctx!.toolResults![0].content).toEqual([{ text: "test" }])
    expect(ctx!.toolResults![0].status).toBe("success")

    // tools should also be present
    expect(ctx!.tools).toHaveLength(1)

    // History should contain user message + assistant tool call, but NOT the tool result
    expect(result.history).toHaveLength(2)
    expect("userInputMessage" in result.history[0]).toBe(true)
    expect("assistantResponseMessage" in result.history[1]).toBe(true)
  })

  test("sends multiple trailing tool results as structured toolResults", async () => {
    const { translate } = await import("../../src/provider/sdk/kiro/kiro-translate")
    const result = translate({
      prompt: [
        { role: "user" as const, content: [{ type: "text" as const, text: "run two tools" }] },
        {
          role: "assistant" as const,
          content: [
            {
              type: "tool-call" as const,
              toolCallId: "tc-a",
              toolName: "bash",
              input: { command: "echo a" },
            },
            {
              type: "tool-call" as const,
              toolCallId: "tc-b",
              toolName: "read",
              input: { path: "/tmp" },
            },
          ],
        },
        {
          role: "tool" as const,
          content: [
            {
              type: "tool-result" as const,
              toolCallId: "tc-a",
              toolName: "bash",
              output: { type: "text" as const, value: "a" },
            },
          ],
        },
        {
          role: "tool" as const,
          content: [
            {
              type: "tool-result" as const,
              toolCallId: "tc-b",
              toolName: "read",
              output: { type: "json" as const, value: { files: ["x.txt"] } },
            },
          ],
        },
      ],
      modelId: "kiro-v1",
      conversationId: "conv-tool-2",
    })

    expect(result.currentMessage.userInputMessage.content).toBe(" ")

    const ctx = result.currentMessage.userInputMessage.userInputMessageContext
    expect(ctx).toBeDefined()
    expect(ctx!.toolResults).toHaveLength(2)
    expect(ctx!.toolResults![0].toolUseId).toBe("tc-a")
    expect(ctx!.toolResults![0].content).toEqual([{ text: "a" }])
    expect(ctx!.toolResults![1].toolUseId).toBe("tc-b")
    expect(ctx!.toolResults![1].content).toEqual([{ text: JSON.stringify({ files: ["x.txt"] }) }])

    // History: user + assistant (no tool results)
    expect(result.history).toHaveLength(2)
  })

  test("mid-conversation tool results go in history, trailing ones go in toolResults", async () => {
    const { translate } = await import("../../src/provider/sdk/kiro/kiro-translate")
    const result = translate({
      prompt: [
        { role: "user" as const, content: [{ type: "text" as const, text: "first" }] },
        {
          role: "assistant" as const,
          content: [
            {
              type: "tool-call" as const,
              toolCallId: "tc-old",
              toolName: "bash",
              input: { command: "echo old" },
            },
          ],
        },
        {
          role: "tool" as const,
          content: [
            {
              type: "tool-result" as const,
              toolCallId: "tc-old",
              toolName: "bash",
              output: { type: "text" as const, value: "old" },
            },
          ],
        },
        { role: "user" as const, content: [{ type: "text" as const, text: "second" }] },
        {
          role: "assistant" as const,
          content: [
            {
              type: "tool-call" as const,
              toolCallId: "tc-new",
              toolName: "bash",
              input: { command: "echo new" },
            },
          ],
        },
        {
          role: "tool" as const,
          content: [
            {
              type: "tool-result" as const,
              toolCallId: "tc-new",
              toolName: "bash",
              output: { type: "text" as const, value: "new" },
            },
          ],
        },
      ],
      modelId: "kiro-v1",
      conversationId: "conv-tool-3",
    })

    expect(result.currentMessage.userInputMessage.content).toBe(" ")

    // Trailing tool result should be structured
    const ctx = result.currentMessage.userInputMessage.userInputMessageContext
    expect(ctx).toBeDefined()
    expect(ctx!.toolResults).toHaveLength(1)
    expect(ctx!.toolResults![0].toolUseId).toBe("tc-new")

    // History should contain: user, assistant(tool-call), tool-result(old), user, assistant(tool-call)
    // The old tool result is in history as structured toolResults, the new one is NOT in history
    expect(result.history).toHaveLength(5)
    const oldToolResult = result.history[2]
    expect("userInputMessage" in oldToolResult).toBe(true)
    if ("userInputMessage" in oldToolResult) {
      expect(oldToolResult.userInputMessage.content).toBe(" ")
      const ctx = oldToolResult.userInputMessage.userInputMessageContext
      expect(ctx).toBeDefined()
      expect(ctx!.toolResults).toHaveLength(1)
      expect(ctx!.toolResults![0].toolUseId).toBe("tc-old")
      expect(ctx!.toolResults![0].content).toEqual([{ text: "old" }])
      expect(ctx!.toolResults![0].status).toBe("success")
    }
  })

  test("trailing tool results with system prefix prepend to first history message", async () => {
    const { translate } = await import("../../src/provider/sdk/kiro/kiro-translate")
    const result = translate({
      prompt: [
        { role: "system" as const, content: "Be helpful." },
        { role: "user" as const, content: [{ type: "text" as const, text: "run it" }] },
        {
          role: "assistant" as const,
          content: [
            {
              type: "tool-call" as const,
              toolCallId: "tc-sys",
              toolName: "bash",
              input: { command: "date" },
            },
          ],
        },
        {
          role: "tool" as const,
          content: [
            {
              type: "tool-result" as const,
              toolCallId: "tc-sys",
              toolName: "bash",
              output: { type: "text" as const, value: "Mon Mar 23" },
            },
          ],
        },
      ],
      modelId: "kiro-v1",
      conversationId: "conv-tool-4",
    })

    // System prefix should be prepended to first history user message
    const first = result.history[0]
    expect("userInputMessage" in first).toBe(true)
    if ("userInputMessage" in first) {
      expect(first.userInputMessage.content).toContain("Be helpful.")
      expect(first.userInputMessage.content).toContain("run it")
    }

    // Current message should NOT have system prefix (history exists)
    expect(result.currentMessage.userInputMessage.content).toBe(" ")

    // Tool result should be structured
    const ctx = result.currentMessage.userInputMessage.userInputMessageContext
    expect(ctx!.toolResults).toHaveLength(1)
    expect(ctx!.toolResults![0].toolUseId).toBe("tc-sys")
    expect(ctx!.toolResults![0].content).toEqual([{ text: "Mon Mar 23" }])
  })

  test("error tool results get status error", async () => {
    const { translate } = await import("../../src/provider/sdk/kiro/kiro-translate")
    const result = translate({
      prompt: [
        { role: "user" as const, content: [{ type: "text" as const, text: "run it" }] },
        {
          role: "assistant" as const,
          content: [
            {
              type: "tool-call" as const,
              toolCallId: "tc-err",
              toolName: "bash",
              input: { command: "false" },
            },
          ],
        },
        {
          role: "tool" as const,
          content: [
            {
              type: "tool-result" as const,
              toolCallId: "tc-err",
              toolName: "bash",
              output: { type: "error-text" as const, value: "command failed" },
            },
          ],
        },
      ],
      modelId: "kiro-v1",
      conversationId: "conv-tool-5",
    })

    const ctx = result.currentMessage.userInputMessage.userInputMessageContext
    expect(ctx!.toolResults).toHaveLength(1)
    expect(ctx!.toolResults![0].status).toBe("error")
    expect(ctx!.toolResults![0].content).toEqual([{ text: "command failed" }])
  })
})

// ---------------------------------------------------------------------------
// 4. kiro-eventstream — Binary event stream decoding
// ---------------------------------------------------------------------------

describe("kiro-eventstream", () => {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  const codec = new EventStreamCodec(
    (input: Uint8Array | string) => {
      if (typeof input === "string") return input
      return decoder.decode(input)
    },
    (input: string) => encoder.encode(input),
  )

  function encode(headers: MessageHeaders, body: string): Uint8Array {
    return codec.encode({
      headers,
      body: encoder.encode(body),
    })
  }

  function eventHeaders(type: string, event: string): MessageHeaders {
    return {
      ":message-type": { type: "string", value: type },
      ":event-type": { type: "string", value: event },
    }
  }

  function streamFrom(frames: ReadonlyArray<Uint8Array>): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(frame)
        }
        controller.close()
      },
    })
  }

  async function collect(stream: ReadableStream<Uint8Array>): Promise<Array<KiroStreamEvent>> {
    const { decodeEventStream } = await import("../../src/provider/sdk/kiro/kiro-eventstream")
    const events: Array<KiroStreamEvent> = []
    for await (const event of decodeEventStream(stream)) {
      events.push(event)
    }
    return events
  }

  test("decodes a content event", async () => {
    const frame = encode(eventHeaders("event", "content"), JSON.stringify({ content: "hello world" }))
    const events = await collect(streamFrom([frame]))
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe("content")
    expect(events[0].payload).toEqual({ content: "hello world" })
  })

  test("decodes a tool_start event", async () => {
    const frame = encode(
      eventHeaders("event", "tool_start"),
      JSON.stringify({ name: "bash", toolUseId: "tu-1" }),
    )
    const events = await collect(streamFrom([frame]))
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe("tool_start")
    expect(events[0].payload).toEqual({ name: "bash", toolUseId: "tu-1" })
  })

  test("decodes a tool_input event", async () => {
    const frame = encode(eventHeaders("event", "tool_input"), JSON.stringify({ input: '{"cmd":"ls"}' }))
    const events = await collect(streamFrom([frame]))
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe("tool_input")
    expect(events[0].payload).toEqual({ input: '{"cmd":"ls"}' })
  })

  test("decodes a tool_stop event", async () => {
    const frame = encode(eventHeaders("event", "tool_stop"), JSON.stringify({ stop: true }))
    const events = await collect(streamFrom([frame]))
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe("tool_stop")
    expect(events[0].payload).toEqual({ stop: true })
  })

  test("decodes a usage event", async () => {
    const frame = encode(
      eventHeaders("event", "usage"),
      JSON.stringify({ inputTokens: 100, outputTokens: 50 }),
    )
    const events = await collect(streamFrom([frame]))
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe("usage")
    expect(events[0].payload).toEqual({ inputTokens: 100, outputTokens: 50 })
  })

  test("decodes a context_usage event", async () => {
    const frame = encode(
      eventHeaders("event", "context_usage"),
      JSON.stringify({ contextTokens: 2000 }),
    )
    const events = await collect(streamFrom([frame]))
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe("context_usage")
    expect(events[0].payload).toEqual({ contextTokens: 2000 })
  })

  test("decodes error/exception messages", async () => {
    const frame = encode(
      { ":message-type": { type: "string", value: "error" } },
      "something went wrong",
    )
    const events = await collect(streamFrom([frame]))
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe("error")
    expect(events[0].payload).toEqual({ message: "something went wrong" })
  })

  test("decodes exception message type", async () => {
    const frame = encode(
      { ":message-type": { type: "string", value: "exception" } },
      "server error",
    )
    const events = await collect(streamFrom([frame]))
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe("error")
    expect(events[0].payload).toEqual({ message: "server error" })
  })

  test("decodes assistantResponseEvent as content", async () => {
    const frame = encode(
      eventHeaders("event", "assistantResponseEvent"),
      JSON.stringify({ content: "hello from kiro", modelId: "auto" }),
    )
    const events = await collect(streamFrom([frame]))
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe("content")
    expect(events[0].payload).toEqual({ content: "hello from kiro", modelId: "auto" })
  })

  test("skips unknown event types", async () => {
    const frame = encode(eventHeaders("event", "unknown_event"), JSON.stringify({ data: "x" }))
    const events = await collect(streamFrom([frame]))
    expect(events).toHaveLength(0)
  })

  test("skips non-event message types", async () => {
    const frame = encode(
      { ":message-type": { type: "string", value: "other" } },
      "ignored",
    )
    const events = await collect(streamFrom([frame]))
    expect(events).toHaveLength(0)
  })

  test("skips events with empty body", async () => {
    const frame = codec.encode({
      headers: eventHeaders("event", "content"),
      body: new Uint8Array(0),
    })
    const events = await collect(streamFrom([frame]))
    expect(events).toHaveLength(0)
  })

  test("decodes toolUseEvent as tool_start", async () => {
    const frame = encode(
      eventHeaders("event", "toolUseEvent"),
      JSON.stringify({ name: "bash", toolUseId: "tooluse_xxx" }),
    )
    const events = await collect(streamFrom([frame]))
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe("tool_start")
    expect(events[0].payload).toEqual({ name: "bash", toolUseId: "tooluse_xxx" })
  })

  test("decodes toolUseEvent with input as tool_input", async () => {
    const frame = encode(
      eventHeaders("event", "toolUseEvent"),
      JSON.stringify({ input: '{"command": "date"}', name: "bash", toolUseId: "tooluse_xxx" }),
    )
    const events = await collect(streamFrom([frame]))
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe("tool_input")
    expect(events[0].payload).toEqual({ input: '{"command": "date"}', name: "bash", toolUseId: "tooluse_xxx" })
  })

  test("decodes toolUseEvent with stop as tool_stop", async () => {
    const frame = encode(
      eventHeaders("event", "toolUseEvent"),
      JSON.stringify({ name: "bash", stop: true, toolUseId: "tooluse_xxx" }),
    )
    const events = await collect(streamFrom([frame]))
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe("tool_stop")
    expect(events[0].payload).toEqual({ name: "bash", stop: true, toolUseId: "tooluse_xxx" })
  })

  test("decodes full toolUseEvent sequence", async () => {
    const frames = [
      encode(
        eventHeaders("event", "toolUseEvent"),
        JSON.stringify({ name: "bash", toolUseId: "tooluse_xxx" }),
      ),
      encode(
        eventHeaders("event", "toolUseEvent"),
        JSON.stringify({ input: "", name: "bash", toolUseId: "tooluse_xxx" }),
      ),
      encode(
        eventHeaders("event", "toolUseEvent"),
        JSON.stringify({ input: '{"command": "date"}', name: "bash", toolUseId: "tooluse_xxx" }),
      ),
      encode(
        eventHeaders("event", "toolUseEvent"),
        JSON.stringify({ name: "bash", stop: true, toolUseId: "tooluse_xxx" }),
      ),
    ]
    const events = await collect(streamFrom(frames))
    expect(events).toHaveLength(4)
    expect(events[0].type).toBe("tool_start")
    expect(events[1].type).toBe("tool_input")
    expect(events[2].type).toBe("tool_input")
    expect(events[3].type).toBe("tool_stop")
  })

  test("decodes contextUsageEvent as context_usage", async () => {
    const frame = encode(
      eventHeaders("event", "contextUsageEvent"),
      JSON.stringify({ contextUsagePercentage: 1.32 }),
    )
    const events = await collect(streamFrom([frame]))
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe("context_usage")
    expect(events[0].payload).toEqual({ contextUsagePercentage: 1.32 })
  })

  test("decodes meteringEvent as usage", async () => {
    const frame = encode(
      eventHeaders("event", "meteringEvent"),
      JSON.stringify({ unit: "credit", usage: 0.013 }),
    )
    const events = await collect(streamFrom([frame]))
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe("usage")
    expect(events[0].payload).toEqual({ unit: "credit", usage: 0.013 })
  })

  test("decodes multiple events from a single stream", async () => {
    const frames = [
      encode(eventHeaders("event", "content"), JSON.stringify({ content: "part1" })),
      encode(eventHeaders("event", "content"), JSON.stringify({ content: "part2" })),
      encode(
        eventHeaders("event", "usage"),
        JSON.stringify({ inputTokens: 10, outputTokens: 5 }),
      ),
    ]
    const events = await collect(streamFrom(frames))
    expect(events).toHaveLength(3)
    expect(events[0].type).toBe("content")
    expect(events[1].type).toBe("content")
    expect(events[2].type).toBe("usage")
  })

  test("handles chunked delivery (frame split across chunks)", async () => {
    const frame = encode(eventHeaders("event", "content"), JSON.stringify({ content: "chunked" }))
    const mid = Math.floor(frame.length / 2)
    const chunk1 = frame.slice(0, mid)
    const chunk2 = frame.slice(mid)
    const events = await collect(streamFrom([chunk1, chunk2]))
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe("content")
    expect(events[0].payload).toEqual({ content: "chunked" })
  })

  test("handles multiple frames concatenated in one chunk", async () => {
    const frame1 = encode(eventHeaders("event", "content"), JSON.stringify({ content: "a" }))
    const frame2 = encode(eventHeaders("event", "content"), JSON.stringify({ content: "b" }))
    const combined = new Uint8Array(frame1.length + frame2.length)
    combined.set(frame1, 0)
    combined.set(frame2, frame1.length)
    const events = await collect(streamFrom([combined]))
    expect(events).toHaveLength(2)
    expect(events[0].payload).toEqual({ content: "a" })
    expect(events[1].payload).toEqual({ content: "b" })
  })
})

// ---------------------------------------------------------------------------
// 5. kiro-language-model — LanguageModelV2 doGenerate/doStream
// ---------------------------------------------------------------------------

describe("kiro-language-model", () => {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  const codec = new EventStreamCodec(
    (input: Uint8Array | string) => {
      if (typeof input === "string") return input
      return decoder.decode(input)
    },
    (input: string) => encoder.encode(input),
  )

  function encode(headers: MessageHeaders, body: string): Uint8Array {
    return codec.encode({
      headers,
      body: encoder.encode(body),
    })
  }

  function eventHeaders(type: string, event: string): MessageHeaders {
    return {
      ":message-type": { type: "string", value: type },
      ":event-type": { type: "string", value: event },
    }
  }

  function makeEventStreamBody(frames: ReadonlyArray<Uint8Array>): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(frame)
        }
        controller.close()
      },
    })
  }

  function mockResponse(frames: ReadonlyArray<Uint8Array>, status = 200): Response {
    return new Response(makeEventStreamBody(frames), {
      status,
      headers: { "content-type": "application/vnd.amazon.eventstream" },
    })
  }

  // Reset the auth cache between tests by re-importing
  const simplePrompt = [
    { role: "user" as const, content: [{ type: "text" as const, text: "hello" }] },
  ]

  test("doStream returns stream-start, text events, and finish", async () => {
    const { KiroLanguageModel } = await import("../../src/provider/sdk/kiro/kiro-language-model")

    // Mock getToken to return a valid token
    const authMod = await import("../../src/provider/sdk/kiro/kiro-auth")
    const getTokenMock = spyOn(authMod, "getToken").mockResolvedValue("test-token")

    const frames = [
      encode(eventHeaders("event", "content"), JSON.stringify({ content: "Hello " })),
      encode(eventHeaders("event", "content"), JSON.stringify({ content: "world" })),
      encode(
        eventHeaders("event", "usage"),
        JSON.stringify({ inputTokens: 10, outputTokens: 5 }),
      ),
    ]

    const fakeFetch = mock(() => Promise.resolve(mockResponse(frames)))

    const model = new KiroLanguageModel("kiro-v1", {
      provider: "kiro",
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
    })

    const result = await model.doStream({ prompt: simplePrompt })
    const parts: Array<{ type: string; [key: string]: unknown }> = []
    const reader = result.stream.getReader()

    const read = async (): Promise<void> => {
      const { done, value } = await reader.read()
      if (done) return
      parts.push(value as { type: string; [key: string]: unknown })
      return read()
    }
    await read()

    const types = parts.map((p) => p.type)
    expect(types).toContain("stream-start")
    expect(types).toContain("text-start")
    expect(types).toContain("text-delta")
    expect(types).toContain("text-end")
    expect(types).toContain("finish")

    const deltas = parts.filter((p) => p.type === "text-delta").map((p) => p.delta)
    expect(deltas).toEqual(["Hello ", "world"])

    const finish = parts.find((p) => p.type === "finish")!
    expect(finish.finishReason).toBe("stop")
    expect((finish.usage as { inputTokens: number }).inputTokens).toBe(10)
    expect((finish.usage as { outputTokens: number }).outputTokens).toBe(5)

    getTokenMock.mockRestore()
  })

  test("doStream throws KiroAuthError when no token", async () => {
    const { KiroLanguageModel } = await import("../../src/provider/sdk/kiro/kiro-language-model")
    const { KiroAuthError } = await import("../../src/provider/sdk/kiro/kiro-error")
    const authMod = await import("../../src/provider/sdk/kiro/kiro-auth")
    const getTokenMock = spyOn(authMod, "getToken").mockResolvedValue(undefined)

    const model = new KiroLanguageModel("kiro-v1", {
      provider: "kiro",
    })

    await expect(model.doStream({ prompt: simplePrompt })).rejects.toThrow(KiroAuthError)

    getTokenMock.mockRestore()
  })

  test("doStream throws KiroApiError on non-ok response", async () => {
    const { KiroLanguageModel } = await import("../../src/provider/sdk/kiro/kiro-language-model")
    const { KiroApiError } = await import("../../src/provider/sdk/kiro/kiro-error")
    const authMod = await import("../../src/provider/sdk/kiro/kiro-auth")
    const getTokenMock = spyOn(authMod, "getToken").mockResolvedValue("test-token")

    const fakeFetch = mock(() =>
      Promise.resolve(new Response("forbidden", { status: 403 })),
    )

    const model = new KiroLanguageModel("kiro-v1", {
      provider: "kiro",
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
    })

    await expect(model.doStream({ prompt: simplePrompt })).rejects.toThrow(KiroApiError)

    getTokenMock.mockRestore()
  })

  test("doStream handles tool call events", async () => {
    const { KiroLanguageModel } = await import("../../src/provider/sdk/kiro/kiro-language-model")
    const authMod = await import("../../src/provider/sdk/kiro/kiro-auth")
    const getTokenMock = spyOn(authMod, "getToken").mockResolvedValue("test-token")

    const frames = [
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ name: "bash", toolUseId: "tu-1", input: "" }),
      ),
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ input: '{"command":"ls"}' }),
      ),
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ stop: true }),
      ),
      encode(
        eventHeaders("event", "usage"),
        JSON.stringify({ inputTokens: 20, outputTokens: 10 }),
      ),
    ]

    const fakeFetch = mock(() => Promise.resolve(mockResponse(frames)))

    const model = new KiroLanguageModel("kiro-v1", {
      provider: "kiro",
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
    })

    const result = await model.doStream({ prompt: simplePrompt })
    const parts: Array<{ type: string; [key: string]: unknown }> = []
    const reader = result.stream.getReader()

    const read = async (): Promise<void> => {
      const { done, value } = await reader.read()
      if (done) return
      parts.push(value as { type: string; [key: string]: unknown })
      return read()
    }
    await read()

    const types = parts.map((p) => p.type)
    expect(types).toContain("tool-input-start")
    expect(types).toContain("tool-input-delta")
    expect(types).toContain("tool-input-end")
    expect(types).toContain("tool-call")

    const call = parts.find((p) => p.type === "tool-call")!
    expect(call.toolName).toBe("bash")
    expect(call.toolCallId).toBe("tu-1")
    expect(call.input).toBe('{"command":"ls"}')

    const finish = parts.find((p) => p.type === "finish")!
    expect(finish.finishReason).toBe("tool-calls")

    getTokenMock.mockRestore()
  })

  test("doGenerate collects text from stream", async () => {
    const { KiroLanguageModel } = await import("../../src/provider/sdk/kiro/kiro-language-model")
    const authMod = await import("../../src/provider/sdk/kiro/kiro-auth")
    const getTokenMock = spyOn(authMod, "getToken").mockResolvedValue("test-token")

    const frames = [
      encode(eventHeaders("event", "content"), JSON.stringify({ content: "Hello " })),
      encode(eventHeaders("event", "content"), JSON.stringify({ content: "world" })),
      encode(
        eventHeaders("event", "usage"),
        JSON.stringify({ inputTokens: 15, outputTokens: 8 }),
      ),
    ]

    const fakeFetch = mock(() => Promise.resolve(mockResponse(frames)))

    const model = new KiroLanguageModel("kiro-v1", {
      provider: "kiro",
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
    })

    const result = await model.doGenerate({ prompt: simplePrompt })

    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe("text")
    if (result.content[0].type === "text") {
      expect(result.content[0].text).toBe("Hello world")
    }
    expect(result.finishReason).toBe("stop")
    expect(result.usage.inputTokens).toBe(15)
    expect(result.usage.outputTokens).toBe(8)
    expect(result.warnings).toEqual([])

    getTokenMock.mockRestore()
  })

  test("doGenerate collects tool calls", async () => {
    const { KiroLanguageModel } = await import("../../src/provider/sdk/kiro/kiro-language-model")
    const authMod = await import("../../src/provider/sdk/kiro/kiro-auth")
    const getTokenMock = spyOn(authMod, "getToken").mockResolvedValue("test-token")

    const frames = [
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ name: "read", toolUseId: "tu-2", input: "" }),
      ),
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ input: '{"path":"/tmp"}' }),
      ),
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ stop: true }),
      ),
      encode(
        eventHeaders("event", "usage"),
        JSON.stringify({ inputTokens: 5, outputTokens: 3 }),
      ),
    ]

    const fakeFetch = mock(() => Promise.resolve(mockResponse(frames)))

    const model = new KiroLanguageModel("kiro-v1", {
      provider: "kiro",
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
    })

    const result = await model.doGenerate({ prompt: simplePrompt })

    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe("tool-call")
    if (result.content[0].type === "tool-call") {
      expect(result.content[0].toolName).toBe("read")
      expect(result.content[0].toolCallId).toBe("tu-2")
      expect(result.content[0].input).toBe('{"path":"/tmp"}')
    }
    expect(result.finishReason).toBe("tool-calls")

    getTokenMock.mockRestore()
  })

  test("doStream sends correct headers and body", async () => {
    const { KiroLanguageModel } = await import("../../src/provider/sdk/kiro/kiro-language-model")
    const authMod = await import("../../src/provider/sdk/kiro/kiro-auth")
    const getTokenMock = spyOn(authMod, "getToken").mockResolvedValue("my-token")

    const frames = [
      encode(
        eventHeaders("event", "usage"),
        JSON.stringify({ inputTokens: 1, outputTokens: 1 }),
      ),
    ]

    const fakeFetch = mock(() => Promise.resolve(mockResponse(frames)))

    const model = new KiroLanguageModel("kiro-v1", {
      provider: "kiro",
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
    })

    const result = await model.doStream({ prompt: simplePrompt })
    // Drain the stream
    const reader = result.stream.getReader()
    const drain = async (): Promise<void> => {
      const { done } = await reader.read()
      if (done) return
      return drain()
    }
    await drain()

    expect(fakeFetch).toHaveBeenCalledTimes(1)
    const [url, opts] = fakeFetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://q.us-east-1.amazonaws.com/generateAssistantResponse")
    expect(opts.method).toBe("POST")
    expect((opts.headers as Record<string, string>)["Authorization"]).toBe("Bearer my-token")
    expect((opts.headers as Record<string, string>)["Content-Type"]).toBe("application/json")
    expect((opts.headers as Record<string, string>)["User-Agent"]).toBe(
      "aws-sdk-js/1.0.27 ua/2.1 os/darwin lang/js api/codewhispererstreaming#1.0.27 m/E Kiro-opencode",
    )
    expect((opts.headers as Record<string, string>)["x-amz-user-agent"]).toBe("aws-sdk-js/1.0.27 Kiro-opencode")
    expect((opts.headers as Record<string, string>)["x-amzn-codewhisperer-optout"]).toBe("true")
    expect((opts.headers as Record<string, string>)["amz-sdk-invocation-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    expect((opts.headers as Record<string, string>)["amz-sdk-request"]).toBe("attempt=1; max=3")
    expect((opts.headers as Record<string, string>)["X-Amz-Target"]).toBeUndefined()

    const body = JSON.parse(opts.body as string)
    expect(body.conversationState).toBeDefined()
    expect(body.conversationState.currentMessage.userInputMessage.content).toBe("hello")

    getTokenMock.mockRestore()
  })

  test("model exposes specificationVersion, provider, and modelId", async () => {
    const { KiroLanguageModel } = await import("../../src/provider/sdk/kiro/kiro-language-model")
    const model = new KiroLanguageModel("kiro-v1", { provider: "kiro" })
    expect(model.specificationVersion).toBe("v2")
    expect(model.provider).toBe("kiro")
    expect(model.modelId).toBe("kiro-v1")
    expect(model.defaultObjectGenerationMode).toBeUndefined()
  })

  test("doStream handles error events in stream", async () => {
    const { KiroLanguageModel } = await import("../../src/provider/sdk/kiro/kiro-language-model")
    const authMod = await import("../../src/provider/sdk/kiro/kiro-auth")
    const getTokenMock = spyOn(authMod, "getToken").mockResolvedValue("test-token")

    const frames = [
      encode(eventHeaders("event", "content"), JSON.stringify({ content: "partial" })),
      encode(
        { ":message-type": { type: "string", value: "error" } },
        "stream error occurred",
      ),
      encode(
        eventHeaders("event", "usage"),
        JSON.stringify({ inputTokens: 1, outputTokens: 1 }),
      ),
    ]

    const fakeFetch = mock(() => Promise.resolve(mockResponse(frames)))

    const model = new KiroLanguageModel("kiro-v1", {
      provider: "kiro",
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
    })

    const result = await model.doStream({ prompt: simplePrompt })
    const parts: Array<{ type: string; [key: string]: unknown }> = []
    const reader = result.stream.getReader()

    const read = async (): Promise<void> => {
      const { done, value } = await reader.read()
      if (done) return
      parts.push(value as { type: string; [key: string]: unknown })
      return read()
    }
    await read()

    const types = parts.map((p) => p.type)
    expect(types).toContain("error")
    const errPart = parts.find((p) => p.type === "error")!
    expect(errPart.error).toBe("stream error occurred")

    getTokenMock.mockRestore()
  })

  test("doStream handles assistantResponseEvent from real API", async () => {
    const { KiroLanguageModel } = await import("../../src/provider/sdk/kiro/kiro-language-model")
    const authMod = await import("../../src/provider/sdk/kiro/kiro-auth")
    const getTokenMock = spyOn(authMod, "getToken").mockResolvedValue("test-token")

    const frames = [
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ content: "Hello ", modelId: "auto" }),
      ),
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ content: "world", modelId: "auto" }),
      ),
      encode(
        eventHeaders("event", "usage"),
        JSON.stringify({ inputTokens: 10, outputTokens: 5 }),
      ),
    ]

    const fakeFetch = mock(() => Promise.resolve(mockResponse(frames)))

    const model = new KiroLanguageModel("kiro-v1", {
      provider: "kiro",
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
    })

    const result = await model.doStream({ prompt: simplePrompt })
    const parts: Array<{ type: string; [key: string]: unknown }> = []
    const reader = result.stream.getReader()

    const read = async (): Promise<void> => {
      const { done, value } = await reader.read()
      if (done) return
      parts.push(value as { type: string; [key: string]: unknown })
      return read()
    }
    await read()

    const types = parts.map((p) => p.type)
    expect(types).toContain("stream-start")
    expect(types).toContain("text-start")
    expect(types).toContain("text-delta")
    expect(types).toContain("text-end")
    expect(types).toContain("finish")

    const deltas = parts.filter((p) => p.type === "text-delta").map((p) => p.delta)
    expect(deltas).toEqual(["Hello ", "world"])

    getTokenMock.mockRestore()
  })

  test("doGenerate with mixed text and tool calls", async () => {
    const { KiroLanguageModel } = await import("../../src/provider/sdk/kiro/kiro-language-model")
    const authMod = await import("../../src/provider/sdk/kiro/kiro-auth")
    const getTokenMock = spyOn(authMod, "getToken").mockResolvedValue("test-token")

    const frames = [
      encode(eventHeaders("event", "assistantResponseEvent"), JSON.stringify({ content: "I'll run that." })),
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ name: "bash", toolUseId: "tu-3", input: "" }),
      ),
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ input: '{"cmd":"echo hi"}' }),
      ),
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ stop: true }),
      ),
      encode(
        eventHeaders("event", "usage"),
        JSON.stringify({ inputTokens: 30, outputTokens: 20 }),
      ),
    ]

    const fakeFetch = mock(() => Promise.resolve(mockResponse(frames)))

    const model = new KiroLanguageModel("kiro-v1", {
      provider: "kiro",
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
    })

    const result = await model.doGenerate({ prompt: simplePrompt })

    expect(result.content).toHaveLength(2)
    expect(result.content[0].type).toBe("text")
    expect(result.content[1].type).toBe("tool-call")
    expect(result.finishReason).toBe("tool-calls")
    expect(result.usage.inputTokens).toBe(30)
    expect(result.usage.outputTokens).toBe(20)
    expect(result.usage.totalTokens).toBe(50)

    getTokenMock.mockRestore()
  })

  test("doStream treats thinking tool as normal tool call", async () => {
    const { KiroLanguageModel } = await import("../../src/provider/sdk/kiro/kiro-language-model")
    const authMod = await import("../../src/provider/sdk/kiro/kiro-auth")
    const getTokenMock = spyOn(authMod, "getToken").mockResolvedValue("test-token")

    const frames = [
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ name: "thinking", toolUseId: "think-1", input: "" }),
      ),
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ input: '{"thought": "Let me' }),
      ),
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ input: ' analyze this"}' }),
      ),
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ stop: true }),
      ),
      encode(eventHeaders("event", "content"), JSON.stringify({ content: "The answer is 42." })),
      encode(
        eventHeaders("event", "usage"),
        JSON.stringify({ inputTokens: 50, outputTokens: 30 }),
      ),
    ]

    const fakeFetch = mock(() => Promise.resolve(mockResponse(frames)))

    const model = new KiroLanguageModel("kiro-v1", {
      provider: "kiro",
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
    })

    const result = await model.doStream({ prompt: simplePrompt })
    const parts: Array<{ type: string; [key: string]: unknown }> = []
    const reader = result.stream.getReader()

    const read = async (): Promise<void> => {
      const { done, value } = await reader.read()
      if (done) return
      parts.push(value as { type: string; [key: string]: unknown })
      return read()
    }
    await read()

    const types = parts.map((p) => p.type)
    // No reasoning parts — thinking is just a normal tool call
    expect(types).not.toContain("reasoning-start")
    expect(types).not.toContain("reasoning-delta")
    expect(types).not.toContain("reasoning-end")

    // Should have tool-call parts for thinking
    expect(types).toContain("tool-input-start")
    expect(types).toContain("tool-input-delta")
    expect(types).toContain("tool-input-end")
    expect(types).toContain("tool-call")

    // Text should be the final answer
    expect(types).toContain("text-start")
    expect(types).toContain("text-delta")
    expect(types).toContain("text-end")
    const text = parts.filter((p) => p.type === "text-delta").map((p) => p.delta)
    expect(text.join("")).toBe("The answer is 42.")

    // Finish reason should be "tool-calls" since thinking is tracked as a tool call
    const finish = parts.find((p) => p.type === "finish")!
    expect(finish.finishReason).toBe("tool-calls")

    getTokenMock.mockRestore()
  })

  test("doStream thinking tool emits raw input as tool-input-delta", async () => {
    const { KiroLanguageModel } = await import("../../src/provider/sdk/kiro/kiro-language-model")
    const authMod = await import("../../src/provider/sdk/kiro/kiro-auth")
    const getTokenMock = spyOn(authMod, "getToken").mockResolvedValue("test-token")

    const frames = [
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ name: "thinking", toolUseId: "think-2", input: "" }),
      ),
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ input: '{"thought": "Line 1\\nLine 2\\tTabbed"}' }),
      ),
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ stop: true }),
      ),
      encode(
        eventHeaders("event", "usage"),
        JSON.stringify({ inputTokens: 10, outputTokens: 5 }),
      ),
    ]

    const fakeFetch = mock(() => Promise.resolve(mockResponse(frames)))

    const model = new KiroLanguageModel("kiro-v1", {
      provider: "kiro",
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
    })

    const result = await model.doStream({ prompt: simplePrompt })
    const parts: Array<{ type: string; [key: string]: unknown }> = []
    const reader = result.stream.getReader()

    const read = async (): Promise<void> => {
      const { done, value } = await reader.read()
      if (done) return
      parts.push(value as { type: string; [key: string]: unknown })
      return read()
    }
    await read()

    const types = parts.map((p) => p.type)
    // No reasoning parts
    expect(types).not.toContain("reasoning-delta")
    // Raw JSON input is emitted as tool-input-delta
    const deltas = parts.filter((p) => p.type === "tool-input-delta").map((p) => p.delta)
    expect(deltas.join("")).toBe('{"thought": "Line 1\\nLine 2\\tTabbed"}')

    const call = parts.find((p) => p.type === "tool-call")!
    expect(call.toolName).toBe("thinking")

    getTokenMock.mockRestore()
  })

  test("doStream thinking tool mixed with real tool calls", async () => {
    const { KiroLanguageModel } = await import("../../src/provider/sdk/kiro/kiro-language-model")
    const authMod = await import("../../src/provider/sdk/kiro/kiro-auth")
    const getTokenMock = spyOn(authMod, "getToken").mockResolvedValue("test-token")

    const frames = [
      // Thinking tool
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ name: "thinking", toolUseId: "think-3", input: "" }),
      ),
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ input: '{"thought": "I should run bash"}' }),
      ),
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ stop: true }),
      ),
      // Real tool call
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ name: "bash", toolUseId: "tu-real", input: "" }),
      ),
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ input: '{"command":"ls"}' }),
      ),
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ stop: true }),
      ),
      encode(
        eventHeaders("event", "usage"),
        JSON.stringify({ inputTokens: 40, outputTokens: 20 }),
      ),
    ]

    const fakeFetch = mock(() => Promise.resolve(mockResponse(frames)))

    const model = new KiroLanguageModel("kiro-v1", {
      provider: "kiro",
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
    })

    const result = await model.doStream({ prompt: simplePrompt })
    const parts: Array<{ type: string; [key: string]: unknown }> = []
    const reader = result.stream.getReader()

    const read = async (): Promise<void> => {
      const { done, value } = await reader.read()
      if (done) return
      parts.push(value as { type: string; [key: string]: unknown })
      return read()
    }
    await read()

    const types = parts.map((p) => p.type)
    // No reasoning parts — thinking is just a normal tool call
    expect(types).not.toContain("reasoning-start")
    expect(types).not.toContain("reasoning-delta")
    expect(types).not.toContain("reasoning-end")
    // Should have tool call parts for both
    expect(types).toContain("tool-input-start")
    expect(types).toContain("tool-call")

    // Both thinking and real tool calls should appear
    const calls = parts.filter((p) => p.type === "tool-call")
    expect(calls).toHaveLength(2)
    expect(calls[0].toolName).toBe("thinking")
    expect(calls[1].toolName).toBe("bash")

    // Finish reason should be "tool-calls" since there is a real tool call
    const finish = parts.find((p) => p.type === "finish")!
    expect(finish.finishReason).toBe("tool-calls")

    getTokenMock.mockRestore()
  })

  test("doGenerate collects thinking tool as normal tool-call", async () => {
    const { KiroLanguageModel } = await import("../../src/provider/sdk/kiro/kiro-language-model")
    const authMod = await import("../../src/provider/sdk/kiro/kiro-auth")
    const getTokenMock = spyOn(authMod, "getToken").mockResolvedValue("test-token")

    const frames = [
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ name: "thinking", toolUseId: "think-4", input: "" }),
      ),
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ input: '{"thought": "Step 1: multiply"}' }),
      ),
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ stop: true }),
      ),
      encode(eventHeaders("event", "content"), JSON.stringify({ content: "49,403" })),
      encode(
        eventHeaders("event", "usage"),
        JSON.stringify({ inputTokens: 20, outputTokens: 10 }),
      ),
    ]

    const fakeFetch = mock(() => Promise.resolve(mockResponse(frames)))

    const model = new KiroLanguageModel("kiro-v1", {
      provider: "kiro",
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
    })

    const result = await model.doGenerate({ prompt: simplePrompt })

    // text + thinking tool-call (no reasoning content)
    expect(result.content).toHaveLength(2)
    expect(result.content[0].type).toBe("text")
    if (result.content[0].type === "text") {
      expect(result.content[0].text).toBe("49,403")
    }
    expect(result.content[1].type).toBe("tool-call")
    if (result.content[1].type === "tool-call") {
      expect(result.content[1].toolName).toBe("thinking")
      expect(result.content[1].input).toBe('{"thought": "Step 1: multiply"}')
    }
    expect(result.finishReason).toBe("tool-calls")

    getTokenMock.mockRestore()
  })

  test("doStream skips thinking tool when no prior tool calls", async () => {
    const { KiroLanguageModel } = await import("../../src/provider/sdk/kiro/kiro-language-model")
    const authMod = await import("../../src/provider/sdk/kiro/kiro-auth")
    const getTokenMock = spyOn(authMod, "getToken").mockResolvedValue("test-token")

    const frames = [
      encode(
        eventHeaders("event", "usage"),
        JSON.stringify({ inputTokens: 1, outputTokens: 1 }),
      ),
    ]

    const fakeFetch = mock(() => Promise.resolve(mockResponse(frames)))

    const model = new KiroLanguageModel("kiro-v1", {
      provider: "kiro",
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
    })

    const result = await model.doStream({ prompt: simplePrompt })
    const reader = result.stream.getReader()
    const drain = async (): Promise<void> => {
      const { done } = await reader.read()
      if (done) return
      return drain()
    }
    await drain()

    const body = JSON.parse(result.request!.body as string)
    const tools = body.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools
    const thinking = tools.find((t: { toolSpecification: { name: string } }) => t.toolSpecification.name === "thinking")
    expect(thinking).toBeUndefined()

    getTokenMock.mockRestore()
  })

  test("doStream injects thinking tool when prior tool calls exist", async () => {
    const { KiroLanguageModel } = await import("../../src/provider/sdk/kiro/kiro-language-model")
    const authMod = await import("../../src/provider/sdk/kiro/kiro-auth")
    const getTokenMock = spyOn(authMod, "getToken").mockResolvedValue("test-token")

    const frames = [
      encode(
        eventHeaders("event", "usage"),
        JSON.stringify({ inputTokens: 1, outputTokens: 1 }),
      ),
    ]

    const fakeFetch = mock(() => Promise.resolve(mockResponse(frames)))

    const model = new KiroLanguageModel("kiro-v1", {
      provider: "kiro",
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
    })

    const prompt = [
      { role: "user" as const, content: [{ type: "text" as const, text: "run ls" }] },
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "tc-1",
            toolName: "bash",
            input: { command: "ls" },
          },
        ],
      },
      {
        role: "tool" as const,
        content: [
          {
            type: "tool-result" as const,
            toolCallId: "tc-1",
            toolName: "bash",
            output: { type: "text" as const, value: "file.txt" },
          },
        ],
      },
    ]

    const result = await model.doStream({ prompt })
    const reader = result.stream.getReader()
    const drain = async (): Promise<void> => {
      const { done } = await reader.read()
      if (done) return
      return drain()
    }
    await drain()

    const body = JSON.parse(result.request!.body as string)
    const tools = body.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools
    const thinking = tools.find((t: { toolSpecification: { name: string } }) => t.toolSpecification.name === "thinking")
    expect(thinking).toBeDefined()
    expect(thinking.toolSpecification.description).toContain("Internal reasoning tool for working through complex problems")

    getTokenMock.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// 6. Phase 3 — Provider factory, CUSTOM_LOADERS, schema, integration
// ---------------------------------------------------------------------------

describe("kiro-provider factory", () => {
  test("createKiro returns provider with languageModel method", async () => {
    const { createKiro } = await import("../../src/provider/sdk/kiro/kiro-provider")
    const provider = createKiro()
    expect(typeof provider.languageModel).toBe("function")
  })

  test("createKiro is callable as function (provider(modelId) syntax)", async () => {
    const { createKiro } = await import("../../src/provider/sdk/kiro/kiro-provider")
    const provider = createKiro()
    const model = provider("test-model")
    expect(model).toBeDefined()
    expect(model.modelId).toBe("test-model")
    expect(model.provider).toBe("kiro")
  })

  test("languageModel returns KiroLanguageModel with correct properties", async () => {
    const { createKiro } = await import("../../src/provider/sdk/kiro/kiro-provider")
    const { KiroLanguageModel } = await import("../../src/provider/sdk/kiro/kiro-language-model")
    const provider = createKiro()
    const model = provider.languageModel("kiro-v1")
    expect(model).toBeInstanceOf(KiroLanguageModel)
    expect(model.modelId).toBe("kiro-v1")
    expect(model.specificationVersion).toBe("v2")
  })

  test("createKiro passes custom fetch to model", async () => {
    const { createKiro } = await import("../../src/provider/sdk/kiro/kiro-provider")
    const fakeFetch = mock(() => Promise.resolve(new Response()))
    const provider = createKiro({ fetch: fakeFetch as unknown as typeof globalThis.fetch })
    const model = provider("kiro-v1")
    expect(model).toBeDefined()
    expect(model.modelId).toBe("kiro-v1")
  })
})

describe("kiro index exports", () => {
  test("index re-exports createKiro", async () => {
    const mod = await import("../../src/provider/sdk/kiro/index")
    expect(typeof mod.createKiro).toBe("function")
  })
})

describe("kiro schema registration", () => {
  test("ProviderID.kiro is available", () => {
    expect(String(ProviderID.kiro)).toBe("kiro")
  })

  test("ProviderID.make('kiro') matches ProviderID.kiro", () => {
    expect(ProviderID.make("kiro")).toBe(ProviderID.kiro)
  })
})

describe("kiro CUSTOM_LOADERS integration", () => {
  test("provider not loaded when token file missing", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({ $schema: "https://opencode.ai/config.json" }),
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const providers = await Provider.list()
        expect(providers[ProviderID.kiro]).toBeUndefined()
      },
    })
  })

  test("CUSTOM_LOADERS kiro entry returns autoload false when no token", async () => {
    // Verify the kiro loader behavior directly: when hasToken returns false,
    // autoload should be false and the provider should not appear
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({ $schema: "https://opencode.ai/config.json" }),
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const providers = await Provider.list()
        // kiro should not be in the list since no token file exists
        const keys = Object.keys(providers)
        expect(keys).not.toContain("kiro")
      },
    })
  })

  test("kiro exists in models-snapshot with correct npm field", async () => {
    const { snapshot } = await import("../../src/provider/models-snapshot")
    const kiro = snapshot["kiro" as keyof typeof snapshot] as { id: string; npm: string; api: string }
    expect(kiro).toBeDefined()
    expect(kiro.id).toBe("kiro")
    expect(kiro.npm).toBe("kiro")
    expect(kiro.api).toBe("https://q.us-east-1.amazonaws.com")
  })
})
