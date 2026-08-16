import { describe, expect, it, vi } from "vitest";

import {
  DeepSeekGateway,
  GatewayError,
  redactText,
  redactValue,
  type ApiKeyStore,
  type GatewayLogRecord,
} from "../src/index.js";

const TEST_KEY = "fixture-secret-without-provider-prefix";

function keyStore(options: { available?: boolean; value?: string | null } = {}): ApiKeyStore {
  let value = options.value === undefined ? TEST_KEY : options.value;
  return {
    isAvailable: async () => options.available ?? true,
    get: async () => value,
    set: async (next) => {
      value = next;
    },
    delete: async () => {
      value = null;
    },
  };
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function request() {
  return {
    model: "deepseek-test",
    messages: [{ role: "user" as const, content: "未发表的测试文本" }],
    max_tokens: 100,
    temperature: 0.4,
    thinking: { type: "enabled" as const },
    reasoning_effort: "high" as const,
  };
}

describe("DeepSeekGateway fixed-host transport", () => {
  it("only calls the fixed models endpoint and disables redirects", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse({ data: [] }));
    const gateway = new DeepSeekGateway({ keyStore: keyStore(), fetch: fetchMock });

    await expect(gateway.listModels()).resolves.toEqual({ data: [] });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.deepseek.com/models");
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TEST_KEY}`);
  });

  it("fails closed before fetch when protected storage is unavailable", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const gateway = new DeepSeekGateway({
      keyStore: keyStore({ available: false }),
      fetch: fetchMock,
    });

    await expect(gateway.listModels()).rejects.toMatchObject({ code: "AUTH_UNAVAILABLE" });
    expect(fetchMock).not.toHaveBeenCalled();

    const collect = async () => {
      for await (const _event of gateway.streamChatCompletion(request())) {
        // No events are possible: authorization must fail before fetch.
      }
    };
    await expect(collect()).rejects.toMatchObject({ code: "AUTH_UNAVAILABLE" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks redirects without reading their body", async () => {
    const response = new Response("do not follow", {
      status: 302,
      headers: { location: "https://attacker.invalid/collect" },
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
    const gateway = new DeepSeekGateway({ keyStore: keyStore(), fetch: fetchMock });

    await expect(gateway.listModels()).rejects.toMatchObject({
      code: "HTTP_ERROR",
      status: 302,
    });
  });

  it("sends only the allowlisted chat payload and emits content-free logs", async () => {
    const logs: GatewayLogRecord[] = [];
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          model: "deepseek-returned",
          system_fingerprint: "fp-1",
          choices: [],
          usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
        },
        { headers: { "x-request-id": "req-1" } },
      ),
    );
    const gateway = new DeepSeekGateway({
      keyStore: keyStore(),
      fetch: fetchMock,
      logger: { log: (record) => logs.push(record) },
      runtimeVersion: "gateway-test",
    });

    await gateway.createChatCompletion(request());

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect(init?.redirect).toBe("manual");
    expect(JSON.parse(String(init?.body))).toEqual({ ...request(), stream: false });
    expect(JSON.stringify(logs)).not.toContain(TEST_KEY);
    expect(JSON.stringify(logs)).not.toContain("未发表的测试文本");
    expect(logs.at(-1)).toMatchObject({
      event: "request.completed",
      requestedModel: "deepseek-test",
      returnedModel: "deepseek-returned",
      systemFingerprint: "fp-1",
      requestId: "req-1",
      parameters: { stream: false, messageCount: 1, maxTokens: 100 },
      usage: { promptTokens: 12, completionTokens: 7, totalTokens: 19 },
    });
  });

  it("rejects request fields that could bypass the narrow API", async () => {
    const gateway = new DeepSeekGateway({ keyStore: keyStore(), fetch: vi.fn<typeof fetch>() });
    const unsafe = { ...request(), user: "tracking-id", base_url: "https://attacker.invalid" };

    await expect(gateway.createChatCompletion(unsafe as never)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it.each([
    ["output token ceiling", { max_tokens: 32_769 }],
    ["disabled thinking", { thinking: { type: "disabled" } }],
    ["missing thinking", { thinking: undefined }],
    ["lower reasoning effort", { reasoning_effort: "medium" }],
    ["missing reasoning effort", { reasoning_effort: undefined }],
    ["thinking extension field", { thinking: { type: "enabled", budget_tokens: 10 } }],
  ])("rejects %s", async (_name: string, override: Record<string, unknown>) => {
    const fetchMock = vi.fn<typeof fetch>();
    const gateway = new DeepSeekGateway({ keyStore: keyStore(), fetch: fetchMock });

    await expect(gateway.createChatCompletion({ ...request(), ...override } as never)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts the exact 32768 output-token ceiling", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ model: "deepseek-returned", choices: [] }),
    );
    const gateway = new DeepSeekGateway({ keyStore: keyStore(), fetch: fetchMock });

    await gateway.createChatCompletion({ ...request(), max_tokens: 32_768 });

    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toMatchObject({
      max_tokens: 32_768,
      thinking: { type: "enabled" },
      reasoning_effort: "high",
    });
  });

  it("accepts a validated assistant tool-call reasoning round trip", async () => {
    const logs: GatewayLogRecord[] = [];
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ model: "deepseek-returned", choices: [] }),
    );
    const gateway = new DeepSeekGateway({
      keyStore: keyStore(),
      fetch: fetchMock,
      logger: { log: (record) => logs.push(record) },
    });
    const toolRequest = {
      ...request(),
      messages: [
        ...request().messages,
        {
          role: "assistant" as const,
          content: null,
          reasoning_content: "本轮临时推理",
          tool_calls: [
            {
              id: "call-1",
              type: "function" as const,
              function: { name: "lookup", arguments: '{"query":"虚构资料"}' },
            },
          ],
        },
        { role: "tool" as const, content: "虚构结果", tool_call_id: "call-1" },
      ],
    };

    await gateway.createChatCompletion(toolRequest);

    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          reasoning_content: "本轮临时推理",
          tool_calls: [expect.objectContaining({ id: "call-1", type: "function" })],
        }),
      ]),
    });
    expect(JSON.stringify(logs)).not.toContain("本轮临时推理");
  });

  it.each([
    [
      "reasoning on user",
      { role: "user", content: "x", reasoning_content: "must not leave assistant boundary" },
    ],
    [
      "tool call without reasoning",
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: "{}" } }],
      },
    ],
    [
      "malformed tool call",
      {
        role: "assistant",
        content: null,
        reasoning_content: "temporary",
        tool_calls: [{ id: "call-1", type: "shell", function: { name: "lookup", arguments: "{}" } }],
      },
    ],
    ["nested unknown field", { role: "user", content: "x", metadata: { private: true } }],
  ])("rejects %s", async (_name: string, message: Record<string, unknown>) => {
    const fetchMock = vi.fn<typeof fetch>();
    const gateway = new DeepSeekGateway({ keyStore: keyStore(), fetch: fetchMock });

    await expect(
      gateway.createChatCompletion({ ...request(), messages: [message] } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("strict DeepSeek SSE", () => {
  it("accepts only the DSH usage-stream option and forwards it to DeepSeek", async () => {
    const body = [
      'data: {"model":"deepseek-returned","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(body, { headers: { "content-type": "text/event-stream" } }),
    );
    const gateway = new DeepSeekGateway({ keyStore: keyStore(), fetch: fetchMock });

    const events = [];
    for await (const event of gateway.streamChatCompletion({
      ...request(),
      stream_options: { include_usage: true },
    })) {
      events.push(event);
    }

    expect(events.at(-1)).toEqual({ type: "done" });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({
      ...request(),
      stream_options: { include_usage: true },
      stream: true,
    });
  });

  it.each([
    ["false include_usage", { include_usage: false }],
    ["unknown option", { include_usage: true, reveal_private_trace: true }],
    ["non-object", true],
  ])("rejects unsafe stream_options: %s", async (_name: string, streamOptions: unknown) => {
    const fetchMock = vi.fn<typeof fetch>();
    const gateway = new DeepSeekGateway({ keyStore: keyStore(), fetch: fetchMock });
    const collect = async () => {
      for await (const _event of gateway.streamChatCompletion({
        ...request(),
        stream_options: streamOptions,
      } as never)) {
        // Validation must fail before transport.
      }
    };

    await expect(collect()).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects stream_options on non-streaming requests", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const gateway = new DeepSeekGateway({ keyStore: keyStore(), fetch: fetchMock });

    await expect(gateway.createChatCompletion({
      ...request(),
      stream_options: { include_usage: true },
    })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("parses UTF-8 data split across network chunks and requires DONE", async () => {
    const logs: GatewayLogRecord[] = [];
    const source = [
      'data: {"model":"deepseek-returned","system_fingerprint":"fp-stream","choices":[{"delta":{"reasoning_content":"思考","content":"你"}}]}\r\n\r\n',
      'data: {"model":"deepseek-returned","choices":[{"delta":{"content":"好"}}]}\n\n',
      'data: {"model":"deepseek-returned","choices":[],"usage":{"prompt_tokens":20,"completion_tokens":8,"total_tokens":28}}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const bytes = new TextEncoder().encode(source);
    const pieces = [bytes.slice(0, 17), bytes.slice(17, 83), bytes.slice(83)];
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const piece = pieces.shift();
        if (piece === undefined) controller.close();
        else controller.enqueue(piece);
      },
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8" } }),
    );
    const gateway = new DeepSeekGateway({
      keyStore: keyStore(),
      fetch: fetchMock,
      logger: { log: (record) => logs.push(record) },
    });

    const events = [];
    for await (const event of gateway.streamChatCompletion(request())) events.push(event);

    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({ type: "chunk", chunk: { model: "deepseek-returned" } });
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(logs.at(-1)).toMatchObject({
      event: "request.completed",
      usage: { promptTokens: 20, completionTokens: 8, totalTokens: 28 },
    });
  });

  it("settles an aborted SSE read even when reader cancellation never settles", async () => {
    vi.useFakeTimers();
    try {
      let markReadStarted!: () => void;
      const readStarted = new Promise<void>((resolve) => {
        markReadStarted = resolve;
      });
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      const stream = new ReadableStream<Uint8Array>({
        pull() {
          markReadStarted();
          return new Promise<void>(() => {});
        },
        cancel,
      });
      const gateway = new DeepSeekGateway({
        keyStore: keyStore(),
        fetch: vi.fn<typeof fetch>().mockResolvedValue(
          new Response(stream, { headers: { "content-type": "text/event-stream" } }),
        ),
        budget: {
          firstEventTimeoutMs: 10_000,
          streamIdleTimeoutMs: 10_000,
          totalTimeoutMs: 10_000,
        },
      });
      const abortController = new AbortController();
      const collect = (async () => {
        for await (const _event of gateway.streamChatCompletion(request(), {
          signal: abortController.signal,
        })) {
          // The source deliberately never emits an event.
        }
      })();

      await readStarted;
      abortController.abort(new Error("test-abort"));

      await expect(collect).rejects.toMatchObject({ code: "NETWORK_ERROR" });
      expect(cancel).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a progressing stream alive beyond the former 120-second total limit", async () => {
    vi.useFakeTimers();
    try {
      const source = controlledSseResponse();
      const fetchCalled = promiseSignal();
      const gateway = new DeepSeekGateway({
        keyStore: keyStore(),
        fetch: vi.fn<typeof fetch>().mockImplementation(async () => {
          fetchCalled.resolve();
          return source.response;
        }),
        budget: {
          firstEventTimeoutMs: 60_000,
          streamIdleTimeoutMs: 50_000,
          totalTimeoutMs: 300_000,
        },
      });
      const collecting = collectStream(gateway);
      await fetchCalled.promise;
      source.send(sseChunk("one"));
      for (const id of ["two", "three", "four", "five"]) {
        await vi.advanceTimersByTimeAsync(40_000);
        source.send(sseChunk(id));
      }
      source.send("data: [DONE]\n\n");
      source.close();

      const events = await collecting;
      expect(events[0]).toMatchObject({ type: "chunk" });
      expect(events.at(-1)).toEqual({ type: "done" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies silence before the first validated SSE event", async () => {
    vi.useFakeTimers();
    try {
      const source = controlledSseResponse();
      const fetchCalled = promiseSignal();
      const gateway = new DeepSeekGateway({
        keyStore: keyStore(),
        fetch: vi.fn<typeof fetch>().mockImplementation(async () => {
          fetchCalled.resolve();
          return source.response;
        }),
        budget: {
          firstEventTimeoutMs: 120_000,
          streamIdleTimeoutMs: 90_000,
          totalTimeoutMs: 600_000,
        },
      });
      const collecting = capturePromise(collectStream(gateway));
      await fetchCalled.promise;
      // A transport comment is activity, but not a validated model event.
      source.send(": keepalive\n\n");
      await vi.advanceTimersByTimeAsync(120_000);

      await expect(collecting).resolves.toMatchObject({
        ok: false,
        error: { code: "FIRST_EVENT_TIMEOUT" },
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies stream idle after a validated event", async () => {
    vi.useFakeTimers();
    try {
      const source = controlledSseResponse();
      const fetchCalled = promiseSignal();
      const gateway = new DeepSeekGateway({
        keyStore: keyStore(),
        fetch: vi.fn<typeof fetch>().mockImplementation(async () => {
          fetchCalled.resolve();
          return source.response;
        }),
        budget: {
          firstEventTimeoutMs: 120_000,
          streamIdleTimeoutMs: 90_000,
          totalTimeoutMs: 600_000,
        },
      });
      const collecting = capturePromise(collectStream(gateway));
      await fetchCalled.promise;
      source.send(sseChunk("first"));
      await vi.advanceTimersByTimeAsync(90_000);

      await expect(collecting).resolves.toMatchObject({
        ok: false,
        error: { code: "STREAM_IDLE_TIMEOUT" },
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces the absolute total even while valid events keep arriving", async () => {
    vi.useFakeTimers();
    try {
      const source = controlledSseResponse();
      const fetchCalled = promiseSignal();
      const gateway = new DeepSeekGateway({
        keyStore: keyStore(),
        fetch: vi.fn<typeof fetch>().mockImplementation(async () => {
          fetchCalled.resolve();
          return source.response;
        }),
        budget: {
          firstEventTimeoutMs: 100_000,
          streamIdleTimeoutMs: 90_000,
          totalTimeoutMs: 250_000,
        },
      });
      const collecting = capturePromise(collectStream(gateway));
      await fetchCalled.promise;
      source.send(sseChunk("one"));
      for (const id of ["two", "three", "four"]) {
        await vi.advanceTimersByTimeAsync(80_000);
        source.send(sseChunk(id));
      }
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(collecting).resolves.toMatchObject({
        ok: false,
        error: { code: "TOTAL_TIMEOUT" },
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects malformed usage rather than logging it", async () => {
    const body = 'data: {"choices":[],"usage":{"total_tokens":-1}}\n\ndata: [DONE]\n\n';
    const gateway = new DeepSeekGateway({
      keyStore: keyStore(),
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(body, { headers: { "content-type": "text/event-stream" } }),
      ),
    });
    const collect = async () => {
      for await (const _event of gateway.streamChatCompletion(request())) {
        // Consume the stream to validate every usage-bearing chunk.
      }
    };

    await expect(collect()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it.each([
    ["wrong content type", "data: [DONE]\n\n", "application/json"],
    ["missing DONE", 'data: {"choices":[]}\n\n', "text/event-stream"],
    ["unknown field", "url: https://attacker.invalid\n\ndata: [DONE]\n\n", "text/event-stream"],
    ["invalid JSON", "data: not-json\n\ndata: [DONE]\n\n", "text/event-stream"],
    ["data after DONE", "data: [DONE]\n\ndata: {}\n\n", "text/event-stream"],
  ])("rejects %s", async (_name: string, body: string, contentType: string) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(body, { headers: { "content-type": contentType } }),
    );
    const gateway = new DeepSeekGateway({ keyStore: keyStore(), fetch: fetchMock });

    const collect = async () => {
      for await (const _event of gateway.streamChatCompletion(request())) {
        // Fully consume to exercise EOF and post-DONE validation.
      }
    };
    await expect(collect()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});

describe("budgets and redaction", () => {
  it("uses canonical layered defaults and keeps legacy timeout input out of snapshots", () => {
    const legacy = new DeepSeekGateway({
      keyStore: keyStore(),
      fetch: vi.fn<typeof fetch>(),
      budget: { timeoutMs: 321 },
    });
    expect(legacy.budget.snapshot().limits).toMatchObject({
      firstEventTimeoutMs: 321,
      streamIdleTimeoutMs: 321,
      totalTimeoutMs: 321,
    });
    expect(legacy.budget.snapshot().limits).not.toHaveProperty("timeoutMs");

    expect(() => new DeepSeekGateway({
      keyStore: keyStore(),
      fetch: vi.fn<typeof fetch>(),
      budget: { timeoutMs: 321, totalTimeoutMs: 654 },
    })).toThrow(/timeoutMs.*混用/u);
  });

  it("enforces request count and response byte budgets", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse({ data: [] }));
    const oneRequest = new DeepSeekGateway({
      keyStore: keyStore(),
      fetch: fetchMock,
      budget: { maxRequests: 1 },
    });
    await oneRequest.listModels();
    await expect(oneRequest.listModels()).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });

    const tinyResponse = new DeepSeekGateway({
      keyStore: keyStore(),
      fetch: fetchMock,
      budget: { maxSingleResponseBytes: 4 },
    });
    await expect(tinyResponse.listModels()).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });

  it("redacts exact secrets, bearer values, provider keys, paths and sensitive object fields", () => {
    const slash = String.fromCharCode(47);
    const backslash = String.fromCharCode(92);
    const posixPath = ["", "Users", "person", "private.txt"].join(slash);
    const windowsPath = ["C:", "Users", "person", "private.txt"].join(backslash);
    const text = `failed ${TEST_KEY} Bearer abc.def sk-example123 ${posixPath} ${windowsPath}`;
    const redacted = redactText(text, [TEST_KEY]);
    expect(redacted).not.toContain(TEST_KEY);
    expect(redacted).not.toContain("abc.def");
    expect(redacted).not.toContain("sk-example123");
    expect(redacted).not.toContain(["person", "private.txt"].join(slash));
    expect(redacted).not.toContain(["person", "private.txt"].join(backslash));
    expect(redactValue({ authorization: "anything", nested: { api_key: TEST_KEY } })).toEqual({
      authorization: "[REDACTED]",
      nested: { api_key: "[REDACTED]" },
    });
  });

  it("redacts a key echoed by a failed fetch", async () => {
    const localPath = ["", "Users", "person", "project"].join(String.fromCharCode(47));
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(
      new Error(`transport accidentally echoed ${TEST_KEY} from ${localPath}`),
    );
    const gateway = new DeepSeekGateway({ keyStore: keyStore(), fetch: fetchMock });

    let caught: unknown;
    try {
      await gateway.listModels();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GatewayError);
    expect(String(caught)).not.toContain(TEST_KEY);
    expect(String(caught)).not.toContain(localPath);
  });

  it("uses the first-event bound for the non-streaming model-list check", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url: RequestInfo | URL, init?: RequestInit) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
      throw new Error("unreachable");
    });
    const gateway = new DeepSeekGateway({
      keyStore: keyStore(),
      fetch: fetchMock,
      budget: {
        firstEventTimeoutMs: 10,
        streamIdleTimeoutMs: 20,
        totalTimeoutMs: 1_000,
      },
    });

    await expect(gateway.listModels()).rejects.toMatchObject({ code: "FIRST_EVENT_TIMEOUT" });
  });

  it("uses the absolute-total bound for a non-streaming chat response", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url: RequestInfo | URL, init?: RequestInit) => {
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
        throw new Error("unreachable");
      });
      const gateway = new DeepSeekGateway({
        keyStore: keyStore(),
        fetch: fetchMock,
        budget: {
          firstEventTimeoutMs: 10,
          streamIdleTimeoutMs: 20,
          totalTimeoutMs: 30,
        },
      });
      const pending = gateway.createChatCompletion(request());
      let settled = false;
      void pending.then(() => { settled = true; }, () => { settled = true; });

      await vi.advanceTimersByTimeAsync(10);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(20);
      await expect(pending).rejects.toMatchObject({ code: "TOTAL_TIMEOUT" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("also applies the timeout while consuming a response body", async () => {
    const neverEndingBody = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(neverEndingBody, { headers: { "content-type": "application/json" } }),
    );
    const gateway = new DeepSeekGateway({
      keyStore: keyStore(),
      fetch: fetchMock,
      budget: { timeoutMs: 10 },
    });

    await expect(gateway.listModels()).rejects.toMatchObject({ code: "FIRST_EVENT_TIMEOUT" });
  });
});

function controlledSseResponse(): {
  readonly response: Response;
  send(value: string): void;
  close(): void;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  return {
    response: new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    send: value => controller.enqueue(new TextEncoder().encode(value)),
    close: () => controller.close(),
  };
}

function sseChunk(id: string): string {
  return `data: {"id":"${id}","model":"deepseek-returned","choices":[]}\n\n`;
}

function promiseSignal(): { readonly promise: Promise<void>; resolve(): void } {
  let resolvePromise!: () => void;
  const promise = new Promise<void>(resolve => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

async function collectStream(gateway: DeepSeekGateway): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of gateway.streamChatCompletion(request())) events.push(event);
  return events;
}

function capturePromise<T>(promise: Promise<T>): Promise<
  { readonly ok: true; readonly value: T } |
  { readonly ok: false; readonly error: unknown }
> {
  return promise.then(
    value => ({ ok: true as const, value }),
    error => ({ ok: false as const, error }),
  );
}
