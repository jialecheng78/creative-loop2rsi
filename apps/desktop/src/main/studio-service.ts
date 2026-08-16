import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

import {
  DeepSeekGateway,
  GatewayError,
  MAX_DEEPSEEK_OUTPUT_TOKENS,
  type ApiKeyStore,
  type ModelListResponse,
} from '@creative-loop2rsi/model-gateway'
import {
  DshRuntimeError,
  resolvePublishedRuntime,
  SUPPORTED_DSH_RUNTIME_VERSION,
  type DshModelId,
  type DshRuntimeLaunchSpec,
  type RuntimeErrorCode,
  type RuntimeEvent,
  type RuntimeRunHandle,
  type RuntimeRole,
  type RuntimeStatus,
} from '@creative-loop2rsi/runtime-dsh'

import type {
  CredentialPublicStatus,
  CompareCandidateInput,
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
import {
  PendingWorkStore,
  type PendingTerminationExpectation,
  type PendingWorkIntent,
} from './pending-work-store.js'
import type { RuntimeWorkerManager } from './runtime-worker-manager.js'
import type { DesktopSettings, SettingsStore } from './settings-store.js'

const CONTROLLER_VERSION = '1'
const SYSTEM_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const METHOD_GENERATION_LABELS = [
  'targeted_candidate',
  'regression_candidate',
  'heldout_baseline',
  'heldout_candidate',
] as const

type JsonRecord = Readonly<Record<string, unknown>>
type MethodGenerationLabel = typeof METHOD_GENERATION_LABELS[number]
type StudioControllerOperation =
  | 'begin_method_candidate_preparation'
  | 'begin_method_generation'
  | 'begin_work'
  | 'bootstrap_intent'
  | 'cancel_work'
  | 'complete_work'
  | 'create_method_candidate'
  | 'adopt_method_candidate'
  | 'method_candidate_context'
  | 'production_context'
  | 'record_feedback'
  | 'record_method_generation'
  | 'record_method_generation_failure'
  | 'record_method_builder_failure'
  | 'reject_method_candidate'
  | 'resume_feedback'
  | 'seal_feedback'
  | 'rollback_method'
  | 'stage_method_comparisons'
  | 'submit_method_comparison'
  | 'submit_feedback'
  | 'system_snapshot'
  | 'terminate_work'

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
  'clearSession' | 'delete' | 'set' | 'status'> {}

export interface SettingsStorePort extends Pick<SettingsStore, 'load' | 'update'> {}

export interface RuntimePort extends Pick<RuntimeWorkerManager,
  'cancelRun' | 'clearConfiguration' | 'configure' | 'startRun' | 'status' | 'stop'> {}

export interface LoopbackGatewayPort extends Pick<LoopbackModelGateway,
  'close' | 'issueLease' | 'start'> {}

export interface PendingWorkStorePort extends Pick<PendingWorkStore,
  'clear' | 'createLaunching' | 'load' | 'requireTermination'> {}

export type RuntimeSpecFactory = (input: {
  readonly nodeExecutable: string
  readonly cwd: string
  readonly workspaceDir: string
  readonly dshHome: string
  readonly sessionRoot: string
  readonly role: RuntimeRole
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
  readonly pendingWorkStore?: PendingWorkStorePort
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
  readonly pendingWork: PendingWorkIntent
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

interface InternalModelRun {
  readonly runtimeRunId: string
  output: string | undefined
  errorCode: RuntimeErrorCode | undefined
  errorMessage: string | undefined
  readonly completion: Promise<void>
  resolve(): void
  reject(error: Error): void
}

interface InternalGenerationResult {
  readonly output: string
  readonly runtimeProvenance: JsonRecord | null
  readonly provenanceError: StudioServiceError | null
  readonly provenanceEvidenceSha256: string | null
}

interface InternalGenerationInput {
  readonly project: string
  readonly model: ModelChoice
  readonly role: RuntimeRole
  readonly contextSha256: string
  readonly instruction: string
  readonly expectedEpoch: MethodSourceEpoch
}

interface MethodSourceEpoch {
  readonly sha256: string
  readonly methodVersion: string
  readonly requestedModel: ModelChoice
  readonly returnedModel: ModelChoice
  readonly systemFingerprint: string
  readonly profileSha256: string
  readonly parameters: {
    readonly thinking: 'enabled'
    readonly reasoningEffort: 'high'
    readonly maxTokens: number
  }
}

interface TerminationExpectation {
  readonly project: string
  readonly systemId: string
  readonly runId: string
  readonly dispatchId: string
  readonly outcome: 'FAILED' | 'CANCELLED'
  readonly reason: string
  readonly errorCode?: string
  readonly runtimeProvenance?: JsonRecord
}

interface PreparedTermination {
  readonly pending: PendingWorkIntent
  readonly expected: TerminationExpectation
}

interface LaunchOwnership {
  readonly systemId: string
  readonly runId: string
  readonly workId: string
  readonly dispatchId: string
  readonly contextId: string
}

export class StudioService {
  private readonly systemsRoot: string
  private readonly pendingWorkStore: PendingWorkStorePort
  private readonly now: () => string
  private readonly idFactory: () => string
  private readonly credentialValidator: (apiKey: string) => Promise<readonly ModelChoice[]>
  private readonly runtimeSpecFactory: RuntimeSpecFactory
  private readonly profileDigest: (spec: DshRuntimeLaunchSpec) => Promise<string>
  private starting: StartingWork | undefined
  private active: ActiveWork | undefined
  private launchInProgress = false
  private launchCancellationRequested = false
  private launchBeginConfirmed = false
  private launchOwnership: LaunchOwnership | undefined
  private launchCompletion: LaunchCompletion | undefined
  private createInProgress = false
  private credentialMutationInProgress = false
  private feedbackRecoveryTask: FeedbackRecoveryTask | undefined
  private methodOperationInProgress = false
  private methodCancellationRequested = false
  private methodOperationCompletion: Promise<void> | undefined
  private internalLaunchEvents: RuntimeEvent[] | undefined
  private internalRun: InternalModelRun | undefined
  private eventQueue: Promise<void> = Promise.resolve()
  private pendingRecoveryTask: Promise<boolean> | undefined
  private currentPendingWork: PendingWorkIntent | undefined

  constructor(private readonly options: StudioServiceOptions) {
    if (!isAbsolute(options.userDataPath) || options.userDataPath.includes('\0')) {
      throw new TypeError('userDataPath 必须是可信绝对路径。')
    }
    if (!isAbsolute(options.nodeExecutable) || options.nodeExecutable.includes('\0')) {
      throw new TypeError('nodeExecutable 必须是可信绝对路径。')
    }
    this.systemsRoot = resolve(options.userDataPath, 'systems')
    this.pendingWorkStore = options.pendingWorkStore ?? new PendingWorkStore(options.userDataPath)
    this.now = options.now ?? (() => new Date().toISOString())
    this.idFactory = options.idFactory ?? randomUUID
    this.credentialValidator = options.credentialValidator ?? validateOfficialCredential
    this.runtimeSpecFactory = options.runtimeSpecFactory ?? resolvePublishedRuntime
    this.profileDigest = options.profileDigest ?? digestRuntimeProfile
  }

  async getStatus(): Promise<StudioStatus> {
    let workRecoveryState: StudioStatus['workRecoveryState'] = 'none'
    try {
      if (await this.reconcilePendingWork()) workRecoveryState = 'recovered'
    } catch {
      workRecoveryState = 'retry-required'
    }
    const [credential, settings] = await Promise.all([
      this.credentialStatus(),
      this.options.settings.load(),
    ])
    const snapshot = workRecoveryState === 'retry-required' || settings.activeSystemId === null
      ? null
      : await this.readProjectSnapshot(
          this.projectPath(settings.activeSystemId),
          settings.activeSystemId,
        )
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
      credentialPersistence: credential.persistence,
      selectedModel: settings.selectedModel,
      runtime: this.options.runtime.status(),
      activeSystem,
      feedbackRecoveryState,
      workRecoveryState,
    }
  }

  async credentialStatus(): Promise<CredentialPublicStatus> {
    return publicCredentialStatus(await this.options.credentials.status())
  }

  async configureCredential(apiKey: string, allowSessionOnly: boolean): Promise<CredentialPublicStatus> {
    if (this.active !== undefined || this.launchInProgress || this.methodOperationInProgress || this.credentialMutationInProgress) {
      throw new StudioServiceError('WORK_ACTIVE', '请先结束当前创作，再更换 API Key。')
    }
    this.credentialMutationInProgress = true
    let candidate = apiKey
    try {
      const initialStatus = await this.options.credentials.status()
      if (!initialStatus.secureStorageAvailable && !allowSessionOnly) {
        throw new StudioServiceError(
          'SECURE_STORAGE_UNAVAILABLE',
          '系统安全存储不可用；如接受连接信息仅本次打开有效，请重新提交。',
        )
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
      await this.options.credentials.set(candidate, { allowSessionOnly })
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
    // A user-requested delete revokes a session Key before cancellation or I/O.
    this.options.credentials.clearSession()
    try {
      if (this.methodOperationInProgress) throw new StudioServiceError('METHOD_ACTIVE', '请等待新方式比较完成。')
      if (this.active !== undefined || this.launchInProgress) await this.cancelWork('active')
      await this.options.runtime.clearConfiguration()
      await this.options.credentials.delete()
      return await this.credentialStatus()
    } finally {
      this.credentialMutationInProgress = false
    }
  }

  async selectModel(model: ModelChoice): Promise<StudioStatus> {
    await this.requirePendingWorkReconciled()
    if (this.active !== undefined || this.launchInProgress || this.methodOperationInProgress) {
      throw new StudioServiceError('WORK_ACTIVE', '请先结束当前创作，再切换模型。')
    }
    await this.options.settings.update({ selectedModel: model })
    return await this.getStatus()
  }

  async createSystem(input: CreateSystemInput): Promise<SystemSnapshot> {
    await this.requirePendingWorkReconciled()
    if (this.createInProgress || this.launchInProgress || this.active !== undefined || this.methodOperationInProgress) {
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
    await this.requirePendingWorkReconciled()
    const settings = await this.options.settings.load()
    if (settings.activeSystemId === null) return null
    const result = await this.callController('system_snapshot', {
      project: this.projectPath(settings.activeSystemId),
    })
    return parseSystemSnapshot(result, settings.activeSystemId)
  }

  async startWork(task: string): Promise<WorkRunHandle> {
    await this.requirePendingWorkReconciled()
    if (this.launchInProgress
      || this.active !== undefined
      || this.starting !== undefined
      || this.methodOperationInProgress
      || this.credentialMutationInProgress) {
      throw new StudioServiceError('WORK_ACTIVE', '已有创作正在进行。')
    }
    this.launchInProgress = true
    this.launchCancellationRequested = false
    this.launchBeginConfirmed = false
    const launchCompletion = createLaunchCompletion()
    this.launchCompletion = launchCompletion
    let lease: LoopbackGatewayLease | undefined
    let controllerRunId: string | undefined
    let dispatchId: string | undefined
    let project: string | undefined
    let systemId: string | undefined
    let pendingWork: PendingWorkIntent | undefined
    let runtimeRunId: string | undefined
    let launchOwnership: LaunchOwnership | undefined
    try {
      const credential = await this.credentialStatus()
      if (!credential.configured) {
        throw new StudioServiceError('CREDENTIAL_REQUIRED', '请先连接 DeepSeek API Key。')
      }
      const settings = await this.options.settings.load()
      if (settings.activeSystemId === null) {
        throw new StudioServiceError('SYSTEM_REQUIRED', '请先告诉我你想创作什么。')
      }
      systemId = settings.activeSystemId
      this.throwIfLaunchCancelled()
      project = this.projectPath(settings.activeSystemId)
      const rawCreativeSystem = await this.readProjectSnapshot(project, settings.activeSystemId)
      if (rawCreativeSystem === null) throw invalidControllerResponse()
      const creativeSystem = await this.requireFeedbackRecovery(rawCreativeSystem)
      const productionContext = await this.callController('production_context', { project })
      const contextSha256 = requiredSha256(productionContext.context_sha256)
      const methodVersion = requiredString(productionContext.method_version)
      const guidance = nullableString(productionContext.guidance)
      const guidanceSha256 = nullableSha256(productionContext.guidance_sha256)
      if ((guidance === null) !== (guidanceSha256 === null)
        || productionContext.initial_intent !== creativeSystem.initialIntent) {
        throw invalidControllerResponse()
      }
      controllerRunId = this.internalId('run')
      dispatchId = this.internalId('dispatch')
      const workId = this.internalId('work')
      const contextId = this.internalId('context')
      launchOwnership = {
        systemId,
        runId: controllerRunId,
        workId,
        dispatchId,
        contextId,
      }
      this.launchOwnership = launchOwnership
      const beginPayload = {
        run_id: controllerRunId,
        work_id: workId,
        task,
        loop: 'main-loop',
        dispatch_id: dispatchId,
        context_id: contextId,
        context_sha256: contextSha256,
        ...(creativeSystem.interruptedRun === null
          ? {}
          : { recovery_of: creativeSystem.interruptedRun.runId }),
      }
      pendingWork = await this.pendingWorkStore.createLaunching({
        createdAt: this.now(),
        systemId,
        beginPayload,
        beginExpectation: {
          method_version: methodVersion,
          method_guidance_sha256: guidanceSha256,
        },
      })
      this.currentPendingWork = pendingWork
      await this.beginControllerWork(project, pendingWork)
      this.launchBeginConfirmed = true
      this.throwIfLaunchCancelled()

      lease = this.options.loopback.issueLease('production', settings.selectedModel)
      if (lease.role !== 'production' || lease.model !== settings.selectedModel) throw invalidControllerResponse()
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
        maxTokens: MAX_DEEPSEEK_OUTPUT_TOKENS,
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
        contextSha256,
        lease,
        profileSha256,
        queuedEvents: [],
        pendingWork,
      }
      this.starting = starting
      const runtimeHandle = await this.options.runtime.startRun(
        creationInstruction(creativeSystem.initialIntent, task, guidance),
      )
      runtimeRunId = runtimeHandle.runId
      if (this.launchCancellationRequested) {
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
      const publicError = publicServiceError(error, '无法开始本次创作。')
      lease?.revoke()
      let prepared: PreparedTermination | undefined
      let persistenceError: unknown
      if (project !== undefined
        && systemId !== undefined
        && controllerRunId !== undefined
        && dispatchId !== undefined
        && pendingWork !== undefined
        && this.launchBeginConfirmed) {
        const cancelled = this.launchCancellationRequested
        try {
          prepared = await this.persistTerminationIntent({
            project,
            systemId,
            runId: controllerRunId,
            dispatchId,
            outcome: cancelled ? 'CANCELLED' : 'FAILED',
            reason: cancelled
              ? 'user-cancelled-during-launch'
              : 'runtime-launch-failed-before-output',
            ...(cancelled ? {} : { errorCode: publicError.code }),
            ...(launchState === undefined
              ? {}
              : { runtimeProvenance: runtimeProvenancePayload(
                  this.options.appVersion,
                  launchState,
                  launchState.lease.provenance(),
                ) }),
          }, pendingWork, true)
        } catch (caught) {
          persistenceError = caught
        }
      }
      this.starting = undefined
      await this.stopProductionRuntime(runtimeRunId)
      if (persistenceError !== undefined) throw pendingTerminationError()
      if (project !== undefined
        && systemId !== undefined
        && controllerRunId !== undefined
        && dispatchId !== undefined
        && pendingWork !== undefined) {
        const cancelled = this.launchCancellationRequested
        const expectation = {
          project,
          systemId,
          runId: controllerRunId,
          dispatchId,
          outcome: cancelled ? 'CANCELLED' : 'FAILED',
          reason: cancelled
            ? 'user-cancelled-during-launch'
            : 'runtime-launch-failed-before-output',
          ...(cancelled ? {} : { errorCode: publicError.code }),
          ...(launchState === undefined
            ? {}
            : { runtimeProvenance: runtimeProvenancePayload(
                this.options.appVersion,
                launchState,
                launchState.lease.provenance(),
              ) }),
        } satisfies TerminationExpectation
        if (prepared === undefined) {
          await this.terminateControllerDispatch(expectation, pendingWork)
        } else {
          await this.sealPreparedTermination(prepared)
        }
      }
      throw publicError
    } finally {
      this.launchInProgress = false
      this.launchBeginConfirmed = false
      if (this.launchOwnership === launchOwnership) this.launchOwnership = undefined
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
        let persistenceFailed = false
        try {
          await this.persistLaunchCancellation('user-cancelled-during-launch')
        } catch {
          persistenceFailed = true
        }
        await this.stopProductionRuntime()
        await this.launchCompletion?.promise
        if (persistenceFailed) throw pendingTerminationError()
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
    active.cancelReason ??= 'user-cancelled'
    active.lease.revoke()
    await this.finishUnsuccessful(active, active.cancelReason, 'cancelled', undefined, true)
  }

  async submitFeedback(input: SubmitFeedbackInput): Promise<SubmitFeedbackResult> {
    await this.requirePendingWorkReconciled()
    if (this.active !== undefined || this.launchInProgress || this.methodOperationInProgress) {
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

  async prepareMethodCandidate(observationId: string): Promise<SystemSnapshot> {
    return await this.withMethodOperation(async () => {
      const { project, systemId, model, snapshot } = await this.methodOperationContext()
      const observation = snapshot.observations.find(item => item.id === observationId)
      if (observation?.readyForCandidate !== true) {
        throw new StudioServiceError('EVIDENCE_INSUFFICIENT', '这条观察还没有来自三个独立作品的证据。')
      }
      const proposedCandidateId = this.internalId('method')
      const context = await this.callController('method_candidate_context', {
        project,
        candidate_id: proposedCandidateId,
        observation_id: observationId,
      })
      if (context.heldout_included !== false || context.observation_id !== observationId) {
        throw invalidControllerResponse()
      }
      const candidateId = requiredString(context.candidate_id)
      const builderRequired = requiredBoolean(context.builder_required)
      const expectedEpoch = parseMethodSourceEpoch(
        context.method_epoch,
        context.method_epoch_sha256,
        model,
        snapshot.method.activeVersion,
      )
      let completed = methodGenerationLabels(
        context.completed_generation_labels,
        context.generation_total,
      )
      let guidance: string
      let plan: JsonRecord
      if (builderRequired) {
        if (candidateId !== proposedCandidateId
          || completed.size !== 0
          || context.guidance !== null
          || context.evaluation_plan !== null) {
          throw invalidControllerResponse()
        }
        const sourceWorks = requiredRecordArray(context.source_works, 3)
        const builderContextSha256 = requiredSha256(context.builder_context_sha256)
        this.throwIfMethodCancelled()
        const builderIntentPayload = {
          project,
          candidate_id: candidateId,
          observation_id: observationId,
          builder_context_sha256: builderContextSha256,
          expected_epoch_sha256: expectedEpoch.sha256,
        } as const
        let builderIntentRecorded = false
        for (let attempt = 0; attempt < 2 && !builderIntentRecorded; attempt += 1) {
          try {
            const intent = await this.callController(
              'begin_method_candidate_preparation',
              builderIntentPayload,
            )
            if (intent.candidate_id !== candidateId
              || intent.observation_id !== observationId
              || intent.builder_context_sha256 !== builderContextSha256
              || intent.expected_epoch_sha256 !== expectedEpoch.sha256
              || typeof intent.idempotent !== 'boolean') {
              throw invalidControllerResponse()
            }
            requiredSha256(intent.intent_sha256)
            builderIntentRecorded = true
          } catch (error) {
            if (attempt === 1) throw error
          }
        }
        if (!builderIntentRecorded) throw invalidControllerResponse()
        const builder = await this.executeInternalGeneration({
          project,
          model,
          role: 'candidate',
          contextSha256: builderContextSha256,
          instruction: methodBuilderInstruction(
            requiredString(context.initial_intent, true),
            requiredString(context.feedback, true),
            nullableString(context.current_guidance),
            sourceWorks,
          ),
          expectedEpoch,
        })
        if (builder.runtimeProvenance === null) {
          const evidenceSha256 = builder.provenanceEvidenceSha256
          if (evidenceSha256 !== null) {
            const failurePayload = {
              project,
              candidate_id: candidateId,
              observation_id: observationId,
              builder_context_sha256: builderContextSha256,
              expected_epoch_sha256: expectedEpoch.sha256,
              observed_evidence_sha256: evidenceSha256,
              error_code: 'METHOD_EPOCH_UNVERIFIABLE',
            } as const
            let failureRecorded = false
            for (let attempt = 0; attempt < 2 && !failureRecorded; attempt += 1) {
              try {
                const receipt = await this.callController(
                  'record_method_builder_failure',
                  failurePayload,
                )
                if (receipt.candidate_id !== candidateId
                  || receipt.observation_id !== observationId
                  || receipt.error_code !== 'METHOD_EPOCH_UNVERIFIABLE'
                  || typeof receipt.idempotent !== 'boolean') {
                  throw invalidControllerResponse()
                }
                requiredSha256(receipt.failure_marker_sha256)
                failureRecorded = true
              } catch (error) {
                if (attempt === 1) throw error
              }
            }
          }
          throw builder.provenanceError ?? invalidControllerResponse()
        }
        guidance = normalizedGuidance(builder.output)
        const createPayload = {
          project,
          candidate_id: candidateId,
          observation_id: observationId,
          guidance,
          builder_role_id: 'method-candidate-builder',
          builder_context_id: `builder-context-${candidateId}`,
          builder_task_id: `builder-task-${candidateId}`,
          builder_attested_by: 'local-main-supervisor',
          builder_provenance: builder.runtimeProvenance,
        } as const
        let created: JsonRecord | undefined
        for (let attempt = 0; attempt < 2 && created === undefined; attempt += 1) {
          try {
            const candidate = await this.callController('create_method_candidate', createPayload)
            assertMethodCandidateCreationReadback(candidate, {
              candidateId,
              observationId,
              guidance,
              builderContextSha256,
              sourceEpochSha256: expectedEpoch.sha256,
            })
            created = candidate
          } catch (error) {
            if (attempt === 1) throw error
          }
        }
        if (created === undefined) throw invalidControllerResponse()
        completed = methodGenerationLabels(
          created.completed_generation_labels,
          created.generation_total,
        )
        if (completed.size !== 0) throw invalidControllerResponse()
        plan = requiredRecord(created.evaluation_plan)
      } else {
        guidance = requiredString(context.guidance)
        plan = requiredRecord(context.evaluation_plan)
      }
      const targeted = requiredRecord(plan.targeted)
      const regression = requiredRecord(plan.regression)
      const heldout = requiredRecord(plan.heldout)
      const initialIntent = requiredString(context.initial_intent, true)
      const currentGuidance = nullableString(context.current_guidance)
      const generations: ReadonlyArray<{
        readonly label: MethodGenerationLabel
        readonly input: InternalGenerationInput
      }> = [
        { label: 'targeted_candidate', input: {
          project, model, role: 'candidate',
          contextSha256: requiredSha256(targeted.candidate_context_sha256),
          instruction: creationInstruction(initialIntent, requiredString(targeted.task, true), guidance),
          expectedEpoch,
        } },
        { label: 'regression_candidate', input: {
          project, model, role: 'candidate',
          contextSha256: requiredSha256(regression.candidate_context_sha256),
          instruction: creationInstruction(initialIntent, requiredString(regression.task, true), guidance),
          expectedEpoch,
        } },
        { label: 'heldout_baseline', input: {
          project, model, role: 'production',
          contextSha256: requiredSha256(heldout.baseline_context_sha256),
          instruction: creationInstruction(initialIntent, requiredString(heldout.task, true), currentGuidance),
          expectedEpoch,
        } },
        { label: 'heldout_candidate', input: {
          project, model, role: 'candidate',
          contextSha256: requiredSha256(heldout.candidate_context_sha256),
          instruction: creationInstruction(initialIntent, requiredString(heldout.task, true), guidance),
          expectedEpoch,
        } },
      ]
      for (const generation of generations) {
        if (completed.has(generation.label)) continue
        this.throwIfMethodCancelled()
        const generationIntentPayload = {
          project,
          candidate_id: candidateId,
          label: generation.label,
          context_sha256: generation.input.contextSha256,
          expected_epoch_sha256: generation.input.expectedEpoch.sha256,
        } as const
        let generationIntentRecorded = false
        for (let attempt = 0; attempt < 2 && !generationIntentRecorded; attempt += 1) {
          try {
            const intent = await this.callController(
              'begin_method_generation',
              generationIntentPayload,
            )
            if (intent.candidate_id !== candidateId
              || intent.label !== generation.label
              || intent.context_sha256 !== generation.input.contextSha256
              || intent.expected_epoch_sha256 !== generation.input.expectedEpoch.sha256
              || typeof intent.idempotent !== 'boolean') {
              throw invalidControllerResponse()
            }
            requiredSha256(intent.intent_sha256)
            generationIntentRecorded = true
          } catch (error) {
            if (attempt === 1) throw error
          }
        }
        if (!generationIntentRecorded) throw invalidControllerResponse()
        const generated = await this.executeInternalGeneration(generation.input)
        if (generated.runtimeProvenance === null) {
          const evidenceSha256 = generated.provenanceEvidenceSha256
          if (evidenceSha256 === null) throw generated.provenanceError ?? invalidControllerResponse()
          const failurePayload = {
            project,
            candidate_id: candidateId,
            label: generation.label,
            context_sha256: generation.input.contextSha256,
            expected_epoch_sha256: generation.input.expectedEpoch.sha256,
            observed_evidence_sha256: evidenceSha256,
            error_code: 'METHOD_EPOCH_UNVERIFIABLE',
          } as const
          let failureRecorded = false
          for (let attempt = 0; attempt < 2 && !failureRecorded; attempt += 1) {
            try {
              const receipt = await this.callController('record_method_generation_failure', failurePayload)
              if (receipt.candidate_id !== candidateId
                || receipt.label !== generation.label
                || receipt.error_code !== 'METHOD_EPOCH_UNVERIFIABLE'
                || typeof receipt.failure_marker_sha256 !== 'string') {
                throw invalidControllerResponse()
              }
              requiredSha256(receipt.failure_marker_sha256)
              failureRecorded = true
            } catch (error) {
              if (attempt === 1) throw error
            }
          }
          throw generated.provenanceError ?? invalidControllerResponse()
        }
        const recorded = await this.callController('record_method_generation', {
          project,
          candidate_id: candidateId,
          label: generation.label,
          generation: {
            output: generated.output,
            runtime_provenance: generated.runtimeProvenance,
          },
        })
        if (recorded.candidate_id !== candidateId
          || recorded.label !== generation.label
          || typeof recorded.idempotent !== 'boolean') {
          throw invalidControllerResponse()
        }
        const nextCompleted = methodGenerationLabels(
          recorded.completed_generation_labels,
          recorded.generation_total,
        )
        if (!nextCompleted.has(generation.label)
          || [...completed].some(label => !nextCompleted.has(label))) {
          throw invalidControllerResponse()
        }
        completed = nextCompleted
      }
      if (completed.size !== METHOD_GENERATION_LABELS.length) throw invalidControllerResponse()
      this.throwIfMethodCancelled()
      const staged = await this.callController('stage_method_comparisons', {
        project,
        candidate_id: candidateId,
      })
      if (!isPlainRecord(staged.snapshot)) throw invalidControllerResponse()
      return parseSystemSnapshot(staged.snapshot, systemId)
    })
  }

  async submitMethodComparison(input: CompareCandidateInput): Promise<SystemSnapshot> {
    return await this.withMethodOperation(async () => {
      const { project, systemId } = await this.methodOperationContext()
      const result = await this.callController('submit_method_comparison', {
        project,
        candidate_id: input.candidateId,
        phase: input.phase,
        choice: input.choice,
      })
      if (!isPlainRecord(result.snapshot)) throw invalidControllerResponse()
      return parseSystemSnapshot(result.snapshot, systemId)
    })
  }

  async adoptMethodCandidate(candidateId: string): Promise<SystemSnapshot> {
    return await this.methodDecision('adopt_method_candidate', candidateId)
  }

  async rejectMethodCandidate(candidateId: string): Promise<SystemSnapshot> {
    return await this.methodDecision('reject_method_candidate', candidateId)
  }

  async rollbackMethod(version: string): Promise<SystemSnapshot> {
    return await this.withMethodOperation(async () => {
      const { project, systemId } = await this.methodOperationContext()
      const result = await this.callController('rollback_method', { project, to_version: version })
      if (!isPlainRecord(result.snapshot)) throw invalidControllerResponse()
      return parseSystemSnapshot(result.snapshot, systemId)
    })
  }

  acceptRuntimeEvent(event: RuntimeEvent): Promise<void> {
    const operation = this.eventQueue.then(() => this.processRuntimeEvent(event))
    this.eventQueue = operation.catch(() => undefined)
    return operation
  }

  async shutdown(): Promise<void> {
    let terminationPending = false
    if (this.launchInProgress) {
      this.launchCancellationRequested = true
      this.starting?.lease.revoke()
      let persistenceFailed = false
      try {
        await this.persistLaunchCancellation('application-closed-during-launch')
      } catch {
        persistenceFailed = true
      }
      await this.stopProductionRuntime()
      await this.launchCompletion?.promise
      terminationPending ||= persistenceFailed
    }
    const active = this.active
    if (active !== undefined) {
      active.cancelRequested = true
      active.cancelReason ??= 'application-closed'
      active.lease.revoke()
      try {
        await this.finishUnsuccessful(active, active.cancelReason, 'cancelled', undefined, true)
      } catch (error) {
        if (error instanceof StudioServiceError && error.code === 'WORK_TERMINATION_PENDING') {
          terminationPending = true
        } else {
          throw error
        }
      }
    }
    if (this.methodOperationInProgress) {
      this.methodCancellationRequested = true
      const internal = this.internalRun
      if (internal !== undefined) {
        internal.reject(new StudioServiceError('APPLICATION_CLOSED', '应用已关闭，新方式比较没有完成。'))
        await this.options.runtime.cancelRun(internal.runtimeRunId).catch(() => undefined)
      }
      await this.methodOperationCompletion
    }
    this.starting?.lease.revoke()
    this.starting = undefined
    await this.options.runtime.clearConfiguration()
    await this.options.loopback.close()
    if (terminationPending) throw pendingTerminationError()
  }

  private async methodDecision(
    operation: 'adopt_method_candidate' | 'reject_method_candidate',
    candidateId: string,
  ): Promise<SystemSnapshot> {
    return await this.withMethodOperation(async () => {
      const { project, systemId } = await this.methodOperationContext()
      const result = await this.callController(operation, { project, candidate_id: candidateId })
      if (!isPlainRecord(result.snapshot)) throw invalidControllerResponse()
      return parseSystemSnapshot(result.snapshot, systemId)
    })
  }

  private async methodOperationContext(): Promise<{
    readonly project: string
    readonly systemId: string
    readonly model: ModelChoice
    readonly snapshot: SystemSnapshot
  }> {
    const credential = await this.credentialStatus()
    if (!credential.configured) throw new StudioServiceError('CREDENTIAL_REQUIRED', '请先连接 DeepSeek API Key。')
    const settings = await this.options.settings.load()
    if (settings.activeSystemId === null) throw new StudioServiceError('SYSTEM_REQUIRED', '没有可改进的创作系统。')
    const project = this.projectPath(settings.activeSystemId)
    const snapshot = await this.readProjectSnapshot(project, settings.activeSystemId)
    if (snapshot === null) throw invalidControllerResponse()
    return {
      project,
      systemId: settings.activeSystemId,
      model: settings.selectedModel,
      snapshot: await this.requireFeedbackRecovery(snapshot),
    }
  }

  private async withMethodOperation<T>(action: () => Promise<T>): Promise<T> {
    await this.requirePendingWorkReconciled()
    if (this.methodOperationInProgress || this.active !== undefined || this.launchInProgress) {
      throw new StudioServiceError('METHOD_ACTIVE', '当前有创作或新方式比较正在进行。')
    }
    this.methodOperationInProgress = true
    this.methodCancellationRequested = false
    let resolveCompletion!: () => void
    const completion = new Promise<void>(resolve => { resolveCompletion = resolve })
    this.methodOperationCompletion = completion
    try {
      return await action()
    } finally {
      this.methodOperationInProgress = false
      this.methodCancellationRequested = false
      resolveCompletion()
      if (this.methodOperationCompletion === completion) {
        this.methodOperationCompletion = undefined
      }
    }
  }

  private async executeInternalGeneration(input: InternalGenerationInput): Promise<InternalGenerationResult> {
    this.throwIfMethodCancelled()
    assertMethodSourceEpochRuntime(input.expectedEpoch, input.model)
    const lease = this.options.loopback.issueLease(input.role, input.model)
    if (lease.role !== input.role || lease.model !== input.model) throw invalidControllerResponse()
    const workspaceDir = join(input.project, 'creative-system', 'runtime', `workspace-${input.role}`)
    const dshHome = join(this.systemsRoot, '..', 'runtime', 'dsh-home', input.role)
    let profileSha256: string | undefined
    let runtimeConfigured = false
    try {
      await Promise.all([
        mkdir(workspaceDir, { recursive: true }),
        mkdir(dshHome, { recursive: true, mode: 0o700 }),
      ])
      const spec = this.runtimeSpecFactory({
        nodeExecutable: this.options.nodeExecutable,
        cwd: workspaceDir,
        workspaceDir,
        dshHome,
        sessionRoot: workspaceDir,
        role: input.role,
        model: input.model,
        gateway: { url: lease.url, token: lease.token },
        maxTokens: MAX_DEEPSEEK_OUTPUT_TOKENS,
      })
      profileSha256 = await this.profileDigest(spec)
      if (profileSha256 !== input.expectedEpoch.profileSha256) {
        throw new StudioServiceError(
          'METHOD_EPOCH_CHANGED',
          '内置运行配置已变化；为避免混用模型基线，本次候选没有继续调用模型。请放弃本次准备后重新建立候选。',
        )
      }
      this.throwIfMethodCancelled()
      this.options.runtime.configure(spec)
      runtimeConfigured = true
      this.internalLaunchEvents = []
      const handle = await this.options.runtime.startRun(input.instruction)
      const completion = createInternalCompletion(handle.runId)
      this.internalRun = completion
      if (this.methodCancellationRequested) {
        completion.reject(new StudioServiceError('APPLICATION_CLOSED', '应用已关闭，新方式比较没有完成。'))
        await this.options.runtime.cancelRun(handle.runId).catch(() => undefined)
      }
      const queued = this.internalLaunchEvents
      this.internalLaunchEvents = undefined
      for (const event of queued ?? []) await this.processInternalRuntimeEvent(event)
      await withTimeout(completion.completion, 900_000, '新方式生成超过十五分钟，本轮没有记为成功。')
      if (completion.output === undefined || completion.output.trim() === '') {
        throw new StudioServiceError('EMPTY_OUTPUT', '模型没有返回可比较的内容。')
      }
      const observedProvenance = lease.provenance()
      try {
        const provenance = validatedProvenance(observedProvenance)
        return {
          output: completion.output,
          runtimeProvenance: runtimeProvenancePayload(
            this.options.appVersion,
            { contextSha256: input.contextSha256, model: input.model, profileSha256 },
            provenance,
          ),
          provenanceError: null,
          provenanceEvidenceSha256: null,
        }
      } catch (error) {
        if (!(error instanceof StudioServiceError) || error.code !== 'PROVENANCE_INCOMPLETE') throw error
        return {
          output: completion.output,
          runtimeProvenance: null,
          provenanceError: error,
          provenanceEvidenceSha256: methodProvenanceEvidenceSha256(
            input,
            profileSha256,
            observedProvenance,
          ),
        }
      }
    } finally {
      lease.revoke()
      this.internalLaunchEvents = undefined
      this.internalRun = undefined
      if (runtimeConfigured) await this.options.runtime.stop().catch(() => undefined)
    }
  }

  private async processInternalRuntimeEvent(event: RuntimeEvent): Promise<boolean> {
    const internal = this.internalRun
    if (internal === undefined) {
      if (this.internalLaunchEvents !== undefined) {
        this.internalLaunchEvents.push(event)
        return true
      }
      return false
    }
    if (event.runId !== internal.runtimeRunId) return false
    if (event.type === 'output') internal.output = event.text
    if (event.type === 'error') {
      internal.errorCode = event.code
      internal.errorMessage = event.message
    }
    if (event.type === 'state' && event.state === 'completed') internal.resolve()
    if (event.type === 'state' && (event.state === 'failed' || event.state === 'cancelled')) {
      internal.reject(new StudioServiceError(
        internal.errorCode ?? 'RUNTIME_FAILED',
        internal.errorMessage ?? '新方式生成没有完成。',
      ))
    }
    return true
  }

  private async processRuntimeEvent(event: RuntimeEvent): Promise<void> {
    if (await this.processInternalRuntimeEvent(event)) return
    const active = this.active
    if (active === undefined) {
      if (this.starting !== undefined) this.starting.queuedEvents.push(event)
      return
    }
    if (event.runId !== active.runtimeRunId) return
    if (active.terminalTask !== undefined) return
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
        await this.clearPendingWork(active.pendingWork).catch(() => undefined)
        active.lease.revoke()
        await this.options.runtime.stop().catch(() => undefined)
        if (this.active === active) this.active = undefined
        this.options.emit({ type: 'state', runId: active.controllerRunId, state: 'completed' })
      } catch (error) {
        const commitError = publicServiceError(error, '作品未能安全保存，本次没有记为成功。')
        await this.performUnsuccessful(
          active,
          'completion-evidence-or-commit-failed',
          'failed',
          commitError.message,
          'COMMIT_FAILED',
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
    cancelRuntime = false,
  ): Promise<void> {
    if (active.terminalTask !== undefined) return await active.terminalTask
    active.terminalTask = this.performUnsuccessful(active, reason, state, message, undefined, cancelRuntime)
    return await active.terminalTask
  }

  private async performUnsuccessful(
    active: ActiveWork,
    reason: string,
    state: 'cancelled' | 'failed',
    message?: string,
    errorCode?: string,
    cancelRuntime = false,
  ): Promise<void> {
    active.lease.revoke()
    const effectiveState = active.runtimeErrorCode === undefined ? state : 'failed'
    const effectiveReason = effectiveState === 'failed' && state === 'cancelled'
      ? 'runtime-failed-before-commit'
      : reason
    const failure = effectiveState === 'failed'
      ? classifiedRuntimeFailure(active, errorCode, message)
      : undefined
    let prepared: PreparedTermination | undefined
    let persistenceError: unknown
    try {
      prepared = await this.persistTerminationIntent({
        project: active.project,
        systemId: active.systemId,
        runId: active.controllerRunId,
        dispatchId: active.dispatchId,
        outcome: effectiveState === 'failed' ? 'FAILED' : 'CANCELLED',
        reason: effectiveReason,
        ...(failure === undefined ? {} : { errorCode: failure.code }),
        runtimeProvenance: runtimeProvenancePayload(
          this.options.appVersion,
          active,
          active.lease.provenance(),
        ),
      }, active.pendingWork, true)
    } catch (caught) {
      persistenceError = caught
    }
    await this.stopProductionRuntime(cancelRuntime ? active.runtimeRunId : undefined)
    if (persistenceError !== undefined || prepared === undefined) {
      if (this.active === active) this.active = undefined
      this.options.emit({
        type: 'error',
        runId: active.controllerRunId,
        code: 'WORK_TERMINATION_PENDING',
        message: pendingTerminationError().message,
      })
      this.options.emit({ type: 'state', runId: active.controllerRunId, state: 'failed' })
      throw pendingTerminationError()
    }
    try {
      await this.sealPreparedTermination(prepared)
    } catch (error) {
      if (this.active === active) this.active = undefined
      const pending = publicServiceError(
        error,
        '生成已经停止，但失败记录还没有安全封存。请重启应用后恢复；本次不会计为作品或学习证据。',
      )
      this.options.emit({
        type: 'error',
        runId: active.controllerRunId,
        code: 'WORK_TERMINATION_PENDING',
        message: pending.message,
      })
      this.options.emit({ type: 'state', runId: active.controllerRunId, state: 'failed' })
      return
    }
    if (this.active === active) this.active = undefined
    if (effectiveState === 'failed') {
      this.options.emit({
        type: 'error',
        runId: active.controllerRunId,
        code: failure?.code ?? 'RUNTIME_FAILED',
        message: failure?.message ?? '本次创作未完成，请重试。',
      })
    }
    this.options.emit({ type: 'state', runId: active.controllerRunId, state: effectiveState })
  }

  private emitForControllerRun(active: ActiveWork, event: RuntimeEvent): void {
    this.options.emit({ ...event, runId: active.controllerRunId })
  }

  private async beginControllerWork(project: string, pending: PendingWorkIntent): Promise<void> {
    let failure: unknown
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const begun = await this.callController('begin_work', {
          project,
          ...pending.begin_payload,
        })
        validateBeginReceipt(begun, pending)
        return
      } catch (error) {
        failure = error
      }
    }
    throw failure
  }

  private async persistLaunchCancellation(reason: string): Promise<void> {
    const pending = this.currentPendingWork
    if (!this.launchBeginConfirmed || pending === undefined) return
    const starting = this.starting
    await this.persistTerminationIntent({
      project: this.projectPath(pending.system_id),
      systemId: pending.system_id,
      runId: pending.run_id,
      dispatchId: pending.dispatch_id,
      outcome: 'CANCELLED',
      reason,
      ...(starting === undefined
        ? {}
        : { runtimeProvenance: runtimeProvenancePayload(
            this.options.appVersion,
            starting,
            starting.lease.provenance(),
          ) }),
    }, pending, true)
  }

  private async stopProductionRuntime(runtimeRunId?: string): Promise<void> {
    const operations: Promise<unknown>[] = []
    if (runtimeRunId !== undefined) operations.push(this.options.runtime.cancelRun(runtimeRunId))
    operations.push(this.options.runtime.stop())
    await Promise.allSettled(operations)
  }

  private async terminateControllerDispatch(
    input: TerminationExpectation,
    pending: PendingWorkIntent,
  ): Promise<void> {
    await this.sealPreparedTermination(await this.persistTerminationIntent(input, pending))
  }

  private async persistTerminationIntent(
    input: TerminationExpectation,
    pending: PendingWorkIntent,
    beginConfirmed = false,
  ): Promise<PreparedTermination> {
    if (!beginConfirmed) await this.ensureBeginBeforeTermination(input.project, pending)
    const durable = await this.pendingWorkStore.requireTermination(
      pending,
      pendingTerminationExpectation(input),
    )
    if (this.currentPendingWork?.run_id === durable.run_id) this.currentPendingWork = durable
    const expected = terminationExpectationFromPending(input.project, durable)
    return { pending: durable, expected }
  }

  private async sealPreparedTermination(prepared: PreparedTermination): Promise<void> {
    const { expected, pending } = prepared
    const payload = {
      project: expected.project,
      run_id: expected.runId,
      dispatch_id: expected.dispatchId,
      outcome: expected.outcome,
      reason: expected.reason,
      ...(expected.errorCode === undefined ? {} : { error_code: expected.errorCode }),
      ...(expected.runtimeProvenance === undefined ? {} : { runtime_provenance: expected.runtimeProvenance }),
    } as const
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const receipt = await this.callController('terminate_work', payload)
        validateTerminationReceipt(receipt, expected)
        await this.clearPendingWork(pending)
        return
      } catch {
        if (attempt === 0) continue
      }
    }
    try {
      const snapshot = await this.readProjectSnapshot(expected.project, expected.systemId)
      if (snapshot !== null && confirmsTermination(snapshot, expected)) {
        await this.clearPendingWork(pending)
        return
      }
    } catch {
      // The public error below is the only state exposed when both receipt and
      // read-back verification fail. It intentionally contains no local path.
    }
    throw new StudioServiceError(
      'WORK_TERMINATION_PENDING',
      '生成已经停止，但失败记录还没有安全封存。请重启应用后恢复；本次不会计为作品或学习证据。',
    )
  }

  private async ensureBeginBeforeTermination(project: string, pending: PendingWorkIntent): Promise<void> {
    if (pending.phase === 'TERMINATION_REQUIRED') return
    try {
      await this.beginControllerWork(project, pending)
      return
    } catch {
      try {
        const snapshot = await this.readProjectSnapshot(project, pending.system_id)
        if (snapshot !== null && confirmsOpenedDispatch(snapshot, pending)) return
      } catch {
        // Keep the LAUNCHING intent intact. A later startup will replay the
        // exact begin payload before any terminal semantic is committed.
      }
      throw new StudioServiceError(
        'WORK_TERMINATION_PENDING',
        '生成已经停止，但本地创作记录尚未确认打开。请重启应用恢复；恢复完成前不会开始新创作。',
      )
    }
  }

  private async clearPendingWork(pending: PendingWorkIntent): Promise<void> {
    await this.pendingWorkStore.clear(pending)
    if (this.currentPendingWork?.run_id === pending.run_id) this.currentPendingWork = undefined
  }

  private async requirePendingWorkReconciled(): Promise<void> {
    try {
      await this.reconcilePendingWork()
    } catch {
      throw new StudioServiceError(
        'WORK_TERMINATION_PENDING',
        '上次创作的失败记录还没有安全封存。请重试或重启应用；恢复完成前不会开始新创作。',
      )
    }
  }

  private async reconcilePendingWork(): Promise<boolean> {
    const existing = this.pendingRecoveryTask
    if (existing !== undefined) return await existing
    const operation = this.reconcilePendingWorkOnce()
    this.pendingRecoveryTask = operation
    try {
      return await operation
    } finally {
      if (this.pendingRecoveryTask === operation) this.pendingRecoveryTask = undefined
    }
  }

  private async reconcilePendingWorkOnce(): Promise<boolean> {
    let pending = await this.pendingWorkStore.load()
    if (pending === null) return false
    if (this.isLivePendingWork(pending)) return false
    const project = this.projectPath(pending.system_id)
    let snapshot: SystemSnapshot | null = null
    try {
      snapshot = await this.readProjectSnapshot(project, pending.system_id)
    } catch {
      // The exact idempotent Controller operations below are the recovery path
      // when a snapshot response is unavailable or malformed.
    }
    if (snapshot !== null && confirmsCompletedWork(snapshot, pending)) {
      await this.clearPendingWork(pending)
      return true
    }
    if (snapshot !== null
      && pending.termination_expectation !== null
      && confirmsTermination(snapshot, terminationExpectationFromPending(project, pending))) {
      await this.clearPendingWork(pending)
      return true
    }
    if (pending.phase === 'LAUNCHING') {
      await this.terminateControllerDispatch({
        project,
        systemId: pending.system_id,
        runId: pending.run_id,
        dispatchId: pending.dispatch_id,
        outcome: 'CANCELLED',
        reason: 'application-restarted-before-terminal-commit',
      }, pending)
      return true
    }
    await this.terminateControllerDispatch(
      terminationExpectationFromPending(project, pending),
      pending,
    )
    return true
  }

  private isLivePendingWork(pending: PendingWorkIntent): boolean {
    if (!this.launchInProgress && this.starting === undefined && this.active === undefined) return false
    const launchOwnership = this.launchOwnership
    if (launchOwnership !== undefined
      && launchOwnership.systemId === pending.system_id
      && launchOwnership.runId === pending.run_id
      && launchOwnership.workId === pending.work_id
      && launchOwnership.dispatchId === pending.dispatch_id
      && launchOwnership.contextId === pending.context_id) {
      return true
    }
    return this.currentPendingWork?.content_hash === pending.content_hash
      || this.starting?.controllerRunId === pending.run_id
      || this.active?.controllerRunId === pending.run_id
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

  private throwIfMethodCancelled(): void {
    if (this.methodCancellationRequested) {
      throw new StudioServiceError('APPLICATION_CLOSED', '应用已关闭，新方式比较没有完成。')
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
    dsh_version: SUPPORTED_DSH_RUNTIME_VERSION,
    profile_sha256: active.profileSha256,
    context_sha256: active.contextSha256,
    requested_model: active.model,
    returned_model: returnedModel ?? null,
    system_fingerprint: fingerprint ?? null,
    response_id: provenance.responseId ?? null,
    parameters: {
      thinking: 'enabled',
      reasoning_effort: 'high',
      max_tokens: MAX_DEEPSEEK_OUTPUT_TOKENS,
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

function validateBeginReceipt(receipt: JsonRecord, pending: PendingWorkIntent): void {
  const begin = pending.begin_payload
  const expectation = pending.begin_expectation
  if (receipt.run_id !== pending.run_id
    || receipt.dispatch_id !== pending.dispatch_id
    || receipt.work_id !== pending.work_id
    || receipt.task_sha256 !== createHash('sha256').update(begin.task, 'utf8').digest('hex')
    || receipt.context_sha256 !== begin.context_sha256
    || receipt.method_version !== expectation.method_version
    || (receipt.method_guidance_sha256 ?? null) !== expectation.method_guidance_sha256) {
    throw invalidControllerResponse()
  }
}

function pendingTerminationExpectation(input: TerminationExpectation): PendingTerminationExpectation {
  if (input.outcome === 'FAILED' && input.errorCode === undefined) throw invalidControllerResponse()
  return {
    outcome: input.outcome,
    reason: input.reason,
    error_code: input.errorCode ?? null,
    runtime_provenance: input.runtimeProvenance ?? null,
  }
}

function terminationExpectationFromPending(
  project: string,
  pending: PendingWorkIntent,
): TerminationExpectation {
  const expectation = pending.termination_expectation
  if (expectation === null) throw invalidControllerResponse()
  return {
    project,
    systemId: pending.system_id,
    runId: pending.run_id,
    dispatchId: pending.dispatch_id,
    outcome: expectation.outcome,
    reason: expectation.reason,
    ...(expectation.error_code === null ? {} : { errorCode: expectation.error_code }),
    ...(expectation.runtime_provenance === null
      ? {}
      : { runtimeProvenance: expectation.runtime_provenance }),
  }
}

function confirmsCompletedWork(snapshot: SystemSnapshot, pending: PendingWorkIntent): boolean {
  const work = snapshot.lastWork
  return work !== null
    && work.runId === pending.run_id
    && work.workId === pending.work_id
    && work.runtimeProvenanceSha256 !== null
    && work.reviewSubjectSha256 !== null
}

function confirmsOpenedDispatch(snapshot: SystemSnapshot, pending: PendingWorkIntent): boolean {
  const interrupted = snapshot.interruptedRun
  return interrupted !== null
    && interrupted.runId === pending.run_id
    && interrupted.workId === pending.work_id
    && interrupted.dispatchId === pending.dispatch_id
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

function validateTerminationReceipt(
  receipt: JsonRecord,
  expected: TerminationExpectation,
): void {
  if (receipt.run_id !== expected.runId
    || receipt.dispatch_id !== expected.dispatchId
    || receipt.outcome !== expected.outcome
    || receipt.execution_status !== 'BLOCK'
    || receipt.finding_eligible !== false
    || typeof receipt.idempotent !== 'boolean') {
    throw invalidControllerResponse()
  }
  requiredString(receipt.attempt_id)
  requiredString(receipt.terminal_receipt)
  requiredSha256(receipt.terminal_receipt_sha256)
  requiredBoolean(receipt.content_attempt_consumed)
}

function confirmsTermination(
  snapshot: SystemSnapshot,
  expected: TerminationExpectation,
): boolean {
  const interrupted = snapshot.interruptedRun
  return snapshot.recoveryRequired
    && interrupted !== null
    && interrupted.runId === expected.runId
    && interrupted.dispatchId === expected.dispatchId
    && interrupted.state === `TERMINATED_${expected.outcome}`
    && interrupted.outcome === expected.outcome
    && interrupted.executionStatus === 'BLOCK'
    && interrupted.findingEligible === false
    && interrupted.terminalReceipt !== undefined
    && interrupted.terminalReceiptSha256 !== undefined
    && interrupted.contentAttemptConsumed !== undefined
    && (expected.outcome === 'FAILED'
      ? interrupted.reasonCode === expected.errorCode
      : interrupted.reasonCode === expected.reason)
}

function classifiedRuntimeFailure(
  active: ActiveWork,
  explicitCode?: string,
  explicitMessage?: string,
): { readonly code: RuntimeErrorCode; readonly message: string } {
  const provenance = active.lease.provenance()
  const lastRequest = provenance.requests[provenance.requests.length - 1]
  const latestFailedCode = lastRequest?.status === 'FAILED' ? lastRequest.errorCode : undefined
  const preciseTimeout: RuntimeErrorCode | undefined = latestFailedCode === 'DEEPSEEK_FIRST_EVENT_TIMEOUT'
    || latestFailedCode === 'DEEPSEEK_STREAM_IDLE_TIMEOUT'
    || latestFailedCode === 'DEEPSEEK_TOTAL_TIMEOUT'
    ? latestFailedCode
    : undefined
  const code: RuntimeErrorCode = explicitCode === 'COMMIT_FAILED'
    ? 'COMMIT_FAILED'
    : preciseTimeout ?? active.runtimeErrorCode ?? 'RUNTIME_FAILED'
  if (explicitMessage !== undefined && explicitCode !== undefined) {
    return { code, message: explicitMessage }
  }
  const attempts = provenance.requestCount
  const attemptText = attempts > 0 ? `（本次共发起 ${attempts} 次请求）` : ''
  if (code === 'DEEPSEEK_FIRST_EVENT_TIMEOUT') {
    return {
      code,
      message: `DeepSeek 在两分钟内没有开始返回内容${attemptText}，本次没有保存。请稍后重试。`,
    }
  }
  if (code === 'DEEPSEEK_STREAM_IDLE_TIMEOUT') {
    return {
      code,
      message: `DeepSeek 已开始生成，但九十秒没有新进展${attemptText}；未完成内容不会保存。`,
    }
  }
  if (code === 'DEEPSEEK_TOTAL_TIMEOUT') {
    return {
      code,
      message: `DeepSeek 生成已达到十分钟上限${attemptText}；未完成内容不会保存。`,
    }
  }
  return {
    code,
    message: explicitMessage ?? active.runtimeError ?? '本次创作未完成，请重试。',
  }
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
      methodVersion: requiredString(lastWorkValue.method_version),
      methodGuidanceSha256: nullableSha256(lastWorkValue.method_guidance_sha256),
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
  const learning = requiredRecord(value.learning)
  const observations = requiredRecordArray(learning.observations).map(item => ({
    id: requiredString(item.id),
    findingCode: requiredString(item.finding_code),
    feedback: requiredString(item.feedback, true),
    independentWorks: requiredNonNegativeNumber(item.independent_works),
    independentRuns: requiredNonNegativeNumber(item.independent_runs),
    independentTasks: requiredNonNegativeNumber(item.independent_tasks),
    readyForCandidate: requiredBoolean(item.ready_for_candidate),
  }))
  const adoptedPrinciples = requiredRecordArray(learning.adopted_principles).map(item => ({
    version: requiredString(item.version),
    guidance: requiredString(item.guidance, true),
    adoptedAt: requiredString(item.adopted_at),
    active: requiredBoolean(item.active),
  }))
  const methodValue = requiredRecord(value.method)
  const method = {
    activeVersion: requiredString(methodValue.active_version),
    activeGuidance: nullableString(methodValue.active_guidance),
    history: requiredRecordArray(methodValue.history).map(parseMethodHistory),
  }
  const methodCandidates = requiredRecordArray(value.method_candidates).map(parseMethodCandidate)
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
    observations,
    adoptedPrinciples,
    method,
    methodCandidates,
  }
}

function parseMethodHistory(value: JsonRecord): SystemSnapshot['method']['history'][number] {
  const action = value.action
  if (action !== 'PROMOTE' && action !== 'ROLLBACK') throw invalidControllerResponse()
  return {
    action,
    version: requiredString(value.version),
    previousVersion: requiredString(value.previous_version),
    createdAt: requiredString(value.created_at),
  }
}

function parseMethodCandidate(value: JsonRecord): SystemSnapshot['methodCandidates'][number] {
  const status = requiredString(value.status)
  if (!['CANDIDATE', 'EVALUATING', 'READY_FOR_HUMAN', 'BLOCKED', 'PROMOTED', 'REJECTED'].includes(status)) {
    throw invalidControllerResponse()
  }
  const adoptionPending = requiredBoolean(value.adoption_pending)
  const rolledBack = requiredBoolean(value.rolled_back)
  const completedGenerationCount = requiredNonNegativeNumber(value.preparation_completed)
  const generationTotal = requiredNonNegativeNumber(value.preparation_total)
  const resumable = requiredBoolean(value.preparation_resumable)
  const preparationBlockedReason = nullableString(value.preparation_blocked_reason)
  if (adoptionPending && rolledBack) throw invalidControllerResponse()
  if ((adoptionPending || rolledBack) && status !== 'PROMOTED') throw invalidControllerResponse()
  if (generationTotal !== 4 || completedGenerationCount > generationTotal) throw invalidControllerResponse()
  if (resumable && (status !== 'CANDIDATE' || preparationBlockedReason !== null)) {
    throw invalidControllerResponse()
  }
  if (status === 'CANDIDATE' && !resumable && preparationBlockedReason === null) {
    throw invalidControllerResponse()
  }
  const comparisons = requiredRecordArray(value.comparisons).map(item => {
    const phase = item.phase
    const choice = item.choice
    if (phase !== 'targeted' && phase !== 'regression' && phase !== 'heldout') throw invalidControllerResponse()
    if (choice !== null && choice !== undefined && choice !== 'A' && choice !== 'B' && choice !== 'TIE') {
      throw invalidControllerResponse()
    }
    return {
      phase: phase as 'targeted' | 'regression' | 'heldout',
      left: requiredString(item.left, true),
      right: requiredString(item.right, true),
      choice: (choice ?? null) as 'A' | 'B' | 'TIE' | null,
    }
  })
  const comparisonPhases = new Set(comparisons.map(item => item.phase))
  if (comparisons.length !== comparisonPhases.size
    || (comparisons.length !== 0
      && (comparisons.length !== 3
        || !comparisonPhases.has('targeted')
        || !comparisonPhases.has('regression')
        || !comparisonPhases.has('heldout')))) {
    throw invalidControllerResponse()
  }
  if (status !== 'CANDIDATE' && status !== 'REJECTED' && comparisons.length !== 3) {
    throw invalidControllerResponse()
  }
  const allComparisonsDecided = comparisons.length === 3
    && comparisons.every(item => item.choice !== null)
  if (['READY_FOR_HUMAN', 'BLOCKED', 'PROMOTED'].includes(status) && !allComparisonsDecided) {
    throw invalidControllerResponse()
  }
  const ready = requiredBoolean(value.ready)
  if (ready !== (status === 'READY_FOR_HUMAN')) throw invalidControllerResponse()
  return {
    id: requiredString(value.id),
    observationId: requiredString(value.observation_id),
    title: requiredString(value.title),
    summary: requiredString(value.summary, true),
    tradeoff: requiredString(value.tradeoff, true),
    status,
    ready,
    adoptionPending,
    rolledBack,
    completedGenerationCount,
    generationTotal,
    resumable,
    preparationBlockedReason,
    comparisons,
  }
}

function parseInterruptedRun(value: unknown): SystemSnapshot['interruptedRun'] {
  if (value === null || value === undefined) return null
  if (!isPlainRecord(value)) throw invalidControllerResponse()
  const base = {
    runId: requiredString(value.run_id),
    workId: requiredString(value.work_id),
    attemptId: requiredString(value.attempt_id),
    dispatchId: nullableString(value.dispatch_id),
    state: requiredString(value.state),
    reasonCode: requiredString(value.reason_code),
  }
  if (base.state === 'TERMINATED_FAILED' || base.state === 'TERMINATED_CANCELLED') {
    const outcome = requiredString(value.outcome)
    const terminationClass = requiredString(value.termination_class)
    if ((outcome !== 'FAILED' && outcome !== 'CANCELLED')
      || (terminationClass !== 'ZERO_FILE_RUNTIME_FAILURE'
        && terminationClass !== 'UNCOMMITTED_OUTPUT_FAILURE')
      || value.execution_status !== 'BLOCK'
      || value.finding_eligible !== false) {
      throw invalidControllerResponse()
    }
    return {
      ...base,
      outcome,
      executionStatus: 'BLOCK',
      terminationClass,
      terminalReceipt: requiredString(value.terminal_receipt),
      terminalReceiptSha256: requiredSha256(value.terminal_receipt_sha256),
      contentAttemptConsumed: requiredBoolean(value.content_attempt_consumed),
      findingEligible: false,
    }
  }
  return base
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
    persistence: value.persistence,
  }
}

function defaultDisplayName(intent: string): string {
  const compact = intent.replace(/\s+/gu, ' ').trim()
  const beginning = Array.from(compact).slice(0, 28).join('')
  return beginning.length < compact.length ? `${beginning}…` : beginning
}

function creationInstruction(initialIntent: string, task: string, guidance: string | null = null): string {
  return [
    '完成下面的创意写作任务。',
    '只输出可供用户直接阅读和编辑的成品，不解释过程，不把推测的偏好写成永久规则。',
    '',
    '用户首次确认的创作方向（保留原意，不扩写为新规则）：',
    initialIntent,
    ...(guidance === null
      ? []
      : [
          '',
          '用户已经通过盲比并明确采用的当前创作方法（必须用于本次作品）：',
          guidance,
        ]),
    '',
    '本次任务：',
    task,
  ].join('\n')
}

function methodBuilderInstruction(
  initialIntent: string,
  feedback: string,
  currentGuidance: string | null,
  sourceWorks: readonly JsonRecord[],
): string {
  const evidence = sourceWorks.map((work, index) => [
    `作品 ${index + 1} 任务：${requiredString(work.task, true)}`,
    `作品 ${index + 1} 文本：${requiredString(work.output, true)}`,
  ].join('\n')).join('\n\n')
  return [
    '你是创作方法候选 Builder。根据三个独立作品上完全相同的用户明确反馈，提出一条可执行、可复用的创作指导。',
    '只输出这条指导本身，最多三句话；不得输出标题、代码、JSON、评价结论或 held-out 内容。',
    '',
    `创作方向：${initialIntent}`,
    `用户重复反馈：${feedback}`,
    `当前已采用指导：${currentGuidance ?? '无，使用通用起步方法'}`,
    '',
    evidence,
  ].join('\n')
}

function normalizedGuidance(value: string): string {
  const result = value.trim()
  if (result === '' || Buffer.byteLength(result, 'utf8') > 2_000 || result.includes('```') || /<script/iu.test(result)) {
    throw new StudioServiceError('CANDIDATE_INVALID', '模型没有返回可安全比较的声明式创作指导。')
  }
  return result
}

function assertMethodCandidateCreationReadback(
  value: JsonRecord,
  expected: {
    readonly candidateId: string
    readonly observationId: string
    readonly guidance: string
    readonly builderContextSha256: string
    readonly sourceEpochSha256: string
  },
): void {
  if (value.candidate_id !== expected.candidateId
    || value.observation_id !== expected.observationId
    || value.lifecycle !== 'CANDIDATE'
    || value.guidance !== expected.guidance
    || value.guidance_sha256 !== createHash('sha256').update(expected.guidance, 'utf8').digest('hex')
    || value.builder_context_sha256 !== expected.builderContextSha256
    || value.source_epoch_sha256 !== expected.sourceEpochSha256
    || typeof value.idempotent !== 'boolean') {
    throw invalidControllerResponse()
  }
  requiredSha256(value.builder_provenance_sha256)
  requiredSha256(value.proposal_sha256)
}

function methodProvenanceEvidenceSha256(
  input: InternalGenerationInput,
  profileSha256: string,
  value: LoopbackLeaseProvenance,
): string {
  const evidence = {
    completed_requests: value.completedRequests,
    failed_requests: value.failedRequests,
    parameters: {
      max_tokens: MAX_DEEPSEEK_OUTPUT_TOKENS,
      reasoning_effort: 'high',
      thinking: 'enabled',
    },
    profile_sha256: profileSha256,
    request_count: value.requestCount,
    requested_model: input.model,
    returned_models: [...value.returnedModels].sort(),
    system_fingerprints: [...value.systemFingerprints].sort(),
    requests: value.requests.map(request => ({
      request_number: request.requestNumber,
      status: request.status,
      returned_model: request.returnedModel ?? null,
      system_fingerprint: request.systemFingerprint ?? null,
    })),
  }
  return createHash('sha256').update(`${JSON.stringify(evidence)}\n`, 'utf8').digest('hex')
}

function methodGenerationLabels(value: unknown, totalValue: unknown): Set<MethodGenerationLabel> {
  if (requiredNonNegativeNumber(totalValue) !== METHOD_GENERATION_LABELS.length || !Array.isArray(value)) {
    throw invalidControllerResponse()
  }
  const allowed = new Set<string>(METHOD_GENERATION_LABELS)
  const labels = value.map(item => requiredString(item))
  if (new Set(labels).size !== labels.length || labels.some(label => !allowed.has(label))) {
    throw invalidControllerResponse()
  }
  return new Set(labels as MethodGenerationLabel[])
}

function parseMethodSourceEpoch(
  value: unknown,
  sha256Value: unknown,
  selectedModel: ModelChoice,
  activeMethodVersion: string,
): MethodSourceEpoch {
  const epoch = requiredRecord(value)
  if (!hasExactKeys(epoch, [
    'method_version',
    'parameters',
    'profile_sha256',
    'requested_model',
    'returned_model',
    'system_fingerprint',
  ])) {
    throw invalidControllerResponse()
  }
  const parameters = requiredRecord(epoch.parameters)
  if (!hasExactKeys(parameters, ['max_tokens', 'reasoning_effort', 'thinking'])) {
    throw invalidControllerResponse()
  }
  const methodVersion = requiredString(epoch.method_version)
  const requestedModel = requiredModelChoice(epoch.requested_model)
  const returnedModel = requiredModelChoice(epoch.returned_model)
  const sourceEpoch: MethodSourceEpoch = {
    sha256: requiredSha256(sha256Value),
    methodVersion,
    requestedModel,
    returnedModel,
    systemFingerprint: requiredString(epoch.system_fingerprint),
    profileSha256: requiredSha256(epoch.profile_sha256),
    parameters: {
      thinking: parameters.thinking === 'enabled' ? 'enabled' : invalidMethodEpoch(),
      reasoningEffort: parameters.reasoning_effort === 'high' ? 'high' : invalidMethodEpoch(),
      maxTokens: requiredNonNegativeNumber(parameters.max_tokens),
    },
  }
  const canonical = {
    method_version: sourceEpoch.methodVersion,
    parameters: {
      max_tokens: sourceEpoch.parameters.maxTokens,
      reasoning_effort: sourceEpoch.parameters.reasoningEffort,
      thinking: sourceEpoch.parameters.thinking,
    },
    profile_sha256: sourceEpoch.profileSha256,
    requested_model: sourceEpoch.requestedModel,
    returned_model: sourceEpoch.returnedModel,
    system_fingerprint: sourceEpoch.systemFingerprint,
  }
  const actualSha256 = createHash('sha256').update(`${JSON.stringify(canonical)}\n`, 'utf8').digest('hex')
  if (actualSha256 !== sourceEpoch.sha256
    || sourceEpoch.methodVersion !== activeMethodVersion
    || sourceEpoch.requestedModel !== selectedModel
    || sourceEpoch.returnedModel !== selectedModel
    || sourceEpoch.parameters.maxTokens !== MAX_DEEPSEEK_OUTPUT_TOKENS) {
    throw new StudioServiceError(
      'METHOD_EPOCH_CHANGED',
      '当前模型基线与候选来源不一致；本次没有调用模型。请放弃本次准备后重新建立候选。',
    )
  }
  return sourceEpoch
}

function assertMethodSourceEpochRuntime(epoch: MethodSourceEpoch, selectedModel: ModelChoice): void {
  if (epoch.requestedModel !== selectedModel
    || epoch.returnedModel !== selectedModel
    || epoch.parameters.thinking !== 'enabled'
    || epoch.parameters.reasoningEffort !== 'high'
    || epoch.parameters.maxTokens !== MAX_DEEPSEEK_OUTPUT_TOKENS) {
    throw new StudioServiceError(
      'METHOD_EPOCH_CHANGED',
      '当前模型或固定生成参数已变化；本次没有调用模型。请放弃本次准备后重新建立候选。',
    )
  }
}

function requiredModelChoice(value: unknown): ModelChoice {
  if (value !== 'deepseek-v4-pro' && value !== 'deepseek-v4-flash') throw invalidControllerResponse()
  return value
}

function invalidMethodEpoch(): never {
  throw new StudioServiceError(
    'METHOD_EPOCH_CHANGED',
    '当前固定生成参数与候选来源不一致；本次没有调用模型。请放弃本次准备后重新建立候选。',
  )
}

function hasExactKeys(value: JsonRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index])
}

function createInternalCompletion(runId: string): InternalModelRun {
  let resolvePromise!: () => void
  let rejectPromise!: (error: Error) => void
  const completion = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return {
    runtimeRunId: runId,
    output: undefined,
    errorCode: undefined,
    errorMessage: undefined,
    completion,
    resolve: resolvePromise,
    reject: rejectPromise,
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new StudioServiceError('RUNTIME_TIMEOUT', message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function requiredRecord(value: unknown): JsonRecord {
  if (!isPlainRecord(value)) throw invalidControllerResponse()
  return value
}

function requiredRecordArray(value: unknown, exactLength?: number): readonly JsonRecord[] {
  if (!Array.isArray(value) || (exactLength !== undefined && value.length !== exactLength)) {
    throw invalidControllerResponse()
  }
  return value.map(requiredRecord)
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

function requiredNonNegativeNumber(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalidControllerResponse()
  return value as number
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

function pendingTerminationError(): StudioServiceError {
  return new StudioServiceError(
    'WORK_TERMINATION_PENDING',
    '生成已经停止，但失败记录还没有安全封存。请重启应用后恢复；本次不会计为作品或学习证据。',
  )
}

function createLaunchCompletion(): LaunchCompletion {
  let resolvePromise!: () => void
  const promise = new Promise<void>(resolve => { resolvePromise = resolve })
  return { promise, resolve: resolvePromise }
}

function publicServiceError(error: unknown, fallback: string): StudioServiceError {
  if (error instanceof StudioServiceError) return error
  if (error instanceof DshRuntimeError) {
    if (error.code === 'UNSUPPORTED_DSH') {
      return new StudioServiceError(
        'RUNTIME_COMPONENT_MISSING',
        '创作运行组件不完整。请安装包含完整 DSH Runtime 的新版后重试。',
      )
    }
    return new StudioServiceError(error.code, error.message)
  }
  return new StudioServiceError('STUDIO_OPERATION_FAILED', fallback)
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
