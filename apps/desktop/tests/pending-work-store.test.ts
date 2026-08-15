import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  PendingWorkStore,
  PendingWorkStoreError,
  type CreatePendingWorkInput,
} from '../src/main/pending-work-store.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('PendingWorkStore', () => {
  it('atomically stores one private replay intent and permits usage token counters', async () => {
    const userData = await temporaryDirectory()
    const store = new PendingWorkStore(userData)
    const launching = await store.createLaunching(pendingInput())
    const terminal = await store.requireTermination(launching, {
      outcome: 'FAILED',
      reason: 'runtime-failed-before-commit',
      error_code: 'RUNTIME_FAILED',
      runtime_provenance: {
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        reasoning_content_persisted: false,
      },
    })
    const raced = await store.requireTermination(launching, {
      outcome: 'CANCELLED',
      reason: 'application-closed',
      error_code: null,
      runtime_provenance: null,
    })

    await expect(store.load()).resolves.toEqual(terminal)
    expect(raced).toEqual(terminal)
    expect(terminal.phase).toBe('TERMINATION_REQUIRED')
    const text = await readFile(store.path, 'utf8')
    expect(text).not.toContain('/Users/')
    expect(text).not.toContain('api_key')
    if (process.platform !== 'win32') {
      expect((await stat(join(userData, 'supervisor'))).mode & 0o777).toBe(0o700)
      expect((await stat(store.path)).mode & 0o777).toBe(0o600)
    }
  })

  it('fails closed on content tampering and preserves the evidence file', async () => {
    const userData = await temporaryDirectory()
    const store = new PendingWorkStore(userData)
    await store.createLaunching(pendingInput())
    const parsed = JSON.parse(await readFile(store.path, 'utf8')) as Record<string, unknown>
    parsed.system_id = 'system-tampered'
    await writeFile(store.path, `${JSON.stringify(parsed)}\n`, { encoding: 'utf8', mode: 0o600 })

    await expect(store.load()).rejects.toBeInstanceOf(PendingWorkStoreError)
    await expect(readFile(store.path, 'utf8')).resolves.toContain('system-tampered')
  })

  it.skipIf(process.platform === 'win32')('rejects a symlinked pending intent without following it', async () => {
    const userData = await temporaryDirectory()
    const outside = join(userData, 'outside.json')
    await writeFile(outside, '{"outside":true}\n', 'utf8')
    await mkdir(join(userData, 'supervisor'), { mode: 0o700 })
    const store = new PendingWorkStore(userData)
    await symlink(outside, store.path)

    await expect(store.load()).rejects.toBeInstanceOf(PendingWorkStoreError)
    await expect(readFile(outside, 'utf8')).resolves.toBe('{"outside":true}\n')
  })

  it.skipIf(process.platform === 'win32')('rejects a symlinked supervisor directory', async () => {
    const userData = await temporaryDirectory()
    const outside = join(userData, 'outside-supervisor')
    await mkdir(outside, { mode: 0o700 })
    await symlink(outside, join(userData, 'supervisor'))

    await expect(new PendingWorkStore(userData).load()).rejects.toBeInstanceOf(PendingWorkStoreError)
  })
})

function pendingInput(): CreatePendingWorkInput {
  return {
    createdAt: '2026-08-15T01:00:00.000Z',
    systemId: 'system-one',
    beginPayload: {
      run_id: 'run-one',
      work_id: 'work-one',
      task: '写一个克制的悬疑开场',
      loop: 'main-loop',
      dispatch_id: 'dispatch-one',
      context_id: 'context-one',
      context_sha256: 'a'.repeat(64),
    },
    beginExpectation: {
      method_version: 'baseline-v1',
      method_guidance_sha256: null,
    },
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'creative-rsi-pending-work-test-'))
  temporaryDirectories.push(directory)
  return directory
}
