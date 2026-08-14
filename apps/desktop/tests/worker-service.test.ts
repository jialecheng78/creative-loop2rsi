import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import type {
  DshRuntimeLaunchSpec,
  RuntimeEvent,
  RuntimeStatus,
} from '@creative-loop2rsi/runtime-dsh'

import { RuntimeWorkerService, type WorkerRuntime } from '../src/worker/service.js'

const spec: DshRuntimeLaunchSpec = {
  command: resolve('/tmp', 'node'),
  args: [],
  cwd: resolve('/tmp', 'workspace'),
  workspaceDir: resolve('/tmp', 'workspace'),
  dshHome: resolve('/tmp', 'app-runtime', 'dsh-home', 'production'),
  sessionRoot: resolve('/tmp', 'sessions'),
  role: 'production',
  model: 'deepseek-v4-pro',
  gateway: { url: 'http://127.0.0.1:4000', token: 'c'.repeat(32) },
}

describe('RuntimeWorkerService', () => {
  it('fails closed before trusted main configures a runtime', async () => {
    const service = new RuntimeWorkerService(() => { throw new Error('must not construct') })
    expect(await service.handle({ id: '1', method: 'startRun', input: 'hello' }, () => {})).toMatchObject({
      id: '1',
      ok: false,
      error: { code: 'NOT_CONFIGURED' },
    })
  })

  it('forwards only runtime-neutral events', async () => {
    const emitted: RuntimeEvent[] = []
    const runtime: WorkerRuntime = {
      status: (): RuntimeStatus => ({ state: 'ready', role: 'production', model: 'deepseek-v4-pro' }),
      startRun: async () => ({ runId: 'run-1', sessionId: 'session-1' }),
      streamEvents: async function * () {
        yield { type: 'output', runId: 'run-1', text: '结果' }
        yield { type: 'state', runId: 'run-1', state: 'completed' }
      },
      cancelRun: async () => {},
      dispose: async () => {},
    }
    const service = new RuntimeWorkerService(() => runtime)
    expect(await service.handle({ id: '1', method: 'configure', spec }, event => emitted.push(event))).toMatchObject({ ok: true })
    expect(await service.handle({ id: '2', method: 'startRun', input: 'hello' }, event => emitted.push(event))).toEqual({
      id: '2',
      ok: true,
      result: { runId: 'run-1', sessionId: 'session-1' },
    })
    await new Promise(resolvePromise => setTimeout(resolvePromise, 0))
    expect(emitted).toEqual([
      { type: 'output', runId: 'run-1', text: '结果' },
      { type: 'state', runId: 'run-1', state: 'completed' },
    ])
  })
})
