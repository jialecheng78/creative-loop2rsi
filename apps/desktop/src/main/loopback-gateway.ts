import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import {
  DeepSeekGateway,
  GatewayError,
  type ApiKeyStore,
  type ChatCompletionRequest,
  type ChatStreamChunk,
  type ChatStreamEvent,
  type GatewayBudgetPolicy,
} from '@creative-loop2rsi/model-gateway'
import type { DshModelId, RuntimeRole } from '@creative-loop2rsi/runtime-dsh'

const MAX_BODY_BYTES = 2 * 1024 * 1024
const DEFAULT_WORKER_BUDGET: Partial<GatewayBudgetPolicy> = {
  maxRequests: 12,
  maxRequestBytes: 4 * 1024 * 1024,
  maxResponseBytes: 32 * 1024 * 1024,
  maxSingleRequestBytes: MAX_BODY_BYTES,
  maxSingleResponseBytes: 16 * 1024 * 1024,
  timeoutMs: 120_000,
}

interface GatewayStream {
  streamChatCompletion(
    request: ChatCompletionRequest,
    options?: { readonly signal?: AbortSignal },
  ): AsyncIterable<ChatStreamEvent>
}

interface LeaseRecord {
  readonly role: RuntimeRole
  readonly model: DshModelId
  readonly gateway: GatewayStream
  readonly observation: MutableLeaseObservation
  readonly abortController: AbortController
  readonly requests: MutableLoopbackRequestProvenance[]
  nextRequestNumber: number
}

interface MutableLeaseObservation {
  completedRequests: number
  completedAt?: string
  responseId?: string
  readonly returnedModels: Set<string>
  readonly systemFingerprints: Set<string>
  readonly usage: Record<string, number>
}

export interface LoopbackLeaseProvenance {
  readonly requestCount: number
  readonly completedRequests: number
  readonly failedRequests: number
  readonly completedAt?: string
  readonly requestedModel: DshModelId
  readonly responseId?: string
  readonly returnedModels: readonly string[]
  readonly systemFingerprints: readonly string[]
  readonly usage: Readonly<Record<string, number>>
  readonly requests: readonly LoopbackRequestProvenance[]
}

export interface LoopbackRequestProvenance {
  readonly requestNumber: number
  readonly startedAt: string
  readonly completedAt?: string
  readonly status: 'STARTED' | 'COMPLETED' | 'FAILED'
  readonly httpStatus?: number
  readonly errorCode?: string
  readonly responseId?: string
  readonly returnedModel?: string
  readonly systemFingerprint?: string
  readonly usage: Readonly<Record<string, number>>
}

interface MutableLoopbackRequestProvenance {
  requestNumber: number
  startedAt: string
  completedAt?: string
  status: 'STARTED' | 'COMPLETED' | 'FAILED'
  httpStatus?: number
  errorCode?: string
  responseId?: string
  returnedModel?: string
  systemFingerprint?: string
  usage: Record<string, number>
}

export interface LoopbackGatewayLease {
  readonly url: string
  readonly token: string
  readonly role: RuntimeRole
  readonly model: DshModelId
  provenance(): LoopbackLeaseProvenance
  revoke(): void
}

export interface LoopbackGatewayOptions {
  readonly keyStore: ApiKeyStore
  readonly gatewayFactory?: (budget: Partial<GatewayBudgetPolicy>) => GatewayStream
}

/** Main-process-only loopback capability server for DSH workers. */
export class LoopbackModelGateway {
  private readonly leases = new Map<string, LeaseRecord>()
  private readonly server: Server
  private readonly gatewayFactory: (budget: Partial<GatewayBudgetPolicy>) => GatewayStream
  private port: number | undefined

  constructor(options: LoopbackGatewayOptions) {
    this.gatewayFactory = options.gatewayFactory
      ?? (budget => new DeepSeekGateway({ keyStore: options.keyStore, budget }))
    this.server = createServer((request, response) => {
      void this.handle(request, response)
    })
  }

  async start(): Promise<void> {
    if (this.port !== undefined) return
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.removeListener('error', reject)
        const address = this.server.address()
        if (address === null || typeof address === 'string' || address.address !== '127.0.0.1') {
          reject(new Error('Loopback Gateway 未绑定到 127.0.0.1。'))
          return
        }
        this.port = address.port
        resolve()
      })
    })
  }

  issueLease(
    role: RuntimeRole,
    model: DshModelId,
    budget: Partial<GatewayBudgetPolicy> = DEFAULT_WORKER_BUDGET,
  ): LoopbackGatewayLease {
    const port = this.port
    if (port === undefined) throw new Error('Loopback Gateway 尚未启动。')
    const token = randomBytes(32).toString('base64url')
    const digest = tokenDigest(token)
    const observation: MutableLeaseObservation = {
      completedRequests: 0,
      returnedModels: new Set(),
      systemFingerprints: new Set(),
      usage: {},
    }
    const requests: MutableLoopbackRequestProvenance[] = []
    const abortController = new AbortController()
    this.leases.set(digest, {
      role,
      model,
      gateway: this.gatewayFactory(budget),
      observation,
      abortController,
      requests,
      nextRequestNumber: 1,
    })
    let revoked = false
    return {
      url: `http://127.0.0.1:${port}`,
      token,
      role,
      model,
      provenance: () => ({
        requestCount: requests.length,
        completedRequests: observation.completedRequests,
        failedRequests: requests.filter(item => item.status === 'FAILED').length,
        ...(observation.completedAt === undefined ? {} : { completedAt: observation.completedAt }),
        requestedModel: model,
        ...(observation.responseId === undefined ? {} : { responseId: observation.responseId }),
        returnedModels: [...observation.returnedModels].sort(),
        systemFingerprints: [...observation.systemFingerprints].sort(),
        usage: aggregateRequestUsage(requests),
        requests: requests.map(publicRequestRecord),
      }),
      revoke: () => {
        if (revoked) return
        revoked = true
        abortController.abort(new Error('lease-revoked'))
        this.leases.delete(digest)
      },
    }
  }

  async close(): Promise<void> {
    for (const lease of this.leases.values()) {
      lease.abortController.abort(new Error('gateway-closed'))
    }
    this.leases.clear()
    this.port = undefined
    if (!this.server.listening) return
    await new Promise<void>((resolve, reject) => {
      this.server.close(error => error === undefined ? resolve() : reject(error))
    })
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let abortScope: RequestAbortScope | undefined
    let iterator: AsyncIterator<ChatStreamEvent> | undefined
    let requestObservation: MutableLeaseObservation | undefined
    let requestRecord: MutableLoopbackRequestProvenance | undefined
    try {
      const lease = this.authorize(request)
      if (request.method !== 'POST' || request.url !== '/chat/completions') {
        writeJson(response, 404, { error: { code: 'NOT_FOUND', message: '路径不存在。' } })
        return
      }
      const value = JSON.parse(await readBody(request)) as unknown
      if (!isRecord(value) || value.stream !== true) {
        writeJson(response, 400, { error: { code: 'BAD_REQUEST', message: 'DSH 必须使用流式请求。' } })
        return
      }
      if (value.model !== lease.model) {
        writeJson(response, 403, { error: { code: 'MODEL_SCOPE', message: '模型不在当前 Worker 授权范围内。' } })
        return
      }
      const { stream: _stream, ...requestBody } = value
      const governedRequest = {
        ...requestBody,
        thinking: { type: 'enabled' },
        reasoning_effort: 'high',
        max_tokens: 16_384,
      }
      abortScope = createRequestAbortScope(lease.abortController.signal, response)
      requestObservation = {
        completedRequests: 0,
        returnedModels: new Set(),
        systemFingerprints: new Set(),
        usage: {},
      }
      requestRecord = beginRequestRecord(lease)
      iterator = lease.gateway.streamChatCompletion(
        governedRequest as unknown as ChatCompletionRequest,
        { signal: abortScope.controller.signal },
      )[Symbol.asyncIterator]()
      // Do not commit an SSE 200 until upstream has produced its first event.
      // A 402/429/5xx raised by the initial next() therefore remains an
      // actionable HTTP JSON error instead of becoming a broken 200 stream.
      const first = await iterator.next()
      if (first.done) throw new GatewayRequestError(502, 'EMPTY_STREAM', 'DeepSeek 没有返回流式内容，请重试。')
      if (first.value.type === 'done') {
        throw new GatewayRequestError(502, 'EMPTY_STREAM', 'DeepSeek 没有返回可保存的内容，请重试。')
      }
      if (abortScope.controller.signal.aborted) throw abortScope.error()
      response.writeHead(200, {
        'cache-control': 'no-store',
        connection: 'close',
        'content-type': 'text/event-stream; charset=utf-8',
        'x-content-type-options': 'nosniff',
      })
      writeStreamEvent(response, first.value, requestObservation)
      for (;;) {
        const next = await iterator.next()
        if (next.done) break
        writeStreamEvent(response, next.value, requestObservation)
      }
      if (requestObservation.responseId === undefined
        || requestObservation.returnedModels.size !== 1
        || requestObservation.systemFingerprints.size !== 1) {
        throw new GatewayRequestError(502, 'PROVENANCE_INCOMPLETE', '模型来源证据不完整，本次不会保存为成功结果。')
      }
      completeRequestRecord(requestRecord, requestObservation)
      commitObservation(lease.observation, requestObservation)
      response.end()
    } catch (error) {
      const safe = abortScope?.controller.signal.aborted === true
        ? abortScope.error()
        : publicGatewayError(error)
      if (requestRecord !== undefined && requestObservation !== undefined) {
        failRequestRecord(requestRecord, requestObservation, safe, error)
      }
      if (abortScope?.kind === 'client' || response.destroyed) return
      if (response.headersSent) {
        response.destroy()
        return
      }
      writeJson(response, safe.status, { error: { code: safe.code, message: safe.message } })
    } finally {
      abortScope?.cleanup()
      if (iterator?.return !== undefined) {
        try {
          await iterator.return()
        } catch {
          // The upstream iterator may already have failed because this request
          // was aborted. Its original failure has already been handled above.
        }
      }
    }
  }

  private authorize(request: IncomingMessage): LeaseRecord {
    const remote = request.socket.remoteAddress
    if (remote !== '127.0.0.1' && remote !== '::ffff:127.0.0.1') {
      throw new GatewayRequestError(403, 'LOCAL_ONLY', '只允许本机 Worker。')
    }
    const port = this.port
    if (port === undefined || request.headers.host !== `127.0.0.1:${port}`) {
      throw new GatewayRequestError(403, 'HOST_REJECTED', 'Host 校验失败。')
    }
    if (request.headers.origin !== undefined || request.headers.referer !== undefined) {
      throw new GatewayRequestError(403, 'BROWSER_REJECTED', '浏览器来源不允许访问 Worker 网关。')
    }
    if (request.headers['x-forwarded-for'] !== undefined
      || request.headers['x-forwarded-host'] !== undefined
      || request.headers['x-forwarded-proto'] !== undefined) {
      throw new GatewayRequestError(403, 'FORWARDED_REJECTED', '转发请求不允许访问 Worker 网关。')
    }
    const authorization = request.headers.authorization
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
      throw new GatewayRequestError(401, 'CAPABILITY_REQUIRED', '缺少 Worker capability。')
    }
    const supplied = tokenDigest(authorization.slice('Bearer '.length))
    let match: LeaseRecord | undefined
    for (const [digest, lease] of this.leases) {
      const left = Buffer.from(digest, 'hex')
      const right = Buffer.from(supplied, 'hex')
      if (left.length === right.length && timingSafeEqual(left, right)) match = lease
    }
    if (match === undefined) {
      throw new GatewayRequestError(401, 'CAPABILITY_REJECTED', 'Worker capability 无效或已撤销。')
    }
    return match
  }
}

class GatewayRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

function tokenDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MAX_BODY_BYTES) {
      throw new GatewayRequestError(413, 'REQUEST_TOO_LARGE', '请求体过大。')
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

type RequestAbortKind = 'client' | 'lease'

class RequestAbortScope {
  readonly controller = new AbortController()
  kind: RequestAbortKind | undefined
  private readonly onClientClose: () => void
  private readonly onLeaseAbort: () => void

  constructor(
    private readonly leaseSignal: AbortSignal,
    private readonly response: ServerResponse,
  ) {
    this.onLeaseAbort = () => { this.abort('lease') }
    this.onClientClose = () => {
      if (!this.response.writableEnded) this.abort('client')
    }
    leaseSignal.addEventListener('abort', this.onLeaseAbort, { once: true })
    response.once('close', this.onClientClose)
    if (leaseSignal.aborted) this.abort('lease')
  }

  error(): GatewayRequestError {
    if (this.kind === 'client') {
      return new GatewayRequestError(499, 'CLIENT_DISCONNECTED', '客户端已断开，本次模型调用已停止。')
    }
    return new GatewayRequestError(503, 'LEASE_REVOKED', '本次模型调用已停止，请重新开始创作。')
  }

  cleanup(): void {
    this.leaseSignal.removeEventListener('abort', this.onLeaseAbort)
    this.response.removeListener('close', this.onClientClose)
  }

  private abort(kind: RequestAbortKind): void {
    if (this.controller.signal.aborted) return
    this.kind = kind
    this.controller.abort(new Error(kind === 'client' ? 'client-disconnected' : 'lease-revoked'))
  }
}

function createRequestAbortScope(
  leaseSignal: AbortSignal,
  response: ServerResponse,
): RequestAbortScope {
  return new RequestAbortScope(leaseSignal, response)
}

function publicGatewayError(error: unknown): GatewayRequestError {
  if (error instanceof GatewayRequestError) return error
  if (!(error instanceof GatewayError)) {
    return new GatewayRequestError(502, 'GATEWAY_ERROR', 'DeepSeek 调用失败，请稍后重试。')
  }

  if (error.status === 401 || error.status === 403
    || error.code === 'AUTH_MISSING' || error.code === 'AUTH_UNAVAILABLE') {
    return new GatewayRequestError(401, 'CREDENTIAL_REJECTED', 'API Key 无效或已失效，请在设置中重新配置。')
  }
  if (error.status === 402) {
    return new GatewayRequestError(402, 'ACCOUNT_BALANCE', 'DeepSeek 账户余额不足，请充值后重试。')
  }
  if (error.status === 429) {
    return new GatewayRequestError(429, 'RATE_LIMITED', '请求过于频繁，请稍后再试。')
  }
  if (error.status !== undefined && error.status >= 500 && error.status <= 599) {
    return new GatewayRequestError(error.status, 'DEEPSEEK_UNAVAILABLE', 'DeepSeek 服务暂时不可用，请稍后重试。')
  }
  if (error.code === 'TIMEOUT') {
    return new GatewayRequestError(504, 'DEEPSEEK_TIMEOUT', 'DeepSeek 响应超时，请重试。')
  }
  if (error.code === 'NETWORK_ERROR') {
    return new GatewayRequestError(502, 'DEEPSEEK_NETWORK', '无法连接 DeepSeek，请检查网络后重试。')
  }
  if (error.code === 'BAD_REQUEST') {
    return new GatewayRequestError(400, 'BAD_REQUEST', '创作请求无法处理，请调整内容后重试。')
  }
  if (error.code === 'BUDGET_EXCEEDED') {
    return new GatewayRequestError(429, 'TASK_BUDGET_EXCEEDED', '本次任务已达调用上限，请重新开始。')
  }
  return new GatewayRequestError(502, 'GATEWAY_ERROR', 'DeepSeek 调用失败，请稍后重试。')
}

function writeStreamEvent(
  response: ServerResponse,
  event: ChatStreamEvent,
  observation: MutableLeaseObservation,
): void {
  if (event.type === 'chunk') {
    observeChunk(observation, event.chunk)
    response.write(`data: ${JSON.stringify(event.chunk)}\n\n`)
    return
  }
  response.write('data: [DONE]\n\n')
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    connection: 'close',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(body))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function observeChunk(
  observation: MutableLeaseObservation,
  chunk: ChatStreamChunk,
): void {
  if (typeof chunk.id === 'string' && chunk.id !== '') observation.responseId = chunk.id
  if (typeof chunk.model === 'string' && chunk.model !== '') observation.returnedModels.add(chunk.model)
  if (typeof chunk.system_fingerprint === 'string' && chunk.system_fingerprint !== '') {
    observation.systemFingerprints.add(chunk.system_fingerprint)
  }
  if (chunk.usage === undefined || chunk.usage === null) return
  const aliases: Readonly<Record<string, string>> = {
    prompt_cache_hit_tokens: 'cache_hit_tokens',
    prompt_cache_miss_tokens: 'cache_miss_tokens',
  }
  for (const [rawKey, rawValue] of Object.entries(chunk.usage)) {
    if (!Number.isSafeInteger(rawValue) || (rawValue as number) < 0) continue
    const key = aliases[rawKey] ?? rawKey
    if (![
      'cache_hit_tokens',
      'cache_miss_tokens',
      'completion_tokens',
      'prompt_tokens',
      'total_tokens',
    ].includes(key)) continue
    observation.usage[key] = rawValue as number
  }
}

function commitObservation(target: MutableLeaseObservation, source: MutableLeaseObservation): void {
  target.completedRequests += 1
  target.completedAt = new Date().toISOString()
  if (source.responseId !== undefined) target.responseId = source.responseId
  for (const value of source.returnedModels) target.returnedModels.add(value)
  for (const value of source.systemFingerprints) target.systemFingerprints.add(value)
  for (const [key, value] of Object.entries(source.usage)) {
    target.usage[key] = (target.usage[key] ?? 0) + value
  }
}

function beginRequestRecord(lease: LeaseRecord): MutableLoopbackRequestProvenance {
  const record: MutableLoopbackRequestProvenance = {
    requestNumber: lease.nextRequestNumber,
    startedAt: new Date().toISOString(),
    status: 'STARTED',
    usage: {},
  }
  lease.nextRequestNumber += 1
  lease.requests.push(record)
  return record
}

function completeRequestRecord(
  record: MutableLoopbackRequestProvenance,
  observation: MutableLeaseObservation,
): void {
  record.status = 'COMPLETED'
  record.completedAt = new Date().toISOString()
  record.httpStatus = 200
  copyRequestObservation(record, observation)
}

function failRequestRecord(
  record: MutableLoopbackRequestProvenance,
  observation: MutableLeaseObservation,
  error: GatewayRequestError,
  original: unknown,
): void {
  if (record.status !== 'STARTED') return
  record.status = 'FAILED'
  record.completedAt = new Date().toISOString()
  record.httpStatus = error.status
  record.errorCode = error.code
  if (original instanceof GatewayError && original.requestId !== undefined) {
    record.responseId = original.requestId
  }
  copyRequestObservation(record, observation)
}

function copyRequestObservation(
  record: MutableLoopbackRequestProvenance,
  observation: MutableLeaseObservation,
): void {
  if (observation.responseId !== undefined) record.responseId = observation.responseId
  const returnedModels = [...observation.returnedModels].sort()
  const fingerprints = [...observation.systemFingerprints].sort()
  const returnedModel = returnedModels[0]
  const fingerprint = fingerprints[0]
  if (returnedModel !== undefined) record.returnedModel = returnedModel
  if (fingerprint !== undefined) record.systemFingerprint = fingerprint
  record.usage = { ...observation.usage }
}

function publicRequestRecord(record: MutableLoopbackRequestProvenance): LoopbackRequestProvenance {
  return {
    requestNumber: record.requestNumber,
    startedAt: record.startedAt,
    ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
    status: record.status,
    ...(record.httpStatus === undefined ? {} : { httpStatus: record.httpStatus }),
    ...(record.errorCode === undefined ? {} : { errorCode: record.errorCode }),
    ...(record.responseId === undefined ? {} : { responseId: record.responseId }),
    ...(record.returnedModel === undefined ? {} : { returnedModel: record.returnedModel }),
    ...(record.systemFingerprint === undefined ? {} : { systemFingerprint: record.systemFingerprint }),
    usage: { ...record.usage },
  }
}

function aggregateRequestUsage(requests: readonly MutableLoopbackRequestProvenance[]): Record<string, number> {
  const usage: Record<string, number> = {}
  for (const request of requests) {
    for (const [key, value] of Object.entries(request.usage)) usage[key] = (usage[key] ?? 0) + value
  }
  return usage
}
