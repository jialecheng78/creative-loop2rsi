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
  | 'create_method_candidate'
  | 'adopt_method_candidate'
  | 'method_candidate_context'
  | 'production_context'
  | 'record_feedback'
  | 'reject_method_candidate'
  | 'resume_feedback'
  | 'seal_feedback'
  | 'rollback_method'
  | 'stage_method_comparisons'
  | 'submit_method_comparison'
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
  readonly runtimeProvenance: JsonRecord
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
  private methodOperationInProgress = false
  private methodCancellationRequested = false
  private methodOperationCompletion: Promise<void> | undefined
  private internalLaunchEvents: RuntimeEvent[] | undefined
  private internalRun: InternalModelRun | undefined
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
    if (this.active !== undefined || this.launchInProgress || this.methodOperationInProgress || this.credentialMutationInProgress) {
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
    if (this.active !== undefined || this.launchInProgress || this.methodOperationInProgress) {
      throw new StudioServiceError('WORK_ACTIVE', '请先结束当前创作，再切换模型。')
    }
    await this.options.settings.update({ selectedModel: model })
    return await this.getStatus()
  }

  async createSystem(input: CreateSystemInput): Promise<SystemSnapshot> {
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
      || this.methodOperationInProgress
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
      const begun = await this.callController('begin_work', {
        project,
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
      })
      if (begun.run_id !== controllerRunId
        || begun.dispatch_id !== dispatchId
        || begun.work_id !== workId
        || begun.task_sha256 !== createHash('sha256').update(task, 'utf8').digest('hex')
        || begun.context_sha256 !== contextSha256
        || begun.method_version !== methodVersion
        || (begun.method_guidance_sha256 ?? null) !== guidanceSha256) {
        throw invalidControllerResponse()
      }
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
        contextSha256,
        lease,
        profileSha256,
        queuedEvents: [],
      }
      this.starting = starting
      const runtimeHandle = await this.options.runtime.startRun(
        creationInstruction(creativeSystem.initialIntent, task, guidance),
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
      const candidateId = this.internalId('method')
      const context = await this.callController('method_candidate_context', {
        project,
        candidate_id: candidateId,
        observation_id: observationId,
      })
      if (context.heldout_included !== false || context.candidate_id !== candidateId) {
        throw invalidControllerResponse()
      }
      const builderContextSha256 = requiredSha256(context.builder_context_sha256)
      const sourceWorks = requiredRecordArray(context.source_works, 3)
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
      })
      const guidance = normalizedGuidance(builder.output)
      const created = await this.callController('create_method_candidate', {
        project,
        candidate_id: candidateId,
        observation_id: observationId,
        guidance,
        builder_role_id: 'method-candidate-builder',
        builder_context_id: `builder-context-${candidateId}`,
        builder_task_id: `builder-task-${candidateId}`,
        builder_attested_by: 'desktop-main-supervisor',
        builder_provenance: builder.runtimeProvenance,
      })
      const plan = requiredRecord(created.evaluation_plan)
      const targeted = requiredRecord(plan.targeted)
      const regression = requiredRecord(plan.regression)
      const heldout = requiredRecord(plan.heldout)
      const initialIntent = requiredString(context.initial_intent, true)
      const currentGuidance = nullableString(context.current_guidance)
      const generated = {
        targeted_candidate: await this.executeInternalGeneration({
          project, model, role: 'candidate',
          contextSha256: requiredSha256(targeted.candidate_context_sha256),
          instruction: creationInstruction(initialIntent, requiredString(targeted.task, true), guidance),
        }),
        regression_candidate: await this.executeInternalGeneration({
          project, model, role: 'candidate',
          contextSha256: requiredSha256(regression.candidate_context_sha256),
          instruction: creationInstruction(initialIntent, requiredString(regression.task, true), guidance),
        }),
        heldout_baseline: await this.executeInternalGeneration({
          project, model, role: 'production',
          contextSha256: requiredSha256(heldout.baseline_context_sha256),
          instruction: creationInstruction(initialIntent, requiredString(heldout.task, true), currentGuidance),
        }),
        heldout_candidate: await this.executeInternalGeneration({
          project, model, role: 'candidate',
          contextSha256: requiredSha256(heldout.candidate_context_sha256),
          instruction: creationInstruction(initialIntent, requiredString(heldout.task, true), guidance),
        }),
      }
      this.throwIfMethodCancelled()
      const staged = await this.callController('stage_method_comparisons', {
        project,
        candidate_id: candidateId,
        generations: Object.fromEntries(Object.entries(generated).map(([key, value]) => [key, {
          output: value.output,
          runtime_provenance: value.runtimeProvenance,
        }])),
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

  private async executeInternalGeneration(input: {
    readonly project: string
    readonly model: ModelChoice
    readonly role: RuntimeRole
    readonly contextSha256: string
    readonly instruction: string
  }): Promise<InternalGenerationResult> {
    this.throwIfMethodCancelled()
    const lease = this.options.loopback.issueLease(input.role, input.model)
    if (lease.role !== input.role || lease.model !== input.model) throw invalidControllerResponse()
    const workspaceDir = join(input.project, 'creative-system', 'runtime', `workspace-${input.role}`)
    const dshHome = join(this.systemsRoot, '..', 'runtime', 'dsh-home', input.role)
    let profileSha256: string | undefined
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
        maxTokens: MAX_MODEL_OUTPUT_TOKENS,
      })
      profileSha256 = await this.profileDigest(spec)
      this.options.runtime.configure(spec)
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
      await withTimeout(completion.completion, 240_000, '新方式生成超时，本轮没有记为成功。')
      this.throwIfMethodCancelled()
      if (completion.output === undefined || completion.output.trim() === '') {
        throw new StudioServiceError('EMPTY_OUTPUT', '模型没有返回可比较的内容。')
      }
      const provenance = validatedProvenance(lease.provenance())
      return {
        output: completion.output,
        runtimeProvenance: runtimeProvenancePayload(
          this.options.appVersion,
          { contextSha256: input.contextSha256, model: input.model, profileSha256 },
          provenance,
        ),
      }
    } finally {
      lease.revoke()
      this.internalLaunchEvents = undefined
      this.internalRun = undefined
      await this.options.runtime.stop().catch(() => undefined)
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
  return {
    id: requiredString(value.id),
    title: requiredString(value.title),
    summary: requiredString(value.summary, true),
    tradeoff: requiredString(value.tradeoff, true),
    status: requiredString(value.status),
    ready: requiredBoolean(value.ready),
    comparisons,
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
