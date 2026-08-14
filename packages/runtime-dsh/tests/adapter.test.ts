import { resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  DshRuntimeAdapter,
  type DshRuntimeLaunchSpec,
  type HarnessFactory,
  type RuntimeEvent,
} from '../src/index.js'

const runtimeSpec: DshRuntimeLaunchSpec = {
  command: resolve('/tmp', 'node'),
  args: [resolve('/tmp', 'runtime.js')],
  cwd: resolve('/tmp', 'workspace'),
  workspaceDir: resolve('/tmp', 'workspace'),
  dshHome: resolve('/tmp', 'app-runtime', 'dsh-home', 'production'),
  sessionRoot: resolve('/tmp', 'sessions'),
  role: 'production',
  model: 'deepseek-v4-flash',
  gateway: { url: 'http://127.0.0.1:41001', token: 'b'.repeat(32) },
}

async function collect(iterable: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const result: RuntimeEvent[] = []
  for await (const event of iterable) result.push(event)
  return result
}

describe('DshRuntimeAdapter', () => {
  it('maps public SDK runs to runtime-neutral events', async () => {
    const close = vi.fn(async () => {})
    const factory: HarnessFactory = async () => ({
      start: vi.fn(async () => {}),
      run: async (_input, options) => {
        options.onNotification({ method: 'session.status', params: { status: 'running' } })
        options.onNotification({ method: 'session.status', params: { status: 'idle' } })
        return {
          sessionId: options.sessionId,
          finalResponse: '一个安静但完整的结尾。',
          events: [turnEnd({ kind: 'completed' })],
        }
      },
      close,
    })
    const adapter = new DshRuntimeAdapter(runtimeSpec, factory, () => undefined)
    const handle = await adapter.startRun({ input: '写一个短场景' })
    const events = await collect(adapter.streamEvents(handle.runId))
    expect(events).toEqual(expect.arrayContaining([
      { type: 'state', runId: handle.runId, state: 'running' },
      { type: 'progress', runId: handle.runId, phase: 'working' },
      { type: 'progress', runId: handle.runId, phase: 'idle' },
      { type: 'output', runId: handle.runId, text: '一个安静但完整的结尾。' },
      { type: 'state', runId: handle.runId, state: 'completed' },
    ]))
    expect(adapter.status().state).toBe('ready')
    await adapter.dispose()
    expect(close).toHaveBeenCalledOnce()
  })

  it('implements cancellation by closing and replacing the whole SDK runtime', async () => {
    let rejectRun: ((error: Error) => void) | undefined
    const close = vi.fn(async () => rejectRun?.(new Error('closed')))
    const factory: HarnessFactory = async () => ({
      start: async () => {},
      run: async () => await new Promise((_resolve, reject) => { rejectRun = reject }),
      close,
    })
    const adapter = new DshRuntimeAdapter(runtimeSpec, factory, () => undefined)
    const handle = await adapter.startRun({ input: '开始' })
    const collecting = collect(adapter.streamEvents(handle.runId))
    await adapter.cancelRun(handle.runId)
    expect(await collecting).toContainEqual({ type: 'state', runId: handle.runId, state: 'cancelled' })
    expect(close).toHaveBeenCalledOnce()
    expect(adapter.status().state).toBe('ready')
  })

  it('does not leak SDK error details to runtime events', async () => {
    const factory: HarnessFactory = async () => ({
      start: async () => {},
      run: async () => { throw new Error('Bearer sensitive-value') },
      close: async () => {},
    })
    const adapter = new DshRuntimeAdapter(runtimeSpec, factory, () => undefined)
    const handle = await adapter.startRun({ input: '开始' })
    const events = await collect(adapter.streamEvents(handle.runId))
    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain('sensitive-value')
    expect(serialized).toContain('RUNTIME_FAILED')
  })

  it.each([
    [{ code: 'AUTH', status: 401 }, 'CREDENTIAL_REJECTED', '请在设置中重新配置'],
    [{ code: 'QUOTA', status: 402 }, 'ACCOUNT_BALANCE', '请充值后重试'],
    [{ code: 'RATE_LIMIT', status: 429 }, 'RATE_LIMITED', '请稍后重试'],
    [{ code: 'HTTP_ERROR', status: 503 }, 'DEEPSEEK_UNAVAILABLE', '服务暂时不可用'],
    [{ code: 'TIMEOUT' }, 'DEEPSEEK_TIMEOUT', '响应超时'],
  ] as const)(
    'turn/end failures are terminal and sanitized: %o -> %s',
    async (failure, expectedCode, expectedMessage) => {
      const factory: HarnessFactory = async () => ({
        start: async () => {},
        run: async (_input, options) => ({
          sessionId: options.sessionId,
          finalResponse: '',
          events: [turnEnd({
            kind: 'error',
            error: { ...failure, message: 'Bearer provider-secret /private/provider/path' },
          })],
        }),
        close: async () => {},
      })
      const adapter = new DshRuntimeAdapter(runtimeSpec, factory, () => undefined)
      const handle = await adapter.startRun({ input: '开始' })
      const events = await collect(adapter.streamEvents(handle.runId))
      expect(events).toContainEqual(expect.objectContaining({
        type: 'error',
        runId: handle.runId,
        code: expectedCode,
        message: expect.stringContaining(expectedMessage),
      }))
      expect(events).toContainEqual({ type: 'state', runId: handle.runId, state: 'failed' })
      expect(events.some(event => event.type === 'output')).toBe(false)
      expect(events.some(event => event.type === 'state' && event.state === 'completed')).toBe(false)
      expect(JSON.stringify(events)).not.toContain('provider-secret')
      expect(JSON.stringify(events)).not.toContain('/private/provider/path')
      expect(adapter.status()).toMatchObject({ state: 'failed', lastErrorCode: expectedCode })
      await adapter.dispose()
    },
  )

  it('does not publish a non-empty max-token response as a completed work', async () => {
    const factory: HarnessFactory = async () => ({
      start: async () => {},
      run: async (_input, options) => ({
        sessionId: options.sessionId,
        finalResponse: '这是一份被截断的草稿。',
        events: [turnEnd({ kind: 'max-tokens' })],
      }),
      close: async () => {},
    })
    const adapter = new DshRuntimeAdapter(runtimeSpec, factory, () => undefined)
    const handle = await adapter.startRun({ input: '开始' })
    const events = await collect(adapter.streamEvents(handle.runId))
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error', code: 'OUTPUT_TRUNCATED', message: expect.stringContaining('未保存为完整版本'),
    }))
    expect(events.some(event => event.type === 'output')).toBe(false)
    expect(events).toContainEqual({ type: 'state', runId: handle.runId, state: 'failed' })
  })
})

function turnEnd(reason: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'turn/end',
    seq: 1,
    time: 1,
    data: { turn: 1, reason },
  }
}
