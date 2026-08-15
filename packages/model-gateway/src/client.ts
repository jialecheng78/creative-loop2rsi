import { RequestBudget } from "./budget.js";
import { GatewayError } from "./errors.js";
import { assertApiKeyStore, readApiKey } from "./key-store.js";
import { redactText, redactValue } from "./redaction.js";
import { parseDeepSeekSse } from "./sse.js";
import { assertDeepSeekUsage, normalizeUsage } from "./usage.js";
import {
  DEEPSEEK_ORIGIN,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ChatStreamEvent,
  type DeepSeekEndpoint,
  type DeepSeekGatewayOptions,
  type GatewayLogRecord,
  type GatewayErrorCode,
  type GatewayUsageSummary,
  type ModelListResponse,
  type RequestOptions,
  type RequestParameterSummary,
} from "./types.js";

const ALLOWED_REQUEST_FIELDS = new Set([
  "model",
  "messages",
  "max_tokens",
  "temperature",
  "top_p",
  "stop",
  "frequency_penalty",
  "presence_penalty",
  "response_format",
  "tools",
  "tool_choice",
  "logprobs",
  "top_logprobs",
  "thinking",
  "reasoning_effort",
  "stream_options",
]);

const ALLOWED_MESSAGE_FIELDS = new Set([
  "role",
  "content",
  "name",
  "tool_call_id",
  "tool_calls",
  "reasoning_content",
]);
const MAX_OUTPUT_TOKENS = 16_384;

interface RequestContext {
  endpoint: DeepSeekEndpoint;
  requestNumber: number;
  requestedModel?: string;
  parameters?: RequestParameterSummary;
}

export class DeepSeekGateway {
  readonly budget: RequestBudget;
  readonly #keyStore;
  readonly #fetch: typeof globalThis.fetch;
  readonly #logger;
  readonly #runtimeVersion: string | undefined;

  constructor(options: DeepSeekGatewayOptions) {
    if (options === null || typeof options !== "object") {
      throw new TypeError("Gateway options 必须是对象");
    }
    assertApiKeyStore(options.keyStore);
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") throw new TypeError("当前运行时不支持 fetch");
    this.#keyStore = options.keyStore;
    this.#fetch = fetchImpl;
    this.#logger = options.logger;
    this.#runtimeVersion = options.runtimeVersion;
    this.budget = new RequestBudget(options.budget);
  }

  async listModels(options: RequestOptions = {}): Promise<ModelListResponse> {
    const requestNumber = this.budget.reserveRequest(0);
    const context: RequestContext = { endpoint: "/models", requestNumber };
    const requestScope = await this.#request(context, { method: "GET" }, options);
    try {
      const value = await this.#readJson(requestScope.response, requestScope.scope.signal);
      if (!isRecord(value) || !Array.isArray(value.data) || !value.data.every(isRecord)) {
        throw new GatewayError("INVALID_RESPONSE", "模型列表响应格式无效");
      }
      this.#completed(
        context,
        requestScope.response,
        undefined,
        undefined,
        undefined,
        [requestScope.key],
      );
      return value as unknown as ModelListResponse;
    } catch (error) {
      const safe = normalizeGatewayError(error, requestScope.scope);
      this.#failed(context, safe, [requestScope.key]);
      throw safe;
    } finally {
      requestScope.key = "";
      requestScope.scope.cleanup();
    }
  }

  async createChatCompletion(
    request: ChatCompletionRequest,
    options: RequestOptions = {},
  ): Promise<ChatCompletionResponse> {
    const normalized = validateChatRequest(request, false);
    const body = JSON.stringify({ ...normalized, stream: false });
    const requestNumber = this.budget.reserveRequest(new TextEncoder().encode(body).byteLength);
    const context: RequestContext = {
      endpoint: "/chat/completions",
      requestNumber,
      requestedModel: normalized.model,
      parameters: summarizeRequest(normalized, false),
    };
    const requestScope = await this.#request(
      context,
      { method: "POST", body, headers: { "content-type": "application/json" } },
      options,
    );
    try {
      const value = await this.#readJson(requestScope.response, requestScope.scope.signal);
      assertChatResponse(value);
      this.#completed(
        context,
        requestScope.response,
        value.model,
        value.system_fingerprint ?? undefined,
        normalizeUsage(value.usage),
        [requestScope.key],
      );
      return value;
    } catch (error) {
      const safe = normalizeGatewayError(error, requestScope.scope);
      this.#failed(context, safe, [requestScope.key]);
      throw safe;
    } finally {
      requestScope.key = "";
      requestScope.scope.cleanup();
    }
  }

  async *streamChatCompletion(
    request: ChatCompletionRequest,
    options: RequestOptions = {},
  ): AsyncGenerator<ChatStreamEvent> {
    const normalized = validateChatRequest(request, true);
    const body = JSON.stringify({ ...normalized, stream: true });
    const requestNumber = this.budget.reserveRequest(new TextEncoder().encode(body).byteLength);
    const context: RequestContext = {
      endpoint: "/chat/completions",
      requestNumber,
      requestedModel: normalized.model,
      parameters: summarizeRequest(normalized, true),
    };
    const scope = createStreamAbortScope(options.signal, this.budget.limits);
    let key = "";
    let response: Response;
    try {
      key = await this.#getKey();
      this.#started(context, [key]);
      response = await this.#fetch(fixedUrl(context.endpoint), {
        method: "POST",
        body,
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        cache: "no-store",
        credentials: "omit",
        redirect: "manual",
        referrerPolicy: "no-referrer",
        signal: scope.signal,
      });
    } catch (error) {
      const safe = error instanceof GatewayError ? error : this.#transportError(error, scope);
      this.#failed(context, safe, [key]);
      scope.cleanup();
      throw safe;
    }
    try {
      validateHttpResponse(response, context.endpoint, [key]);
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.startsWith("text/event-stream")) {
        throw new GatewayError("INVALID_RESPONSE", "流式响应 Content-Type 必须是 text/event-stream");
      }
      if (response.body === null) throw new GatewayError("INVALID_RESPONSE", "流式响应缺少 body");
      let returnedModel: string | undefined;
      let fingerprint: string | undefined;
      let usage: GatewayUsageSummary | undefined;
      for await (const event of parseDeepSeekSse(response.body, this.budget, {
        signal: scope.signal,
        maxLineBytes: this.budget.limits.maxSseLineBytes,
        onEvent: scope.markStreamEvent,
      })) {
        if (event.type === "chunk") {
          returnedModel = event.chunk.model ?? returnedModel;
          fingerprint = event.chunk.system_fingerprint ?? fingerprint;
          usage = normalizeUsage(event.chunk.usage) ?? usage;
        }
        yield event;
      }
      this.#completed(context, response, returnedModel, fingerprint, usage, [key]);
    } catch (error) {
      const safe = normalizeGatewayError(error, scope);
      this.#failed(context, safe, [key]);
      throw safe;
    } finally {
      key = "";
      scope.cleanup();
    }
  }

  async #request(
    context: RequestContext,
    init: Pick<RequestInit, "method" | "headers" | "body">,
    options: RequestOptions,
  ): Promise<HttpResponseScope> {
    const isModelList = context.endpoint === "/models";
    const timeoutMs = isModelList
      ? this.budget.limits.firstEventTimeoutMs
      : this.budget.limits.totalTimeoutMs;
    const scope = createDeadlineAbortScope(
      options.signal,
      timeoutMs,
      isModelList ? "FIRST_EVENT_TIMEOUT" : "TOTAL_TIMEOUT",
    );
    let key = "";
    try {
      key = await this.#getKey();
      this.#started(context, [key]);
      const response = await this.#fetch(fixedUrl(context.endpoint), {
        ...init,
        headers: { authorization: `Bearer ${key}`, ...init.headers },
        cache: "no-store",
        credentials: "omit",
        redirect: "manual",
        referrerPolicy: "no-referrer",
        signal: scope.signal,
      });
      validateHttpResponse(response, context.endpoint, [key]);
      return { response, scope, key };
    } catch (error) {
      const safe = error instanceof GatewayError ? error : this.#transportError(error, scope);
      this.#failed(context, safe, [key]);
      key = "";
      scope.cleanup();
      throw safe;
    }
  }

  async #readJson(response: Response, signal: AbortSignal): Promise<unknown> {
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("application/json")) {
      throw new GatewayError("INVALID_RESPONSE", "响应 Content-Type 必须是 application/json");
    }
    const bytes = await readBoundedBody(response, this.budget, signal);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new GatewayError("INVALID_RESPONSE", "JSON 响应不是合法 UTF-8");
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new GatewayError("INVALID_RESPONSE", "响应不是合法 JSON");
    }
  }

  async #getKey(): Promise<string> {
    try {
      return await readApiKey(this.#keyStore);
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError("AUTH_UNAVAILABLE", "无法从系统安全存储读取 API Key");
    }
  }

  #transportError(_error: unknown, scope: AbortScope): GatewayError {
    const timeout = scope.timeoutCode();
    if (timeout !== undefined) return timeoutError(timeout);
    if (scope.signal.aborted) return new GatewayError("NETWORK_ERROR", "模型请求已取消");
    return new GatewayError("NETWORK_ERROR", "模型网络请求失败");
  }

  #started(context: RequestContext, secrets: readonly string[]): void {
    this.#log({ event: "request.started", ...context }, secrets);
  }

  #completed(
    context: RequestContext,
    response: Response,
    returnedModel?: string,
    systemFingerprint?: string,
    usage?: GatewayUsageSummary,
    secrets: readonly string[] = [],
  ): void {
    const requestId = getRequestId(response, secrets);
    this.#log({
      event: "request.completed",
      ...context,
      status: response.status,
      ...(requestId === undefined ? {} : { requestId }),
      ...(returnedModel === undefined ? {} : { returnedModel }),
      ...(systemFingerprint === undefined ? {} : { systemFingerprint }),
      ...(usage === undefined ? {} : { usage }),
    }, secrets);
  }

  #failed(context: RequestContext, error: GatewayError, secrets: readonly string[] = []): void {
    this.#log({
      event: "request.failed",
      ...context,
      errorCode: error.code,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
    }, secrets);
  }

  #log(record: GatewayLogRecord, secrets: readonly string[] = []): void {
    if (this.#logger === undefined) return;
    const withRuntime = this.#runtimeVersion === undefined
      ? record
      : { ...record, runtimeVersion: redactText(this.#runtimeVersion) };
    try {
      this.#logger.log(redactValue(withRuntime, secrets) as GatewayLogRecord);
    } catch {
      // Logging is best effort and must never change the model request result.
    }
  }
}

function fixedUrl(endpoint: DeepSeekEndpoint): string {
  return `${DEEPSEEK_ORIGIN}${endpoint}`;
}

function validateHttpResponse(
  response: Response,
  endpoint: DeepSeekEndpoint,
  secrets: readonly string[] = [],
): void {
  if (!(response instanceof Response) && !isResponseLike(response)) {
    throw new GatewayError("INVALID_RESPONSE", "fetch 未返回合法 Response");
  }
  if (response.url) {
    let url: URL;
    try {
      url = new URL(response.url);
    } catch {
      throw new GatewayError("INVALID_RESPONSE", "响应 URL 无效");
    }
    if (url.origin !== DEEPSEEK_ORIGIN || url.pathname !== endpoint || url.search !== "") {
      throw new GatewayError("INVALID_RESPONSE", "响应来源不在 DeepSeek 白名单");
    }
  }
  const requestId = getRequestId(response, secrets);
  if (response.status >= 300 && response.status < 400) {
    throw new GatewayError("HTTP_ERROR", "DeepSeek 重定向已阻止", {
      status: response.status,
      ...(requestId === undefined ? {} : { requestId }),
    });
  }
  if (!response.ok) {
    throw new GatewayError("HTTP_ERROR", `DeepSeek 请求失败（HTTP ${response.status}）`, {
      status: response.status,
      ...(requestId === undefined ? {} : { requestId }),
    });
  }
}

function validateChatRequest(
  request: ChatCompletionRequest,
  allowStreamOptions: boolean,
): ChatCompletionRequest {
  if (!isRecord(request)) throw new GatewayError("BAD_REQUEST", "聊天请求必须是对象");
  for (const key of Object.keys(request)) {
    if (!ALLOWED_REQUEST_FIELDS.has(key)) {
      throw new GatewayError("BAD_REQUEST", `聊天请求包含不允许的字段：${redactText(key)}`);
    }
  }
  if (typeof request.model !== "string" || request.model.trim().length === 0) {
    throw new GatewayError("BAD_REQUEST", "model 必须是非空字符串");
  }
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    throw new GatewayError("BAD_REQUEST", "messages 必须是非空数组");
  }
  for (const message of request.messages) {
    if (!isRecord(message) || !["system", "user", "assistant", "tool"].includes(String(message.role))) {
      throw new GatewayError("BAD_REQUEST", "message role 无效");
    }
    for (const key of Object.keys(message)) {
      if (!ALLOWED_MESSAGE_FIELDS.has(key)) {
        throw new GatewayError("BAD_REQUEST", `message 包含不允许的字段：${redactText(key)}`);
      }
    }
    if (message.content !== null && typeof message.content !== "string") {
      throw new GatewayError("BAD_REQUEST", "message content 必须是字符串或 null");
    }
    validateMessage(message);
  }
  if (!isRecord(request.thinking) || request.thinking.type !== "enabled") {
    throw new GatewayError("BAD_REQUEST", "thinking 必须固定为 enabled");
  }
  if (Object.keys(request.thinking).some((key) => key !== "type")) {
    throw new GatewayError("BAD_REQUEST", "thinking 包含不允许的字段");
  }
  if (request.reasoning_effort !== "high") {
    throw new GatewayError("BAD_REQUEST", "reasoning_effort 必须固定为 high");
  }
  if (request.stream_options !== undefined) {
    if (!allowStreamOptions) {
      throw new GatewayError("BAD_REQUEST", "stream_options 只允许用于流式请求");
    }
    if (
      !isRecord(request.stream_options) ||
      request.stream_options.include_usage !== true ||
      Object.keys(request.stream_options).some((key) => key !== "include_usage")
    ) {
      throw new GatewayError(
        "BAD_REQUEST",
        "stream_options 必须严格为 { include_usage: true }",
      );
    }
  }
  validateOptionalFinite(request, "temperature");
  validateOptionalFinite(request, "top_p");
  validateOptionalFinite(request, "frequency_penalty");
  validateOptionalFinite(request, "presence_penalty");
  validateOptionalPositiveInteger(request, "max_tokens", MAX_OUTPUT_TOKENS);
  validateOptionalPositiveInteger(request, "top_logprobs");
  return request;
}

function validateOptionalFinite(request: Record<string, unknown>, field: string): void {
  const value = request[field];
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new GatewayError("BAD_REQUEST", `${field} 必须是有限数字`);
  }
}

function validateOptionalPositiveInteger(
  request: Record<string, unknown>,
  field: string,
  maximum = Number.MAX_SAFE_INTEGER,
): void {
  const value = request[field];
  if (
    value !== undefined &&
    (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum)
  ) {
    throw new GatewayError("BAD_REQUEST", `${field} 必须是 1 到 ${maximum} 的整数`);
  }
}

function validateMessage(message: Record<string, unknown>): void {
  const role = message.role;
  const hasToolCalls = message.tool_calls !== undefined;
  const hasReasoning = message.reasoning_content !== undefined;

  if (message.name !== undefined && (typeof message.name !== "string" || message.name.length === 0)) {
    throw new GatewayError("BAD_REQUEST", "message name 必须是非空字符串");
  }
  if (role === "tool") {
    if (typeof message.tool_call_id !== "string" || message.tool_call_id.length === 0) {
      throw new GatewayError("BAD_REQUEST", "tool message 必须包含 tool_call_id");
    }
  } else if (message.tool_call_id !== undefined) {
    throw new GatewayError("BAD_REQUEST", "仅 tool message 可包含 tool_call_id");
  }
  if (hasToolCalls) {
    if (role !== "assistant" || !Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
      throw new GatewayError("BAD_REQUEST", "tool_calls 只允许用于 assistant 且必须是非空数组");
    }
    for (const toolCall of message.tool_calls) validateToolCall(toolCall);
  }
  if (hasReasoning) {
    if (role !== "assistant" || !hasToolCalls || typeof message.reasoning_content !== "string") {
      throw new GatewayError("BAD_REQUEST", "reasoning_content 只允许回传 assistant tool-call");
    }
  }
  if (hasToolCalls && !hasReasoning) {
    throw new GatewayError("BAD_REQUEST", "assistant tool-call 回传必须包含 reasoning_content");
  }
  if (message.content === null && !(role === "assistant" && hasToolCalls)) {
    throw new GatewayError("BAD_REQUEST", "仅 assistant tool-call 的 content 可以为 null");
  }
}

function validateToolCall(value: unknown): void {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.type !== "function" ||
    !isRecord(value.function) ||
    typeof value.function.name !== "string" ||
    value.function.name.length === 0 ||
    typeof value.function.arguments !== "string"
  ) {
    throw new GatewayError("BAD_REQUEST", "assistant tool_call 格式无效");
  }
  if (Object.keys(value).some((key) => !["id", "type", "function"].includes(key))) {
    throw new GatewayError("BAD_REQUEST", "assistant tool_call 包含不允许的字段");
  }
  if (Object.keys(value.function).some((key) => !["name", "arguments"].includes(key))) {
    throw new GatewayError("BAD_REQUEST", "assistant tool_call function 包含不允许的字段");
  }
}

function summarizeRequest(request: ChatCompletionRequest, stream: boolean): RequestParameterSummary {
  return {
    stream,
    messageCount: request.messages.length,
    toolCount: request.tools?.length ?? 0,
    ...(request.max_tokens === undefined ? {} : { maxTokens: request.max_tokens }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.top_p === undefined ? {} : { topP: request.top_p }),
  };
}

function assertChatResponse(value: unknown): asserts value is ChatCompletionResponse {
  if (!isRecord(value) || typeof value.model !== "string" || !Array.isArray(value.choices)) {
    throw new GatewayError("INVALID_RESPONSE", "聊天响应格式无效");
  }
  if (
    value.system_fingerprint !== undefined &&
    value.system_fingerprint !== null &&
    typeof value.system_fingerprint !== "string"
  ) {
    throw new GatewayError("INVALID_RESPONSE", "system_fingerprint 类型无效");
  }
  assertDeepSeekUsage(value.usage);
}

async function readBoundedBody(
  response: Response,
  budget: RequestBudget,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let responseBytes = 0;
  try {
    while (true) {
      const { value, done } = await readWithSignal(reader, signal);
      if (done) break;
      responseBytes = budget.consumeResponse(value.byteLength, responseBytes);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const result = new Uint8Array(responseBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function readWithSignal(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function getRequestId(response: Response, secrets: readonly string[] = []): string | undefined {
  const raw = response.headers.get("x-request-id") ?? response.headers.get("request-id");
  return raw === null ? undefined : redactText(raw, secrets).slice(0, 200);
}

interface AbortScope {
  signal: AbortSignal;
  timeoutCode(): GatewayErrorCode | undefined;
  markStreamEvent?(): void;
  cleanup(): void;
}

interface HttpResponseScope {
  response: Response;
  scope: AbortScope;
  key: string;
}

function createDeadlineAbortScope(
  external: AbortSignal | undefined,
  timeoutMs: number,
  deadlineCode: "FIRST_EVENT_TIMEOUT" | "TOTAL_TIMEOUT",
): AbortScope {
  const controller = new AbortController();
  let timeoutCode: GatewayErrorCode | undefined;
  const onExternalAbort = (): void => controller.abort(external?.reason);
  if (external?.aborted) onExternalAbort();
  else external?.addEventListener("abort", onExternalAbort, { once: true });
  const timeout = setTimeout(() => {
    if (controller.signal.aborted) return;
    timeoutCode = deadlineCode;
    controller.abort(new Error(deadlineCode.toLowerCase().replaceAll("_", "-")));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timeoutCode: () => timeoutCode,
    cleanup: () => {
      clearTimeout(timeout);
      external?.removeEventListener("abort", onExternalAbort);
    },
  };
}

function createStreamAbortScope(
  external: AbortSignal | undefined,
  limits: Pick<
    DeepSeekGateway["budget"]["limits"],
    "firstEventTimeoutMs" | "streamIdleTimeoutMs" | "totalTimeoutMs"
  >,
): AbortScope & { markStreamEvent(): void } {
  const controller = new AbortController();
  let timeoutCode: GatewayErrorCode | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const abortFor = (code: GatewayErrorCode): void => {
    if (controller.signal.aborted) return;
    timeoutCode = code;
    controller.abort(new Error(code.toLowerCase().replaceAll("_", "-")));
  };
  const onExternalAbort = (): void => controller.abort(external?.reason);
  if (external?.aborted) onExternalAbort();
  else external?.addEventListener("abort", onExternalAbort, { once: true });
  const firstEventTimer = setTimeout(
    () => abortFor("FIRST_EVENT_TIMEOUT"),
    limits.firstEventTimeoutMs,
  );
  const totalTimer = setTimeout(
    () => abortFor("TOTAL_TIMEOUT"),
    limits.totalTimeoutMs,
  );
  let sawEvent = false;
  return {
    signal: controller.signal,
    timeoutCode: () => timeoutCode,
    markStreamEvent: () => {
      if (controller.signal.aborted) return;
      if (!sawEvent) {
        sawEvent = true;
        clearTimeout(firstEventTimer);
      }
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => abortFor("STREAM_IDLE_TIMEOUT"),
        limits.streamIdleTimeoutMs,
      );
    },
    cleanup: () => {
      clearTimeout(firstEventTimer);
      clearTimeout(totalTimer);
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      external?.removeEventListener("abort", onExternalAbort);
    },
  };
}

function normalizeGatewayError(error: unknown, scope: AbortScope): GatewayError {
  const timeout = scope.timeoutCode();
  if (timeout !== undefined) return timeoutError(timeout);
  if (error instanceof GatewayError) return error;
  if (scope.signal.aborted) return new GatewayError("NETWORK_ERROR", "模型请求已取消");
  return new GatewayError("INVALID_RESPONSE", "无法解析模型响应");
}

function timeoutError(code: GatewayErrorCode): GatewayError {
  if (code === "FIRST_EVENT_TIMEOUT") {
    return new GatewayError(code, "模型在开始返回有效数据前超时");
  }
  if (code === "STREAM_IDLE_TIMEOUT") {
    return new GatewayError(code, "模型流已开始，但长时间没有新事件");
  }
  return new GatewayError("TOTAL_TIMEOUT", "模型请求超过绝对总时限");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isResponseLike(value: unknown): value is Response {
  return (
    isRecord(value) &&
    typeof value.status === "number" &&
    typeof value.ok === "boolean" &&
    isRecord(value.headers) &&
    typeof value.headers.get === "function"
  );
}
