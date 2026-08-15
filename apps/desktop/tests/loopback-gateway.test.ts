import { request as httpRequest } from 'node:http'

import { describe, expect, it, vi } from 'vitest'

import {
  GatewayError,
  type ChatCompletionRequest,
  type ChatStreamEvent,
} from '@creative-loop2rsi/model-gateway'

import { LoopbackModelGateway } from '../src/main/loopback-gateway.js'

const keyStore = {
  isAvailable: () => true,
  get: () => 'never-read-by-fake',
  set: () => {},
  delete: () => {},
}

describe('LoopbackModelGateway', () => {
  it('binds loopback, scopes model, strips inbound headers, and revokes capabilities', async () => {
    const seen: ChatCompletionRequest[] = []
    const stream = vi.fn(async function * (body: ChatCompletionRequest): AsyncGenerator<ChatStreamEvent> {
      seen.push(body)
      yield {
        type: 'chunk',
        chunk: {
          id: 'response-one',
          model: body.model,
          system_fingerprint: 'fp-one',
          choices: [],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 20,
            total_tokens: 32,
            prompt_cache_hit_tokens: 5,
          },
        },
      }
      yield { type: 'done' }
    })
    const gateway = new LoopbackModelGateway({
      keyStore,
      gatewayFactory: () => ({ streamChatCompletion: stream }),
    })
    await gateway.start()
    const lease = gateway.issueLease('production', 'deepseek-v4-pro')
    expect(new URL(lease.url).hostname).toBe('127.0.0.1')
    expect(new URL(lease.url).port).not.toBe('0')

    const accepted = await post(lease.url, lease.token, {
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: '写一个场景' }],
      stream: true,
    }, { 'x-deepseek-harness-user-id': 'must-not-forward' })
    expect(accepted.status).toBe(200)
    expect(accepted.body).toContain('data: [DONE]')
    expect(seen).toEqual([{
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: '写一个场景' }],
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
      max_tokens: 16_384,
    }])
    expect(lease.provenance()).toMatchObject({
      completedRequests: 1,
      requestedModel: 'deepseek-v4-pro',
      responseId: 'response-one',
      returnedModels: ['deepseek-v4-pro'],
      systemFingerprints: ['fp-one'],
      usage: { prompt_tokens: 12, completion_tokens: 20, total_tokens: 32, cache_hit_tokens: 5 },
    })
    expect(lease.provenance().completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u)

    expect((await post(lease.url, lease.token, {
      model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'x' }], stream: true,
    })).status).toBe(403)
    lease.revoke()
    expect((await post(lease.url, lease.token, {
      model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'x' }], stream: true,
    })).status).toBe(401)
    await gateway.close()
  })

  it('rejects browser Origin and unrecognized paths before model invocation', async () => {
    const stream = vi.fn(async function * (): AsyncGenerator<ChatStreamEvent> { yield { type: 'done' } })
    const gateway = new LoopbackModelGateway({ keyStore, gatewayFactory: () => ({ streamChatCompletion: stream }) })
    await gateway.start()
    const lease = gateway.issueLease('candidate', 'deepseek-v4-flash')
    expect((await post(lease.url, lease.token, {
      model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'x' }], stream: true,
    }, { origin: 'file://' })).status).toBe(403)
    expect((await post(`${lease.url}/unexpected`, lease.token, {
      model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'x' }], stream: true,
    })).status).toBe(404)
    expect(stream).not.toHaveBeenCalled()
    await gateway.close()
  })

  it.each([
    [402, 'ACCOUNT_BALANCE'],
    [429, 'RATE_LIMITED'],
    [503, 'DEEPSEEK_UNAVAILABLE'],
  ] as const)('preserves actionable upstream HTTP %i before committing SSE headers', async (status, code) => {
    const stream = vi.fn(async function * (): AsyncGenerator<ChatStreamEvent> {
      throw new GatewayError('HTTP_ERROR', 'upstream body must stay private', { status })
    })
    const gateway = new LoopbackModelGateway({
      keyStore,
      gatewayFactory: () => ({ streamChatCompletion: stream }),
    })
    await gateway.start()
    const lease = gateway.issueLease('production', 'deepseek-v4-pro')

    const result = await post(lease.url, lease.token, requestBody())
    expect(result.status).toBe(status)
    expect(JSON.parse(result.body)).toMatchObject({ error: { code } })
    expect(result.body).not.toContain('upstream body must stay private')
    expect(result.body).not.toContain('data:')
    await gateway.close()
  })

  it.each([
    ['FIRST_EVENT_TIMEOUT', 'DEEPSEEK_FIRST_EVENT_TIMEOUT'],
    ['STREAM_IDLE_TIMEOUT', 'DEEPSEEK_STREAM_IDLE_TIMEOUT'],
    ['TOTAL_TIMEOUT', 'DEEPSEEK_TOTAL_TIMEOUT'],
  ] as const)('preserves the classified %s timeout in HTTP evidence', async (upstreamCode, publicCode) => {
    const stream = vi.fn(async function * (): AsyncGenerator<ChatStreamEvent> {
      throw new GatewayError(upstreamCode, 'private timeout detail')
    })
    const gateway = new LoopbackModelGateway({
      keyStore,
      gatewayFactory: () => ({ streamChatCompletion: stream }),
    })
    await gateway.start()
    const lease = gateway.issueLease('production', 'deepseek-v4-pro')

    const result = await post(lease.url, lease.token, requestBody())
    expect(result.status).toBe(504)
    expect(JSON.parse(result.body)).toMatchObject({ error: { code: publicCode } })
    expect(result.body).not.toContain('private timeout detail')
    expect(lease.provenance().requests[0]).toMatchObject({
      status: 'FAILED',
      httpStatus: 504,
      errorCode: publicCode,
    })
    await gateway.close()
  })

  it('issues production leases with layered timeout defaults', async () => {
    const budgets: Partial<import('@creative-loop2rsi/model-gateway').GatewayBudgetPolicy>[] = []
    const gateway = new LoopbackModelGateway({
      keyStore,
      gatewayFactory: budget => {
        budgets.push(budget)
        return {
          streamChatCompletion: async function * (): AsyncGenerator<ChatStreamEvent> {
            yield { type: 'done' }
          },
        }
      },
    })
    await gateway.start()
    gateway.issueLease('production', 'deepseek-v4-flash')

    expect(budgets).toEqual([expect.objectContaining({
      firstEventTimeoutMs: 120_000,
      streamIdleTimeoutMs: 90_000,
      totalTimeoutMs: 600_000,
    })])
    expect(budgets[0]).not.toHaveProperty('timeoutMs')
    await gateway.close()
  })

  it('keeps sanitized per-request evidence across an intermediate failure and retry', async () => {
    let invocation = 0
    const stream = vi.fn(async function * (body: ChatCompletionRequest): AsyncGenerator<ChatStreamEvent> {
      invocation += 1
      if (invocation === 1) {
        throw new GatewayError('HTTP_ERROR', 'private upstream response body', {
          status: 503,
          requestId: 'failed-request-id',
        })
      }
      yield {
        type: 'chunk',
        chunk: {
          id: 'successful-response-id',
          model: body.model,
          system_fingerprint: 'fingerprint-two',
          choices: [],
          usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
        },
      }
      yield { type: 'done' }
    })
    const gateway = new LoopbackModelGateway({
      keyStore,
      gatewayFactory: () => ({ streamChatCompletion: stream }),
    })
    await gateway.start()
    const lease = gateway.issueLease('production', 'deepseek-v4-pro')

    expect((await post(lease.url, lease.token, requestBody())).status).toBe(503)
    expect((await post(lease.url, lease.token, requestBody())).status).toBe(200)

    const evidence = lease.provenance()
    expect(evidence.completedRequests).toBe(1)
    expect(evidence.requests).toHaveLength(2)
    expect(evidence.requests[0]).toMatchObject({
      requestNumber: 1,
      status: 'FAILED',
      httpStatus: 503,
      errorCode: 'DEEPSEEK_UNAVAILABLE',
      responseId: 'failed-request-id',
      usage: {},
    })
    expect(evidence.requests[1]).toMatchObject({
      requestNumber: 2,
      status: 'COMPLETED',
      responseId: 'successful-response-id',
      returnedModel: 'deepseek-v4-pro',
      systemFingerprint: 'fingerprint-two',
      usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
    })
    expect(JSON.stringify(evidence)).not.toContain('private upstream response body')
    expect(evidence.requests.every(item => item.startedAt !== '' && item.completedAt !== undefined)).toBe(true)
    await gateway.close()
  })

  it('aborts the upstream DeepSeek stream when its lease is revoked', async () => {
    const entered = deferred<void>()
    const upstreamAborted = deferred<AbortSignal>()
    const stream = vi.fn(async function * (
      _body: ChatCompletionRequest,
      options?: { readonly signal?: AbortSignal },
    ): AsyncGenerator<ChatStreamEvent> {
      const signal = requiredSignal(options?.signal)
      entered.resolve()
      await rejectWhenAborted(signal, upstreamAborted)
      yield { type: 'done' }
    })
    const gateway = new LoopbackModelGateway({
      keyStore,
      gatewayFactory: () => ({ streamChatCompletion: stream }),
    })
    await gateway.start()
    const lease = gateway.issueLease('production', 'deepseek-v4-pro')
    const pending = post(lease.url, lease.token, requestBody())
    await entered.promise

    lease.revoke()

    expect((await upstreamAborted.promise).aborted).toBe(true)
    const result = await pending
    expect(result.status).toBe(503)
    expect(JSON.parse(result.body)).toMatchObject({ error: { code: 'LEASE_REVOKED' } })
    expect(lease.provenance().requests[0]).toMatchObject({
      status: 'FAILED', errorCode: 'LEASE_REVOKED', httpStatus: 503,
    })
    await gateway.close()
  })

  it('aborts every in-flight upstream stream before closing the gateway', async () => {
    const entered = deferred<void>()
    const upstreamAborted = deferred<AbortSignal>()
    const stream = vi.fn(async function * (
      _body: ChatCompletionRequest,
      options?: { readonly signal?: AbortSignal },
    ): AsyncGenerator<ChatStreamEvent> {
      const signal = requiredSignal(options?.signal)
      entered.resolve()
      await rejectWhenAborted(signal, upstreamAborted)
      yield { type: 'done' }
    })
    const gateway = new LoopbackModelGateway({
      keyStore,
      gatewayFactory: () => ({ streamChatCompletion: stream }),
    })
    await gateway.start()
    const lease = gateway.issueLease('production', 'deepseek-v4-pro')
    const pending = post(lease.url, lease.token, requestBody())
    await entered.promise

    const closing = gateway.close()

    expect((await upstreamAborted.promise).aborted).toBe(true)
    const result = await pending
    expect(result.status).toBe(503)
    expect(JSON.parse(result.body)).toMatchObject({ error: { code: 'LEASE_REVOKED' } })
    expect(lease.provenance().requests[0]).toMatchObject({
      status: 'FAILED', errorCode: 'LEASE_REVOKED', httpStatus: 503,
    })
    await closing
  })

  it('bounds shutdown, force-closes an abort-ignoring stream, and never records it as completed', async () => {
    const entered = deferred<void>()
    const releaseMaliciousStream = deferred<void>()
    const maliciousStreamSettled = deferred<void>()
    const stream = vi.fn(async function * (
      body: ChatCompletionRequest,
      options?: { readonly signal?: AbortSignal },
    ): AsyncGenerator<ChatStreamEvent> {
      try {
        requiredSignal(options?.signal)
        entered.resolve()
        // Deliberately ignore the AbortSignal to model a broken transport.
        await releaseMaliciousStream.promise
        yield {
          type: 'chunk',
          chunk: {
            id: 'must-not-be-accepted',
            model: body.model,
            system_fingerprint: 'must-not-be-accepted',
            choices: [],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        }
        yield { type: 'done' }
      } finally {
        maliciousStreamSettled.resolve()
      }
    })
    const gateway = new LoopbackModelGateway({
      keyStore,
      gatewayFactory: () => ({ streamChatCompletion: stream }),
      shutdownGraceMs: 10,
    })
    await gateway.start()
    const lease = gateway.issueLease('production', 'deepseek-v4-pro')
    const pending = post(lease.url, lease.token, requestBody()).then(
      value => ({ kind: 'response' as const, value }),
      () => ({ kind: 'disconnected' as const }),
    )
    await entered.promise

    await settleWithin(gateway.close(), 250)
    expect(await settleWithin(pending, 250)).toMatchObject({ kind: 'disconnected' })
    expect(lease.provenance()).toMatchObject({ completedRequests: 0, failedRequests: 1 })
    expect(lease.provenance().requests[0]).toMatchObject({
      status: 'FAILED', errorCode: 'LEASE_REVOKED', httpStatus: 503,
    })

    // Even if the hostile iterator later fabricates a complete response, the
    // aborted request remains failed and cannot update aggregate provenance.
    releaseMaliciousStream.resolve()
    await settleWithin(maliciousStreamSettled.promise, 250)
    expect(lease.provenance()).toMatchObject({
      completedRequests: 0,
      returnedModels: [],
      systemFingerprints: [],
    })
    expect(lease.provenance().responseId).toBeUndefined()
    expect(lease.provenance().requests[0]).toMatchObject({ status: 'FAILED' })
  })

  it('aborts the upstream stream when the loopback client disconnects', async () => {
    const entered = deferred<void>()
    const upstreamAborted = deferred<AbortSignal>()
    const stream = vi.fn(async function * (
      _body: ChatCompletionRequest,
      options?: { readonly signal?: AbortSignal },
    ): AsyncGenerator<ChatStreamEvent> {
      const signal = requiredSignal(options?.signal)
      entered.resolve()
      await rejectWhenAborted(signal, upstreamAborted)
      yield { type: 'done' }
    })
    const gateway = new LoopbackModelGateway({
      keyStore,
      gatewayFactory: () => ({ streamChatCompletion: stream }),
    })
    await gateway.start()
    const lease = gateway.issueLease('production', 'deepseek-v4-pro')
    const client = startPost(lease.url, lease.token, requestBody())
    await entered.promise

    client.destroy()

    expect((await upstreamAborted.promise).aborted).toBe(true)
    await vi.waitFor(() => {
      expect(lease.provenance().requests[0]).toMatchObject({
        status: 'FAILED', errorCode: 'CLIENT_DISCONNECTED', httpStatus: 499,
      })
    })
    await gateway.close()
  })
})

function requestBody(): unknown {
  return {
    model: 'deepseek-v4-pro',
    messages: [{ role: 'user', content: '写一个场景' }],
    stream: true,
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(reason?: unknown): void
} {
  let resolvePromise!: (value: T) => void
  let rejectPromise!: (reason?: unknown) => void
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

function requiredSignal(signal: AbortSignal | undefined): AbortSignal {
  if (signal === undefined) throw new Error('loopback gateway did not pass an AbortSignal upstream')
  return signal
}

async function rejectWhenAborted(
  signal: AbortSignal,
  observed: ReturnType<typeof deferred<AbortSignal>>,
): Promise<never> {
  if (signal.aborted) {
    observed.resolve(signal)
    throw signal.reason
  }
  return await new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      observed.resolve(signal)
      reject(signal.reason)
    }, { once: true })
  })
}

async function post(
  base: string,
  token: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const url = new URL(base)
  const path = url.pathname === '/' ? '/chat/completions' : url.pathname
  return await new Promise((resolvePromise, reject) => {
    const request = httpRequest({
      hostname: url.hostname,
      port: Number(url.port),
      path,
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...headers,
      },
    }, response => {
      let responseBody = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { responseBody += chunk })
      response.on('end', () => resolvePromise({ status: response.statusCode ?? 0, body: responseBody }))
    })
    request.once('error', reject)
    request.end(JSON.stringify(body))
  })
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('operation did not settle within the test bound')), timeoutMs)
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

function startPost(base: string, token: string, body: unknown) {
  const url = new URL(base)
  const request = httpRequest({
    hostname: url.hostname,
    port: Number(url.port),
    path: '/chat/completions',
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
  })
  // Destroying the client is the behavior under test; ECONNRESET is expected.
  request.on('error', () => undefined)
  request.end(JSON.stringify(body))
  return request
}
