import { GatewayError } from "./errors.js";
import type { RequestBudget } from "./budget.js";
import type { ChatStreamChunk, ChatStreamEvent } from "./types.js";
import { assertDeepSeekUsage } from "./usage.js";

interface SseParserOptions {
  signal: AbortSignal;
  maxLineBytes: number;
}

export async function* parseDeepSeekSse(
  body: ReadableStream<Uint8Array>,
  budget: RequestBudget,
  options: SseParserOptions,
): AsyncGenerator<ChatStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();
  let responseBytes = 0;
  let buffer = "";
  let dataLines: string[] = [];
  let eventName: string | undefined;
  let sawDone = false;

  const dispatch = (): ChatStreamEvent | undefined => {
    if (dataLines.length === 0) {
      if (eventName !== undefined) {
        throw invalidResponse("SSE event 缺少 data 字段");
      }
      return undefined;
    }
    if (sawDone) throw invalidResponse("[DONE] 后出现额外 SSE event");
    if (eventName !== undefined && eventName !== "message") {
      throw invalidResponse(`不支持的 SSE event 类型：${eventName}`);
    }
    const data = dataLines.join("\n");
    dataLines = [];
    eventName = undefined;
    if (data === "[DONE]") {
      sawDone = true;
      return { type: "done" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw invalidResponse("SSE data 不是合法 JSON");
    }
    assertStreamChunk(parsed);
    return { type: "chunk", chunk: parsed };
  };

  const processLine = (line: string): ChatStreamEvent | undefined => {
    if (encoder.encode(line).byteLength > options.maxLineBytes) {
      throw new GatewayError("BUDGET_EXCEEDED", "SSE 单行超过预算");
    }
    if (line.includes("\0")) throw invalidResponse("SSE 包含 NUL 字符");
    if (line === "") return dispatch();
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    if (colon <= 0) throw invalidResponse("SSE 字段格式无效");
    const field = line.slice(0, colon);
    const rawValue = line.slice(colon + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "data") {
      dataLines.push(value);
    } else if (field === "event") {
      if (eventName !== undefined) throw invalidResponse("SSE event 字段重复");
      eventName = value;
    } else if (field === "id") {
      if (value.includes("\0")) throw invalidResponse("SSE id 字段无效");
    } else if (field === "retry") {
      if (!/^\d+$/.test(value)) throw invalidResponse("SSE retry 字段无效");
    } else {
      throw invalidResponse(`不支持的 SSE 字段：${field}`);
    }
    return undefined;
  };

  try {
    while (true) {
      if (options.signal.aborted) throw options.signal.reason;
      const { value, done } = await readWithSignal(reader, options.signal);
      if (done) break;
      if (!(value instanceof Uint8Array)) throw invalidResponse("SSE 响应块类型无效");
      responseBytes = budget.consumeResponse(value.byteLength, responseBytes);
      try {
        buffer += decoder.decode(value, { stream: true });
      } catch {
        throw invalidResponse("SSE 响应不是合法 UTF-8");
      }
      if (encoder.encode(buffer).byteLength > options.maxLineBytes && !buffer.includes("\n")) {
        throw new GatewayError("BUDGET_EXCEEDED", "SSE 单行超过预算");
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        const event = processLine(line);
        if (event !== undefined) yield event;
        newline = buffer.indexOf("\n");
      }
    }
    try {
      buffer += decoder.decode();
    } catch {
      throw invalidResponse("SSE 响应不是合法 UTF-8");
    }
    if (buffer.length > 0) {
      let line = buffer;
      if (line.endsWith("\r")) line = line.slice(0, -1);
      const event = processLine(line);
      if (event !== undefined) yield event;
    }
    if (dataLines.length > 0 || eventName !== undefined) {
      const event = dispatch();
      if (event !== undefined) yield event;
    }
    if (!sawDone) throw invalidResponse("SSE 响应在 [DONE] 前结束");
  } finally {
    // Cancellation is best effort: a custom or broken stream source is
    // allowed to return a promise that never settles from cancel(). Waiting
    // for it here would turn an already-observed AbortSignal into an
    // unbounded shutdown. Calling cancel() still closes the reader and
    // settles pending reads synchronously according to the Streams contract.
    try {
      void reader.cancel().catch(() => undefined);
    } catch {
      // A non-conforming reader must not mask the original parse/abort result.
    }
    try {
      reader.releaseLock();
    } catch {
      // Releasing is also best effort when a non-conforming reader leaves a
      // read request pending after cancellation.
    }
  }
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

function assertStreamChunk(value: unknown): asserts value is ChatStreamChunk {
  if (!isRecord(value) || !Array.isArray(value.choices)) {
    throw invalidResponse("SSE chunk 缺少 choices 数组");
  }
  if (value.model !== undefined && typeof value.model !== "string") {
    throw invalidResponse("SSE chunk 的 model 类型无效");
  }
  if (
    value.system_fingerprint !== undefined &&
    value.system_fingerprint !== null &&
    typeof value.system_fingerprint !== "string"
  ) {
    throw invalidResponse("SSE chunk 的 system_fingerprint 类型无效");
  }
  assertDeepSeekUsage(value.usage);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidResponse(message: string): GatewayError {
  return new GatewayError("INVALID_RESPONSE", message);
}
