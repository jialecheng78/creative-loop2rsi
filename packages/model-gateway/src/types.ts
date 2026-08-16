export const DEEPSEEK_ORIGIN = "https://api.deepseek.com" as const;
export const MAX_DEEPSEEK_OUTPUT_TOKENS = 32_768 as const;

export type DeepSeekEndpoint = "/models" | "/chat/completions";

export interface ApiKeyStore {
  /** Fail closed when the platform's protected storage cannot be used. */
  isAvailable(): boolean | Promise<boolean>;
  get(): string | null | Promise<string | null>;
  set(value: string): void | Promise<void>;
  delete(): void | Promise<void>;
}

export interface GatewayLogger {
  log(record: GatewayLogRecord): void;
}

export interface GatewayLogRecord {
  event: "request.started" | "request.completed" | "request.failed";
  endpoint: DeepSeekEndpoint;
  requestNumber: number;
  requestedModel?: string;
  returnedModel?: string;
  systemFingerprint?: string;
  requestId?: string;
  parameters?: RequestParameterSummary;
  usage?: GatewayUsageSummary;
  status?: number;
  errorCode?: GatewayErrorCode;
  runtimeVersion?: string;
}

export interface RequestParameterSummary {
  stream: boolean;
  messageCount: number;
  toolCount: number;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
}

export interface GatewayUsageSummary {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

export interface GatewayBudgetPolicy {
  maxRequests: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
  maxSingleRequestBytes: number;
  maxSingleResponseBytes: number;
  /** Time from request start until the first validated SSE event. */
  firstEventTimeoutMs: number;
  /** Maximum silence between validated SSE events after the first event. */
  streamIdleTimeoutMs: number;
  /** Absolute request lifetime; stream progress never resets this limit. */
  totalTimeoutMs: number;
  /**
   * @deprecated Compatibility input only. When supplied alone, it sets all
   * three timeout limits. Mixing it with a canonical timeout field is invalid.
   * Canonical snapshots never contain this field.
   */
  timeoutMs?: number;
  maxSseLineBytes: number;
}

export interface GatewayBudgetSnapshot {
  requestCount: number;
  requestBytes: number;
  responseBytes: number;
  limits: Readonly<GatewayBudgetPolicy>;
}

export type GatewayErrorCode =
  | "AUTH_UNAVAILABLE"
  | "AUTH_MISSING"
  | "BAD_REQUEST"
  | "BUDGET_EXCEEDED"
  | "HTTP_ERROR"
  | "INVALID_RESPONSE"
  | "NETWORK_ERROR"
  | "FIRST_EVENT_TIMEOUT"
  | "STREAM_IDLE_TIMEOUT"
  | "TOTAL_TIMEOUT";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: readonly ChatToolCall[];
  reasoning_content?: string;
}

export interface ChatToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatCompletionRequest {
  model: string;
  messages: readonly ChatMessage[];
  thinking: { type: "enabled" };
  reasoning_effort: "high";
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | readonly string[] | null;
  frequency_penalty?: number;
  presence_penalty?: number;
  response_format?: Readonly<Record<string, unknown>>;
  tools?: readonly unknown[];
  tool_choice?: unknown;
  logprobs?: boolean;
  top_logprobs?: number;
  stream_options?: { readonly include_usage: true };
}

export interface DeepSeekUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  [key: string]: unknown;
}

export interface ChatCompletionResponse {
  id?: string;
  model: string;
  system_fingerprint?: string | null;
  choices: readonly unknown[];
  usage?: DeepSeekUsage | null;
  [key: string]: unknown;
}

export interface ModelListResponse {
  object?: string;
  data: readonly Readonly<Record<string, unknown>>[];
}

export interface ChatStreamChunk {
  id?: string;
  model?: string;
  system_fingerprint?: string | null;
  choices: readonly unknown[];
  usage?: DeepSeekUsage | null;
  [key: string]: unknown;
}

export type ChatStreamEvent =
  | { type: "chunk"; chunk: ChatStreamChunk }
  | { type: "done" };

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface DeepSeekGatewayOptions {
  keyStore: ApiKeyStore;
  budget?: Partial<GatewayBudgetPolicy>;
  fetch?: typeof globalThis.fetch;
  logger?: GatewayLogger;
  runtimeVersion?: string;
}
