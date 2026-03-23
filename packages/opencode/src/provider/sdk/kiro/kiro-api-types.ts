export interface KiroConversationState {
  readonly conversationId: string
  readonly currentMessage: KiroCurrentMessage
  readonly history: ReadonlyArray<KiroHistoryMessage>
  readonly chatTriggerType: "MANUAL"
}

export interface KiroCurrentMessage {
  readonly userInputMessage: KiroUserInputMessage
}

export interface KiroUserInputMessage {
  readonly content: string
  readonly modelId: string
  readonly origin: "AI_EDITOR"
  readonly userInputMessageContext?: KiroUserInputMessageContext
}

export interface KiroToolResult {
  readonly toolUseId: string
  readonly content: ReadonlyArray<{ readonly text: string }>
  readonly status: "success" | "error"
}

export interface KiroUserInputMessageContext {
  readonly tools?: ReadonlyArray<KiroToolSpec>
  readonly toolResults?: ReadonlyArray<KiroToolResult>
  readonly envState?: KiroEnvState
}

export interface KiroToolSpec {
  readonly toolSpecification: {
    readonly name: string
    readonly description: string
    readonly inputSchema: { readonly json: Record<string, unknown> }
  }
}

export interface KiroEnvState {
  readonly currentWorkingDirectory?: string
  readonly operatingSystem?: string
}

export interface KiroAssistantResponseMessage {
  readonly content: string
  readonly toolUses?: ReadonlyArray<{
    readonly name: string
    readonly input: Record<string, unknown>
    readonly toolUseId: string
  }>
}

export type KiroHistoryMessage =
  | { readonly userInputMessage: KiroUserInputMessage }
  | { readonly assistantResponseMessage: KiroAssistantResponseMessage }

export interface KiroGenerateRequest {
  readonly conversationState: KiroConversationState
  readonly profileArn?: string
}

export interface KiroListModelsRequest {
  readonly origin: "AI_EDITOR"
}

export interface KiroListModelsResponse {
  readonly models?: ReadonlyArray<KiroModelInfo>
}

export interface KiroModelInfo {
  readonly modelId: string
  readonly displayName?: string
  readonly contextWindow?: number
  readonly maxOutputTokens?: number
  readonly capabilities?: ReadonlyArray<string>
}

export interface KiroContentEvent {
  readonly content: string
  readonly modelId?: string
}

export interface KiroToolStartEvent {
  readonly name: string
  readonly toolUseId: string
  readonly input?: string
  readonly stop?: boolean
}

export interface KiroToolInputEvent {
  readonly input: string
}

export interface KiroToolStopEvent {
  readonly stop: boolean
}

export interface KiroUsageEvent {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
  readonly unit?: string
  readonly usage?: number
}

export interface KiroContextUsageEvent {
  readonly contextTokens?: number
  readonly contextUsagePercentage?: number
}

export type KiroStreamEvent =
  | { readonly type: "content"; readonly payload: KiroContentEvent }
  | { readonly type: "tool_start"; readonly payload: KiroToolStartEvent }
  | { readonly type: "tool_input"; readonly payload: KiroToolInputEvent }
  | { readonly type: "tool_stop"; readonly payload: KiroToolStopEvent }
  | { readonly type: "usage"; readonly payload: KiroUsageEvent }
  | { readonly type: "context_usage"; readonly payload: KiroContextUsageEvent }
  | { readonly type: "error"; readonly payload: { readonly message: string } }
