# Model Gateway

该包是桌面 Main 进程访问 DeepSeek 的唯一网络边界，不依赖 Electron，也不读取环境变量。

## 固定边界

- 只请求 `https://api.deepseek.com/models` 与 `https://api.deepseek.com/chat/completions`。
- API Key 只从调用方提供的 `ApiKeyStore` 抽象读取；安全存储不可用时 fail closed。
- 请求固定使用 `thinking: { type: "enabled" }` 与 `reasoning_effort: "high"`，`max_tokens` 不得超过 `16384`。
- 通过请求次数、请求/响应字节数、SSE 单行大小和全请求超时控制预算，不按价格累计。
- completion 日志只含模型、fingerprint、request id、参数摘要与 token usage，不含消息正文或 `reasoning_content`。

## 128k 输入边界

Studio 的模型配置以 128,000 token 作为上下文窗口，但本包不捆绑供应商 tokenizer，无法在本地对输入做可信的精确 token 预判。输入侧因此采用 UTF-8 字节预算作为 fail-closed 保护；最终 token 接受与 usage 以 DeepSeek 响应为准，不把字节估算描述为 token 精确计数。

## 验证

```bash
pnpm typecheck
pnpm test
pnpm build
```

测试全部使用注入的 fetch mock，不访问真实网络。
