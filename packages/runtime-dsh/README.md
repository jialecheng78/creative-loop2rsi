# DSH runtime adapter

This package is the only DSH-specific boundary in Creative RSI Studio. Its
public types describe Studio runs and never expose DSH session or Cordis
types.

The pinned `@deepseek-ai/dsh` package is a profile CLI. It is **not** treated
as a reusable JSON-RPC runtime. Long-lived application runs use the separate,
published `@deepseek-ai/dsh-sdk-client` API and require an explicitly supplied
stdio JSON-RPC runtime command. Missing commands, unsupported package versions,
non-loopback gateways, and unsafe environments fail closed.

Electron `utilityProcess` cannot provide a writable stdin stream. The desktop
application therefore runs this adapter inside a utility worker and lets the
SDK client own the runtime subprocess. Main-to-worker traffic uses Electron
message ports; runtime-to-SDK traffic uses DSH's newline-delimited JSON-RPC
stdio protocol. `resolvePublishedRuntime()` resolves only the package's public
`@deepseek-ai/dsh-sdk-jsonrpc-demo/bin` export and fails closed if it disappears.

The trusted profile configures the stock rc.6 DeepSeek adapter with
`apiKeyEnv: CREATIVE_RSI_GATEWAY_TOKEN` and a loopback-only Gateway URL. The
DSH process therefore receives a short-lived gateway capability, never the
user's DeepSeek API key. Stock DSH headless mode is deliberately not used as a
fallback because it is one-shot text output rather than the required session,
notification, cancellation, and shutdown protocol.

The trusted v1 profile deliberately mounts neither the JSONL session
persistence backend nor its checkpoint policy. The pinned rc.6 backend stores
assistant reasoning chunks losslessly, which conflicts with Studio's promise
that model reasoning never reaches disk. Completed work and governance state
are recovered from the Python Controller; an interrupted model turn is
redispatched from the last sealed boundary instead of being resumed after a
process restart.

The profile also overrides rc.6's default model retry policy. It permits at
most two retries only for `RATE_LIMIT` and pre-stream `SERVER` failures. It
does not retry `TIMEOUT` or `TRANSPORT`: once the loopback Gateway has emitted
a valid SSE event, replaying the whole request can repeat a long, partially
generated response and duplicate cost. The Gateway owns the public
first-event, stream-idle, and absolute-total timeout contract. The adapter
recognizes all three codes when rc.6 exposes them. Because rc.6 flattens an
HTTP 5xx exhausted before the first stream event to `SERVER`, Main also reads
the loopback request ledger and restores the precise timeout class before it
is shown or committed; the runtime event alone is not authoritative.

The trusted profile fixes thinking to `enabled`, reasoning effort to `high`,
and the total output ceiling to 32,768 tokens for every Studio role. It keeps
`maxTokensAsSuccess: false`, so reaching that ceiling remains
`OUTPUT_TRUNCATED`; partial output cannot be promoted to a completed work.
