import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

import {
  DeepSeekGateway,
  GatewayError,
  type ApiKeyStore,
  type ModelListResponse,
} from '@creative-loop2rsi/model-gateway'
import {
  resolvePublishedRuntime,
  SUPPORTED_DSH_VERSION,
  type DshModelId,
  type DshRuntimeLaunchSpec,
  type RuntimeErrorCode,
  type RuntimeEvent,
  type RuntimeRunHandle,
  type RuntimeStatus,
} from '@creative-loop2rsi/runtime-dsh'

import type {
  CredentialPublicStatus,
  CreateSystemInput,
  ModelChoice,
  StudioEvent,
  StudioStatus,
  SubmitFeedbackInput,
  SubmitFeedbackResult,
  SystemSnapshot,
  WorkRunHandle,
  WorkSnapshot,
} from '../shared/ipc.js'
import type { CredentialStatus, EncryptedCredentialStore } from './credential-store.js'
import type {
  LoopbackGatewayLease,
  LoopbackLeaseProvenance,
  LoopbackModelGateway,
} from './loopback-gateway.js'
import type { RuntimeWorkerManager } from './runtime-worker-manager.js'
import type { DesktopSettings, SettingsStore } from './settings-store.js'

const CONTROLLER_VERSION = '1'
const MAX_MODEL_OUTPUT_TOKENS = 16_384
const SYSTEM_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

type JsonRecord = Readonly<Record<string, unknown>>
type StudioControllerOperation =
  | 'begin_work'
  | 'bootstrap_intent'
  | 'cancel_work'
  | 'complete_work'
  | 'record_feedback'
  | 'resume_feedback'
  | 'seal_feedback'
  | 'submit_feedback'
  | 'system_snapshot'

export interface ControllerRequestLike {
  readonly request_id: string
  readonly operation: StudioControllerOperation
  readonly payload: JsonRecord
}

export interface ControllerPort {
  invoke(request: ControllerRequestLike): Promise<{
    readonly exitCode: number
    readonly payload: unknown
  }>
}

export interface CredentialStorePort extends Pick<EncryptedCredentialStore,
  'delete' | 'get' | 'isAvailable' | 'set' | 'status'> {}

export interface SettingsStorePort extends Pick<SettingsStore, 'load' | 'update'> {}

export interface RuntimePort extends Pick<RuntimeWorkerManager,
  'cancelRun' | 'clearConfiguration' | 'configure' | 'startRun' | 'status' | 'stop'> {}

export interface LoopbackGatewayPort extends Pick<LoopbackModelGateway,
  'close' | 'issueLease' | 'start'> {}

export type RuntimeSpecFactory = (input: {
  readonly nodeExecutable: string
  readonly cwd: string
  readonly workspaceDir: string
  readonly dshHome: string
  readonly sessionRoot: string
  readonly role: 'production'
  readonly model: DshModelId
  readonly gateway: { readonly url: string; readonly token: string }
  readonly maxTokens: number
}) => DshRuntimeLaunchSpec

export interface StudioServiceOptions {
  readonly appVersion: string
  readonly userDataPath: string
  readonly nodeExecutable: string
  readonly controller: ControllerPort
  readonly credentials: CredentialStorePort
  readonly settings: SettingsStorePort
  readonly runtime: RuntimePort
  readonly loopback: LoopbackGatewayPort
  readonly emit: (event: StudioEvent) => void
  readonly now?: () => string
  readonly idFactory?: () => string
  readonly credentialValidator?: (apiKey: string) => Promise<readonly ModelChoice[]>
  readonly runtimeSpecFactory?: RuntimeSpecFactory
  readonly profileDigest?: (spec: DshRuntimeLaunchSpec) => Promise<string>
}

interface StartingWork {
  readonly systemId: string
  readonly controllerRunId: string
  readonly dispatchId: string
  readonly workId: string
  readonly project: string
  readonly model: ModelChoice
  readonly contextSha256: string
  readonly lease: LoopbackGatewayLease
  readonly profileSha256: string
  readonly queuedEvents: RuntimeEvent[]
}

interface ActiveWork extends StartingWork {
  readonly runtimeRunId: string
  readonly runtimeSessionId: string
  output: string | undefined
  runtimeErrorCode: RuntimeErrorCode | undefined
  runtimeError: string | undefined
  cancelRequested: boolean
  cancelReason: string | undefined
  terminalTask: Promise<void> | undefined
}

interface LaunchCompletion {
  readonly promise: Promise<void>
  resolve(): void
}

interface FeedbackRecoveryTask {
  readonly runId: string
  readonly promise: Promise<SystemSnapshot>
}

export class StudioService {
  private readonly systemsRoot: string
  private readonly now: () => string
  private readonly idFactory: () => string
  private readonly credentialValidator: (apiKey: string) => Promise<readonly ModelChoice[]>
  private readonly runtimeSpecFactory: RuntimeSpecFactory
  private readonly profileDigest: (spec: DshRuntimeLaunchSpec) => Promise<string>
  private starting: StartingWork | undefined
  private active: ActiveWork | undefined
  private launchInProgress = false
  private launchCancellationRequested = false
  private launchCompletion: LaunchCompletion | undefined
  private createInProgress = false
  private credentialMutationInProgress = false
  private feedbackRecoveryTask: FeedbackRecoveryTask | undefined
  private eventQueue: Promise<void> = Promise.resolve()

  constructor(private readonly options: StudioServiceOptions) {
    if (!isAbsolute(options.userDataPath) || options.userDataPath.includes('\0')) {
      throw new TypeError('userDataPath 必须是可信绝对路径。')
    }
    if (!isAbsolute(options.nodeExecutable) || options.nodeExecutable.includes('\0')) {
      throw new TypeError('nodeExecutable 必须是可信绝对路径。')
    }
    this.systemsRoot = resolve(options.userDataPath, 'systems')
    this.now = options.now ?? (() => new Date().toISOString())
    this.idFactory = options.idFactory ?? randomUUID
    this.credentialValidator = options.credentialValidator ?? validateOfficialCredential
    this.runtimeSpecFactory = options.runtimeSpecFactory ?? resolvePublishedRuntime
    this.profileDigest = options.profileDigest ?? digestRuntimeProfile
  }

  async getStatus(): Promise<StudioStatus> {
    const [credential, settings, snapshot] = await Promise.all([
      this.credentialStatus(),
      this.options.settings.load(),
      this.systemSnapshot(),
    ])
    let activeSystem = snapshot
    let feedbackRecoveryState: StudioStatus['feedbackRecoveryState'] = 'none'
    if (activeSystem?.feedbackRecoveryRequired === true) {
      try {
        activeSystem = await this.resumePendingFeedback(activeSystem)
        feedbackRecoveryState = 'recovered'
      } catch {
        feedbackRecoveryState = 'retry-required'
      }
    }
    return {
      version: this.options.appVersion,
      credential: credential.configured ? 'configured' : 'not-configured',
      secureStorageAvailable: credential.secureStorageAvailable,
      selectedModel: settings.selectedModel,
      runtime: this.options.runtime.status(),
      activeSystem,
      feedbackRecoveryState,
    }
  }

  async credentialStatus(): Promise<CredentialPublicStatus> {
    return publicCredentialStatus(await this.options.credentials.status())
  }

  async configureCredential(apiKey: string): Promise<CredentialPublicStatus> {
    if (this.active !== undefined || this.launchInProgress || this.credentialMutationInProgress) {
      throw new StudioServiceError('WORK_ACTIVE', '请先结束当前创作，再更换 API Key。')
    }
    this.credentialMutationInProgress = true
    let candidate = apiKey
    try {
      if (!this.options.credentials.isAvailable()) {
        throw new StudioServiceError('SECURE_STORAGE_UNAVAILABLE', '系统安全存储不可用，API Key 未保存。')
      }
      let available: readonly ModelChoice[]
      try {
        available = await this.credentialValidator(candidate)
      } catch (error) {
        throw credentialConnectionError(error)
      }
      if (!available.includes('deepseek-v4-pro') || !available.includes('deepseek-v4-flash')) {
        throw new StudioServiceError(
          'MODELS_UNAVAILABLE',
          '这个 Key 暂时无法使用 V4 Pro 和 V4 Flash，请检查 DeepSeek 账号权限。',
        )
      }
      await this.options.credentials.set(candidate)
      return await this.credentialStatus()
    } finally {
      candidate = ''
      this.credentialMutationInProgress = false
    }
  }

  async deleteCredential(): Promise<CredentialPublicStatus> {
    if (this.credentialMutationInProgress) {
      throw new StudioServiceError('CREDENTIAL_BUSY', '正在检查 API Key，请稍后再试。')
    }
    this.credentialMutationInProgress = true
    try {
      if (this.active !== undefined || this.launchInProgress) await this.cancelWork('active')
      await this.options.runtime.clearConfiguration()
      await this.options.credentials.delete()
      return await this.credentialStatus()
    } finally {
      this.credentialMutationInProgress = false
    }
  }

  async selectModel(model: ModelChoice): Promise<StudioStatus> {
    if (this.active !== undefined || this.launchInProgress) {
      throw new StudioServiceError('WORK_ACTIVE', '请先结束当前创作，再切换模型。')
    }
    await this.options.settings.update({ selectedModel: model })
    return await this.getStatus()
  }

  async createSystem(input: CreateSystemInput): Promise<SystemSnapshot> {
    if (this.createInProgress || this.launchInProgress || this.active !== undefined) {
      throw new StudioServiceError('BUSY', '当前有操作正在进行，请稍后再试。')
    }
    this.createInProgress = true
    try {
      const systemId = this.internalId('system')
      const project = this.projectPath(systemId)
      const displayName = input.displayName ?? defaultDisplayName(input.intent)
      const result = await this.callController('bootstrap_intent', {
        project,
        system_id: systemId,
        display_name: displayName,
        intent: input.intent,
      })
      if (result.system_id !== systemId) throw invalidControllerResponse()
      await this.options.settings.update({ activeSystemId: systemId })
      const snapshot = await this.systemSnapshot()
      if (snapshot === null) throw invalidControllerResponse()
      return snapshot
    } finally {
      this.createInProgress = false
    }
  }

  async systemSnapshot(): Promise<SystemSnapshot | null> {
    const settings = await this.options.settings.load()
    if (settings.activeSystemId === null) return null
    const result = await this.callController('system_snapshot', {
      project: this.projectPath(settings.activeSystemId),
    })
    return parseSystemSnapshot(result, settings.activeSystemId)
  }

  async startWork(task: string): Promise<WorkRunHandle> {
    if (this.launchInProgress
      || this.active !== undefined
      || this.starting !== undefined
      || this.credentialMutationInProgress) {
      throw new StudioServiceError('WORK_ACTIVE', '已有创作正在进行。')
    }
    this.launchInProgress = true
    this.launchCancellationRequested = false
    const launchCompletion = createLaunchCompletion()
    this.launchCompletion = launchCompletion
    let lease: LoopbackGatewayLease | undefined
    let controllerRunId: string | undefined
    let dispatchId: string | undefined
    let project: string | undefined
    try {
      const credential = await this.credentialStatus()
      if (!credential.configured) {
        throw new StudioServiceError('CREDENTIAL_REQUIRED', '请先连接 DeepSeek API Key。')
      }
      const settings = await this.options.settings.load()
      if (settings.activeSystemId === null) {
        throw new StudioServiceError('SYSTEM_REQUIRED', '请先告诉我你想创作什么。')
      }
      this.throwIfLaunchCancelled()
      project = this.projectPath(settings.activeSystemId)
      const rawCreativeSystem = await this.readProjectSnapshot(project, settings.activeSystemId)
      if (rawCreativeSystem === null) throw invalidControllerResponse()
      const creativeSystem = await this.requireFeedbackRecovery(rawCreativeSystem)
      controllerRunId = this.internalId('run')
      dispatchId = this.internalId('dispatch')
      const workId = this.internalId('work')
      const contextId = this.internalId('context')
      const begun = await this.callController('begin_work', {
        project,
        run_id: controllerRunId,
        work_id: workId,
        task,
        loop: 'main-loop',
        dispatch_id: dispatchId,
        context_id: contextId,
        context_sha256: creativeSystem.initialIntentSha256,
        ...(creativeSystem.interruptedRun === null
          ? {}
          : { recovery_of: creativeSystem.interruptedRun.runId }),
      })
      if (begun.run_id !== controllerRunId
        || begun.dispatch_id !== dispatchId
        || begun.work_id !== workId
        || begun.task_sha256 !== createHash('sha256').update(task, 'utf8').digest('hex')
        || begun.context_sha256 !== creativeSystem.initialIntentSha256) {
        throw invalidControllerResponse()
      }
      this.throwIfLaunchCancelled()

      lease = this.options.loopback.issueLease('production', settings.selectedModel)
      const workspaceDir = join(project, 'creative-system', 'runtime', 'workspace')
      const dshHome = join(this.systemsRoot, '..', 'runtime', 'dsh-home', 'production')
      await Promise.all([
        mkdir(workspaceDir, { recursive: true }),
        mkdir(dshHome, { recursive: true, mode: 0o700 }),
      ])
      const spec = this.runtimeSpecFactory({
        nodeExecutable: this.options.nodeExecutable,
        cwd: workspaceDir,
        workspaceDir,
        dshHome,
        // The trusted profile mounts no session persistence. This required
        // adapter field therefore names the already-trusted workspace without
        // creating a second on-disk transcript location.
        sessionRoot: workspaceDir,
        role: 'production',
        model: settings.selectedModel,
        gateway: { url: lease.url, token: lease.token },
        maxTokens: MAX_MODEL_OUTPUT_TOKENS,
      })
      const profileSha256 = await this.profileDigest(spec)
      this.throwIfLaunchCancelled()
      this.options.runtime.configure(spec)
      const starting: StartingWork = {
        systemId: settings.activeSystemId,
        controllerRunId,
        dispatchId,
        workId,
        project,
        model: settings.selectedModel,
        contextSha256: creativeSystem.initialIntentSha256,
        lease,
        profileSha256,
        queuedEvents: [],
      }
      this.starting = starting
      const runtimeHandle = await this.options.runtime.startRun(
        creationInstruction(creativeSystem.initialIntent, task),
      )
      if (this.launchCancellationRequested) {
        await this.options.runtime.cancelRun(runtimeHandle.runId).catch(() => undefined)
        throw new StudioServiceError('LAUNCH_CANCELLED', '本次创作已停止。')
      }
      const active: ActiveWork = {
        ...starting,
        runtimeRunId: runtimeHandle.runId,
        runtimeSessionId: runtimeHandle.sessionId,
        output: undefined,
        runtimeErrorCode: undefined,
        runtimeError: undefined,
        cancelRequested: false,
        cancelReason: undefined,
        terminalTask: undefined,
      }
      this.active = active
      this.starting = undefined
      const queued = [...active.queuedEvents]
      active.queuedEvents.length = 0
      for (const event of queued) await this.processRuntimeEvent(event)
      return { runId: controllerRunId, sessionId: runtimeHandle.sessionId }
    } catch (error) {
      const launchState = this.starting
      lease?.revoke()
      this.starting = undefined
      await this.options.runtime.stop().catch(() => undefined)
      if (project !== undefined && controllerRunId !== undefined && dispatchId !== undefined) {
        await this.cancelControllerDispatch(
          project,
          controllerRunId,
          dispatchId,
          this.launchCancellationRequested
            ? 'user-cancelled-during-launch'
            : 'runtime-launch-failed-before-output',
          launchState === undefined
            ? undefined
            : runtimeProvenancePayload(
                this.options.appVersion,
                launchState,
                launchState.lease.provenance(),
              ),
        ).catch(() => undefined)
      }
      throw publicServiceError(error, '无法开始本次创作。')
    } finally {
      this.launchInProgress = false
      launchCompletion.resolve()
      if (this.launchCompletion === launchCompletion) this.launchCompletion = undefined
    }
  }

  async cancelWork(runId: string): Promise<void> {
    let active = this.active
    if (active === undefined) {
      if (runId === 'active' && this.launchInProgress) {
        this.launchCancellationRequested = true
        this.starting?.lease.revoke()
        await this.launchCompletion?.promise
        active = this.active
        if (active === undefined) return
      } else if (runId === 'active') {
        return
      }
    }
    if (active === undefined) {
      throw new StudioServiceError('RUN_NOT_FOUND', '找不到可取消的创作。')
    }
    if (runId !== 'active' && runId !== active.controllerRunId) {
      throw new StudioServiceError('RUN_NOT_FOUND', '找不到可取消的创作。')
    }
    // Revoke the network capability before waiting for runtime shutdown.
    active.cancelRequested = true
    active.cancelReason = 'user-cancelled'
    active.lease.revoke()
    await this.options.runtime.cancelRun(active.runtimeRunId).catch(() => undefined)
    await this.finishUnsuccessful(active, 'user-cancelled', 'cancelled')
  }

  async submitFeedback(input: SubmitFeedbackInput): Promise<SubmitFeedbackResult> {
    if (this.active !== undefined || this.launchInProgress) {
      throw new StudioServiceError('WORK_ACTIVE', '请等待当前创作结束后再提交反馈。')
    }
    const settings = await this.options.settings.load()
    if (settings.activeSystemId === null) throw new StudioServiceError('SYSTEM_REQUIRED', '没有可反馈的创作系统。')
    const rawSnapshot = await this.systemSnapshot()
    if (rawSnapshot === null) {
      throw new StudioServiceError('SYSTEM_REQUIRED', '没有可反馈的创作系统。')
    }
    if (rawSnapshot.feedbackRecoveryRequired) {
      return {
        outcome: 'recovered-previous',
        snapshot: await this.requireFeedbackRecovery(rawSnapshot),
      }
    }
    const snapshot = rawSnapshot
    if (snapshot.lastWork === null
      || snapshot.lastWork.runId !== input.runId
      || snapshot.lastWork.sealed) {
      throw new StudioServiceError('REVIEW_NOT_OPEN', '这个版本当前不能提交反馈。')
    }
    const project = this.projectPath(settings.activeSystemId)
    const feedbackAt = notBefore(this.now(), snapshot.lastWork.reviewAvailableAt)
    const feedbackPayload = {
      project,
      run_id: input.runId,
      action: input.action,
      feedback_at: feedbackAt,
      machine_direction: 'UNKNOWN',
      ...(input.feedbackText === undefined ? {} : { feedback_text: input.feedbackText }),
      ...(input.editedText === undefined ? {} : { edited_text: input.editedText }),
    } as const
    let submitted: JsonRecord | undefined
    for (let attempt = 0; attempt < 2 && submitted === undefined; attempt += 1) {
      try {
        submitted = await this.callController('submit_feedback', feedbackPayload)
      } catch (error) {
        if (attempt === 1) throw error
      }
    }
    if (submitted === undefined) throw invalidControllerResponse()
    if (!isPlainRecord(submitted.snapshot)) throw invalidControllerResponse()
    return {
      outcome: 'submitted',
      snapshot: parseSystemSnapshot(submitted.snapshot, settings.activeSystemId),
    }
  }

  acceptRuntimeEvent(event: RuntimeEvent): Promise<void> {
    const operation = this.eventQueue.then(() => this.processRuntimeEvent(event))
    this.eventQueue = operation.catch(() => undefined)
    return operation
  }

  async shutdown(): Promise<void> {
    if (this.launchInProgress) {
      this.launchCancellationRequested = true
      this.starting?.lease.revoke()
      await this.launchCompletion?.promise
    }
    const active = this.active
    if (active !== undefined) {
      active.cancelRequested = true
      active.cancelReason = 'application-closed'
      active.lease.revoke()
      await this.options.runtime.cancelRun(active.runtimeRunId).catch(() => undefined)
      await this.finishUnsuccessful(active, 'application-closed', 'cancelled')
    }
    this.starting?.lease.revoke()
    this.starting = undefined
    await this.options.runtime.clearConfiguration()
    await this.options.loopback.close()
  }

  private async processRuntimeEvent(event: RuntimeEvent): Promise<void> {
    const active = this.active
    if (active === undefined) {
      if (this.starting !== undefined) this.starting.queuedEvents.push(event)
      return
    }
    if (event.runId !== active.runtimeRunId) return
    if (event.type === 'output') {
      active.output = event.text
      this.emitForControllerRun(active, event)
      return
    }
    if (event.type === 'error') {
      active.runtimeErrorCode = event.code
      active.runtimeError = event.message
      return
    }
    if (event.type === 'progress' || (event.type === 'state' && event.state === 'running')) {
      this.emitForControllerRun(active, event)
      return
    }
    if (event.type !== 'state') return
    if (active.cancelRequested
      && (event.state === 'completed' || event.state === 'failed' || event.state === 'cancelled')) {
      await this.finishUnsuccessful(
        active,
        active.cancelReason ?? 'user-cancelled',
        'cancelled',
      )
      return
    }
    if (event.state === 'completed') {
      await this.finishCompleted(active)
    } else if (event.state === 'cancelled') {
      await this.finishUnsuccessful(active, 'runtime-cancelled-before-commit', 'cancelled')
    } else if (event.state === 'failed') {
      await this.finishUnsuccessful(active, 'runtime-failed-before-commit', 'failed')
    }
  }

  private async finishCompleted(active: ActiveWork): Promise<void> {
    if (active.cancelRequested) {
      return await this.finishUnsuccessful(
        active,
        active.cancelReason ?? 'user-cancelled',
        'cancelled',
      )
    }
    if (active.terminalTask !== undefined) return await active.terminalTask
    active.terminalTask = (async () => {
      try {
        if (active.output === undefined || active.output.trim() === '') {
          throw new StudioServiceError('EMPTY_OUTPUT', '模型没有返回可保存的作品。')
        }
        const provenance = validatedProvenance(active.lease.provenance())
        const request = {
          project: active.project,
          run_id: active.controllerRunId,
          dispatch_id: active.dispatchId,
          output: active.output,
          runtime_provenance: runtimeProvenancePayload(this.options.appVersion, active, provenance),
        } as const
        let persisted = false
        for (let attempt = 0; attempt < 2 && !persisted; attempt += 1) {
          try {
            const receipt = await this.callController('complete_work', request)
            validateCompletionReceipt(receipt, active, active.output)
            persisted = true
          } catch {
            if (attempt === 1) {
              const snapshot = await this.readProjectSnapshot(active.project, active.systemId)
              const expectedArtifactSha256 = createHash('sha256').update(active.output, 'utf8').digest('hex')
              persisted = snapshot?.lastWork?.runId === active.controllerRunId
                && snapshot.lastWork.workId === active.workId
                && snapshot.lastWork.artifactSha256 === expectedArtifactSha256
                && snapshot.lastWork.output === active.output
                && snapshot.lastWork.runtimeProvenanceSha256 !== null
                && snapshot.lastWork.reviewSubjectSha256 !== null
                && snapshot.lastWork.reviewAvailableAt !== null
            }
          }
        }
        if (!persisted) throw new StudioServiceError('COMMIT_FAILED', '作品未能安全保存，本次没有记为成功。')
        active.lease.revoke()
        await this.options.runtime.stop().catch(() => undefined)
        if (this.active === active) this.active = undefined
        this.options.emit({ type: 'state', runId: active.controllerRunId, state: 'completed' })
      } catch (error) {
        await this.performUnsuccessful(
          active,
          'completion-evidence-or-commit-failed',
          'failed',
          publicServiceError(error, '作品未能安全保存，本次没有记为成功。').message,
        )
      }
    })()
    return await active.terminalTask
  }

  private async finishUnsuccessful(
    active: ActiveWork,
    reason: string,
    state: 'cancelled' | 'failed',
    message?: string,
  ): Promise<void> {
    if (active.terminalTask !== undefined) return await active.terminalTask
    active.terminalTask = this.performUnsuccessful(active, reason, state, message)
    return await active.terminalTask
  }

  private async performUnsuccessful(
    active: ActiveWork,
    reason: string,
    state: 'cancelled' | 'failed',
    message?: string,
  ): Promise<void> {
    active.lease.revoke()
    await this.options.runtime.stop().catch(() => undefined)
    await this.cancelControllerDispatch(
      active.project,
      active.controllerRunId,
      active.dispatchId,
      reason,
      runtimeProvenancePayload(this.options.appVersion, active, active.lease.provenance()),
    ).catch(() => undefined)
    if (this.active === active) this.active = undefined
    if (state === 'failed') {
      this.options.emit({
        type: 'error',
        runId: active.controllerRunId,
        code: active.runtimeErrorCode ?? 'RUNTIME_FAILED',
        message: message ?? active.runtimeError ?? '本次创作未完成，请重试。',
      })
    }
    this.options.emit({ type: 'state', runId: active.controllerRunId, state })
  }

  private emitForControllerRun(active: ActiveWork, event: RuntimeEvent): void {
    this.options.emit({ ...event, runId: active.controllerRunId })
  }

  private async cancelControllerDispatch(
    project: string,
    runId: string,
    dispatchId: string,
    reason: string,
    runtimeProvenance?: JsonRecord,
  ): Promise<void> {
    await this.callController('cancel_work', {
      project,
      run_id: runId,
      dispatch_id: dispatchId,
      reason,
      ...(runtimeProvenance === undefined ? {} : { runtime_provenance: runtimeProvenance }),
    })
  }

  private async readProjectSnapshot(project: string, systemId: string): Promise<SystemSnapshot | null> {
    const result = await this.callController('system_snapshot', { project })
    return parseSystemSnapshot(result, systemId)
  }

  private async requireFeedbackRecovery(snapshot: SystemSnapshot): Promise<SystemSnapshot> {
    if (!snapshot.feedbackRecoveryRequired) return snapshot
    try {
      return await this.resumePendingFeedback(snapshot)
    } catch {
      throw new StudioServiceError(
        'FEEDBACK_RECOVERY_REQUIRED',
        '上次反馈尚未恢复完成。原编辑仍保存在本机，请重试；恢复完成前不能开始新创作或提交新反馈。',
      )
    }
  }

  private async resumePendingFeedback(snapshot: SystemSnapshot): Promise<SystemSnapshot> {
    const pending = snapshot.pendingFeedback
    if (!snapshot.feedbackRecoveryRequired || pending === null) throw invalidControllerResponse()
    const existing = this.feedbackRecoveryTask
    if (existing !== undefined) {
      if (existing.runId !== pending.runId) {
        throw new StudioServiceError('FEEDBACK_RECOVERY_BUSY', '正在恢复另一条反馈，请稍后重试。')
      }
      return await existing.promise
    }
    const project = this.projectPath(snapshot.systemId)
    const promise = (async (): Promise<SystemSnapshot> => {
      const result = await this.callController('resume_feedback', {
        project,
        run_id: pending.runId,
      })
      if (result.run_id !== pending.runId
        || (result.resume_status !== 'RECOVERED' && result.resume_status !== 'ALREADY_COMMITTED')
        || result.submission_id !== pending.submissionId
        || result.attempt_id !== pending.attemptId
        || typeof result.idempotent !== 'boolean') {
        throw invalidControllerResponse()
      }
      requiredString(result.receipt)
      requiredSha256(result.receipt_sha256)
      requiredString(result.manifest)
      requiredSha256(result.manifest_sha256)
      if (!isPlainRecord(result.snapshot)) throw invalidControllerResponse()
      const recovered = parseSystemSnapshot(result.snapshot, snapshot.systemId)
      if (recovered.feedbackRecoveryRequired
        || recovered.pendingFeedback !== null
        || recovered.lastWork?.runId !== pending.runId
        || recovered.lastWork.sealed !== true) {
        throw invalidControllerResponse()
      }
      return recovered
    })()
    const task = { runId: pending.runId, promise }
    this.feedbackRecoveryTask = task
    try {
      return await promise
    } finally {
      if (this.feedbackRecoveryTask === task) this.feedbackRecoveryTask = undefined
    }
  }

  private async callController(operation: StudioControllerOperation, payload: JsonRecord): Promise<JsonRecord> {
    const invocation = await this.options.controller.invoke({
      request_id: this.internalId('request'),
      operation,
      payload,
    })
    if (!isPlainRecord(invocation.payload)) throw invalidControllerResponse()
    if (invocation.payload.status !== 'PASS') {
      throw new StudioServiceError('CONTROLLER_BLOCK', '本地创作记录未通过安全校验。')
    }
    return invocation.payload
  }

  private projectPath(systemId: string): string {
    if (!SYSTEM_ID_PATTERN.test(systemId)) throw new StudioServiceError('INVALID_SYSTEM', '创作系统标识无效。')
    const project = resolve(this.systemsRoot, systemId)
    const pathFromRoot = relative(this.systemsRoot, project)
    if (pathFromRoot === '' || pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
      throw new StudioServiceError('INVALID_SYSTEM', '创作系统标识无效。')
    }
    return project
  }

  private internalId(prefix: string): string {
    const raw = this.idFactory().toLowerCase().replace(/[^a-z0-9-]/gu, '-')
    const normalized = raw.replace(/-+/gu, '-').replace(/^-|-$/gu, '')
    if (normalized === '') throw new Error('internal id source is empty')
    return `${prefix}-${normalized}`
  }

  private throwIfLaunchCancelled(): void {
    if (this.launchCancellationRequested) {
      throw new StudioServiceError('LAUNCH_CANCELLED', '本次创作已停止。')
    }
  }
}

export class StudioServiceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'StudioServiceError'
  }
}

async function validateOfficialCredential(apiKey: string): Promise<readonly ModelChoice[]> {
  let candidate = apiKey
  const keyStore: ApiKeyStore = {
    isAvailable: () => true,
    get: () => candidate,
    set: () => undefined,
    delete: () => { candidate = '' },
  }
  try {
    const response = await new DeepSeekGateway({ keyStore }).listModels()
    return supportedModels(response)
  } finally {
    candidate = ''
  }
}

function supportedModels(response: ModelListResponse): ModelChoice[] {
  const result = new Set<ModelChoice>()
  for (const item of response.data) {
    if (item.id === 'deepseek-v4-pro' || item.id === 'deepseek-v4-flash') result.add(item.id)
  }
  return [...result]
}

async function digestRuntimeProfile(spec: DshRuntimeLaunchSpec): Promise<string> {
  const candidate = spec.args.at(-1)
  if (candidate === undefined || !isAbsolute(candidate) || candidate.includes('\0')) {
    throw new StudioServiceError('PROFILE_INVALID', '内置运行配置无效。')
  }
  return createHash('sha256').update(await readFile(candidate)).digest('hex')
}

interface ValidatedProvenance extends LoopbackLeaseProvenance {
  readonly completedAt: string
  readonly responseId: string
  readonly returnedModels: readonly [string]
  readonly systemFingerprints: readonly [string]
}

function validatedProvenance(value: LoopbackLeaseProvenance): ValidatedProvenance {
  const lastCompleted = [...value.requests].reverse().find(item => item.status === 'COMPLETED')
  if (value.completedRequests < 1
    || value.requestCount !== value.requests.length
    || value.completedRequests !== value.requests.filter(item => item.status === 'COMPLETED').length
    || value.failedRequests !== value.requests.filter(item => item.status === 'FAILED').length
    || value.requests.some(item => item.status === 'STARTED')
    || value.completedAt === undefined
    || value.responseId === undefined
    || value.returnedModels.length !== 1
    || value.returnedModels[0] !== value.requestedModel
    || value.systemFingerprints.length !== 1
    || value.systemFingerprints[0] === ''
    || !Number.isSafeInteger(value.usage.total_tokens)
    || (value.usage.total_tokens ?? -1) < 0) {
    throw new StudioServiceError('PROVENANCE_INCOMPLETE', '模型来源证据不完整，本次没有记为成功。')
  }
  if (lastCompleted === undefined
    || lastCompleted.responseId !== value.responseId
    || lastCompleted.returnedModel !== value.returnedModels[0]
    || lastCompleted.systemFingerprint !== value.systemFingerprints[0]) {
    throw new StudioServiceError('PROVENANCE_INCOMPLETE', '模型请求证据与完成汇总不一致，本次没有记为成功。')
  }
  return value as ValidatedProvenance
}

function runtimeProvenancePayload(
  appVersion: string,
  active: Pick<ActiveWork, 'contextSha256' | 'model' | 'profileSha256'>,
  provenance: LoopbackLeaseProvenance,
): JsonRecord {
  const returnedModel = provenance.returnedModels.length === 1 ? provenance.returnedModels[0] : null
  const fingerprint = provenance.systemFingerprints.length === 1
    ? provenance.systemFingerprints[0]
    : null
  return {
    app_version: appVersion,
    completed_at: provenance.completedAt ?? null,
    controller_version: CONTROLLER_VERSION,
    dsh_version: SUPPORTED_DSH_VERSION,
    profile_sha256: active.profileSha256,
    context_sha256: active.contextSha256,
    requested_model: active.model,
    returned_model: returnedModel ?? null,
    system_fingerprint: fingerprint ?? null,
    response_id: provenance.responseId ?? null,
    parameters: {
      thinking: 'enabled',
      reasoning_effort: 'high',
      max_tokens: MAX_MODEL_OUTPUT_TOKENS,
    },
    usage: { ...provenance.usage },
    request_count: provenance.requestCount,
    completed_requests: provenance.completedRequests,
    failed_requests: provenance.failedRequests,
    requests: provenance.requests.map(request => ({
      request_number: request.requestNumber,
      started_at: request.startedAt,
      completed_at: request.completedAt ?? null,
      status: request.status,
      http_status: request.httpStatus ?? null,
      error_code: request.errorCode ?? null,
      response_id: request.responseId ?? null,
      returned_model: request.returnedModel ?? null,
      system_fingerprint: request.systemFingerprint ?? null,
      usage: { ...request.usage },
    })),
  }
}

function validateCompletionReceipt(
  receipt: JsonRecord,
  active: Pick<ActiveWork, 'controllerRunId' | 'workId'>,
  output: string,
): void {
  if (receipt.run_id !== active.controllerRunId
    || receipt.work_id !== active.workId
    || receipt.artifact_sha256 !== createHash('sha256').update(output, 'utf8').digest('hex')) {
    throw invalidControllerResponse()
  }
  requiredSha256(receipt.runtime_provenance_sha256)
  requiredString(receipt.runtime_provenance)
  requiredString(receipt.review_subject)
  const reviewAvailableAt = requiredString(receipt.review_available_at)
  if (!Number.isFinite(Date.parse(reviewAvailableAt))) throw invalidControllerResponse()
}

function parseSystemSnapshot(value: JsonRecord, expectedSystemId: string): SystemSnapshot {
  const systemId = requiredString(value.system_id)
  if (systemId !== expectedSystemId) throw invalidControllerResponse()
  const lastWorkValue = value.last_work
  let lastWork: WorkSnapshot | null = null
  if (lastWorkValue !== null && lastWorkValue !== undefined) {
    if (!isPlainRecord(lastWorkValue)) throw invalidControllerResponse()
    const direction = lastWorkValue.human_direction
    if (direction !== 'BLOCK' && direction !== 'PASS' && direction !== 'UNKNOWN') {
      throw invalidControllerResponse()
    }
    lastWork = {
      runId: requiredString(lastWorkValue.run_id),
      workId: requiredString(lastWorkValue.work_id),
      output: requiredString(lastWorkValue.output, true),
      artifactSha256: requiredString(lastWorkValue.artifact_sha256),
      runtimeProvenanceSha256: nullableSha256(lastWorkValue.runtime_provenance_sha256),
      reviewSubjectSha256: nullableSha256(lastWorkValue.review_subject_sha256),
      reviewAvailableAt: nullableString(lastWorkValue.review_available_at),
      sealed: requiredBoolean(lastWorkValue.sealed),
      humanAccepted: nullableBoolean(lastWorkValue.human_accepted),
      humanDirection: direction,
      decision: nullableString(lastWorkValue.decision),
    }
  }
  const initialIntent = requiredString(value.initial_intent, true)
  const initialIntentSha256 = requiredSha256(value.initial_intent_sha256)
  if (createHash('sha256').update(initialIntent, 'utf8').digest('hex') !== initialIntentSha256) {
    throw invalidControllerResponse()
  }
  const recoveryRequired = requiredBoolean(value.recovery_required)
  const interruptedRun = parseInterruptedRun(value.interrupted_run)
  if (recoveryRequired !== (interruptedRun !== null)) throw invalidControllerResponse()
  const feedbackRecoveryRequired = requiredBoolean(value.feedback_recovery_required)
  const pendingFeedback = parsePendingFeedback(value.pending_feedback)
  if (feedbackRecoveryRequired !== (pendingFeedback !== null)) throw invalidControllerResponse()
  return {
    systemId,
    displayName: requiredString(value.display_name),
    activeVersion: requiredString(value.active_version),
    operatingStage: requiredString(value.operating_stage),
    charterConfirmed: requiredBoolean(value.charter_confirmed),
    initialIntent,
    initialIntentSha256,
    lastWork,
    recoveryRequired,
    interruptedRun,
    feedbackRecoveryRequired,
    pendingFeedback,
  }
}

function parseInterruptedRun(value: unknown): SystemSnapshot['interruptedRun'] {
  if (value === null || value === undefined) return null
  if (!isPlainRecord(value)) throw invalidControllerResponse()
  return {
    runId: requiredString(value.run_id),
    workId: requiredString(value.work_id),
    attemptId: requiredString(value.attempt_id),
    dispatchId: nullableString(value.dispatch_id),
    state: requiredString(value.state),
    reasonCode: requiredString(value.reason_code),
  }
}

function parsePendingFeedback(value: unknown): SystemSnapshot['pendingFeedback'] {
  if (value === null || value === undefined) return null
  if (!isPlainRecord(value)) throw invalidControllerResponse()
  const action = value.action
  if (action !== 'edit' && action !== 'keep' && action !== 'reject' && action !== 'rewrite') {
    throw invalidControllerResponse()
  }
  if (value.state !== 'RECOVERY_REQUIRED') throw invalidControllerResponse()
  return {
    submissionId: requiredString(value.submission_id),
    runId: requiredString(value.run_id),
    attemptId: requiredString(value.attempt_id),
    action,
    state: 'RECOVERY_REQUIRED',
  }
}

function publicCredentialStatus(value: CredentialStatus): CredentialPublicStatus {
  return {
    secureStorageAvailable: value.secureStorageAvailable,
    configured: value.configured,
  }
}

function defaultDisplayName(intent: string): string {
  const compact = intent.replace(/\s+/gu, ' ').trim()
  const beginning = Array.from(compact).slice(0, 28).join('')
  return beginning.length < compact.length ? `${beginning}…` : beginning
}

function creationInstruction(initialIntent: string, task: string): string {
  return [
    '完成下面的创意写作任务。',
    '只输出可供用户直接阅读和编辑的成品，不解释过程，不把推测的偏好写成永久规则。',
    '',
    '用户首次确认的创作方向（保留原意，不扩写为新规则）：',
    initialIntent,
    '',
    '本次任务：',
    task,
  ].join('\n')
}

function notBefore(now: string, boundary: string | null): string {
  if (boundary === null) throw new StudioServiceError('REVIEW_NOT_OPEN', '作品还没有进入可反馈状态。')
  const nowTime = Date.parse(now)
  const boundaryTime = Date.parse(boundary)
  if (!Number.isFinite(nowTime) || !Number.isFinite(boundaryTime)) {
    throw new StudioServiceError('TIME_INVALID', '本机时间无效，反馈未保存。')
  }
  return nowTime < boundaryTime ? boundary : now
}

function requiredString(value: unknown, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value === '')) throw invalidControllerResponse()
  return value
}

function requiredSha256(value: unknown): string {
  const text = requiredString(value)
  if (!/^[0-9a-f]{64}$/u.test(text)) throw invalidControllerResponse()
  return text
}

function nullableSha256(value: unknown): string | null {
  return value === null || value === undefined ? null : requiredSha256(value)
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : requiredString(value)
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalidControllerResponse()
  return value
}

function nullableBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined) return null
  return requiredBoolean(value)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

function invalidControllerResponse(): StudioServiceError {
  return new StudioServiceError('CONTROLLER_PROTOCOL', '本地创作记录返回了无效结果。')
}

function createLaunchCompletion(): LaunchCompletion {
  let resolvePromise!: () => void
  const promise = new Promise<void>(resolve => { resolvePromise = resolve })
  return { promise, resolve: resolvePromise }
}

function publicServiceError(error: unknown, fallback: string): StudioServiceError {
  return error instanceof StudioServiceError
    ? error
    : new StudioServiceError('STUDIO_OPERATION_FAILED', fallback)
}

function credentialConnectionError(error: unknown): StudioServiceError {
  if (!(error instanceof GatewayError)) {
    return new StudioServiceError('CREDENTIAL_CHECK_FAILED', '无法连接 DeepSeek，请检查网络后重试。')
  }
  if (error.status === 401 || error.status === 403) {
    return new StudioServiceError('CREDENTIAL_REJECTED', 'DeepSeek 未接受这个 API Key，请检查后重试。')
  }
  if (error.status === 402) {
    return new StudioServiceError('ACCOUNT_BALANCE', 'DeepSeek 账号余额不足，请充值后重试。')
  }
  if (error.status === 429) {
    return new StudioServiceError('RATE_LIMITED', 'DeepSeek 当前请求较多，请稍后重试。')
  }
  if (error.status !== undefined && error.status >= 500) {
    return new StudioServiceError('DEEPSEEK_UNAVAILABLE', 'DeepSeek 服务暂时不可用，请稍后重试。')
  }
  return new StudioServiceError('CREDENTIAL_CHECK_FAILED', '无法连接 DeepSeek，请检查网络后重试。')
}
