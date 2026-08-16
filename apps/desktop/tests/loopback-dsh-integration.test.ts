import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  type ChatCompletionRequest,
  type ChatStreamEvent,
} from '@creative-loop2rsi/model-gateway'
import {
  DshRuntimeAdapter,
  resolvePublishedRuntime,
  type RuntimeEvent,
} from '@creative-loop2rsi/runtime-dsh'

import { LoopbackModelGateway } from '../src/main/loopback-gateway.js'

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe('published DSH and LoopbackModelGateway', () => {
  it('commits the ledger before rc.6 completes after a delayed upstream EOF', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studio-loopback-dsh-'))
    temporary.push(root)
    const workspaceDir = join(root, 'workspace')
    const dshHome = join(root, 'dsh-home')
    await Promise.all([
      mkdir(workspaceDir, { recursive: true }),
      mkdir(dshHome, { recursive: true }),
    ])

    let pullAfterDone = false
    let markWaitingAfterDone: (() => void) | undefined
    const waitingAfterDone = new Promise<void>(resolve => { markWaitingAfterDone = resolve })
    let releaseValidatedEof: (() => void) | undefined
    const validatedEof = new Promise<void>(resolve => { releaseValidatedEof = resolve })
    const stream = async function * (
      body: ChatCompletionRequest,
    ): AsyncGenerator<ChatStreamEvent> {
      yield {
        type: 'chunk',
        chunk: {
          id: 'response-published-runtime',
          model: body.model,
          system_fingerprint: 'fingerprint-published-runtime',
          choices: [{ delta: { reasoning_content: 'not persisted', content: '合成正文' }, finish_reason: 'stop' }],
        },
      }
      yield {
        type: 'chunk',
        chunk: {
          id: 'response-published-runtime',
          model: body.model,
          system_fingerprint: 'fingerprint-published-runtime',
          choices: [],
          usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
        },
      }
      yield { type: 'done' }
      pullAfterDone = true
      markWaitingAfterDone?.()
      await validatedEof
    }

    const gateway = new LoopbackModelGateway({
      keyStore: {
        isAvailable: () => true,
        get: () => 'synthetic-key-never-read',
        set: () => {},
        delete: () => {},
      },
      gatewayFactory: () => ({ streamChatCompletion: stream }),
    })
    await gateway.start()
    const lease = gateway.issueLease('production', 'deepseek-v4-flash')
    const adapter = new DshRuntimeAdapter(resolvePublishedRuntime({
      nodeExecutable: process.execPath,
      cwd: workspaceDir,
      workspaceDir,
      dshHome,
      sessionRoot: workspaceDir,
      role: 'production',
      model: 'deepseek-v4-flash',
      gateway: { url: lease.url, token: lease.token },
      maxTokens: 32_768,
    }))

    try {
      const handle = await adapter.startRun({ input: '只输出一行纯虚构正文。' })
      const events: RuntimeEvent[] = []
      const collecting = (async () => {
        for await (const event of adapter.streamEvents(handle.runId)) events.push(event)
      })()

      await waitingAfterDone
      expect(pullAfterDone).toBe(true)
      expect(events).not.toContainEqual({ type: 'state', runId: handle.runId, state: 'completed' })
      expect(lease.provenance()).toMatchObject({ completedRequests: 0, failedRequests: 0 })
      expect(lease.provenance().requests[0]).toMatchObject({ status: 'STARTED' })

      releaseValidatedEof?.()
      await collecting

      expect(events).toContainEqual({ type: 'output', runId: handle.runId, text: '合成正文' })
      expect(events.at(-1)).toEqual({ type: 'state', runId: handle.runId, state: 'completed' })
      expect(lease.provenance()).toMatchObject({
        completedRequests: 1,
        failedRequests: 0,
        responseId: 'response-published-runtime',
        returnedModels: ['deepseek-v4-flash'],
        systemFingerprints: ['fingerprint-published-runtime'],
        usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
      })
      expect(lease.provenance().requests[0]).toMatchObject({
        status: 'COMPLETED',
        httpStatus: 200,
      })
    } finally {
      lease.revoke()
      await adapter.dispose()
      await gateway.close()
    }
  }, 30_000)
})
