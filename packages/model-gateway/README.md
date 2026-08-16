# Model Gateway

该包是桌面 Main 进程访问 DeepSeek 的唯一网络边界，不依赖 Electron，也不读取环境变量。

## 固定边界

- 只请求 `https://api.deepseek.com/models` 与 `https://api.deepseek.com/chat/completions`。
- API Key 只从调用方提供的 `ApiKeyStore` 抽象读取；安全存储不可用时 fail closed。
- 请求固定使用 `thinking: { type: "enabled" }` 与 `reasoning_effort: "high"`，`max_tokens` 不得超过 `32768`；达到上限由 Runtime 归类为 `OUTPUT_TRUNCATED`，不能视为完整成功。
- 通过请求次数、请求/响应字节数、SSE 单行大小和分层超时控制预算，不按价格累计。
- completion 日志只含模型、fingerprint、request id、参数摘要与 token usage，不含消息正文或 `reasoning_content`。

## 分层超时合同

流式请求不得再用一个总计时器把“正在持续产生进展”误判为传输失败。固定三层边界为：

- `firstEventTimeoutMs = 120000`：流式聊天从请求开始到第一个通过校验的 SSE event；HTTP 响应头、裸字节和 comment 不算进展。`/models` 是连接校验，同样受这一较短时限约束，不等待绝对总时限。
- `streamIdleTimeoutMs = 90000`：首个合法 event 之后，两个合法 event 之间允许的最长静默时间；每个 event 重置该计时器。
- `totalTimeoutMs = 600000`：从请求开始到完整结束的绝对上限；任何进展都不重置。

三类失败分别返回 `FIRST_EVENT_TIMEOUT`、`STREAM_IDLE_TIMEOUT` 和 `TOTAL_TIMEOUT`。调用方的 `AbortSignal` 始终优先表示取消，不得被改写成 timeout。

上游 SSE 只有在解析器观察到唯一 `[DONE]`、继续读到正常 EOF 且没有尾随 event 后才算完整。桌面 Loopback 还必须在向 DSH 下发自己的 `[DONE]` 前先提交脱敏 request ledger；缺 DONE、DONE 后异常、EOF 前取消或超时都不得让 Runtime 看见成功终止帧。

`timeoutMs` 仅作为旧调用方的临时兼容入口：单独传入时同时设置三层超时；与任一新字段混用时 fail closed。新代码不得继续使用它。

## 128k 输入边界

Studio 的模型配置以 128,000 token 作为上下文窗口，但本包不捆绑供应商 tokenizer，无法在本地对输入做可信的精确 token 预判。输入侧因此采用 UTF-8 字节预算作为 fail-closed 保护；最终 token 接受与 usage 以 DeepSeek 响应为准，不把字节估算描述为 token 精确计数。

## 验证

```bash
pnpm typecheck
pnpm test
pnpm build
```

测试全部使用注入的 fetch mock，不访问真实网络。
