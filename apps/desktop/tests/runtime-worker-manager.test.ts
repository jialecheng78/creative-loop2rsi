import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  utilityProcess: { fork: vi.fn() },
}))

import type { RuntimeEvent } from '@creative-loop2rsi/runtime-dsh'
import type { RuntimeWorkerRequest } from '@creative-loop2rsi/runtime-dsh/worker-protocol'

import { RuntimeWorkerManager } from '../src/main/runtime-worker-manager.js'

describe('RuntimeWorkerManager process failure', () => {
  it('turns an active utility-process exit into terminal events for governance cleanup', async () => {
    const child = new FakeUtilityProcess()
    const events: RuntimeEvent[] = []
    const manager = new RuntimeWorkerManager({
      workerPath: '/trusted/worker.js',
      processFactory: (() => child) as never,
      onEvent: event => events.push(event),
    })
    manager.configure({
      command: '/trusted/node',
      args: ['/trusted/runtime', '/trusted/profile'],
      cwd: '/trusted/workspace',
      workspaceDir: '/trusted/workspace',
      dshHome: '/trusted/app-runtime/dsh-home/production',
      sessionRoot: '/trusted/sessions',
      role: 'production',
      model: 'deepseek-v4-pro',
      gateway: { url: 'http://127.0.0.1:12345', token: 'x'.repeat(32) },
      maxTokens: 16_384,
    })

    const handle = await manager.startRun('写一个场景')
    expect(handle.runId).toBe('run-runtime-crash')
    child.emit('exit', 1)

    expect(events.slice(-2)).toEqual([
      {
        type: 'error',
        runId: 'run-runtime-crash',
        code: 'TRANSPORT_CLOSED',
        message: 'DSH Worker 意外停止，本次运行未记为成功。',
      },
      { type: 'state', runId: 'run-runtime-crash', state: 'failed' },
    ])
    expect(manager.status()).toMatchObject({ state: 'failed', lastErrorCode: 'TRANSPORT_CLOSED' })
    await manager.clearConfiguration()
    expect(manager.status()).toEqual({ state: 'unconfigured' })
  })

  it('does not relabel a deliberate worker stop as a transport failure', async () => {
    const child = new FakeUtilityProcess()
    const events: RuntimeEvent[] = []
    const manager = new RuntimeWorkerManager({
      workerPath: '/trusted/worker.js',
      processFactory: (() => child) as never,
      onEvent: event => events.push(event),
    })
    manager.configure({
      command: '/trusted/node',
      args: ['/trusted/runtime', '/trusted/profile'],
      cwd: '/trusted/workspace',
      workspaceDir: '/trusted/workspace',
      dshHome: '/trusted/app-runtime/dsh-home/production',
      sessionRoot: '/trusted/workspace',
      role: 'production',
      model: 'deepseek-v4-pro',
      gateway: { url: 'http://127.0.0.1:12345', token: 'x'.repeat(32) },
      maxTokens: 16_384,
    })

    await manager.startRun('写一个场景')
    await manager.stop()
    child.emit('exit', 0)

    expect(manager.status()).toEqual({
      state: 'ready', role: 'production', model: 'deepseek-v4-pro',
    })
    expect(events).toEqual([])
  })
})

class FakeUtilityProcess extends EventEmitter {
  readonly stdout = { resume: () => undefined }
  readonly stderr = { resume: () => undefined }

  constructor() {
    super()
    queueMicrotask(() => this.emit('spawn'))
  }

  postMessage(request: RuntimeWorkerRequest): void {
    queueMicrotask(() => {
      if (request.method === 'startRun') {
        this.emit('message', {
          id: request.id,
          ok: true,
          result: { runId: 'run-runtime-crash', sessionId: 'session-runtime-crash' },
        })
      } else {
        this.emit('message', { id: request.id, ok: true, result: null })
      }
    })
  }

  kill(): boolean { return true }
}
