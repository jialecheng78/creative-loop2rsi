import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import {
  ControllerBridge,
  type ControllerRequest,
} from '@creative-loop2rsi/controller-bridge'
import {
  type DshModelId,
  type DshRuntimeLaunchSpec,
  type RuntimeRole,
  type RuntimeRunHandle,
  type RuntimeStatus,
} from '@creative-loop2rsi/runtime-dsh'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { LoopbackGatewayLease, LoopbackLeaseProvenance } from '../src/main/loopback-gateway.js'
import type { DesktopSettings } from '../src/main/settings-store.js'
import {
  StudioService,
  type ControllerPort,
  type ControllerRequestLike,
  type CredentialStorePort,
  type LoopbackGatewayPort,
  type RuntimePort,
  type SettingsStorePort,
} from '../src/main/studio-service.js'

const PYTHON_ROOT = fileURLToPath(new URL('../../../python/', import.meta.url))
const PROFILE_SHA256 = 'a'.repeat(64)
const SYSTEM_FINGERPRINT = 'integration-fingerprint-v1'
const REPEATED_FEEDBACK = '减少解释，让人物用可见动作、选择和后果推进情节。'
const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(temporaryDirectories.splice(0).map(async path => {
    await rm(path, { recursive: true, force: true })
  }))
})

describe('StudioService + ControllerBridge + Python Controller integration', () => {
  it('persists the minimum method loop across restarts and restores baseline after rollback', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('network is forbidden in this contract integration test')
    })
    vi.stubGlobal('fetch', fetchSpy)

    const fixture = await createFixture()
    const firstService = fixture.makeService()
    let snapshot = await firstService.createSystem({
      intent: '写克制的近未来悬疑短篇',
      displayName: '合成悬疑创作系统',
    })

    for (const [index, task] of [
      '独立作品一：门外出现无法解释的脚步声',
      '独立作品二：停电后有人试图进入档案室',
      '独立作品三：末班车上只剩一名陌生乘客',
    ].entries()) {
      const run = await completeWork(
        firstService,
        fixture.runtime,
        task,
        `旁白解释主人公为什么害怕，又说明危险即将发生（合成作品 ${index + 1}）。`,
      )
      const feedback = await firstService.submitFeedback({
        runId: run.runId,
        action: 'rewrite',
        feedbackText: REPEATED_FEEDBACK,
      })
      snapshot = feedback.snapshot
      expect(snapshot.lastWork).toMatchObject({ runId: run.runId, sealed: true })
      expect(snapshot.observations).toHaveLength(1)
      expect(snapshot.observations[0]).toMatchObject({
        feedback: REPEATED_FEEDBACK,
        independentWorks: index + 1,
        independentRuns: index + 1,
        independentTasks: index + 1,
        readyForCandidate: index === 2,
      })
    }

    const rawFeedbackSnapshot = responseSnapshot(lastTrace(fixture.traces, 'submit_feedback'))
    const rawObservations = record(rawFeedbackSnapshot.learning).observations
    expect(Array.isArray(rawObservations)).toBe(true)
    expect(rawObservations).toHaveLength(1)
    const rawObservation = record((rawObservations as unknown[])[0])
    expect(rawObservation.epoch_sha256).toMatch(/^[0-9a-f]{64}$/u)
    expect(rawObservation.epoch).toEqual({
      method_version: 'baseline-v1',
      requested_model: 'deepseek-v4-flash',
      returned_model: 'deepseek-v4-flash',
      system_fingerprint: SYSTEM_FINGERPRINT,
      profile_sha256: PROFILE_SHA256,
      parameters: {
        thinking: 'enabled',
        reasoning_effort: 'high',
        max_tokens: 32_768,
      },
    })

    const observation = snapshot.observations[0]
    expect(observation).toBeDefined()
    const handleOffset = fixture.runtime.handles.length
    const preparing = firstService.prepareMethodCandidate(observation!.id)
    for (const [index, output] of [
      '优先用人物可见的动作、选择与后果推进情节；只有动作无法承载必要因果时才保留一句解释。',
      '她关灯，压住门把；门外脚步停住，手机屏幕亮起红色警报。',
      '他把钥匙塞进排水口，转身挡住追来的人；走廊尽头的门随即落锁。',
      '旁白解释她为什么紧张，并说明危险正在逐步靠近。',
      '她剪断电梯线，沿检修梯下坠一层；上方的手电光立刻追了下来。',
    ].entries()) {
      await vi.waitFor(
        () => expect(fixture.runtime.handles.length).toBe(handleOffset + index + 1),
        { timeout: 10_000 },
      )
      const runtimeHandle = fixture.runtime.handles[handleOffset + index]
      expect(runtimeHandle).toBeDefined()
      await firstService.acceptRuntimeEvent({
        type: 'output', runId: runtimeHandle!.runId, text: output,
      })
      await firstService.acceptRuntimeEvent({
        type: 'state', runId: runtimeHandle!.runId, state: 'completed',
      })
    }
    snapshot = await preparing

    expect(snapshot.methodCandidates).toHaveLength(1)
    expect(snapshot.methodCandidates[0]).toMatchObject({
      status: 'EVALUATING',
      ready: false,
      adoptionPending: false,
      rolledBack: false,
    })
    expect(snapshot.methodCandidates[0]?.comparisons.map(item => item.phase)).toEqual([
      'targeted', 'regression', 'heldout',
    ])
    const candidateId = snapshot.methodCandidates[0]!.id

    // This fixture chooses from the public A/B text only. It verifies contract
    // wiring and gates; it is intentionally not an independent quality blind-eval.
    for (const comparison of snapshot.methodCandidates[0]!.comparisons) {
      snapshot = await firstService.submitMethodComparison({
        candidateId,
        phase: comparison.phase,
        choice: fixtureChoice(comparison.left, comparison.right),
      })
    }
    expect(snapshot.methodCandidates[0]).toMatchObject({
      status: 'READY_FOR_HUMAN', ready: true,
    })

    snapshot = await firstService.adoptMethodCandidate(candidateId)
    expect(snapshot.method).toMatchObject({
      activeVersion: candidateId,
      activeGuidance: expect.stringContaining('可见的动作'),
    })
    expect(snapshot.methodCandidates[0]).toMatchObject({
      status: 'PROMOTED', adoptionPending: false, rolledBack: false,
    })
    const rawPromotionHistory = array(record(
      responseSnapshot(lastTrace(fixture.traces, 'adopt_method_candidate')).method,
    ).history)
    expect(rawPromotionHistory).toHaveLength(1)
    expect(record(rawPromotionHistory[0])).toMatchObject({
      action: 'PROMOTE',
      version: candidateId,
      previous_version: 'baseline-v1',
      receipt: expect.stringMatching(/^creative-system\/app-methods\/promotions\//u),
      receipt_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      guidance_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    })

    const fourth = await completeWork(
      firstService,
      fixture.runtime,
      '独立作品四：采用新方式后验证方法绑定',
      '她把门卡留在警报器上，转身拉下防火闸；追赶者被红灯截在另一侧。',
    )
    const kept = await firstService.submitFeedback({ runId: fourth.runId, action: 'keep' })
    const fourthSnapshot = kept.snapshot.lastWork
    expect(fourthSnapshot).toMatchObject({
      runId: fourth.runId,
      sealed: true,
      methodVersion: candidateId,
    })
    expect(fourthSnapshot?.methodGuidanceSha256).toMatch(/^[0-9a-f]{64}$/u)
    const adoptedGuidanceSha256 = fourthSnapshot!.methodGuidanceSha256
    expect(kept.snapshot.observations).toHaveLength(1)
    expect(kept.snapshot.observations[0]?.independentWorks).toBe(3)

    await firstService.shutdown()
    const secondService = fixture.makeService()
    const restartedAfterAdoption = await secondService.getStatus()
    expect(restartedAfterAdoption.activeSystem?.lastWork).toMatchObject({
      runId: fourth.runId,
      sealed: true,
      methodVersion: candidateId,
      methodGuidanceSha256: adoptedGuidanceSha256,
    })
    expect(restartedAfterAdoption.activeSystem?.method.activeVersion).toBe(candidateId)

    snapshot = await secondService.rollbackMethod('baseline-v1')
    expect(snapshot.method.activeVersion).toBe('baseline-v1')
    expect(snapshot.method.history.map(item => item.action)).toEqual(['PROMOTE', 'ROLLBACK'])
    expect(snapshot.methodCandidates[0]).toMatchObject({
      status: 'PROMOTED', adoptionPending: false, rolledBack: true,
    })
    const rawRollbackHistory = array(record(
      responseSnapshot(lastTrace(fixture.traces, 'rollback_method')).method,
    ).history)
    expect(rawRollbackHistory).toHaveLength(2)
    expect(record(rawRollbackHistory[1])).toMatchObject({
      action: 'ROLLBACK',
      version: 'baseline-v1',
      previous_version: candidateId,
      receipt: expect.stringMatching(/^creative-system\/app-methods\/rollbacks\//u),
      receipt_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    })

    await secondService.shutdown()
    const thirdService = fixture.makeService()
    const restartedAfterRollback = await thirdService.getStatus()
    expect(restartedAfterRollback.activeSystem?.method).toMatchObject({
      activeVersion: 'baseline-v1', activeGuidance: null,
    })

    const fifth = await thirdService.startWork('回滚后只验证基线方法上下文')
    const productionContext = record(lastTrace(fixture.traces, 'production_context').response)
    expect(productionContext).toMatchObject({
      method_version: 'baseline-v1', guidance: null, guidance_sha256: null,
    })
    expect(productionContext.context_sha256).toMatch(/^[0-9a-f]{64}$/u)
    await thirdService.cancelWork(fifth.runId)
    const afterCancellation = await thirdService.getStatus()
    expect(afterCancellation.activeSystem?.interruptedRun).toMatchObject({
      runId: fifth.runId,
      outcome: 'CANCELLED',
      findingEligible: false,
    })
    expect(afterCancellation.activeSystem?.observations).toHaveLength(1)
    await thirdService.shutdown()

    expect(operationCount(fixture.traces, 'bootstrap_intent')).toBe(1)
    expect(operationCount(fixture.traces, 'begin_work')).toBe(5)
    expect(operationCount(fixture.traces, 'complete_work')).toBe(4)
    expect(operationCount(fixture.traces, 'submit_feedback')).toBe(4)
    expect(operationCount(fixture.traces, 'method_candidate_context')).toBe(1)
    expect(operationCount(fixture.traces, 'create_method_candidate')).toBe(1)
    expect(operationCount(fixture.traces, 'stage_method_comparisons')).toBe(1)
    expect(operationCount(fixture.traces, 'submit_method_comparison')).toBe(3)
    expect(operationCount(fixture.traces, 'adopt_method_candidate')).toBe(1)
    expect(operationCount(fixture.traces, 'rollback_method')).toBe(1)
    expect(operationCount(fixture.traces, 'terminate_work')).toBe(1)
    expect(new Set(fixture.traces.map(item => item.bridgeGeneration))).toEqual(new Set([1, 2, 3]))
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(fixture.credentials.readAttempts).toBe(0)
  }, 60_000)

  it('persists an epoch mismatch marker and blocks restart before another model call', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('network is forbidden in this contract integration test')
    })
    vi.stubGlobal('fetch', fetchSpy)
    const fixture = await createFixture()
    const firstService = fixture.makeService()
    let snapshot = await firstService.createSystem({
      intent: '写克制的近未来悬疑短篇',
      displayName: '漂移恢复合成系统',
    })
    for (const [index, task] of [
      '漂移证据作品一',
      '漂移证据作品二',
      '漂移证据作品三',
    ].entries()) {
      const run = await completeWork(
        firstService,
        fixture.runtime,
        task,
        `旁白解释危险与人物决定（漂移证据 ${index + 1}）。`,
      )
      const feedback = await firstService.submitFeedback({
        runId: run.runId,
        action: 'rewrite',
        feedbackText: REPEATED_FEEDBACK,
      })
      snapshot = feedback.snapshot
    }
    const observation = snapshot.observations[0]
    expect(observation?.readyForCandidate).toBe(true)

    const preparing = firstService.prepareMethodCandidate(observation!.id)
    await vi.waitFor(() => expect(fixture.runtime.handles).toHaveLength(4))
    const builder = fixture.runtime.handles[3]!
    // Builder still belongs to the source epoch. Only the next paid generation
    // observes the drift, which must become a durable non-content marker.
    fixture.loopback.systemFingerprint = 'integration-fingerprint-v2'
    await firstService.acceptRuntimeEvent({
      type: 'output', runId: builder.runId, text: '用可见动作和后果推进情节。',
    })
    await firstService.acceptRuntimeEvent({
      type: 'state', runId: builder.runId, state: 'completed',
    })
    await vi.waitFor(() => expect(fixture.runtime.handles).toHaveLength(5))
    const mismatchedGeneration = fixture.runtime.handles[4]!
    const firstFailure = expect(preparing).rejects.toMatchObject({ code: 'METHOD_EPOCH_CHANGED' })
    await firstService.acceptRuntimeEvent({
      type: 'output', runId: mismatchedGeneration.runId, text: '这段付费正文不得进入 failure marker。',
    })
    await firstService.acceptRuntimeEvent({
      type: 'state', runId: mismatchedGeneration.runId, state: 'completed',
    })
    await firstFailure

    const blocked = await firstService.getStatus()
    const candidate = blocked.activeSystem?.methodCandidates[0]
    expect(candidate).toMatchObject({
      status: 'CANDIDATE',
      resumable: false,
      completedGenerationCount: 0,
      preparationFailureKind: 'METHOD_EPOCH_CHANGED',
    })
    expect(candidate?.preparationBlockedReason).toContain('固定生成基线已变化')
    const handlesBeforeRestart = fixture.runtime.handles.length
    await firstService.shutdown()

    const restartedService = fixture.makeService()
    await expect(restartedService.prepareMethodCandidate(observation!.id)).rejects.toMatchObject({
      code: 'CONTROLLER_BLOCK',
    })
    expect(fixture.runtime.handles).toHaveLength(handlesBeforeRestart)
    expect(operationCount(fixture.traces, 'method_candidate_context')).toBe(2)
    expect(operationCount(fixture.traces, 'record_method_generation')).toBe(0)
    expect(operationCount(fixture.traces, 'record_method_generation_failure')).toBe(1)

    const rejected = await restartedService.rejectMethodCandidate(candidate!.id)
    expect(rejected.methodCandidates[0]).toMatchObject({
      status: 'REJECTED', resumable: false,
    })
    await restartedService.shutdown()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(fixture.credentials.readAttempts).toBe(0)
  }, 60_000)

  it('persists a Builder epoch mismatch and restarts without rebilling Builder', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('network is forbidden in this contract integration test')
    })
    vi.stubGlobal('fetch', fetchSpy)
    const fixture = await createFixture()
    const firstService = fixture.makeService()
    let snapshot = await firstService.createSystem({
      intent: '写克制的近未来悬疑短篇',
      displayName: 'Builder 漂移恢复合成系统',
    })
    for (const [index, task] of [
      'Builder 漂移证据作品一',
      'Builder 漂移证据作品二',
      'Builder 漂移证据作品三',
    ].entries()) {
      const run = await completeWork(
        firstService,
        fixture.runtime,
        task,
        `旁白解释危险与人物决定（Builder 漂移证据 ${index + 1}）。`,
      )
      const feedback = await firstService.submitFeedback({
        runId: run.runId,
        action: 'rewrite',
        feedbackText: REPEATED_FEEDBACK,
      })
      snapshot = feedback.snapshot
    }
    const observation = snapshot.observations[0]
    expect(observation?.readyForCandidate).toBe(true)

    fixture.loopback.systemFingerprint = 'integration-builder-fingerprint-v2'
    const preparing = firstService.prepareMethodCandidate(observation!.id)
    const firstFailure = expect(preparing).rejects.toMatchObject({ code: 'METHOD_EPOCH_CHANGED' })
    await vi.waitFor(() => expect(fixture.runtime.handles).toHaveLength(4))
    const builder = fixture.runtime.handles[3]!
    await firstService.acceptRuntimeEvent({
      type: 'output', runId: builder.runId, text: '这段已付费 Builder 指导不得进入 failure marker。',
    })
    await firstService.acceptRuntimeEvent({
      type: 'state', runId: builder.runId, state: 'completed',
    })
    await firstFailure

    const blocked = await firstService.getStatus()
    const candidate = blocked.activeSystem?.methodCandidates[0]
    expect(candidate).toMatchObject({
      status: 'CANDIDATE',
      resumable: false,
      completedGenerationCount: 0,
      preparationFailureKind: 'METHOD_EPOCH_CHANGED',
    })
    expect(operationCount(fixture.traces, 'record_method_builder_failure')).toBe(1)
    const handlesBeforeRestart = fixture.runtime.handles.length
    await firstService.shutdown()

    const restartedService = fixture.makeService()
    await expect(restartedService.prepareMethodCandidate(observation!.id)).rejects.toMatchObject({
      code: 'CONTROLLER_BLOCK',
    })
    expect(fixture.runtime.handles).toHaveLength(handlesBeforeRestart)
    const rejected = await restartedService.rejectMethodCandidate(candidate!.id)
    expect(rejected.methodCandidates[0]).toMatchObject({
      status: 'REJECTED', resumable: false,
    })
    await restartedService.shutdown()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(fixture.credentials.readAttempts).toBe(0)
  }, 60_000)
})

interface Fixture {
  readonly credentials: SyntheticCredentials
  readonly loopback: SyntheticLoopback
  readonly runtime: SyntheticRuntime
  readonly traces: ControllerTrace[]
  makeService(): StudioService
}

async function createFixture(): Promise<Fixture> {
  const userDataPath = await mkdtemp(join(tmpdir(), 'creative-rsi-controller-integration-'))
  temporaryDirectories.push(userDataPath)
  const pythonExecutable = resolvePythonExecutable()
  const credentials = new SyntheticCredentials()
  const settings = new SyntheticSettings()
  const runtime = new SyntheticRuntime()
  const loopback = new SyntheticLoopback()
  const traces: ControllerTrace[] = []
  let id = 0
  let bridgeGeneration = 0

  return {
    credentials,
    loopback,
    runtime,
    traces,
    makeService: () => {
      bridgeGeneration += 1
      const controller = new TracedController(
        bridgeGeneration,
        new ControllerBridge({
          file: pythonExecutable,
          fixedArguments: ['-B', '-m', 'creative_loop2rsi'],
          cwd: PYTHON_ROOT,
        }, {
          timeoutMs: 30_000,
          maxRequestBytes: 2 * 1024 * 1024,
          maxOutputBytes: 4 * 1024 * 1024,
        }),
        traces,
      )
      return new StudioService({
        appVersion: '1.0.0-alpha.1-integration',
        userDataPath,
        nodeExecutable: process.execPath,
        controller,
        credentials,
        settings,
        runtime,
        loopback,
        emit: () => undefined,
        now: () => new Date().toISOString(),
        idFactory: () => `integration-${String(++id).padStart(6, '0')}`,
        credentialValidator: async () => {
          throw new Error('credential validation must not run in this fixture')
        },
        profileDigest: async () => PROFILE_SHA256,
        runtimeSpecFactory: input => ({
          command: input.nodeExecutable,
          args: ['/synthetic/runtime-entry', '/synthetic/profile.yml'],
          cwd: input.cwd,
          workspaceDir: input.workspaceDir,
          dshHome: input.dshHome,
          sessionRoot: input.sessionRoot,
          role: input.role,
          model: input.model,
          gateway: input.gateway,
          maxTokens: input.maxTokens,
        }),
      })
    },
  }
}

interface ControllerTrace {
  readonly bridgeGeneration: number
  readonly request: ControllerRequestLike
  readonly response: unknown
}

class TracedController implements ControllerPort {
  constructor(
    private readonly bridgeGeneration: number,
    private readonly bridge: ControllerBridge,
    private readonly traces: ControllerTrace[],
  ) {}

  async invoke(request: ControllerRequestLike): Promise<{ readonly exitCode: number; readonly payload: unknown }> {
    const invocation = await this.bridge.invoke(request as unknown as ControllerRequest)
    this.traces.push({
      bridgeGeneration: this.bridgeGeneration,
      request,
      response: invocation.payload,
    })
    return { exitCode: invocation.exitCode, payload: invocation.payload }
  }
}

class SyntheticCredentials implements CredentialStorePort {
  readAttempts = 0

  async status(): Promise<{
    secureStorageAvailable: boolean
    configured: boolean
    persistence: 'protected'
  }> {
    return { secureStorageAvailable: true, configured: true, persistence: 'protected' }
  }
  async set(): Promise<void> {}
  clearSession(): void {}
  async get(): Promise<string | null> {
    this.readAttempts += 1
    throw new Error('synthetic integration must not read a credential')
  }
  async delete(): Promise<void> {}
}

class SyntheticSettings implements SettingsStorePort {
  private value: DesktopSettings = {
    selectedModel: 'deepseek-v4-flash',
    activeSystemId: null,
    learningPaused: false,
  }

  async load(): Promise<DesktopSettings> { return { ...this.value } }
  async update(patch: unknown): Promise<DesktopSettings> {
    this.value = { ...this.value, ...(patch as Partial<DesktopSettings>) }
    return await this.load()
  }
}

class SyntheticRuntime implements RuntimePort {
  readonly handles: RuntimeRunHandle[] = []
  readonly inputs: string[] = []
  readonly specs: DshRuntimeLaunchSpec[] = []
  private currentStatus: RuntimeStatus = { state: 'unconfigured' }

  configure(spec: DshRuntimeLaunchSpec): void {
    this.specs.push(spec)
    this.currentStatus = { state: 'ready', role: spec.role, model: spec.model }
  }

  status(): RuntimeStatus { return this.currentStatus }

  async startRun(input: string): Promise<RuntimeRunHandle> {
    const sequence = this.handles.length + 1
    const handle = {
      runId: `synthetic-runtime-${sequence}`,
      sessionId: `synthetic-session-${sequence}`,
    }
    this.inputs.push(input)
    this.handles.push(handle)
    const spec = this.specs.at(-1)
    this.currentStatus = {
      state: 'running',
      activeRunId: handle.runId,
      ...(spec === undefined ? {} : { role: spec.role, model: spec.model }),
    }
    return handle
  }

  async cancelRun(): Promise<void> { this.currentStatus = { state: 'ready' } }
  async stop(): Promise<void> { this.currentStatus = { state: 'ready' } }
  async clearConfiguration(): Promise<void> { this.currentStatus = { state: 'unconfigured' } }
}

class SyntheticLease implements LoopbackGatewayLease {
  readonly url = 'http://127.0.0.1:9'
  readonly token = 'synthetic-capability-token-000001'

  constructor(
    readonly role: RuntimeRole,
    readonly model: DshModelId,
    private readonly sequence: number,
    private readonly systemFingerprint: string,
  ) {}

  provenance(): LoopbackLeaseProvenance {
    const startedAt = '2026-08-16T00:00:00.000Z'
    const completedAt = '2026-08-16T00:00:01.000Z'
    const responseId = `synthetic-response-${this.sequence}`
    const usage = { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 }
    return {
      requestCount: 1,
      completedRequests: 1,
      failedRequests: 0,
      completedAt,
      requestedModel: this.model,
      responseId,
      returnedModels: [this.model],
      systemFingerprints: [this.systemFingerprint],
      usage,
      requests: [{
        requestNumber: 1,
        startedAt,
        completedAt,
        status: 'COMPLETED',
        responseId,
        returnedModel: this.model,
        systemFingerprint: this.systemFingerprint,
        usage,
      }],
    }
  }

  revoke(): void {}
}

class SyntheticLoopback implements LoopbackGatewayPort {
  private sequence = 0
  systemFingerprint = SYSTEM_FINGERPRINT

  async start(): Promise<void> {}
  issueLease(role: RuntimeRole, model: DshModelId): LoopbackGatewayLease {
    return new SyntheticLease(
      role,
      model,
      ++this.sequence,
      this.systemFingerprint,
    )
  }
  async close(): Promise<void> {}
}

async function completeWork(
  service: StudioService,
  runtime: SyntheticRuntime,
  task: string,
  output: string,
): Promise<RuntimeRunHandle> {
  const offset = runtime.handles.length
  const governedHandle = await service.startWork(task)
  const runtimeHandle = runtime.handles[offset]
  expect(runtimeHandle).toBeDefined()
  await service.acceptRuntimeEvent({ type: 'output', runId: runtimeHandle!.runId, text: output })
  await service.acceptRuntimeEvent({ type: 'state', runId: runtimeHandle!.runId, state: 'completed' })
  return governedHandle
}

function fixtureChoice(left: string, right: string): 'A' | 'B' {
  const score = (text: string): number => {
    const positive = ['动作', '选择', '后果', '关灯', '门把', '钥匙', '挡住', '剪断', '下坠', '门卡', '防火闸']
    const negative = ['旁白解释', '说明危险', '为什么紧张', '为什么害怕']
    return positive.filter(token => text.includes(token)).length
      - negative.filter(token => text.includes(token)).length
  }
  const leftScore = score(left)
  const rightScore = score(right)
  expect(leftScore).not.toBe(rightScore)
  return leftScore > rightScore ? 'A' : 'B'
}

function operationCount(traces: readonly ControllerTrace[], operation: string): number {
  return traces.filter(item => item.request.operation === operation).length
}

function lastTrace(traces: readonly ControllerTrace[], operation: string): ControllerTrace {
  const trace = [...traces].reverse().find(item => item.request.operation === operation)
  expect(trace, `missing Controller trace for ${operation}`).toBeDefined()
  return trace!
}

function responseSnapshot(trace: ControllerTrace): Record<string, unknown> {
  return record(record(trace.response).snapshot)
}

function record(value: unknown): Record<string, unknown> {
  expect(value).not.toBeNull()
  expect(typeof value).toBe('object')
  expect(Array.isArray(value)).toBe(false)
  return value as Record<string, unknown>
}

function array(value: unknown): unknown[] {
  expect(Array.isArray(value)).toBe(true)
  return value as unknown[]
}

function resolvePythonExecutable(): string {
  const candidates = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python']
  const environment = Object.fromEntries([
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR',
  ].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]))
  for (const candidate of candidates) {
    const result = spawnSync(candidate, [
      '-B', '-c', 'import os, sys; print(os.path.realpath(sys.executable))',
    ], {
      encoding: 'utf8',
      env: environment,
      windowsHide: true,
    })
    const executable = result.status === 0 ? result.stdout.trim() : ''
    if (executable !== '') return executable
  }
  throw new Error('Python 3 executable is required for the real ControllerBridge integration test')
}
