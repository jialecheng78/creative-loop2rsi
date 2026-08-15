import { mkdtemp, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  DshRuntimeError,
  type DshRuntimeLaunchSpec,
  type RuntimeEvent,
  type RuntimeRunHandle,
  type RuntimeRole,
  type RuntimeStatus,
} from '@creative-loop2rsi/runtime-dsh'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DesktopSettings } from '../src/main/settings-store.js'
import {
  StudioService,
  StudioServiceError,
  type ControllerPort,
  type ControllerRequestLike,
  type CredentialStorePort,
  type LoopbackGatewayPort,
  type RuntimePort,
  type RuntimeSpecFactory,
  type SettingsStorePort,
} from '../src/main/studio-service.js'
import type { LoopbackGatewayLease, LoopbackLeaseProvenance } from '../src/main/loopback-gateway.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('StudioService governed alpha loop', () => {
  it('validates a candidate key before replacing the encrypted value and never returns it', async () => {
    const fixture = await createFixture()
    fixture.credentials.value = 'old-key'
    fixture.credentials.configured = true
    fixture.credentialValidator.mockRejectedValueOnce(new Error('synthetic network detail /private/path'))

    await expect(fixture.service.configureCredential('bad-key')).rejects.toMatchObject({
      code: 'CREDENTIAL_CHECK_FAILED',
    })
    expect(fixture.credentials.value).toBe('old-key')

    fixture.credentialValidator.mockResolvedValueOnce(['deepseek-v4-pro', 'deepseek-v4-flash'])
    const result = await fixture.service.configureCredential('new-key')
    expect(result).toEqual({ secureStorageAvailable: true, configured: true })
    expect(fixture.credentials.value).toBe('new-key')
    expect(JSON.stringify(result)).not.toContain('new-key')
  })

  it('creates a system only under userData/systems and restores its snapshot', async () => {
    const fixture = await createFixture()
    const snapshot = await fixture.service.createSystem({ intent: '写克制的近未来悬疑' })
    expect(snapshot.systemId).toMatch(/^system-/u)
    const bootstrap = fixture.controller.requests.find(item => item.operation === 'bootstrap_intent')
    expect(bootstrap?.payload.project).toBe(join(fixture.userData, 'systems', snapshot.systemId))
    expect(bootstrap?.payload.intent).toBe('写克制的近未来悬疑')
    expect(await fixture.service.systemSnapshot()).toEqual(snapshot)
  })

  it('recovers a persisted feedback transaction without replaying Renderer text', async () => {
    const fixture = await readyFixture()
    fixture.controller.primePendingFeedback('用户退出前已经保存的精确编辑')

    const status = await fixture.service.getStatus()

    expect(status.feedbackRecoveryState).toBe('recovered')
    expect(status.activeSystem?.feedbackRecoveryRequired).toBe(false)
    expect(status.activeSystem?.lastWork).toMatchObject({
      runId: 'run-pending-feedback',
      output: '用户退出前已经保存的精确编辑',
      sealed: true,
    })
    const request = fixture.controller.requests.find(item => item.operation === 'resume_feedback')
    expect(request?.payload).toEqual({
      project: join(fixture.userData, 'systems', status.activeSystem?.systemId ?? ''),
      run_id: 'run-pending-feedback',
    })
    expect(Object.keys(request?.payload ?? {}).sort()).toEqual(['project', 'run_id'])
  })

  it('fails closed when persisted feedback cannot be recovered', async () => {
    const fixture = await readyFixture()
    fixture.controller.primePendingFeedback('仍保存在事务中的编辑')
    fixture.controller.failResumeFeedback = true

    const status = await fixture.service.getStatus()
    expect(status.feedbackRecoveryState).toBe('retry-required')
    expect(status.activeSystem?.feedbackRecoveryRequired).toBe(true)

    await expect(fixture.service.startWork('不得开始的新作品')).rejects.toMatchObject({
      code: 'FEEDBACK_RECOVERY_REQUIRED',
    })
    await expect(fixture.service.submitFeedback({
      runId: 'run-pending-feedback', action: 'keep',
    })).rejects.toMatchObject({ code: 'FEEDBACK_RECOVERY_REQUIRED' })
    expect(fixture.controller.requests.some(item => item.operation === 'begin_work')).toBe(false)
    expect(fixture.controller.requests.some(item => item.operation === 'submit_feedback')).toBe(false)
    expect(fixture.runtime.lastInput).toBeUndefined()
  })

  it.each(['keep', 'reject'] as const)(
    'recovers an older pending edit but does not silently submit the current %s action',
    async action => {
      const fixture = await readyFixture()
      fixture.controller.primePendingFeedback('上次退出前保存的编辑')
      const currentFeedback = action === 'reject' ? '这是本次新的拒绝理由' : undefined

      const result = await fixture.service.submitFeedback({
        runId: 'run-pending-feedback',
        action,
        ...(currentFeedback === undefined ? {} : { feedbackText: currentFeedback }),
      })

      expect(result).toMatchObject({
        outcome: 'recovered-previous',
        snapshot: {
          lastWork: {
            output: '上次退出前保存的编辑',
            sealed: true,
            humanDirection: 'BLOCK',
          },
        },
      })
      expect(fixture.controller.requests.some(item => item.operation === 'submit_feedback')).toBe(false)
      expect(JSON.stringify(fixture.controller.requests)).not.toContain(currentFeedback ?? '"action":"keep"')
    },
  )

  it('links a new governed run to the interrupted run and fails closed if Controller rejects recovery', async () => {
    const fixture = await readyFixture()
    fixture.controller.primeInterruptedRun()
    const handle = await fixture.service.startWork('继续完成中断后的新版本')
    expect(fixture.controller.requests.find(item => item.operation === 'begin_work')?.payload).toMatchObject({
      recovery_of: 'run-interrupted',
    })
    await fixture.service.cancelWork(handle.runId)

    const blocked = await readyFixture()
    blocked.controller.primeInterruptedRun()
    blocked.controller.failRecoveryBegin = true
    await expect(blocked.service.startWork('不应绕过恢复')).rejects.toThrow('无法开始本次创作')
    expect(blocked.runtime.lastInput).toBeUndefined()
  })

  it('turns a missing packaged DSH runtime into an actionable fixed message', async () => {
    const fixture = await readyFixture({
      runtimeSpecFactory: () => {
        throw new DshRuntimeError('UNSUPPORTED_DSH', 'synthetic package resolution detail')
      },
    })

    await expect(fixture.service.startWork('不会发起模型请求')).rejects.toMatchObject({
      code: 'RUNTIME_COMPONENT_MISSING',
      message: '创作运行组件不完整。请安装包含完整 DSH Runtime 的新版后重试。',
    })
    expect(fixture.runtime.lastInput).toBeUndefined()
    expect(fixture.loopback.lastLease?.revoked).toBe(true)
  })

  it('commits output and model provenance before emitting completed', async () => {
    const fixture = await readyFixture()
    const task = 'a'.repeat(20_000)
    const handle = await fixture.service.startWork(task)
    const begin = fixture.controller.requests.find(item => item.operation === 'begin_work')
    expect(begin?.payload.task).toBe(task)
    expect(begin?.payload.context_sha256).toBe(
      createHash('sha256').update('写克制的近未来悬疑', 'utf8').digest('hex'),
    )
    expect(fixture.runtime.lastInput).toContain(task)
    expect(fixture.runtime.lastInput).toContain('写克制的近未来悬疑')
    expect(fixture.runtime.spec?.dshHome).toBe(
      join(fixture.userData, 'runtime', 'dsh-home', 'production'),
    )
    expect(fixture.runtime.spec?.dshHome).not.toBe(process.env.DSH_HOME)
    expect(fixture.runtime.spec?.dshHome).not.toBe(process.env.HOME)

    await fixture.service.acceptRuntimeEvent({ type: 'output', runId: 'runtime-one', text: '冻结后的作品' })
    expect(fixture.events.at(-1)).toMatchObject({ type: 'output', runId: handle.runId })
    await fixture.service.acceptRuntimeEvent({ type: 'state', runId: 'runtime-one', state: 'completed' })

    const completeIndex = fixture.controller.requests.findIndex(item => item.operation === 'complete_work')
    const completedEventIndex = fixture.timeline.findIndex(item => item === 'event:completed')
    const completeTimelineIndex = fixture.timeline.findIndex(item => item === 'controller:complete_work')
    expect(completeIndex).toBeGreaterThanOrEqual(0)
    expect(completeTimelineIndex).toBeGreaterThanOrEqual(0)
    expect(completedEventIndex).toBeGreaterThan(completeTimelineIndex)
    const complete = fixture.controller.requests[completeIndex]
    expect(complete?.payload).toMatchObject({
      run_id: handle.runId,
      output: '冻结后的作品',
      runtime_provenance: {
        requested_model: 'deepseek-v4-pro',
        context_sha256: createHash('sha256').update('写克制的近未来悬疑', 'utf8').digest('hex'),
        returned_model: 'deepseek-v4-pro',
        system_fingerprint: 'fingerprint-one',
        response_id: 'response-one',
        parameters: { thinking: 'enabled', reasoning_effort: 'high', max_tokens: 16_384 },
        request_count: 1,
        completed_requests: 1,
        failed_requests: 0,
      },
    })
    expect(JSON.stringify(complete?.payload)).not.toContain('reasoning_content')
    expect(fixture.loopback.lastLease?.revoked).toBe(true)
    expect(fixture.events.at(-1)).toEqual({ type: 'state', runId: handle.runId, state: 'completed' })
  })

  it('injects the same frozen creative direction into later works without inferred taste', async () => {
    const fixture = await readyFixture()
    const first = await fixture.service.startWork('第一个作品')
    expect(fixture.runtime.lastInput).toContain('写克制的近未来悬疑')
    await fixture.service.cancelWork(first.runId)

    const second = await fixture.service.startWork('第二个作品')

    expect(fixture.runtime.lastInput).toContain('写克制的近未来悬疑')
    expect(fixture.runtime.lastInput).toContain('第二个作品')
    expect(fixture.runtime.lastInput).toContain('不把推测的偏好写成永久规则')
    await fixture.service.cancelWork(second.runId)
  })

  it('builds exact-three blind comparisons, adopts a method, and injects it into the next work', async () => {
    const fixture = await readyFixture()
    fixture.controller.primeMethodObservation()

    const preparing = fixture.service.prepareMethodCandidate('app-feedback-synthetic')
    for (let index = 0; index < 5; index += 1) {
      await vi.waitFor(() => expect(fixture.runtime.inputs.length).toBe(index + 1))
      const handle = fixture.runtime.handles[index]
      expect(handle).toBeDefined()
      const output = index === 0
        ? '优先用人物可见的选择、动作与后果推进情节；只在动作无法表达必要因果时保留一句解释。'
        : `盲比生成作品 ${index}`
      await fixture.service.acceptRuntimeEvent({ type: 'output', runId: handle!.runId, text: output })
      await fixture.service.acceptRuntimeEvent({ type: 'state', runId: handle!.runId, state: 'completed' })
    }
    let snapshot = await preparing
    expect(fixture.runtime.inputs[0]).not.toContain('heldout')
    expect(snapshot.methodCandidates).toHaveLength(1)
    expect(snapshot.methodCandidates[0]?.comparisons).toHaveLength(3)
    expect(snapshot.methodCandidates[0]?.status).toBe('EVALUATING')

    const candidateId = snapshot.methodCandidates[0]!.id
    for (const phase of ['targeted', 'regression', 'heldout'] as const) {
      snapshot = await fixture.service.submitMethodComparison({ candidateId, phase, choice: 'A' })
    }
    expect(snapshot.methodCandidates[0]?.ready).toBe(true)
    snapshot = await fixture.service.adoptMethodCandidate(candidateId)
    expect(snapshot.method.activeVersion).toBe(candidateId)
    expect(snapshot.method.activeGuidance).toContain('人物可见的选择')

    const nextWork = await fixture.service.startWork('采用新方式后的第四个作品')
    expect(fixture.runtime.lastInput).toContain('用户已经通过盲比并明确采用的当前创作方法')
    expect(fixture.runtime.lastInput).toContain('人物可见的选择')
    const begin = fixture.controller.requests.filter(item => item.operation === 'begin_work').at(-1)
    expect(begin?.payload.context_sha256).toBe('9'.repeat(64))
    await fixture.service.cancelWork(nextWork.runId)

    snapshot = await fixture.service.rollbackMethod('baseline-v1')
    expect(snapshot.method.activeVersion).toBe('baseline-v1')
    expect(snapshot.method.history.map(item => item.action)).toEqual(['PROMOTE', 'ROLLBACK'])
  })

  it('cancels an in-flight method generation before shutdown completes', async () => {
    const fixture = await readyFixture()
    fixture.controller.primeMethodObservation()

    const preparing = fixture.service.prepareMethodCandidate('app-feedback-synthetic')
    await vi.waitFor(() => expect(fixture.runtime.handles).toHaveLength(1))
    const internalRun = fixture.runtime.handles[0]!
    const rejected = expect(preparing).rejects.toMatchObject({ code: 'APPLICATION_CLOSED' })
    await fixture.service.shutdown()

    await rejected
    expect(fixture.timeline).toContain('runtime:cancel')
    expect(fixture.loopback.lastLease?.revoked).toBe(true)
    expect(fixture.controller.requests.some(item => item.operation === 'stage_method_comparisons')).toBe(false)
    expect(fixture.runtime.status()).toEqual({ state: 'unconfigured' })
    expect(internalRun.runId).toBe('runtime-one')
  })

  it('does not claim success when gateway provenance is incomplete', async () => {
    const fixture = await readyFixture({ provenance: { systemFingerprints: [] } })
    const handle = await fixture.service.startWork('写一段场景')
    await fixture.service.acceptRuntimeEvent({ type: 'output', runId: 'runtime-one', text: '未证实作品' })
    await fixture.service.acceptRuntimeEvent({ type: 'state', runId: 'runtime-one', state: 'completed' })

    expect(fixture.controller.requests.some(item => item.operation === 'complete_work')).toBe(false)
    expect(fixture.controller.requests.some(item => item.operation === 'cancel_work')).toBe(true)
    expect(fixture.events).toContainEqual({
      type: 'state', runId: handle.runId, state: 'failed',
    })
    expect(fixture.events.some(item => item.type === 'state' && item.state === 'completed')).toBe(false)
  })

  it('does not claim success when the returned model differs from the selected model', async () => {
    const fixture = await readyFixture({ provenance: { returnedModels: ['deepseek-v4-flash'] } })
    const handle = await fixture.service.startWork('写一段场景')
    await fixture.service.acceptRuntimeEvent({ type: 'output', runId: 'runtime-one', text: '模型来源不一致的作品' })
    await fixture.service.acceptRuntimeEvent({ type: 'state', runId: 'runtime-one', state: 'completed' })

    expect(fixture.controller.requests.some(item => item.operation === 'complete_work')).toBe(false)
    expect(fixture.controller.requests.some(item => item.operation === 'cancel_work')).toBe(true)
    expect(fixture.events).toContainEqual({
      type: 'state', runId: handle.runId, state: 'failed',
    })
  })

  it('does not mistake an older identical work for a successful current commit', async () => {
    const fixture = await readyFixture()
    fixture.controller.primeLastWork({
      run_id: 'run-older',
      work_id: 'work-older',
      output: '相同的作品',
      artifact_sha256: 'c'.repeat(64),
      review_available_at: '2026-08-15T00:40:00.000Z',
      sealed: false,
      human_accepted: null,
      human_direction: 'UNKNOWN',
      decision: null,
    })
    fixture.controller.failCompleteWork = true
    const handle = await fixture.service.startWork('生成相同文本')
    await fixture.service.acceptRuntimeEvent({ type: 'output', runId: 'runtime-one', text: '相同的作品' })
    await fixture.service.acceptRuntimeEvent({ type: 'state', runId: 'runtime-one', state: 'completed' })

    expect(fixture.controller.requests.filter(item => item.operation === 'complete_work')).toHaveLength(2)
    expect(fixture.controller.requests.some(item => item.operation === 'cancel_work')).toBe(true)
    expect(fixture.events).toContainEqual({ type: 'state', runId: handle.runId, state: 'failed' })
    expect(fixture.events.some(item => item.type === 'state' && item.state === 'completed')).toBe(false)
  })

  it('preserves an actionable resolved DSH model error for the UI', async () => {
    const fixture = await readyFixture()
    const handle = await fixture.service.startWork('写一段场景')
    await fixture.service.acceptRuntimeEvent({
      type: 'error',
      runId: 'runtime-one',
      code: 'ACCOUNT_BALANCE',
      message: 'DeepSeek 账户余额不足，请充值后重试。',
    })
    await fixture.service.acceptRuntimeEvent({ type: 'state', runId: 'runtime-one', state: 'failed' })

    expect(fixture.events).toContainEqual({
      type: 'error',
      runId: handle.runId,
      code: 'ACCOUNT_BALANCE',
      message: 'DeepSeek 账户余额不足，请充值后重试。',
    })
    expect(fixture.events).toContainEqual({ type: 'state', runId: handle.runId, state: 'failed' })
  })

  it('rejects a concurrent launch before a second Controller run can open', async () => {
    const fixture = await readyFixture()
    const first = fixture.service.startWork('第一次创作')
    await expect(fixture.service.startWork('不应启动的第二次创作')).rejects.toMatchObject({
      code: 'WORK_ACTIVE',
    })
    await first
    expect(fixture.controller.requests.filter(item => item.operation === 'begin_work')).toHaveLength(1)
    await fixture.service.cancelWork('active')
  })

  it('revokes the loopback capability and records cancellation', async () => {
    const fixture = await readyFixture()
    const handle = await fixture.service.startWork('写一段场景')
    await fixture.service.cancelWork(handle.runId)

    expect(fixture.timeline.indexOf('lease:revoked')).toBeLessThan(fixture.timeline.indexOf('runtime:cancel'))
    expect(fixture.controller.requests.at(-1)).toMatchObject({
      operation: 'cancel_work',
      payload: {
        run_id: handle.runId,
        reason: 'user-cancelled',
        runtime_provenance: {
          request_count: 1,
          completed_requests: 1,
          failed_requests: 0,
          requests: [expect.objectContaining({ request_number: 1, status: 'COMPLETED' })],
        },
      },
    })
    expect(fixture.events.at(-1)).toEqual({ type: 'state', runId: handle.runId, state: 'cancelled' })
  })

  it('waits for an after-begin launch to cancel its Controller dispatch before shutdown resolves', async () => {
    const profileEntered = deferred<void>()
    const releaseProfile = deferred<string>()
    const fixture = await readyFixture({
      profileDigest: async () => {
        profileEntered.resolve(undefined)
        return await releaseProfile.promise
      },
    })
    const launching = fixture.service.startWork('写一段场景')
    await profileEntered.promise
    let shutdownResolved = false
    const shuttingDown = fixture.service.shutdown().then(() => { shutdownResolved = true })
    await Promise.resolve()
    expect(shutdownResolved).toBe(false)

    releaseProfile.resolve('a'.repeat(64))

    await expect(launching).rejects.toMatchObject({ code: 'LAUNCH_CANCELLED' })
    await shuttingDown
    const cancelIndex = fixture.timeline.indexOf('controller:cancel_work')
    const closeIndex = fixture.timeline.indexOf('loopback:close')
    expect(cancelIndex).toBeGreaterThanOrEqual(0)
    expect(closeIndex).toBeGreaterThan(cancelIndex)
  })

  it('cancel active waits for a deferred runtime launch to converge and cancel the open dispatch', async () => {
    const runtimeEntered = deferred<void>()
    const releaseRuntime = deferred<RuntimeRunHandle>()
    const fixture = await readyFixture({
      runtimeStart: async () => {
        runtimeEntered.resolve(undefined)
        return await releaseRuntime.promise
      },
    })
    const launching = fixture.service.startWork('写一段场景')
    await runtimeEntered.promise
    let cancelResolved = false
    const cancelling = fixture.service.cancelWork('active').then(() => { cancelResolved = true })
    await Promise.resolve()
    expect(cancelResolved).toBe(false)

    releaseRuntime.resolve({ runId: 'runtime-one', sessionId: 'session-one' })

    await expect(launching).rejects.toMatchObject({ code: 'LAUNCH_CANCELLED' })
    await cancelling
    expect(fixture.timeline).toContain('runtime:cancel')
    expect(fixture.timeline).toContain('controller:cancel_work')
    expect(fixture.timeline.indexOf('lease:revoked')).toBeLessThan(
      fixture.timeline.indexOf('controller:cancel_work'),
    )
  })

  it.each(['completed', 'failed'] as const)(
    'normalizes a terminal %s event arriving after user cancellation to cancelled',
    async terminalState => {
      const cancelEntered = deferred<void>()
      const releaseCancel = deferred<void>()
      const fixture = await readyFixture({
        runtimeCancel: async () => {
          cancelEntered.resolve(undefined)
          await releaseCancel.promise
        },
      })
      const handle = await fixture.service.startWork('写一段场景')
      const cancelling = fixture.service.cancelWork(handle.runId)
      await cancelEntered.promise

      await fixture.service.acceptRuntimeEvent({
        type: 'state', runId: 'runtime-one', state: terminalState,
      })
      releaseCancel.resolve(undefined)
      await cancelling

      expect(fixture.events).toContainEqual({
        type: 'state', runId: handle.runId, state: 'cancelled',
      })
      expect(fixture.events.some(event => event.type === 'state'
        && (event.state === 'completed' || event.state === 'failed'))).toBe(false)
      expect(fixture.events.some(event => event.type === 'error')).toBe(false)
    },
  )

  it('records direct feedback, seals the frozen work, and restores it after restart', async () => {
    const fixture = await readyFixture()
    const handle = await fixture.service.startWork('写一段场景')
    await fixture.service.acceptRuntimeEvent({ type: 'output', runId: 'runtime-one', text: '第一版' })
    await fixture.service.acceptRuntimeEvent({ type: 'state', runId: 'runtime-one', state: 'completed' })

    const updated = await fixture.service.submitFeedback({
      runId: handle.runId,
      action: 'edit',
      feedbackText: '减少解释',
      editedText: '用户直接修改后的版本',
    })
    expect(fixture.controller.requests.slice(-2).map(item => item.operation)).toEqual([
      'system_snapshot', 'submit_feedback',
    ])
    expect(updated).toMatchObject({
      outcome: 'submitted',
      snapshot: { lastWork: { sealed: true, humanAccepted: false, humanDirection: 'BLOCK' } },
    })

    const restarted = fixture.makeService()
    const status = await restarted.getStatus()
    expect(status.activeSystem?.lastWork).toMatchObject({
      runId: handle.runId,
      sealed: true,
      output: '用户直接修改后的版本',
    })
    expect(status.credential).toBe('configured')
    expect(JSON.stringify(status)).not.toContain(fixture.credentials.value)
  })
})

function deferred<T>(): {
  readonly promise: Promise<T>
  resolve(value: T): void
} {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>(resolve => { resolvePromise = resolve })
  return { promise, resolve: resolvePromise }
}

interface FixtureOptions {
  readonly provenance?: Partial<LoopbackLeaseProvenance>
  readonly profileDigest?: (spec: DshRuntimeLaunchSpec) => Promise<string>
  readonly runtimeStart?: (input: string) => Promise<RuntimeRunHandle>
  readonly runtimeCancel?: (runId: string) => Promise<void>
  readonly runtimeSpecFactory?: RuntimeSpecFactory
}

async function readyFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const fixture = await createFixture(options)
  fixture.credentials.value = 'stored-key'
  fixture.credentials.configured = true
  await fixture.service.createSystem({ intent: '写克制的近未来悬疑' })
  return fixture
}

interface Fixture {
  readonly userData: string
  readonly timeline: string[]
  readonly events: RuntimeEvent[]
  readonly controller: FakeController
  readonly credentials: FakeCredentials
  readonly runtime: FakeRuntime
  readonly loopback: FakeLoopback
  readonly credentialValidator: ReturnType<typeof vi.fn<(key: string) => Promise<readonly ('deepseek-v4-pro' | 'deepseek-v4-flash')[]>>>
  readonly service: StudioService
  makeService(): StudioService
}

async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const userData = await mkdtemp(join(tmpdir(), 'creative-rsi-studio-'))
  temporaryDirectories.push(userData)
  const timeline: string[] = []
  const events: RuntimeEvent[] = []
  const controller = new FakeController(timeline)
  const credentials = new FakeCredentials()
  const settings = new FakeSettings()
  const runtime = new FakeRuntime(timeline, options.runtimeStart, options.runtimeCancel)
  const loopback = new FakeLoopback(timeline, options.provenance)
  const credentialValidator = vi.fn<(key: string) => Promise<readonly ('deepseek-v4-pro' | 'deepseek-v4-flash')[]>>()
  let nextId = 0
  const makeService = (): StudioService => new StudioService({
    appVersion: '1.0.0-alpha.1',
    userDataPath: userData,
    nodeExecutable: '/trusted/electron',
    controller,
    credentials,
    settings,
    runtime,
    loopback,
    emit: event => {
      events.push(event)
      if (event.type === 'state') timeline.push(`event:${event.state}`)
    },
    now: () => '2026-08-15T01:00:00.000Z',
    idFactory: () => `id-${++nextId}`,
    credentialValidator,
    profileDigest: options.profileDigest ?? (async () => 'a'.repeat(64)),
    runtimeSpecFactory: options.runtimeSpecFactory ?? (input => ({
      command: input.nodeExecutable,
      args: ['/trusted/runtime', '/trusted/profile.yml'],
      cwd: input.cwd,
      workspaceDir: input.workspaceDir,
      dshHome: input.dshHome,
      sessionRoot: input.sessionRoot,
      role: input.role,
      model: input.model,
      gateway: input.gateway,
      maxTokens: input.maxTokens,
    })),
  })
  const service = makeService()
  return { userData, timeline, events, controller, credentials, runtime, loopback, credentialValidator, service, makeService }
}

class FakeCredentials implements CredentialStorePort {
  available = true
  configured = false
  value: string | null = null

  isAvailable(): boolean { return this.available }
  async status(): Promise<{ secureStorageAvailable: boolean; configured: boolean }> {
    return { secureStorageAvailable: this.available, configured: this.available && this.configured }
  }
  async set(value: string): Promise<void> { this.value = value; this.configured = true }
  async get(): Promise<string | null> { return this.value }
  async delete(): Promise<void> { this.value = null; this.configured = false }
}

class FakeSettings implements SettingsStorePort {
  value: DesktopSettings = { selectedModel: 'deepseek-v4-pro', activeSystemId: null, learningPaused: false }
  async load(): Promise<DesktopSettings> { return { ...this.value } }
  async update(patch: unknown): Promise<DesktopSettings> {
    this.value = { ...this.value, ...(patch as Partial<DesktopSettings>) }
    return this.load()
  }
}

class FakeRuntime implements RuntimePort {
  lastInput: string | undefined
  readonly inputs: string[] = []
  readonly handles: RuntimeRunHandle[] = []
  spec: DshRuntimeLaunchSpec | undefined
  private state: RuntimeStatus = { state: 'unconfigured' }

  constructor(
    private readonly timeline: string[],
    private readonly startHook?: (input: string) => Promise<RuntimeRunHandle>,
    private readonly cancelHook?: (runId: string) => Promise<void>,
  ) {}
  configure(spec: DshRuntimeLaunchSpec): void { this.spec = spec; this.state = { state: 'ready' } }
  status(): RuntimeStatus { return this.state }
  async startRun(input: string): Promise<RuntimeRunHandle> {
    this.lastInput = input
    this.inputs.push(input)
    if (this.startHook !== undefined) return await this.startHook(input)
    const number = this.inputs.length
    const suffix = number === 1 ? 'one' : number === 2 ? 'two' : number === 3 ? 'three' : number === 4 ? 'four' : 'five'
    const handle = { runId: `runtime-${suffix}`, sessionId: `session-${suffix}` }
    this.handles.push(handle)
    this.state = { state: 'running', activeRunId: handle.runId }
    return handle
  }
  async cancelRun(runId: string): Promise<void> {
    this.timeline.push('runtime:cancel')
    if (this.cancelHook !== undefined) await this.cancelHook(runId)
    this.state = { state: 'ready' }
  }
  async stop(): Promise<void> { this.state = { state: 'ready' } }
  async clearConfiguration(): Promise<void> { this.state = { state: 'unconfigured' }; this.spec = undefined }
}

class FakeLease implements LoopbackGatewayLease {
  readonly url = 'http://127.0.0.1:12345'
  readonly token = 'x'.repeat(32)
  readonly role: RuntimeRole
  readonly model: 'deepseek-v4-pro' | 'deepseek-v4-flash'
  revoked = false

  constructor(
    private readonly timeline: string[],
    private readonly value: LoopbackLeaseProvenance,
    role: RuntimeRole,
    model: 'deepseek-v4-pro' | 'deepseek-v4-flash',
  ) { this.role = role; this.model = model }
  provenance(): LoopbackLeaseProvenance { return this.value }
  revoke(): void {
    if (this.revoked) return
    this.revoked = true
    this.timeline.push('lease:revoked')
  }
}

class FakeLoopback implements LoopbackGatewayPort {
  lastLease: FakeLease | undefined
  private readonly provenance: LoopbackLeaseProvenance
  private readonly hasReturnedModelOverride: boolean

  constructor(timeline: string[], overrides: Partial<LoopbackLeaseProvenance> = {}) {
    this.timeline = timeline
    this.hasReturnedModelOverride = overrides.returnedModels !== undefined
    this.provenance = {
      requestCount: 1,
      completedRequests: 1,
      failedRequests: 0,
      completedAt: '2026-08-15T00:30:00.000Z',
      requestedModel: 'deepseek-v4-pro',
      responseId: 'response-one',
      returnedModels: ['deepseek-v4-pro'],
      systemFingerprints: ['fingerprint-one'],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      requests: [{
        requestNumber: 1,
        startedAt: '2026-08-15T00:29:00.000Z',
        completedAt: '2026-08-15T00:30:00.000Z',
        status: 'COMPLETED',
        responseId: 'response-one',
        returnedModel: 'deepseek-v4-pro',
        systemFingerprint: 'fingerprint-one',
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }],
      ...overrides,
    }
  }
  private readonly timeline: string[]
  async start(): Promise<void> {}
  issueLease(
    role: RuntimeRole = 'production',
    model: 'deepseek-v4-pro' | 'deepseek-v4-flash' = 'deepseek-v4-pro',
  ): LoopbackGatewayLease {
    const provenance = {
      ...this.provenance,
      requestedModel: model,
      returnedModels: this.hasReturnedModelOverride ? this.provenance.returnedModels : [model],
      requests: this.provenance.requests.map(item => ({
        ...item,
        returnedModel: this.hasReturnedModelOverride ? (item.returnedModel ?? model) : model,
      })),
    }
    this.lastLease = new FakeLease(this.timeline, provenance, role, model)
    return this.lastLease
  }
  async close(): Promise<void> { this.timeline.push('loopback:close') }
}

class FakeController implements ControllerPort {
  readonly requests: ControllerRequestLike[] = []
  failCompleteWork = false
  failRecoveryBegin = false
  failResumeFeedback = false
  private systemId: string | undefined
  private displayName = ''
  private initialIntent = ''
  private lastWork: Record<string, unknown> | null = null
  private lastAction: string | undefined
  private pendingFeedback: Record<string, unknown> | null = null
  private pendingEditedOutput: string | undefined
  private interruptedRun: Record<string, unknown> | null = null
  private observations: Record<string, unknown>[] = []
  private methodCandidates: Record<string, unknown>[] = []
  private methodHistory: Record<string, unknown>[] = []
  private activeMethodVersion = 'baseline-v1'
  private activeGuidance: string | null = null

  constructor(private readonly timeline: string[]) {}

  primeLastWork(value: Record<string, unknown>): void { this.lastWork = { ...value } }

  primePendingFeedback(editedOutput: string): void {
    this.lastWork = {
      run_id: 'run-pending-feedback',
      work_id: 'work-pending-feedback',
      output: '反馈前的作品',
      artifact_sha256: createHash('sha256').update('反馈前的作品', 'utf8').digest('hex'),
      runtime_provenance_sha256: 'd'.repeat(64),
      review_subject_sha256: 'e'.repeat(64),
      review_available_at: '2026-08-15T00:40:00.000Z',
      sealed: false,
      human_accepted: null,
      human_direction: 'UNKNOWN',
      decision: null,
    }
    this.pendingFeedback = {
      submission_id: 'submission-pending-feedback',
      run_id: 'run-pending-feedback',
      attempt_id: 'attempt-001',
      action: 'edit',
      state: 'RECOVERY_REQUIRED',
    }
    this.pendingEditedOutput = editedOutput
  }

  primeInterruptedRun(): void {
    this.interruptedRun = {
      run_id: 'run-interrupted',
      work_id: 'work-interrupted',
      attempt_id: 'attempt-001',
      dispatch_id: 'dispatch-interrupted',
      state: 'STALLED',
      reason_code: 'APPLICATION_CLOSED',
    }
  }

  primeMethodObservation(): void {
    this.observations = [{
      id: 'app-feedback-synthetic',
      finding_code: 'APP-FEEDBACK-SYNTHETIC',
      feedback: '减少解释，让人物用动作推进情节。',
      independent_works: 3,
      independent_runs: 3,
      independent_tasks: 3,
      ready_for_candidate: true,
    }]
  }

  async invoke(request: ControllerRequestLike): Promise<{ exitCode: number; payload: unknown }> {
    this.requests.push(request)
    this.timeline.push(`controller:${request.operation}`)
    const payload = request.payload
    let result: Record<string, unknown>
    switch (request.operation) {
      case 'bootstrap_intent':
        this.systemId = String(payload.system_id)
        this.displayName = String(payload.display_name)
        this.initialIntent = String(payload.intent)
        result = { system_id: this.systemId }
        break
      case 'system_snapshot':
        result = {
          system_id: this.systemId,
          display_name: this.displayName,
          active_version: 'v0.1.0',
          operating_stage: 'BOOTSTRAP',
          charter_confirmed: false,
          initial_intent: this.initialIntent,
          initial_intent_sha256: createHash('sha256').update(this.initialIntent, 'utf8').digest('hex'),
          last_work: this.lastWork === null ? null : {
            method_version: 'baseline-v1',
            method_guidance_sha256: null,
            ...this.lastWork,
          },
          recovery_required: this.interruptedRun !== null,
          interrupted_run: this.interruptedRun,
          feedback_recovery_required: this.pendingFeedback !== null,
          pending_feedback: this.pendingFeedback,
          learning: { observations: this.observations, adopted_principles: this.adoptedPrinciples() },
          method: { active_version: this.activeMethodVersion, active_guidance: this.activeGuidance, history: this.methodHistory },
          method_candidates: this.methodCandidates,
        }
        break
      case 'production_context':
        result = {
          method_version: this.activeMethodVersion,
          guidance: this.activeGuidance,
          guidance_sha256: this.activeGuidance === null
            ? null
            : createHash('sha256').update(this.activeGuidance, 'utf8').digest('hex'),
          context_sha256: this.activeGuidance === null
            ? createHash('sha256').update(this.initialIntent, 'utf8').digest('hex')
            : '9'.repeat(64),
          initial_intent: this.initialIntent,
          formal_l4: false,
        }
        break
      case 'method_candidate_context':
        result = {
          candidate_id: payload.candidate_id,
          observation_id: payload.observation_id,
          finding_code: 'APP-FEEDBACK-SYNTHETIC',
          feedback: '减少解释，让人物用动作推进情节。',
          initial_intent: this.initialIntent,
          current_method_version: this.activeMethodVersion,
          current_guidance: this.activeGuidance,
          builder_context_sha256: 'b'.repeat(64),
          heldout_included: false,
          source_works: [1, 2, 3].map(number => ({
            run_id: `run-source-${number}`,
            work_id: `work-source-${number}`,
            task: `独立创作任务 ${number}`,
            task_sha256: String(number).repeat(64),
            output: `基线作品 ${number}，人物解释了原因。`,
            artifact_sha256: String(number).repeat(64),
            provenance: {},
            provenance_path: `run-${number}/runtime-provenance.json`,
            provenance_sha256: String(number).repeat(64),
          })),
        }
        break
      case 'create_method_candidate':
        this.methodCandidates = [{
          id: payload.candidate_id,
          title: '针对重复反馈的新方式',
          summary: payload.guidance,
          tradeoff: '只改变后续作品的创作指导，不改写既有作品。',
          status: 'CANDIDATE',
          ready: false,
          comparisons: [],
        }]
        result = {
          candidate_id: payload.candidate_id,
          lifecycle: 'CANDIDATE',
          evaluation_plan: {
            targeted: { task: '目标任务', baseline_output: '目标基线', candidate_context_sha256: 'c'.repeat(64) },
            regression: { task: '回归任务', baseline_output: '回归基线', candidate_context_sha256: 'd'.repeat(64) },
            heldout: {
              task: '全新留出任务',
              baseline_context_sha256: 'e'.repeat(64),
              candidate_context_sha256: 'f'.repeat(64),
            },
          },
        }
        break
      case 'stage_method_comparisons':
        this.methodCandidates = this.methodCandidates.map(candidate => ({
          ...candidate,
          status: 'EVALUATING',
          comparisons: [
            { phase: 'targeted', left: '目标 A', right: '目标 B', choice: null },
            { phase: 'regression', left: '回归 A', right: '回归 B', choice: null },
            { phase: 'heldout', left: '留出 A', right: '留出 B', choice: null },
          ],
        }))
        result = { lifecycle: 'EVALUATING', snapshot: this.snapshot() }
        break
      case 'submit_method_comparison':
        this.methodCandidates = this.methodCandidates.map(candidate => {
          const comparisons = (candidate.comparisons as Record<string, unknown>[]).map(item => (
            item.phase === payload.phase ? { ...item, choice: payload.choice } : item
          ))
          const complete = comparisons.every(item => item.choice !== null)
          return { ...candidate, comparisons, status: complete ? 'READY_FOR_HUMAN' : 'EVALUATING', ready: complete }
        })
        result = { snapshot: this.snapshot() }
        break
      case 'adopt_method_candidate': {
        const candidate = this.methodCandidates.find(item => item.id === payload.candidate_id)
        if (candidate === undefined) throw new Error('synthetic missing candidate')
        this.activeMethodVersion = String(payload.candidate_id)
        this.activeGuidance = String(candidate.summary)
        this.methodHistory.push({
          action: 'PROMOTE', version: this.activeMethodVersion, previous_version: 'baseline-v1', created_at: '2026-08-15T01:30:00.000Z',
        })
        this.methodCandidates = this.methodCandidates.map(item => ({ ...item, status: 'PROMOTED', ready: false }))
        result = { snapshot: this.snapshot() }
        break
      }
      case 'reject_method_candidate':
        this.methodCandidates = this.methodCandidates.map(item => ({ ...item, status: 'REJECTED', ready: false }))
        result = { snapshot: this.snapshot() }
        break
      case 'rollback_method':
        this.methodHistory.push({
          action: 'ROLLBACK', version: payload.to_version, previous_version: this.activeMethodVersion, created_at: '2026-08-15T01:40:00.000Z',
        })
        this.activeMethodVersion = String(payload.to_version)
        this.activeGuidance = this.activeMethodVersion === 'baseline-v1' ? null : this.activeGuidance
        result = { snapshot: this.snapshot() }
        break
      case 'begin_work':
        if (payload.recovery_of !== undefined && this.failRecoveryBegin) {
          throw new Error('synthetic recovery rejected')
        }
        result = {
          run_id: payload.run_id,
          dispatch_id: payload.dispatch_id,
          work_id: payload.work_id,
          task_sha256: createHash('sha256').update(String(payload.task), 'utf8').digest('hex'),
          context_sha256: payload.context_sha256,
          method_version: this.activeMethodVersion,
          method_guidance_sha256: this.activeGuidance === null
            ? null
            : createHash('sha256').update(this.activeGuidance, 'utf8').digest('hex'),
        }
        break
      case 'complete_work':
        if (this.failCompleteWork) throw new Error('synthetic complete failure')
        this.lastWork = {
          run_id: payload.run_id,
          work_id: this.requests.find(item => item.operation === 'begin_work')?.payload.work_id,
          output: payload.output,
          artifact_sha256: createHash('sha256').update(String(payload.output), 'utf8').digest('hex'),
          runtime_provenance_sha256: 'd'.repeat(64),
          review_subject_sha256: 'e'.repeat(64),
          review_available_at: '2026-08-15T00:40:00.000Z',
          sealed: false,
          human_accepted: null,
          human_direction: 'UNKNOWN',
          decision: null,
        }
        result = {
          run_id: payload.run_id,
          work_id: this.requests.find(item => item.operation === 'begin_work')?.payload.work_id,
          artifact_sha256: createHash('sha256').update(String(payload.output), 'utf8').digest('hex'),
          runtime_provenance: 'creative-system/runs/run/runtime-provenance.json',
          runtime_provenance_sha256: 'd'.repeat(64),
          review_subject: 'creative-system/approvals/human-review/subject.json',
          review_available_at: '2026-08-15T00:40:00.000Z',
        }
        break
      case 'record_feedback':
        this.lastAction = String(payload.action)
        result = { receipt: 'creative-system/approvals/app-feedback/receipt.json' }
        break
      case 'seal_feedback':
        if (this.lastWork !== null) {
          this.lastWork = {
            ...this.lastWork,
            sealed: true,
            human_accepted: this.lastAction === 'keep',
            human_direction: this.lastAction === 'keep' ? 'PASS' : 'BLOCK',
            decision: this.lastAction === 'keep' ? 'commit' : 'revise',
            review_available_at: null,
          }
        }
        result = { manifest: 'manifest.json' }
        break
      case 'submit_feedback':
        this.lastAction = String(payload.action)
        if (this.lastWork !== null) {
          this.lastWork = {
            ...this.lastWork,
            ...(this.lastAction === 'edit' ? {
              output: payload.edited_text,
              artifact_sha256: createHash('sha256').update(String(payload.edited_text), 'utf8').digest('hex'),
            } : {}),
            sealed: true,
            human_accepted: this.lastAction === 'keep',
            human_direction: this.lastAction === 'keep' ? 'PASS' : 'BLOCK',
            decision: this.lastAction === 'keep' ? 'commit' : 'revise',
            review_available_at: null,
          }
        }
        result = {
          submission_id: 'submission-synthetic',
          snapshot: this.snapshot(),
        }
        break
      case 'resume_feedback': {
        if (this.failResumeFeedback) throw new Error('synthetic resume failure')
        const pending = this.pendingFeedback
        if (pending === null || pending.run_id !== payload.run_id) {
          result = {
            resume_status: 'NO_TRANSACTION',
            run_id: payload.run_id,
            submission_id: null,
            attempt_id: null,
            receipt: null,
            receipt_sha256: null,
            manifest: null,
            manifest_sha256: null,
            idempotent: true,
            snapshot: this.snapshot(),
          }
          break
        }
        if (this.lastWork !== null) {
          const output = this.pendingEditedOutput ?? String(this.lastWork.output)
          this.lastWork = {
            ...this.lastWork,
            output,
            artifact_sha256: createHash('sha256').update(output, 'utf8').digest('hex'),
            sealed: true,
            human_accepted: false,
            human_direction: 'BLOCK',
            decision: 'revise',
            review_available_at: null,
          }
        }
        this.pendingFeedback = null
        this.pendingEditedOutput = undefined
        result = {
          resume_status: 'RECOVERED',
          run_id: payload.run_id,
          submission_id: pending.submission_id,
          attempt_id: pending.attempt_id,
          receipt: 'creative-system/approvals/app-feedback/receipt.json',
          receipt_sha256: 'f'.repeat(64),
          manifest: 'creative-system/runs/run/manifest.json',
          manifest_sha256: 'a'.repeat(64),
          idempotent: false,
          snapshot: this.snapshot(),
        }
        break
      }
      case 'cancel_work':
        result = { run_id: payload.run_id, dispatch_id: payload.dispatch_id }
        break
      default:
        throw new Error(`unexpected operation ${request.operation}`)
    }
    return {
      exitCode: 0,
      payload: { protocol_version: '1', request_id: request.request_id, operation: request.operation, status: 'PASS', ...result },
    }
  }

  private snapshot(): Record<string, unknown> {
    return {
      status: 'PASS',
      system_id: this.systemId,
      display_name: this.displayName,
      active_version: 'v0.1.0',
      operating_stage: 'BOOTSTRAP',
      charter_confirmed: false,
      initial_intent: this.initialIntent,
      initial_intent_sha256: createHash('sha256').update(this.initialIntent, 'utf8').digest('hex'),
      last_work: this.lastWork === null ? null : {
        method_version: 'baseline-v1',
        method_guidance_sha256: null,
        ...this.lastWork,
      },
      recovery_required: this.interruptedRun !== null,
      interrupted_run: this.interruptedRun,
      feedback_recovery_required: this.pendingFeedback !== null,
      pending_feedback: this.pendingFeedback,
      learning: { observations: this.observations, adopted_principles: this.adoptedPrinciples() },
      method: { active_version: this.activeMethodVersion, active_guidance: this.activeGuidance, history: this.methodHistory },
      method_candidates: this.methodCandidates,
    }
  }

  private adoptedPrinciples(): Record<string, unknown>[] {
    return this.methodHistory
      .filter(item => item.action === 'PROMOTE')
      .map(item => ({
        version: item.version,
        guidance: this.methodCandidates.find(candidate => candidate.id === item.version)?.summary ?? '已采用指导',
        adopted_at: item.created_at,
        active: item.version === this.activeMethodVersion,
      }))
  }
}
