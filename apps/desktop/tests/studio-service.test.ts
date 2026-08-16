import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  type PendingWorkStorePort,
  type RuntimePort,
  type RuntimeSpecFactory,
  type SettingsStorePort,
} from '../src/main/studio-service.js'
import type { LoopbackGatewayLease, LoopbackLeaseProvenance } from '../src/main/loopback-gateway.js'
import { PendingWorkStore } from '../src/main/pending-work-store.js'

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

    await expect(fixture.service.configureCredential('bad-key', false)).rejects.toMatchObject({
      code: 'CREDENTIAL_CHECK_FAILED',
    })
    expect(fixture.credentials.value).toBe('old-key')

    fixture.credentialValidator.mockResolvedValueOnce(['deepseek-v4-pro', 'deepseek-v4-flash'])
    const result = await fixture.service.configureCredential('new-key', false)
    expect(result).toEqual({
      secureStorageAvailable: true, configured: true, persistence: 'protected',
    })
    expect(fixture.credentials.value).toBe('new-key')
    expect(JSON.stringify(result)).not.toContain('new-key')
  })

  it('uses an explicitly authorized Main-memory session key when protected storage is unavailable', async () => {
    const fixture = await createFixture()
    fixture.credentials.available = false

    await expect(fixture.service.configureCredential('session-key', false)).rejects.toMatchObject({
      code: 'SECURE_STORAGE_UNAVAILABLE',
    })
    expect(fixture.credentialValidator).not.toHaveBeenCalled()
    expect(fixture.credentials.value).toBeNull()

    fixture.credentialValidator.mockResolvedValueOnce(['deepseek-v4-pro', 'deepseek-v4-flash'])
    const result = await fixture.service.configureCredential('session-key', true)
    expect(result).toEqual({
      secureStorageAvailable: false, configured: true, persistence: 'session',
    })
    expect(fixture.credentials.value).toBe('session-key')
    expect(fixture.credentials.sessionOnly).toBe(true)
    expect(JSON.stringify(result)).not.toContain('session-key')
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
    await expect(blocked.service.startWork('不应绕过恢复')).rejects.toMatchObject({
      code: 'WORK_TERMINATION_PENDING',
    })
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
        parameters: { thinking: 'enabled', reasoning_effort: 'high', max_tokens: 32_768 },
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
    expect(snapshot.methodCandidates[0]).toMatchObject({ adoptionPending: false, rolledBack: false })
    expect(fixture.controller.requests.filter(item => item.operation === 'record_method_generation')
      .map(item => item.payload.label)).toEqual([
      'targeted_candidate', 'regression_candidate', 'heldout_baseline', 'heldout_candidate',
    ])
    expect(fixture.controller.requests.find(item => item.operation === 'stage_method_comparisons')?.payload)
      .toEqual({
        project: join(fixture.userData, 'systems', snapshot.systemId),
        candidate_id: snapshot.methodCandidates[0]?.id,
      })

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
    expect(snapshot.methodCandidates[0]).toMatchObject({ adoptionPending: false, rolledBack: true })
  })

  it('resumes an interrupted method preparation without rerunning Builder or completed generations', async () => {
    const fixture = await readyFixture()
    fixture.controller.primeMethodObservation()
    fixture.controller.failBeginMethodGenerationLabel = 'heldout_baseline'

    const firstPreparation = fixture.service.prepareMethodCandidate('app-feedback-synthetic')
    for (const [index, output] of [
      '优先用人物可见的动作推进情节。',
      '第一次已保存生成',
      '第二次已保存生成',
    ].entries()) {
      await vi.waitFor(() => expect(fixture.runtime.handles.length).toBe(index + 1))
      const handle = fixture.runtime.handles[index]!
      await fixture.service.acceptRuntimeEvent({ type: 'output', runId: handle.runId, text: output })
      await fixture.service.acceptRuntimeEvent({ type: 'state', runId: handle.runId, state: 'completed' })
    }
    await expect(firstPreparation).rejects.toThrow(/intent unavailable before commit/u)
    fixture.controller.failBeginMethodGenerationLabel = null

    expect(fixture.runtime.inputs).toHaveLength(3)
    expect(fixture.controller.requests.filter(item => item.operation === 'create_method_candidate')).toHaveLength(1)
    expect(fixture.controller.requests.filter(item => item.operation === 'record_method_generation')
      .map(item => item.payload.label)).toEqual(['targeted_candidate', 'regression_candidate'])

    const restartedService = fixture.makeService()
    const resumed = restartedService.prepareMethodCandidate('app-feedback-synthetic')
    for (const [offset, output] of ['重试后补齐留出基线', '重试后补齐留出候选'].entries()) {
      await vi.waitFor(() => expect(fixture.runtime.handles.length).toBe(4 + offset))
      const handle = fixture.runtime.handles[3 + offset]!
      await restartedService.acceptRuntimeEvent({ type: 'output', runId: handle.runId, text: output })
      await restartedService.acceptRuntimeEvent({ type: 'state', runId: handle.runId, state: 'completed' })
    }
    const snapshot = await resumed

    expect(fixture.runtime.inputs).toHaveLength(5)
    expect(fixture.controller.requests.filter(item => item.operation === 'method_candidate_context')).toHaveLength(2)
    expect(fixture.controller.requests.filter(item => item.operation === 'create_method_candidate')).toHaveLength(1)
    expect(fixture.controller.requests.filter(item => item.operation === 'record_method_generation')
      .map(item => item.payload.label)).toEqual([
      'targeted_candidate', 'regression_candidate', 'heldout_baseline', 'heldout_candidate',
    ])
    expect(snapshot.methodCandidates[0]).toMatchObject({ status: 'EVALUATING' })
  })

  it('does not turn a live Builder intent into a persistent failure during concurrent status reads', async () => {
    const fixture = await readyFixture()
    fixture.controller.primeMethodObservation()

    const preparing = fixture.service.prepareMethodCandidate('app-feedback-synthetic')
    await vi.waitFor(() => expect(fixture.runtime.handles).toHaveLength(1))
    const live = await fixture.service.systemSnapshot()
    if (live === null) throw new Error('synthetic live method snapshot missing')
    const liveCandidate = live.methodCandidates[0]
    if (liveCandidate === undefined) throw new Error('synthetic live method candidate missing')
    expect(liveCandidate).toMatchObject({
      status: 'CANDIDATE',
      resumable: false,
      completedGenerationCount: 0,
    })
    expect(fixture.controller.requests.some(item =>
      item.operation === 'record_method_builder_failure'
      || item.operation === 'reject_method_candidate')).toBe(false)

    for (let index = 0; index < 5; index += 1) {
      await vi.waitFor(() => expect(fixture.runtime.handles.length).toBe(index + 1))
      const handle = fixture.runtime.handles[index]!
      await fixture.service.acceptRuntimeEvent({
        type: 'output', runId: handle.runId, text: index === 0 ? '用动作推进情节。' : `live 生成 ${index}`,
      })
      await fixture.service.acceptRuntimeEvent({ type: 'state', runId: handle.runId, state: 'completed' })
    }
    await expect(preparing).resolves.toMatchObject({
      methodCandidates: [{ status: 'EVALUATING' }],
    })
  })

  it('retries the exact Builder create payload after a committed response is lost without rebilling Builder', async () => {
    const fixture = await readyFixture()
    fixture.controller.primeMethodObservation()
    fixture.controller.loseFirstMethodCreateResponse = true

    const preparing = fixture.service.prepareMethodCandidate('app-feedback-synthetic')
    for (let index = 0; index < 5; index += 1) {
      await vi.waitFor(() => expect(fixture.runtime.handles.length).toBe(index + 1))
      const handle = fixture.runtime.handles[index]!
      await fixture.service.acceptRuntimeEvent({
        type: 'output', runId: handle.runId, text: index === 0 ? '用动作推进。' : `create retry 生成 ${index}`,
      })
      await fixture.service.acceptRuntimeEvent({ type: 'state', runId: handle.runId, state: 'completed' })
    }
    await expect(preparing).resolves.toMatchObject({
      methodCandidates: [{ status: 'EVALUATING' }],
    })
    expect(fixture.runtime.handles).toHaveLength(5)
    const creates = fixture.controller.requests.filter(item => item.operation === 'create_method_candidate')
    expect(creates).toHaveLength(2)
    expect(creates[0]?.payload).toEqual(creates[1]?.payload)
  })

  it('does not open the first generation intent when shutdown wins after Builder create commits', async () => {
    const fixture = await readyFixture()
    fixture.controller.primeMethodObservation()
    const createResponse = deferred<void>()
    fixture.controller.methodCreateResponseGate = createResponse.promise

    const preparing = fixture.service.prepareMethodCandidate('app-feedback-synthetic')
    const preparationStopped = expect(preparing).rejects.toMatchObject({ code: 'APPLICATION_CLOSED' })
    await vi.waitFor(() => expect(fixture.runtime.handles).toHaveLength(1))
    const builder = fixture.runtime.handles[0]!
    await fixture.service.acceptRuntimeEvent({ type: 'output', runId: builder.runId, text: '用动作推进。' })
    await fixture.service.acceptRuntimeEvent({ type: 'state', runId: builder.runId, state: 'completed' })
    await vi.waitFor(() => expect(fixture.controller.requests
      .filter(item => item.operation === 'create_method_candidate')).toHaveLength(1))

    const shuttingDown = fixture.service.shutdown()
    createResponse.resolve(undefined)
    await preparationStopped
    await shuttingDown
    expect(fixture.controller.requests.some(item => item.operation === 'begin_method_generation')).toBe(false)
    expect(fixture.controller.requests.some(item =>
      item.operation === 'record_method_builder_failure'
      || item.operation === 'record_method_generation_failure')).toBe(false)
  })

  it('does not open the next generation intent when shutdown wins after a slot receipt commits', async () => {
    const fixture = await readyFixture()
    fixture.controller.primeMethodObservation()
    const recordResponse = deferred<void>()
    fixture.controller.methodGenerationRecordResponseGate = {
      label: 'targeted_candidate',
      promise: recordResponse.promise,
    }

    const preparing = fixture.service.prepareMethodCandidate('app-feedback-synthetic')
    const preparationStopped = expect(preparing).rejects.toMatchObject({ code: 'APPLICATION_CLOSED' })
    for (let index = 0; index < 2; index += 1) {
      await vi.waitFor(() => expect(fixture.runtime.handles.length).toBe(index + 1))
      const handle = fixture.runtime.handles[index]!
      await fixture.service.acceptRuntimeEvent({
        type: 'output', runId: handle.runId, text: index === 0 ? '用动作推进。' : '目标候选已完成',
      })
      await fixture.service.acceptRuntimeEvent({ type: 'state', runId: handle.runId, state: 'completed' })
    }
    await vi.waitFor(() => expect(fixture.controller.requests
      .filter(item => item.operation === 'record_method_generation')).toHaveLength(1))

    const shuttingDown = fixture.service.shutdown()
    recordResponse.resolve(undefined)
    await preparationStopped
    await shuttingDown
    expect(fixture.controller.requests.filter(item => item.operation === 'begin_method_generation')
      .map(item => item.payload.label)).toEqual(['targeted_candidate'])
    expect(fixture.controller.requests.some(item =>
      item.operation === 'record_method_generation_failure')).toBe(false)
  })

  it('blocks restart after Builder returns but create never commits instead of rebilling Builder', async () => {
    const fixture = await readyFixture()
    fixture.controller.primeMethodObservation()
    fixture.controller.failMethodCreateBeforeCommit = true

    const preparing = fixture.service.prepareMethodCandidate('app-feedback-synthetic')
    const rejected = expect(preparing).rejects.toThrow(/create unavailable before commit/u)
    await vi.waitFor(() => expect(fixture.runtime.handles).toHaveLength(1))
    const builder = fixture.runtime.handles[0]!
    await fixture.service.acceptRuntimeEvent({ type: 'output', runId: builder.runId, text: '已付费但未封存的 Builder 指导' })
    await fixture.service.acceptRuntimeEvent({ type: 'state', runId: builder.runId, state: 'completed' })
    await rejected
    expect(fixture.controller.requests.filter(item => item.operation === 'create_method_candidate')).toHaveLength(2)

    const snapshot = await fixture.service.systemSnapshot()
    if (snapshot === null) throw new Error('synthetic blocked method snapshot missing')
    const candidate = snapshot.methodCandidates[0]
    if (candidate === undefined) throw new Error('synthetic blocked method candidate missing')
    expect(candidate).toMatchObject({ status: 'CANDIDATE', resumable: false })
    const restartedService = fixture.makeService()
    await expect(restartedService.prepareMethodCandidate('app-feedback-synthetic'))
      .rejects.toThrow(/重复付费/u)
    expect(fixture.runtime.handles).toHaveLength(1)
    await expect(restartedService.rejectMethodCandidate(candidate.id))
      .resolves.toMatchObject({ methodCandidates: [{ status: 'REJECTED' }] })
  })

  it.each([
    ['targeted_candidate', 1],
    ['regression_candidate', 2],
    ['heldout_baseline', 3],
    ['heldout_candidate', 4],
  ] as const)('never rebills %s after paid output returns before its receipt commits', async (label, generationIndex) => {
    const fixture = await readyFixture()
    fixture.controller.primeMethodObservation()
    fixture.controller.failRecordMethodGenerationLabel = label

    const preparing = fixture.service.prepareMethodCandidate('app-feedback-synthetic')
    const rejected = expect(preparing).rejects.toThrow(/after paid output/u)
    for (let index = 0; index <= generationIndex; index += 1) {
      await vi.waitFor(() => expect(fixture.runtime.handles.length).toBe(index + 1))
      const handle = fixture.runtime.handles[index]!
      await fixture.service.acceptRuntimeEvent({
        type: 'output', runId: handle.runId, text: index === 0 ? '用动作推进。' : `${label} 已付费输出`,
      })
      await fixture.service.acceptRuntimeEvent({ type: 'state', runId: handle.runId, state: 'completed' })
    }
    await rejected

    const paidHandleCount = fixture.runtime.handles.length
    const snapshot = await fixture.service.systemSnapshot()
    if (snapshot === null) throw new Error('synthetic paid-window snapshot missing')
    const candidate = snapshot.methodCandidates[0]
    if (candidate === undefined) throw new Error('synthetic paid-window candidate missing')
    expect(candidate).toMatchObject({
      status: 'CANDIDATE',
      resumable: false,
      completedGenerationCount: generationIndex - 1,
    })
    const restartedService = fixture.makeService()
    await expect(restartedService.prepareMethodCandidate('app-feedback-synthetic'))
      .rejects.toThrow(/duplicate|repeat|重复付费/u)
    expect(fixture.runtime.handles).toHaveLength(paidHandleCount)
    expect(fixture.controller.requests.filter(item => item.operation === 'record_method_generation'
      && item.payload.label === label)).toHaveLength(1)

    await expect(restartedService.rejectMethodCandidate(candidate.id)).resolves.toMatchObject({
      methodCandidates: [{ status: 'REJECTED' }],
    })
  })

  it('seals an explicit Builder RUNTIME_FAILED marker and never rebills after restart', async () => {
    const fixture = await readyFixture()
    fixture.controller.primeMethodObservation()

    const preparing = fixture.service.prepareMethodCandidate('app-feedback-synthetic')
    const failed = expect(preparing).rejects.toMatchObject({ code: 'RUNTIME_FAILED' })
    await vi.waitFor(() => expect(fixture.runtime.handles).toHaveLength(1))
    const builder = fixture.runtime.handles[0]!
    await fixture.service.acceptRuntimeEvent({
      type: 'error',
      runId: builder.runId,
      code: 'RUNTIME_FAILED',
      message: 'sensitive Builder body /private/userData token secret-value',
    })
    await fixture.service.acceptRuntimeEvent({ type: 'state', runId: builder.runId, state: 'failed' })
    await failed

    const failure = fixture.controller.requests.find(item =>
      item.operation === 'record_method_builder_failure')
    expect(failure?.payload).toMatchObject({
      error_code: 'RUNTIME_FAILED',
      failure_kind: 'RUNTIME_FAILED',
    })
    expect(failure?.payload.observed_evidence_sha256).toMatch(/^[0-9a-f]{64}$/u)
    expect(JSON.stringify(failure?.payload)).not.toMatch(/sensitive Builder body|private\/userData|secret-value/u)
    const snapshot = await fixture.service.systemSnapshot()
    expect(snapshot?.methodCandidates[0]).toMatchObject({
      status: 'CANDIDATE',
      completedGenerationCount: 0,
      resumable: false,
      preparationFailureKind: 'RUNTIME_FAILED',
    })

    const restarted = fixture.makeService()
    await expect(restarted.prepareMethodCandidate('app-feedback-synthetic')).rejects.toThrow(/重复付费/u)
    expect(fixture.runtime.handles).toHaveLength(1)
  })

  it('keeps 3/4 sealed when heldout candidate fails and restart starts zero new runs', async () => {
    const fixture = await readyFixture()
    fixture.controller.primeMethodObservation()

    const preparing = fixture.service.prepareMethodCandidate('app-feedback-synthetic')
    const failed = expect(preparing).rejects.toMatchObject({ code: 'RUNTIME_FAILED' })
    for (let index = 0; index < 4; index += 1) {
      await vi.waitFor(() => expect(fixture.runtime.handles).toHaveLength(index + 1))
      const handle = fixture.runtime.handles[index]!
      await fixture.service.acceptRuntimeEvent({
        type: 'output',
        runId: handle.runId,
        text: index === 0 ? '用动作推进情节。' : `已封存生成 ${index}`,
      })
      await fixture.service.acceptRuntimeEvent({ type: 'state', runId: handle.runId, state: 'completed' })
    }
    await vi.waitFor(() => expect(fixture.runtime.handles).toHaveLength(5))
    const heldout = fixture.runtime.handles[4]!
    await fixture.service.acceptRuntimeEvent({
      type: 'error',
      runId: heldout.runId,
      code: 'RUNTIME_FAILED',
      message: 'sensitive heldout body /private/userData token secret-value',
    })
    await fixture.service.acceptRuntimeEvent({ type: 'state', runId: heldout.runId, state: 'failed' })
    await failed

    const failure = fixture.controller.requests.find(item =>
      item.operation === 'record_method_generation_failure')
    expect(failure?.payload).toMatchObject({
      label: 'heldout_candidate',
      error_code: 'RUNTIME_FAILED',
      failure_kind: 'RUNTIME_FAILED',
    })
    expect(JSON.stringify(failure?.payload)).not.toMatch(/sensitive heldout body|private\/userData|secret-value|已封存生成/u)
    const snapshot = await fixture.service.systemSnapshot()
    const candidate = snapshot?.methodCandidates[0]
    expect(candidate).toMatchObject({
      status: 'CANDIDATE',
      completedGenerationCount: 3,
      generationTotal: 4,
      resumable: false,
      preparationFailureKind: 'RUNTIME_FAILED',
    })
    expect(candidate?.preparationBlockedReason).not.toMatch(/sensitive|private\/userData|secret-value/u)

    const restarted = fixture.makeService()
    await expect(restarted.prepareMethodCandidate('app-feedback-synthetic')).rejects.toThrow(/重复付费/u)
    expect(fixture.runtime.handles).toHaveLength(5)
    await expect(restarted.rejectMethodCandidate(candidate!.id)).resolves.toMatchObject({
      methodCandidates: [{ status: 'REJECTED' }],
    })
  })

  it.each([
    'OUTPUT_TRUNCATED',
    'DEEPSEEK_FIRST_EVENT_TIMEOUT',
  ] as const)('preserves %s as the stable terminal failure kind', async failureKind => {
    const fixture = await readyFixture()
    fixture.controller.primeMethodObservation()

    const preparing = fixture.service.prepareMethodCandidate('app-feedback-synthetic')
    const failed = expect(preparing).rejects.toMatchObject({ code: failureKind })
    await vi.waitFor(() => expect(fixture.runtime.handles).toHaveLength(1))
    const builder = fixture.runtime.handles[0]!
    await fixture.service.acceptRuntimeEvent({ type: 'output', runId: builder.runId, text: '用动作推进。' })
    await fixture.service.acceptRuntimeEvent({ type: 'state', runId: builder.runId, state: 'completed' })
    await vi.waitFor(() => expect(fixture.runtime.handles).toHaveLength(2))
    const targeted = fixture.runtime.handles[1]!
    await fixture.service.acceptRuntimeEvent({
      type: 'error', runId: targeted.runId, code: failureKind, message: 'raw terminal body',
    })
    await fixture.service.acceptRuntimeEvent({ type: 'state', runId: targeted.runId, state: 'failed' })
    await failed

    const failure = fixture.controller.requests.find(item =>
      item.operation === 'record_method_generation_failure')
    expect(failure?.payload).toMatchObject({
      label: 'targeted_candidate',
      error_code: failureKind,
      failure_kind: failureKind,
    })
    expect(JSON.stringify(failure?.payload)).not.toContain('raw terminal body')
  })

  it('seals EMPTY_OUTPUT when a completed Builder produces no candidate guidance', async () => {
    const fixture = await readyFixture()
    fixture.controller.primeMethodObservation()

    const preparing = fixture.service.prepareMethodCandidate('app-feedback-synthetic')
    const failed = expect(preparing).rejects.toMatchObject({ code: 'EMPTY_OUTPUT' })
    await vi.waitFor(() => expect(fixture.runtime.handles).toHaveLength(1))
    await fixture.service.acceptRuntimeEvent({
      type: 'state', runId: fixture.runtime.handles[0]!.runId, state: 'completed',
    })
    await failed

    expect(fixture.controller.requests.find(item =>
      item.operation === 'record_method_builder_failure')?.payload).toMatchObject({
      error_code: 'EMPTY_OUTPUT',
      failure_kind: 'EMPTY_OUTPUT',
    })
    expect(fixture.runtime.handles).toHaveLength(1)
  })

  it('rolls a committed 4/4 response loss forward without a failure marker or another run', async () => {
    const fixture = await readyFixture()
    fixture.controller.primeMethodObservation()
    fixture.controller.loseMethodGenerationResponseLabel = 'heldout_candidate'

    const preparing = fixture.service.prepareMethodCandidate('app-feedback-synthetic')
    const responseLost = expect(preparing).rejects.toThrow(/response lost after commit/u)
    for (let index = 0; index < 5; index += 1) {
      await vi.waitFor(() => expect(fixture.runtime.handles).toHaveLength(index + 1))
      const handle = fixture.runtime.handles[index]!
      await fixture.service.acceptRuntimeEvent({
        type: 'output', runId: handle.runId, text: index === 0 ? '用动作推进。' : `成功生成 ${index}`,
      })
      await fixture.service.acceptRuntimeEvent({ type: 'state', runId: handle.runId, state: 'completed' })
    }
    await responseLost

    const refreshed = await fixture.service.systemSnapshot()
    expect(refreshed?.methodCandidates[0]).toMatchObject({
      status: 'CANDIDATE', completedGenerationCount: 4, resumable: true,
    })
    expect(fixture.controller.requests.some(item =>
      item.operation === 'record_method_generation_failure')).toBe(false)

    const restarted = fixture.makeService()
    await expect(restarted.prepareMethodCandidate('app-feedback-synthetic')).resolves.toMatchObject({
      methodCandidates: [{ status: 'EVALUATING', completedGenerationCount: 4 }],
    })
    expect(fixture.runtime.handles).toHaveLength(5)
    expect(fixture.controller.requests.filter(item => item.operation === 'record_method_generation'
      && item.payload.label === 'heldout_candidate')).toHaveLength(1)
    expect(fixture.controller.requests.some(item =>
      item.operation === 'record_method_generation_failure')).toBe(false)
  })

  it.each([
    ['returned model mismatch', { returnedModels: ['deepseek-v4-flash'] }],
    ['multiple fingerprints', { systemFingerprints: ['fingerprint-one', 'fingerprint-two'] }],
  ] as const)('persists a hash-only Builder stop for %s and restarts with zero model calls', async (_name, provenance) => {
    const fixture = await readyFixture({ provenance })
    fixture.controller.primeMethodObservation()

    const preparing = fixture.service.prepareMethodCandidate('app-feedback-synthetic')
    const rejected = expect(preparing).rejects.toMatchObject({ code: 'METHOD_EPOCH_UNVERIFIABLE' })
    await vi.waitFor(() => expect(fixture.runtime.handles).toHaveLength(1))
    const handle = fixture.runtime.handles[0]!
    await fixture.service.acceptRuntimeEvent({ type: 'output', runId: handle.runId, text: '不应持久的 Builder 指导' })
    await fixture.service.acceptRuntimeEvent({ type: 'state', runId: handle.runId, state: 'completed' })
    await rejected

    const failure = fixture.controller.requests.find(item =>
      item.operation === 'record_method_builder_failure')
    expect(failure?.payload).toMatchObject({
      error_code: 'METHOD_EPOCH_UNVERIFIABLE',
      failure_kind: 'METHOD_EPOCH_UNVERIFIABLE',
      observed_evidence_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    })
    expect(JSON.stringify(failure?.payload)).not.toMatch(/不应持久|response-one|fingerprint-one/u)
    expect(fixture.controller.requests.some(item => item.operation === 'create_method_candidate')).toBe(false)
    const snapshot = await fixture.service.systemSnapshot()
    if (snapshot === null) throw new Error('synthetic Builder failure snapshot missing')
    const candidate = snapshot.methodCandidates[0]
    if (candidate === undefined) throw new Error('synthetic Builder failure candidate missing')
    expect(candidate).toMatchObject({
      status: 'CANDIDATE',
      completedGenerationCount: 0,
      resumable: false,
      preparationFailureKind: 'METHOD_EPOCH_UNVERIFIABLE',
    })
    const restartedService = fixture.makeService()
    await expect(restartedService.prepareMethodCandidate('app-feedback-synthetic'))
      .rejects.toThrow(/重复付费/u)
    expect(fixture.runtime.handles).toHaveLength(1)
  })

  it.each([
    ['returned model mismatch', { returnedModels: ['deepseek-v4-flash'] }],
    ['multiple fingerprints', { systemFingerprints: ['fingerprint-one', 'fingerprint-two'] }],
  ] as const)('persists a hash-only generation stop for %s and starts no retry', async (_name, provenance) => {
    const fixture = await readyFixture()
    fixture.controller.primeMethodObservation()

    const preparing = fixture.service.prepareMethodCandidate('app-feedback-synthetic')
    const rejected = expect(preparing).rejects.toMatchObject({ code: 'METHOD_EPOCH_UNVERIFIABLE' })
    await vi.waitFor(() => expect(fixture.runtime.handles).toHaveLength(1))
    const builder = fixture.runtime.handles[0]!
    await fixture.service.acceptRuntimeEvent({ type: 'output', runId: builder.runId, text: '用动作推进。' })
    fixture.loopback.setProvenanceOverrides(provenance)
    await fixture.service.acceptRuntimeEvent({ type: 'state', runId: builder.runId, state: 'completed' })
    await vi.waitFor(() => expect(fixture.runtime.handles).toHaveLength(2))
    const targeted = fixture.runtime.handles[1]!
    await fixture.service.acceptRuntimeEvent({
      type: 'output', runId: targeted.runId, text: '不得写入 failure marker 的 slot 正文',
    })
    await fixture.service.acceptRuntimeEvent({ type: 'state', runId: targeted.runId, state: 'completed' })
    await rejected

    const failure = fixture.controller.requests.find(item =>
      item.operation === 'record_method_generation_failure')
    expect(failure?.payload).toMatchObject({
      label: 'targeted_candidate',
      error_code: 'METHOD_EPOCH_UNVERIFIABLE',
      failure_kind: 'METHOD_EPOCH_UNVERIFIABLE',
      observed_evidence_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    })
    expect(JSON.stringify(failure?.payload)).not.toMatch(/slot 正文|response-one|fingerprint-one/u)
    const snapshot = await fixture.service.systemSnapshot()
    expect(snapshot?.methodCandidates[0]).toMatchObject({
      completedGenerationCount: 0,
      resumable: false,
      preparationFailureKind: 'METHOD_EPOCH_UNVERIFIABLE',
    })

    const restarted = fixture.makeService()
    await expect(restarted.prepareMethodCandidate('app-feedback-synthetic')).rejects.toThrow(/重复付费/u)
    expect(fixture.runtime.handles).toHaveLength(2)
  })

  it('blocks a method epoch Profile mismatch before configuring or starting the runtime', async () => {
    const fixture = await readyFixture()
    fixture.controller.primeMethodObservation('b'.repeat(64))

    await expect(fixture.service.prepareMethodCandidate('app-feedback-synthetic')).rejects.toMatchObject({
      code: 'METHOD_EPOCH_CHANGED',
    })

    expect(fixture.runtime.inputs).toHaveLength(0)
    expect(fixture.runtime.spec).toBeUndefined()
    expect(fixture.timeline).not.toContain('runtime:stop')
    expect(fixture.loopback.lastLease?.revoked).toBe(true)
    const failure = fixture.controller.requests.find(item =>
      item.operation === 'record_method_builder_failure')
    expect(failure?.payload).toMatchObject({
      error_code: 'METHOD_EPOCH_CHANGED',
      failure_kind: 'METHOD_EPOCH_CHANGED',
      expected_epoch_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      observed_epoch_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      observed_evidence_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    })
    expect(failure?.payload.observed_epoch_sha256).not.toBe(failure?.payload.expected_epoch_sha256)
    expect(JSON.stringify(failure?.payload)).not.toMatch(/Profile|workspace|instruction|写克制/u)
    expect(fixture.controller.requests.some(item => item.operation === 'create_method_candidate')).toBe(false)
    expect(fixture.controller.requests.some(item => item.operation === 'record_method_generation')).toBe(false)
    const snapshot = await fixture.service.systemSnapshot()
    expect(snapshot?.methodCandidates[0]).toMatchObject({
      completedGenerationCount: 0,
      resumable: false,
      preparationFailureKind: 'METHOD_EPOCH_CHANGED',
    })
    const restarted = fixture.makeService()
    await expect(restarted.prepareMethodCandidate('app-feedback-synthetic')).rejects.toThrow(/重复付费/u)
    expect(fixture.runtime.handles).toHaveLength(0)
  })

  it('lets shutdown win after Profile digest returns before writing a mismatch marker', async () => {
    const profileEntered = deferred<void>()
    const releaseProfile = deferred<string>()
    const fixture = await readyFixture({
      profileDigest: async () => {
        profileEntered.resolve(undefined)
        return await releaseProfile.promise
      },
    })
    fixture.controller.primeMethodObservation()

    const preparing = fixture.service.prepareMethodCandidate('app-feedback-synthetic')
    const rejected = expect(preparing).rejects.toMatchObject({ code: 'APPLICATION_CLOSED' })
    await profileEntered.promise
    let shutdownResolved = false
    const shuttingDown = fixture.service.shutdown().then(() => { shutdownResolved = true })
    await Promise.resolve()
    expect(shutdownResolved).toBe(false)
    releaseProfile.resolve('b'.repeat(64))

    await rejected
    await shuttingDown
    expect(fixture.controller.requests.some(item =>
      item.operation === 'record_method_builder_failure'
      || item.operation === 'record_method_generation_failure')).toBe(false)
    expect(fixture.runtime.handles).toHaveLength(0)
    const snapshot = await fixture.service.systemSnapshot()
    expect(snapshot?.methodCandidates[0]).toMatchObject({
      completedGenerationCount: 0,
      resumable: false,
      preparationFailureKind: 'BUILDER_RESULT_UNKNOWN',
    })
    const restarted = fixture.makeService()
    await expect(restarted.prepareMethodCandidate('app-feedback-synthetic')).rejects.toThrow(/重复付费/u)
    expect(fixture.runtime.handles).toHaveLength(0)
  })

  it('keeps a Builder TRANSPORT_CLOSED failure unresolved without rebilling', async () => {
    const fixture = await readyFixture()
    fixture.controller.primeMethodObservation()

    const preparing = fixture.service.prepareMethodCandidate('app-feedback-synthetic')
    const rejected = expect(preparing).rejects.toMatchObject({ code: 'TRANSPORT_CLOSED' })
    await vi.waitFor(() => expect(fixture.runtime.handles).toHaveLength(1))
    const builder = fixture.runtime.handles[0]!
    await fixture.service.acceptRuntimeEvent({
      type: 'error', runId: builder.runId, code: 'TRANSPORT_CLOSED', message: 'transport closed',
    })
    await fixture.service.acceptRuntimeEvent({ type: 'state', runId: builder.runId, state: 'failed' })
    await rejected

    expect(fixture.controller.requests.some(item =>
      item.operation === 'record_method_builder_failure'
      || item.operation === 'record_method_generation_failure')).toBe(false)
    const snapshot = await fixture.service.systemSnapshot()
    expect(snapshot?.methodCandidates[0]).toMatchObject({
      completedGenerationCount: 0,
      resumable: false,
      preparationFailureKind: 'BUILDER_RESULT_UNKNOWN',
    })
    const restarted = fixture.makeService()
    await expect(restarted.prepareMethodCandidate('app-feedback-synthetic')).rejects.toThrow(/重复付费/u)
    expect(fixture.runtime.handles).toHaveLength(1)
  })

  it('keeps a slot TRANSPORT_CLOSED failure unresolved without rebilling', async () => {
    const fixture = await readyFixture()
    fixture.controller.primeMethodObservation()

    const preparing = fixture.service.prepareMethodCandidate('app-feedback-synthetic')
    const rejected = expect(preparing).rejects.toMatchObject({ code: 'TRANSPORT_CLOSED' })
    await vi.waitFor(() => expect(fixture.runtime.handles).toHaveLength(1))
    const builder = fixture.runtime.handles[0]!
    await fixture.service.acceptRuntimeEvent({ type: 'output', runId: builder.runId, text: '用动作推进。' })
    await fixture.service.acceptRuntimeEvent({ type: 'state', runId: builder.runId, state: 'completed' })
    await vi.waitFor(() => expect(fixture.runtime.handles).toHaveLength(2))
    const targeted = fixture.runtime.handles[1]!
    await fixture.service.acceptRuntimeEvent({
      type: 'error', runId: targeted.runId, code: 'TRANSPORT_CLOSED', message: 'transport closed',
    })
    await fixture.service.acceptRuntimeEvent({ type: 'state', runId: targeted.runId, state: 'failed' })
    await rejected

    expect(fixture.controller.requests.some(item =>
      item.operation === 'record_method_builder_failure'
      || item.operation === 'record_method_generation_failure')).toBe(false)
    const snapshot = await fixture.service.systemSnapshot()
    expect(snapshot?.methodCandidates[0]).toMatchObject({
      completedGenerationCount: 0,
      resumable: false,
      preparationFailureKind: 'GENERATION_RESULT_UNKNOWN',
    })
    const restarted = fixture.makeService()
    await expect(restarted.prepareMethodCandidate('app-feedback-synthetic')).rejects.toThrow(/重复付费/u)
    expect(fixture.runtime.handles).toHaveLength(2)
  })

  it('requires explicit and mutually exclusive method adoption projection flags', async () => {
    const fixture = await readyFixture()
    const candidate = {
      id: 'method-projection',
      title: '候选方法',
      summary: '用行动推进。',
      tradeoff: '可能减少解释。',
      status: 'PROMOTED',
      ready: false,
      comparisons: [
        { phase: 'targeted', left: '目标 A', right: '目标 B', choice: 'A' },
        { phase: 'regression', left: '回归 A', right: '回归 B', choice: 'B' },
        { phase: 'heldout', left: '留出 A', right: '留出 B', choice: 'A' },
      ],
    }

    fixture.controller.primeMethodCandidate({ ...candidate, rolled_back: false })
    await expect(fixture.service.systemSnapshot()).rejects.toMatchObject({ code: 'CONTROLLER_PROTOCOL' })

    fixture.controller.primeMethodCandidate({
      ...candidate, adoption_pending: false, rolled_back: true,
    })
    await expect(fixture.service.systemSnapshot()).resolves.toMatchObject({
      methodCandidates: [{ adoptionPending: false, rolledBack: true }],
    })

    fixture.controller.primeMethodCandidate({
      ...candidate, adoption_pending: true, rolled_back: true,
    })
    await expect(fixture.service.systemSnapshot()).rejects.toMatchObject({ code: 'CONTROLLER_PROTOCOL' })

    fixture.controller.primeMethodCandidate({
      ...candidate, status: 'EVALUATING', adoption_pending: true, rolled_back: false,
    })
    await expect(fixture.service.systemSnapshot()).rejects.toMatchObject({ code: 'CONTROLLER_PROTOCOL' })
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

  it('keeps shutdown unresolved when cancel concurrently reports a failed runtime', async () => {
    let serviceUnderRace: StudioService | undefined
    const fixture = await readyFixture({
      runtimeCancel: async runId => {
        if (serviceUnderRace === undefined) throw new Error('synthetic race service unavailable')
        await serviceUnderRace.acceptRuntimeEvent({
          type: 'error', runId, code: 'RUNTIME_FAILED', message: 'failed while shutdown cancellation won',
        })
        await serviceUnderRace.acceptRuntimeEvent({ type: 'state', runId, state: 'failed' })
      },
    })
    serviceUnderRace = fixture.service
    fixture.controller.primeMethodObservation()

    const preparing = fixture.service.prepareMethodCandidate('app-feedback-synthetic')
    const rejected = expect(preparing).rejects.toMatchObject({ code: 'APPLICATION_CLOSED' })
    await vi.waitFor(() => expect(fixture.runtime.handles).toHaveLength(1))
    await fixture.service.shutdown()
    await rejected

    expect(fixture.controller.requests.some(item =>
      item.operation === 'record_method_builder_failure'
      || item.operation === 'record_method_generation_failure')).toBe(false)
    const snapshot = await fixture.service.systemSnapshot()
    expect(snapshot?.methodCandidates[0]).toMatchObject({
      completedGenerationCount: 0,
      resumable: false,
      preparationFailureKind: 'BUILDER_RESULT_UNKNOWN',
    })
    const restarted = fixture.makeService()
    await expect(restarted.prepareMethodCandidate('app-feedback-synthetic')).rejects.toThrow(/重复付费/u)
    expect(fixture.runtime.handles).toHaveLength(1)
  })

  it('does not claim success when gateway provenance is incomplete', async () => {
    const fixture = await readyFixture({ provenance: { systemFingerprints: [] } })
    const handle = await fixture.service.startWork('写一段场景')
    await fixture.service.acceptRuntimeEvent({ type: 'output', runId: 'runtime-one', text: '未证实作品' })
    await fixture.service.acceptRuntimeEvent({ type: 'state', runId: 'runtime-one', state: 'completed' })

    expect(fixture.controller.requests.some(item => item.operation === 'complete_work')).toBe(false)
    expect(fixture.controller.requests.some(item => item.operation === 'terminate_work')).toBe(true)
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
    expect(fixture.controller.requests.some(item => item.operation === 'terminate_work')).toBe(true)
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
    expect(fixture.controller.requests.some(item => item.operation === 'terminate_work')).toBe(true)
    expect(fixture.controller.requests.find(item => item.operation === 'terminate_work')?.payload)
      .toMatchObject({ outcome: 'FAILED', error_code: 'COMMIT_FAILED' })
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

  it('restores a classified gateway timeout from request evidence after DSH flattens the HTTP error', async () => {
    const fixture = await readyFixture({
      provenance: {
        requestCount: 3,
        completedRequests: 0,
        failedRequests: 3,
        returnedModels: [],
        systemFingerprints: [],
        usage: {},
        requests: [1, 2, 3].map(number => ({
          requestNumber: number,
          startedAt: `2026-08-15T00:2${number}:00.000Z`,
          completedAt: `2026-08-15T00:2${number}:02.000Z`,
          status: 'FAILED' as const,
          httpStatus: 504,
          errorCode: 'DEEPSEEK_FIRST_EVENT_TIMEOUT',
          usage: {},
        })),
      },
    })
    const handle = await fixture.service.startWork('写一段场景')
    await fixture.service.acceptRuntimeEvent({
      type: 'error',
      runId: 'runtime-one',
      code: 'DEEPSEEK_UNAVAILABLE',
      message: 'DeepSeek 服务暂时不可用，请稍后重试。',
    })
    await fixture.service.acceptRuntimeEvent({ type: 'state', runId: 'runtime-one', state: 'failed' })

    expect(fixture.events).toContainEqual(expect.objectContaining({
      type: 'error',
      runId: handle.runId,
      code: 'DEEPSEEK_FIRST_EVENT_TIMEOUT',
      message: expect.stringContaining('共发起 3 次请求'),
    }))
    expect(fixture.controller.requests.find(item => item.operation === 'terminate_work')?.payload)
      .toMatchObject({ outcome: 'FAILED', error_code: 'DEEPSEEK_FIRST_EVENT_TIMEOUT' })
  })

  it('uses only the final request as timeout evidence after an earlier timeout recovered', async () => {
    const fixture = await readyFixture({
      provenance: {
        requestCount: 2,
        completedRequests: 1,
        failedRequests: 1,
        completedAt: '2026-08-15T00:25:00.000Z',
        responseId: 'response-recovered',
        returnedModels: ['deepseek-v4-pro'],
        systemFingerprints: ['fingerprint-recovered'],
        usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
        requests: [
          {
            requestNumber: 1,
            startedAt: '2026-08-15T00:21:00.000Z',
            completedAt: '2026-08-15T00:23:00.000Z',
            status: 'FAILED',
            httpStatus: 504,
            errorCode: 'DEEPSEEK_FIRST_EVENT_TIMEOUT',
            usage: {},
          },
          {
            requestNumber: 2,
            startedAt: '2026-08-15T00:24:00.000Z',
            completedAt: '2026-08-15T00:25:00.000Z',
            status: 'COMPLETED',
            responseId: 'response-recovered',
            returnedModel: 'deepseek-v4-pro',
            systemFingerprint: 'fingerprint-recovered',
            usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
          },
        ],
      },
    })
    const handle = await fixture.service.startWork('写一段场景')
    await fixture.service.acceptRuntimeEvent({
      type: 'error',
      runId: 'runtime-one',
      code: 'OUTPUT_TRUNCATED',
      message: '内容达到本次生成上限，未保存为完整版本；请缩小本次任务后重试。',
    })
    await fixture.service.acceptRuntimeEvent({ type: 'state', runId: 'runtime-one', state: 'failed' })

    expect(fixture.events).toContainEqual({
      type: 'error',
      runId: handle.runId,
      code: 'OUTPUT_TRUNCATED',
      message: '内容达到本次生成上限，未保存为完整版本；请缩小本次任务后重试。',
    })
    expect(fixture.controller.requests.find(item => item.operation === 'terminate_work')?.payload)
      .toMatchObject({ error_code: 'OUTPUT_TRUNCATED' })
  })

  it('retries the exact begin after its committed response is lost', async () => {
    const fixture = await readyFixture()
    fixture.controller.loseFirstBeginResponse = true

    const handle = await fixture.service.startWork('响应丢失后仍只打开一个 run')

    const begins = fixture.controller.requests.filter(item => item.operation === 'begin_work')
    expect(begins).toHaveLength(2)
    expect(begins[1]?.payload).toEqual(begins[0]?.payload)
    expect(fixture.controller.uniqueBeginOpenCount).toBe(1)
    expect(fixture.runtime.lastInput).toContain('响应丢失后仍只打开一个 run')
    await fixture.service.cancelWork(handle.runId)
  })

  it('does not recover its own durable LAUNCHING intent while createLaunching is returning', async () => {
    const launchingWritten = deferred<void>()
    const releaseCreateLaunching = deferred<void>()
    const fixture = await readyFixture({
      pendingWorkStoreFactory: userData => {
        const store = new PendingWorkStore(userData)
        return {
          load: async () => await store.load(),
          createLaunching: async input => {
            const intent = await store.createLaunching(input)
            launchingWritten.resolve(undefined)
            await releaseCreateLaunching.promise
            return intent
          },
          requireTermination: async (pending, expectation) => await store.requireTermination(pending, expectation),
          clear: async pending => await store.clear(pending),
        }
      },
    })

    const launching = fixture.service.startWork('持久化尾部并发状态查询不能误杀当前启动')
    await launchingWritten.promise
    const status = await fixture.service.getStatus()

    expect(status.workRecoveryState).toBe('none')
    expect(fixture.controller.requests.some(item => item.operation === 'begin_work')).toBe(false)
    expect(fixture.controller.requests.some(item => item.operation === 'terminate_work')).toBe(false)

    releaseCreateLaunching.resolve(undefined)
    const handle = await launching
    expect(fixture.controller.requests.filter(item => item.operation === 'begin_work')).toHaveLength(1)
    expect(fixture.controller.requests.some(item => item.operation === 'terminate_work')).toBe(false)
    await fixture.service.cancelWork(handle.runId)
  })

  it('keeps LAUNCHING durable when begin never arrived and replays it before restart termination', async () => {
    const fixture = await readyFixture()
    fixture.controller.failBeginWorkBeforeCommit = true

    await expect(fixture.service.startWork('Controller 恢复后再封存')).rejects.toMatchObject({
      code: 'WORK_TERMINATION_PENDING',
    })
    const pendingPath = join(fixture.userData, 'supervisor', 'pending-work.json')
    const pending = JSON.parse(await readFile(pendingPath, 'utf8')) as Record<string, unknown>
    expect(pending.phase).toBe('LAUNCHING')
    expect(fixture.controller.requests.some(item => item.operation === 'terminate_work')).toBe(false)

    fixture.controller.failBeginWorkBeforeCommit = false
    const restarted = fixture.makeService()
    const status = await restarted.getStatus()

    expect(status.workRecoveryState).toBe('recovered')
    expect(status.activeSystem?.interruptedRun).toMatchObject({
      state: 'TERMINATED_CANCELLED',
      reasonCode: 'application-restarted-before-terminal-commit',
    })
    expect(fixture.controller.uniqueBeginOpenCount).toBe(1)
    await expect(access(pendingPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('persists the precise timeout before a hanging runtime stop and replays it after restart', async () => {
    const stopEntered = deferred<void>()
    const releaseStop = deferred<void>()
    const fixture = await readyFixture({
      provenance: failedTimeoutProvenance('DEEPSEEK_TOTAL_TIMEOUT'),
      runtimeStop: async () => {
        stopEntered.resolve(undefined)
        await releaseStop.promise
      },
    })
    const handle = await fixture.service.startWork('停止进程挂起也不能丢失失败类别')
    fixture.controller.failBeginWorkBeforeCommit = true
    await fixture.service.acceptRuntimeEvent({
      type: 'error', runId: 'runtime-one', code: 'DEEPSEEK_UNAVAILABLE', message: 'flattened runtime error',
    })
    const failing = fixture.service.acceptRuntimeEvent({ type: 'state', runId: 'runtime-one', state: 'failed' })
    await stopEntered.promise

    const pendingPath = join(fixture.userData, 'supervisor', 'pending-work.json')
    const pending = JSON.parse(await readFile(pendingPath, 'utf8')) as {
      phase: string
      termination_expectation: { outcome: string; error_code: string }
    }
    expect(pending).toMatchObject({
      phase: 'TERMINATION_REQUIRED',
      termination_expectation: { outcome: 'FAILED', error_code: 'DEEPSEEK_TOTAL_TIMEOUT' },
    })
    expect(fixture.controller.requests.some(item => item.operation === 'terminate_work')).toBe(false)

    const restarted = fixture.makeService()
    const status = await restarted.getStatus()
    expect(status.workRecoveryState).toBe('recovered')
    expect(status.activeSystem?.interruptedRun).toMatchObject({
      runId: handle.runId,
      outcome: 'FAILED',
      reasonCode: 'DEEPSEEK_TOTAL_TIMEOUT',
    })
    expect(fixture.controller.requests.find(item => item.operation === 'terminate_work')?.payload)
      .toMatchObject({ outcome: 'FAILED', error_code: 'DEEPSEEK_TOTAL_TIMEOUT' })

    releaseStop.resolve(undefined)
    await failing
  })

  it('replays a trusted legacy 16384 termination from the Main pending-work queue', async () => {
    const fixture = await readyFixture()
    const handle = await fixture.service.startWork('升级后只重放旧失败终态')
    const pendingStore = new PendingWorkStore(fixture.userData)
    const launching = await pendingStore.load()
    expect(launching).not.toBeNull()
    if (launching === null) throw new Error('expected durable LAUNCHING intent')

    await pendingStore.requireTermination(launching, {
      outcome: 'FAILED',
      reason: '旧版本达到输出上限',
      error_code: 'OUTPUT_TRUNCATED',
      runtime_provenance: {
        app_version: '1.0.0-alpha.1',
        completed_at: '2026-08-15T00:30:00.000Z',
        controller_version: '1',
        context_sha256: launching.begin_payload.context_sha256,
        dsh_version: '0.1.0-rc.6',
        completed_requests: 1,
        failed_requests: 0,
        parameters: {
          thinking: 'enabled',
          reasoning_effort: 'high',
          max_tokens: 16_384,
        },
        profile_sha256: 'a'.repeat(64),
        request_count: 1,
        requests: [{
          request_number: 1,
          started_at: '2026-08-15T00:20:00.000Z',
          completed_at: '2026-08-15T00:30:00.000Z',
          status: 'COMPLETED',
          http_status: 200,
          error_code: null,
          response_id: 'response-legacy-output-truncated',
          returned_model: 'deepseek-v4-flash',
          system_fingerprint: 'fingerprint-legacy-output-truncated',
          usage: { completion_tokens: 16_381 },
        }],
        requested_model: 'deepseek-v4-flash',
        response_id: 'response-legacy-output-truncated',
        returned_model: 'deepseek-v4-flash',
        system_fingerprint: 'fingerprint-legacy-output-truncated',
        usage: { completion_tokens: 16_381 },
      },
    })

    const restarted = fixture.makeService()
    const status = await restarted.getStatus()

    expect(status.workRecoveryState).toBe('recovered')
    expect(status.activeSystem?.interruptedRun).toMatchObject({
      runId: handle.runId,
      outcome: 'FAILED',
      reasonCode: 'OUTPUT_TRUNCATED',
    })
    const termination = fixture.controller.requests.findLast(item => item.operation === 'terminate_work')
    expect(termination?.payload).toMatchObject({
      run_id: handle.runId,
      outcome: 'FAILED',
      error_code: 'OUTPUT_TRUNCATED',
      runtime_provenance: { parameters: { max_tokens: 16_384 } },
    })
    await expect(access(join(fixture.userData, 'supervisor', 'pending-work.json')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps an observed timeout FAILED before a hanging shutdown cancel and replays it after restart', async () => {
    const cancelEntered = deferred<void>()
    const releaseCancel = deferred<void>()
    const fixture = await readyFixture({
      provenance: failedTimeoutProvenance('DEEPSEEK_STREAM_IDLE_TIMEOUT'),
      runtimeCancel: async () => {
        cancelEntered.resolve(undefined)
        await releaseCancel.promise
      },
    })
    const handle = await fixture.service.startWork('关闭应用也不能把已知超时改成取消')
    fixture.controller.failBeginWorkBeforeCommit = true
    await fixture.service.acceptRuntimeEvent({
      type: 'error', runId: 'runtime-one', code: 'DEEPSEEK_UNAVAILABLE', message: 'flattened runtime error',
    })
    const shuttingDown = fixture.service.shutdown()
    await cancelEntered.promise

    const pendingPath = join(fixture.userData, 'supervisor', 'pending-work.json')
    const pending = JSON.parse(await readFile(pendingPath, 'utf8')) as {
      phase: string
      termination_expectation: { outcome: string; error_code: string }
    }
    expect(pending).toMatchObject({
      phase: 'TERMINATION_REQUIRED',
      termination_expectation: { outcome: 'FAILED', error_code: 'DEEPSEEK_STREAM_IDLE_TIMEOUT' },
    })
    expect(fixture.controller.requests.some(item => item.operation === 'terminate_work')).toBe(false)

    const restarted = fixture.makeService()
    const status = await restarted.getStatus()
    expect(status.workRecoveryState).toBe('recovered')
    expect(status.activeSystem?.interruptedRun).toMatchObject({
      runId: handle.runId,
      outcome: 'FAILED',
      reasonCode: 'DEEPSEEK_STREAM_IDLE_TIMEOUT',
    })

    releaseCancel.resolve(undefined)
    await shuttingDown
  })

  it('does not call Controller after a tampered pending-work queue fails closed', async () => {
    const fixture = await readyFixture()
    await fixture.service.startWork('只用于建立待恢复记录')
    const pendingPath = join(fixture.userData, 'supervisor', 'pending-work.json')
    const tampered = JSON.parse(await readFile(pendingPath, 'utf8')) as Record<string, unknown>
    tampered.system_id = 'system-tampered'
    await writeFile(pendingPath, `${JSON.stringify(tampered)}\n`, { encoding: 'utf8', mode: 0o600 })
    fixture.controller.requests.length = 0

    const restarted = fixture.makeService()
    const status = await restarted.getStatus()

    expect(status.workRecoveryState).toBe('retry-required')
    expect(status.activeSystem).toBeNull()
    expect(fixture.controller.requests).toHaveLength(0)
  })

  it('still stops and closes runtime when active termination persistence fails during shutdown', async () => {
    const fixture = await readyFixture()
    const handle = await fixture.service.startWork('持久化失败也必须清理进程')
    const pendingPath = join(fixture.userData, 'supervisor', 'pending-work.json')
    const tampered = JSON.parse(await readFile(pendingPath, 'utf8')) as Record<string, unknown>
    tampered.system_id = 'system-tampered'
    await writeFile(pendingPath, `${JSON.stringify(tampered)}\n`, { encoding: 'utf8', mode: 0o600 })

    await expect(fixture.service.shutdown()).rejects.toMatchObject({ code: 'WORK_TERMINATION_PENDING' })

    expect(fixture.timeline).toContain('runtime:cancel')
    expect(fixture.timeline).toContain('runtime:stop')
    expect(fixture.timeline).toContain('loopback:close')
    expect(fixture.runtime.status()).toEqual({ state: 'unconfigured' })
    expect(fixture.events).toContainEqual(expect.objectContaining({
      type: 'error', runId: handle.runId, code: 'WORK_TERMINATION_PENDING',
    }))
    expect(fixture.controller.requests.some(item => item.operation === 'terminate_work')).toBe(false)
  })

  it('still stops runtime and returns pending when launch-catch persistence fails', async () => {
    const profileEntered = deferred<void>()
    const releaseProfile = deferred<void>()
    const fixture = await readyFixture({
      profileDigest: async () => {
        profileEntered.resolve(undefined)
        await releaseProfile.promise
        throw new Error('synthetic profile failure')
      },
    })
    const launching = fixture.service.startWork('启动失败也必须清理进程')
    await profileEntered.promise
    const pendingPath = join(fixture.userData, 'supervisor', 'pending-work.json')
    const tampered = JSON.parse(await readFile(pendingPath, 'utf8')) as Record<string, unknown>
    tampered.system_id = 'system-tampered'
    await writeFile(pendingPath, `${JSON.stringify(tampered)}\n`, { encoding: 'utf8', mode: 0o600 })
    releaseProfile.resolve(undefined)

    await expect(launching).rejects.toMatchObject({ code: 'WORK_TERMINATION_PENDING' })
    expect(fixture.timeline).toContain('runtime:stop')
    expect(fixture.controller.requests.some(item => item.operation === 'terminate_work')).toBe(false)
  })

  it('does not let an earlier retry timeout hide the latest terminal cause', async () => {
    const fixture = await readyFixture({
      provenance: {
        requestCount: 2,
        completedRequests: 0,
        failedRequests: 2,
        returnedModels: [],
        systemFingerprints: [],
        usage: {},
        requests: [
          {
            requestNumber: 1,
            startedAt: '2026-08-15T00:21:00.000Z',
            completedAt: '2026-08-15T00:23:00.000Z',
            status: 'FAILED',
            httpStatus: 504,
            errorCode: 'DEEPSEEK_FIRST_EVENT_TIMEOUT',
            usage: {},
          },
          {
            requestNumber: 2,
            startedAt: '2026-08-15T00:24:00.000Z',
            completedAt: '2026-08-15T00:24:01.000Z',
            status: 'FAILED',
            httpStatus: 402,
            errorCode: 'ACCOUNT_BALANCE',
            usage: {},
          },
        ],
      },
    })
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
  })

  it('fails closed when the runtime stopped but Controller termination cannot be verified', async () => {
    const fixture = await readyFixture()
    fixture.controller.failTerminateWork = true
    const handle = await fixture.service.startWork('写一段场景')
    await fixture.service.acceptRuntimeEvent({
      type: 'error', runId: 'runtime-one', code: 'RUNTIME_FAILED', message: 'synthetic failure',
    })
    await fixture.service.acceptRuntimeEvent({ type: 'state', runId: 'runtime-one', state: 'failed' })

    expect(fixture.controller.requests.filter(item => item.operation === 'terminate_work')).toHaveLength(2)
    expect(fixture.events).toContainEqual({
      type: 'error',
      runId: handle.runId,
      code: 'WORK_TERMINATION_PENDING',
      message: '生成已经停止，但失败记录还没有安全封存。请重启应用后恢复；本次不会计为作品或学习证据。',
    })
    expect(fixture.events.at(-1)).toEqual({ type: 'state', runId: handle.runId, state: 'failed' })

    const pendingPath = join(fixture.userData, 'supervisor', 'pending-work.json')
    await expect(readFile(pendingPath, 'utf8')).resolves.toContain(handle.runId)
    fixture.controller.failTerminateWork = false
    const restarted = fixture.makeService()
    const recovered = await restarted.getStatus()
    expect(recovered.workRecoveryState).toBe('recovered')
    expect(recovered.activeSystem?.interruptedRun).toMatchObject({
      runId: handle.runId,
      state: 'TERMINATED_FAILED',
      findingEligible: false,
    })
    await expect(access(pendingPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('lets an exact completed Controller work win over a stale launch intent after restart', async () => {
    const fixture = await readyFixture()
    const handle = await fixture.service.startWork('完成结果应优先')
    const pendingPath = join(fixture.userData, 'supervisor', 'pending-work.json')
    const staleIntent = await readFile(pendingPath, 'utf8')
    await fixture.service.acceptRuntimeEvent({ type: 'output', runId: 'runtime-one', text: '已安全保存的作品' })
    await fixture.service.acceptRuntimeEvent({ type: 'state', runId: 'runtime-one', state: 'completed' })
    await writeFile(pendingPath, staleIntent, { encoding: 'utf8', mode: 0o600 })
    const terminateCount = fixture.controller.requests.filter(item => item.operation === 'terminate_work').length

    const restarted = fixture.makeService()
    const status = await restarted.getStatus()

    expect(status.workRecoveryState).toBe('recovered')
    expect(status.activeSystem?.lastWork).toMatchObject({ runId: handle.runId, output: '已安全保存的作品' })
    expect(fixture.controller.requests.filter(item => item.operation === 'terminate_work')).toHaveLength(terminateCount)
    await expect(access(pendingPath)).rejects.toMatchObject({ code: 'ENOENT' })
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
      operation: 'terminate_work',
      payload: {
        run_id: handle.runId,
        reason: 'user-cancelled',
        outcome: 'CANCELLED',
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
    const cancelIndex = fixture.timeline.indexOf('controller:terminate_work')
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
    expect(fixture.timeline).toContain('controller:terminate_work')
    expect(fixture.timeline.indexOf('lease:revoked')).toBeLessThan(
      fixture.timeline.indexOf('controller:terminate_work'),
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

function failedTimeoutProvenance(
  errorCode: 'DEEPSEEK_STREAM_IDLE_TIMEOUT' | 'DEEPSEEK_TOTAL_TIMEOUT',
): Partial<LoopbackLeaseProvenance> {
  return {
    requestCount: 1,
    completedRequests: 0,
    failedRequests: 1,
    returnedModels: [],
    systemFingerprints: [],
    usage: {},
    requests: [{
      requestNumber: 1,
      startedAt: '2026-08-15T00:20:00.000Z',
      completedAt: '2026-08-15T00:30:00.000Z',
      status: 'FAILED',
      httpStatus: 504,
      errorCode,
      usage: {},
    }],
  }
}

interface FixtureOptions {
  readonly provenance?: Partial<LoopbackLeaseProvenance>
  readonly profileDigest?: (spec: DshRuntimeLaunchSpec) => Promise<string>
  readonly runtimeStart?: (input: string) => Promise<RuntimeRunHandle>
  readonly runtimeCancel?: (runId: string) => Promise<void>
  readonly runtimeStop?: () => Promise<void>
  readonly runtimeSpecFactory?: RuntimeSpecFactory
  readonly pendingWorkStoreFactory?: (userDataPath: string) => PendingWorkStorePort
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
  const runtime = new FakeRuntime(timeline, options.runtimeStart, options.runtimeCancel, options.runtimeStop)
  const loopback = new FakeLoopback(timeline, options.provenance)
  const credentialValidator = vi.fn<(key: string) => Promise<readonly ('deepseek-v4-pro' | 'deepseek-v4-flash')[]>>()
  const pendingWorkStore = options.pendingWorkStoreFactory?.(userData)
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
    ...(pendingWorkStore === undefined ? {} : { pendingWorkStore }),
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
  sessionOnly = false
  value: string | null = null

  async status(): Promise<{
    secureStorageAvailable: boolean
    configured: boolean
    persistence: 'none' | 'protected' | 'session'
  }> {
    return {
      secureStorageAvailable: this.available,
      configured: this.configured,
      persistence: !this.configured ? 'none' : this.sessionOnly ? 'session' : 'protected',
    }
  }
  async set(value: string, options?: { readonly allowSessionOnly: boolean }): Promise<void> {
    if (!this.available && options?.allowSessionOnly !== true) throw new Error('session permission required')
    this.value = value
    this.configured = true
    this.sessionOnly = !this.available
  }
  async get(): Promise<string | null> { return this.value }
  clearSession(): void {
    if (!this.sessionOnly) return
    this.value = null
    this.configured = false
    this.sessionOnly = false
  }
  async delete(): Promise<void> { this.value = null; this.configured = false; this.sessionOnly = false }
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
    private readonly stopHook?: () => Promise<void>,
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
  async stop(): Promise<void> {
    this.timeline.push('runtime:stop')
    if (this.stopHook !== undefined) await this.stopHook()
    this.state = { state: 'ready' }
  }
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
  private provenance: LoopbackLeaseProvenance
  private hasReturnedModelOverride: boolean

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
  setProvenanceOverrides(overrides: Partial<LoopbackLeaseProvenance>): void {
    this.hasReturnedModelOverride = overrides.returnedModels !== undefined
    this.provenance = { ...this.provenance, ...overrides }
  }
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
  readonly openedBegins = new Set<string>()
  failCompleteWork = false
  failBeginWorkBeforeCommit = false
  failRecoveryBegin = false
  failResumeFeedback = false
  failTerminateWork = false
  loseFirstBeginResponse = false
  loseFirstMethodCreateResponse = false
  failMethodCreateBeforeCommit = false
  failBeginMethodGenerationLabel: string | null = null
  failRecordMethodGenerationLabel: string | null = null
  loseMethodGenerationResponseLabel: string | null = null
  methodCreateResponseGate: Promise<void> | null = null
  methodGenerationRecordResponseGate: { readonly label: string; readonly promise: Promise<void> } | null = null
  uniqueBeginOpenCount = 0
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
  private methodCandidateId: string | null = null
  private methodCandidateObservationId: string | null = null
  private methodCandidateGuidance: string | null = null
  private methodEvaluationPlan: Record<string, unknown> | null = null
  private methodBuilderIntentId: string | null = null
  private readonly completedMethodGenerations = new Set<string>()
  private readonly methodGenerationIntents = new Set<string>()
  private methodEpochProfileSha256 = 'a'.repeat(64)

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

  primeMethodObservation(profileSha256 = 'a'.repeat(64)): void {
    this.methodEpochProfileSha256 = profileSha256
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

  primeMethodCandidate(value: Record<string, unknown>): void {
    const resumable = value.status === 'CANDIDATE'
    this.methodCandidates = [{
      observation_id: 'app-feedback-synthetic',
      preparation_completed: resumable ? 0 : 4,
      preparation_total: 4,
      preparation_resumable: resumable,
      preparation_blocked_reason: null,
      preparation_failure_kind: null,
      ...value,
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
        {
          if (this.methodCandidateId === null && this.methodBuilderIntentId !== null) {
            throw new Error('Candidate Builder 可能已调用；为避免重复付费，请放弃本次准备')
          }
          const unresolvedGeneration = [...this.methodGenerationIntents]
            .find(label => !this.completedMethodGenerations.has(label))
          if (this.methodCandidateId !== null && unresolvedGeneration !== undefined) {
            throw new Error(`${unresolvedGeneration} 可能已在付费后中断；为避免重复付费，请放弃`)
          }
          const candidateId = this.methodCandidateId ?? String(payload.candidate_id)
          const builderRequired = this.methodCandidateId === null
          const methodEpoch = syntheticMethodEpoch(this.methodEpochProfileSha256)
          result = {
            candidate_id: candidateId,
            observation_id: this.methodCandidateObservationId ?? payload.observation_id,
            finding_code: 'APP-FEEDBACK-SYNTHETIC',
            feedback: '减少解释，让人物用动作推进情节。',
            initial_intent: this.initialIntent,
            current_method_version: this.activeMethodVersion,
            current_guidance: this.activeGuidance,
            builder_context_sha256: 'b'.repeat(64),
            heldout_included: false,
            method_epoch: methodEpoch,
            method_epoch_sha256: sha256CanonicalJson(methodEpoch),
            builder_required: builderRequired,
            guidance: builderRequired ? null : this.methodCandidateGuidance,
            evaluation_plan: builderRequired ? null : this.methodEvaluationPlan,
            completed_generation_labels: [...this.completedMethodGenerations],
            generation_total: 4,
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
        }
        break
      case 'begin_method_candidate_preparation':
        if (this.methodBuilderIntentId !== null
          && this.methodBuilderIntentId !== String(payload.candidate_id)) {
          throw new Error('synthetic competing builder intent')
        }
        {
          const idempotent = this.methodBuilderIntentId === String(payload.candidate_id)
          this.methodBuilderIntentId = String(payload.candidate_id)
          if (this.methodCandidateId === null) {
            this.methodCandidates = [{
              id: payload.candidate_id,
              observation_id: payload.observation_id,
              title: '未完成的新方式准备',
              summary: '此次准备未封存可用的创作指导。',
              tradeoff: '未改变当前方法，也未保存模型生成正文。',
              status: 'CANDIDATE',
              ready: false,
              adoption_pending: false,
              rolled_back: false,
              preparation_completed: 0,
              preparation_total: 4,
              preparation_resumable: false,
              preparation_blocked_reason: 'Candidate Builder 正在调用或已在付费后中断。',
              preparation_failure_kind: 'BUILDER_RESULT_UNKNOWN',
              comparisons: [],
            }]
          }
          result = {
            candidate_id: payload.candidate_id,
            observation_id: payload.observation_id,
            builder_context_sha256: payload.builder_context_sha256,
            expected_epoch_sha256: payload.expected_epoch_sha256,
            intent_sha256: '5'.repeat(64),
            idempotent,
          }
        }
        break
      case 'create_method_candidate':
        {
        if (this.failMethodCreateBeforeCommit) {
          throw new Error('synthetic method create unavailable before commit')
        }
        if (this.methodBuilderIntentId !== String(payload.candidate_id)) {
          throw new Error('synthetic missing builder intent')
        }
        const idempotent = this.methodCandidateId === String(payload.candidate_id)
        this.methodCandidateId = String(payload.candidate_id)
        this.methodCandidateObservationId = String(payload.observation_id)
        this.methodCandidateGuidance = String(payload.guidance)
        this.methodEvaluationPlan = {
          targeted: { task: '目标任务', baseline_output: '目标基线', candidate_context_sha256: 'c'.repeat(64) },
          regression: { task: '回归任务', baseline_output: '回归基线', candidate_context_sha256: 'd'.repeat(64) },
          heldout: {
            task: '全新留出任务',
            baseline_context_sha256: 'e'.repeat(64),
            candidate_context_sha256: 'f'.repeat(64),
          },
        }
        this.methodCandidates = [{
          id: payload.candidate_id,
          observation_id: payload.observation_id,
          title: '针对重复反馈的新方式',
          summary: payload.guidance,
          tradeoff: '只改变后续作品的创作指导，不改写既有作品。',
          status: 'CANDIDATE',
          ready: false,
          adoption_pending: false,
          rolled_back: false,
          preparation_completed: 0,
          preparation_total: 4,
          preparation_resumable: true,
          preparation_blocked_reason: null,
          preparation_failure_kind: null,
          comparisons: [],
        }]
        result = {
          candidate_id: payload.candidate_id,
          observation_id: payload.observation_id,
          lifecycle: 'CANDIDATE',
          guidance: payload.guidance,
          guidance_sha256: createHash('sha256').update(String(payload.guidance), 'utf8').digest('hex'),
          builder_context_sha256: (payload.builder_provenance as Record<string, unknown>).context_sha256,
          builder_provenance_sha256: '7'.repeat(64),
          proposal_sha256: '8'.repeat(64),
          source_epoch_sha256: sha256CanonicalJson(syntheticMethodEpoch(this.methodEpochProfileSha256)),
          evaluation_plan: this.methodEvaluationPlan,
          completed_generation_labels: [],
          generation_total: 4,
          idempotent,
        }
        if (this.methodCreateResponseGate !== null) await this.methodCreateResponseGate
        if (this.loseFirstMethodCreateResponse) {
          this.loseFirstMethodCreateResponse = false
          throw new Error('synthetic method create response lost after commit')
        }
        break
        }
      case 'begin_method_generation':
        if (payload.candidate_id !== this.methodCandidateId) {
          throw new Error('synthetic generation intent candidate mismatch')
        }
        {
          const label = String(payload.label)
          if (this.failBeginMethodGenerationLabel === label) {
            throw new Error('synthetic generation intent unavailable before commit')
          }
          const idempotent = this.methodGenerationIntents.has(label)
          if (this.completedMethodGenerations.has(label)) {
            throw new Error('synthetic generation already completed')
          }
          this.methodGenerationIntents.add(label)
          result = {
            candidate_id: payload.candidate_id,
            label: payload.label,
            context_sha256: payload.context_sha256,
            expected_epoch_sha256: payload.expected_epoch_sha256,
            intent_sha256: '4'.repeat(64),
            idempotent,
          }
          this.methodCandidates = this.methodCandidates.map(candidate => ({
            ...candidate,
            preparation_resumable: false,
            preparation_blocked_reason: `${label} 正在调用或已在付费后中断。`,
            preparation_failure_kind: 'GENERATION_RESULT_UNKNOWN',
          }))
        }
        break
      case 'record_method_generation':
        if (payload.candidate_id !== this.methodCandidateId
          || !['targeted_candidate', 'regression_candidate', 'heldout_baseline', 'heldout_candidate']
            .includes(String(payload.label))) {
          throw new Error('synthetic invalid method generation')
        }
        if (!this.methodGenerationIntents.has(String(payload.label))) {
          throw new Error('synthetic missing generation intent')
        }
        if (this.failRecordMethodGenerationLabel === String(payload.label)) {
          this.failRecordMethodGenerationLabel = null
          throw new Error('synthetic generation record unavailable after paid output')
        }
        this.completedMethodGenerations.add(String(payload.label))
        this.methodCandidates = this.methodCandidates.map(candidate => ({
          ...candidate,
          preparation_completed: this.completedMethodGenerations.size,
          preparation_resumable: true,
          preparation_blocked_reason: null,
          preparation_failure_kind: null,
        }))
        result = {
          candidate_id: payload.candidate_id,
          label: payload.label,
          completed_generation_labels: [...this.completedMethodGenerations],
          generation_total: 4,
          idempotent: false,
        }
        if (this.methodGenerationRecordResponseGate?.label === String(payload.label)) {
          await this.methodGenerationRecordResponseGate.promise
        }
        if (this.loseMethodGenerationResponseLabel === String(payload.label)) {
          this.loseMethodGenerationResponseLabel = null
          throw new Error('synthetic generation response lost after commit')
        }
        break
      case 'record_method_generation_failure':
        this.methodCandidates = this.methodCandidates.map(candidate => ({
          ...candidate,
          preparation_resumable: false,
          preparation_blocked_reason: syntheticPreparationBlockedReason(String(payload.failure_kind)),
          preparation_failure_kind: payload.failure_kind,
        }))
        result = {
          candidate_id: payload.candidate_id,
          label: payload.label,
          error_code: payload.error_code,
          failure_kind: payload.failure_kind,
          failure_marker_sha256: '6'.repeat(64),
        }
        break
      case 'record_method_builder_failure':
        if (this.methodBuilderIntentId !== String(payload.candidate_id)) {
          throw new Error('synthetic missing builder intent for failure')
        }
        this.methodCandidates = [{
          id: payload.candidate_id,
          observation_id: payload.observation_id,
          title: '未完成的新方式准备',
          summary: '此次准备未封存可用的创作指导。',
          tradeoff: '未改变当前方法，也未保存模型生成正文。',
          status: 'CANDIDATE',
          ready: false,
          adoption_pending: false,
          rolled_back: false,
          preparation_completed: 0,
          preparation_total: 4,
          preparation_resumable: false,
          preparation_blocked_reason: syntheticPreparationBlockedReason(String(payload.failure_kind)),
          preparation_failure_kind: payload.failure_kind,
          comparisons: [],
        }]
        result = {
          candidate_id: payload.candidate_id,
          observation_id: payload.observation_id,
          error_code: payload.error_code,
          failure_kind: payload.failure_kind,
          failure_marker_sha256: '3'.repeat(64),
          idempotent: false,
        }
        break
      case 'stage_method_comparisons':
        if (payload.candidate_id !== this.methodCandidateId
          || this.completedMethodGenerations.size !== 4
          || Object.hasOwn(payload, 'generations')) {
          throw new Error('synthetic incomplete method preparation')
        }
        this.methodCandidates = this.methodCandidates.map(candidate => ({
          ...candidate,
          status: 'EVALUATING',
          adoption_pending: false,
          rolled_back: false,
          preparation_completed: 4,
          preparation_total: 4,
          preparation_resumable: false,
          preparation_blocked_reason: null,
          preparation_failure_kind: null,
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
        this.methodCandidates = this.methodCandidates.map(item => ({
          ...item, status: 'PROMOTED', ready: false, adoption_pending: false, rolled_back: false,
        }))
        result = { snapshot: this.snapshot() }
        break
      }
      case 'reject_method_candidate':
        this.methodCandidates = this.methodCandidates.map(item => ({
          ...item,
          status: 'REJECTED',
          ready: false,
          preparation_resumable: false,
          preparation_blocked_reason: null,
          preparation_failure_kind: null,
        }))
        this.methodCandidateId = null
        this.methodCandidateObservationId = null
        this.methodCandidateGuidance = null
        this.methodEvaluationPlan = null
        this.methodBuilderIntentId = null
        this.completedMethodGenerations.clear()
        this.methodGenerationIntents.clear()
        result = { snapshot: this.snapshot() }
        break
      case 'rollback_method':
        this.methodHistory.push({
          action: 'ROLLBACK', version: payload.to_version, previous_version: this.activeMethodVersion, created_at: '2026-08-15T01:40:00.000Z',
        })
        this.activeMethodVersion = String(payload.to_version)
        this.activeGuidance = this.activeMethodVersion === 'baseline-v1' ? null : this.activeGuidance
        this.methodCandidates = this.methodCandidates.map(item => ({
          ...item,
          adoption_pending: false,
          rolled_back: item.status === 'PROMOTED' && item.id !== this.activeMethodVersion,
        }))
        result = { snapshot: this.snapshot() }
        break
      case 'begin_work':
        if (this.failBeginWorkBeforeCommit) throw new Error('synthetic begin unavailable before commit')
        if (payload.recovery_of !== undefined && this.failRecoveryBegin) {
          throw new Error('synthetic recovery rejected')
        }
        {
          const identity = JSON.stringify([
            payload.run_id, payload.work_id, payload.dispatch_id, payload.context_id,
          ])
          if (!this.openedBegins.has(identity)) {
            this.openedBegins.add(identity)
            this.uniqueBeginOpenCount += 1
          }
        }
        if (this.loseFirstBeginResponse) {
          this.loseFirstBeginResponse = false
          throw new Error('synthetic begin response lost after commit')
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
      case 'terminate_work': {
        if (this.failTerminateWork) throw new Error('synthetic termination failure')
        const begin = [...this.requests].reverse().find(item => item.operation === 'begin_work'
          && item.payload.run_id === payload.run_id)
        const outcome = String(payload.outcome)
        const terminalReceipt = `creative-system/runs/${String(payload.run_id)}/attempts/attempt-001/.terminated.json`
        this.interruptedRun = {
          run_id: payload.run_id,
          work_id: begin?.payload.work_id ?? 'work-unknown',
          attempt_id: 'attempt-001',
          dispatch_id: payload.dispatch_id,
          state: `TERMINATED_${outcome}`,
          reason_code: outcome === 'FAILED' ? payload.error_code : payload.reason,
          outcome,
          execution_status: 'BLOCK',
          termination_class: 'ZERO_FILE_RUNTIME_FAILURE',
          terminal_receipt: terminalReceipt,
          terminal_receipt_sha256: 'b'.repeat(64),
          content_attempt_consumed: false,
          finding_eligible: false,
        }
        result = {
          run_id: payload.run_id,
          attempt_id: 'attempt-001',
          dispatch_id: payload.dispatch_id,
          outcome,
          execution_status: 'BLOCK',
          terminal_receipt: terminalReceipt,
          terminal_receipt_sha256: 'b'.repeat(64),
          content_attempt_consumed: false,
          finding_eligible: false,
          idempotent: false,
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

function syntheticMethodEpoch(profileSha256: string): Record<string, unknown> {
  return {
    method_version: 'baseline-v1',
    requested_model: 'deepseek-v4-pro',
    returned_model: 'deepseek-v4-pro',
    system_fingerprint: 'fingerprint-one',
    profile_sha256: profileSha256,
    parameters: {
      thinking: 'enabled',
      reasoning_effort: 'high',
      max_tokens: 32_768,
    },
  }
}

function syntheticPreparationBlockedReason(failureKind: string): string {
  if (failureKind === 'RUNTIME_FAILED') {
    return '候选生成已明确失败；已封存进度仍保留，本次准备只能放弃。'
  }
  if (failureKind === 'OUTPUT_TRUNCATED') {
    return '候选生成达到输出上限；截断内容不会进入比较，本次准备只能放弃。'
  }
  if (failureKind === 'EMPTY_OUTPUT') {
    return '候选生成已结束但没有可比较内容；本次准备只能放弃。'
  }
  if (failureKind === 'METHOD_EPOCH_CHANGED') {
    return '固定生成基线已变化；为避免混用不同基线，本次准备只能放弃。'
  }
  return '模型来源无法形成唯一可验基线；为避免重复调用，本次准备只能放弃。'
}

function sha256CanonicalJson(value: Record<string, unknown>): string {
  const sorted = Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, item !== null && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right)))
      : item]))
  return createHash('sha256').update(`${JSON.stringify(sorted)}\n`, 'utf8').digest('hex')
}
