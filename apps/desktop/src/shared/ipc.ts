import type {
  DshModelId,
  RuntimeEvent,
  RuntimeRunHandle,
  RuntimeStatus,
} from '@creative-loop2rsi/runtime-dsh'

export const IPC_CHANNELS = {
  appStatus: 'studio:status',
  credentialsConfigure: 'studio:credentials:configure',
  credentialsStatus: 'studio:credentials:status',
  credentialsDelete: 'studio:credentials:delete',
  modelSelect: 'studio:model:select',
  systemsCreate: 'studio:systems:create',
  systemsSnapshot: 'studio:systems:snapshot',
  worksStart: 'studio:works:start',
  worksCancel: 'studio:works:cancel',
  worksSubmitFeedback: 'studio:works:submit-feedback',
  studioEvent: 'studio:event',
} as const

export type ModelChoice = DshModelId
export type FeedbackAction = 'edit' | 'keep' | 'reject' | 'rewrite'

export interface CredentialPublicStatus {
  readonly secureStorageAvailable: boolean
  readonly configured: boolean
}

export interface WorkSnapshot {
  readonly runId: string
  readonly workId: string
  readonly output: string
  readonly artifactSha256: string
  readonly runtimeProvenanceSha256: string | null
  readonly reviewSubjectSha256: string | null
  readonly reviewAvailableAt: string | null
  readonly sealed: boolean
  readonly humanAccepted: boolean | null
  readonly humanDirection: 'BLOCK' | 'PASS' | 'UNKNOWN'
  readonly decision: string | null
}

export interface SystemSnapshot {
  readonly systemId: string
  readonly displayName: string
  readonly activeVersion: string
  readonly operatingStage: string
  readonly charterConfirmed: boolean
  /** Exact user-authored direction from the immutable InitialIntentReceipt. */
  readonly initialIntent: string
  readonly initialIntentSha256: string
  readonly lastWork: WorkSnapshot | null
  readonly recoveryRequired: boolean
  readonly interruptedRun: InterruptedRunSnapshot | null
  readonly feedbackRecoveryRequired: boolean
  readonly pendingFeedback: PendingFeedbackSnapshot | null
}

export interface InterruptedRunSnapshot {
  readonly runId: string
  readonly workId: string
  readonly attemptId: string
  readonly dispatchId: string | null
  readonly state: string
  readonly reasonCode: string
}

export interface PendingFeedbackSnapshot {
  readonly submissionId: string
  readonly runId: string
  readonly attemptId: string
  readonly action: FeedbackAction
  readonly state: 'RECOVERY_REQUIRED'
}

export interface StudioStatus {
  readonly version: string
  readonly credential: 'not-configured' | 'configured'
  readonly secureStorageAvailable: boolean
  readonly selectedModel: ModelChoice
  readonly runtime: RuntimeStatus
  readonly activeSystem: SystemSnapshot | null
  /** Main-owned recovery outcome for a feedback transaction found on this status read. */
  readonly feedbackRecoveryState: 'none' | 'recovered' | 'retry-required'
}

export interface ConfigureCredentialInput {
  readonly apiKey: string
}

export interface SelectModelInput {
  readonly model: ModelChoice
}

export interface CreateSystemInput {
  readonly intent: string
  readonly displayName?: string
}

export interface StartWorkInput {
  readonly task: string
}

export interface CancelWorkInput {
  readonly runId: string
}

export interface SubmitFeedbackInput {
  readonly runId: string
  readonly action: FeedbackAction
  readonly feedbackText?: string
  readonly editedText?: string
}

export interface SubmitFeedbackResult {
  readonly outcome: 'submitted' | 'recovered-previous'
  readonly snapshot: SystemSnapshot
}

/**
 * Public run handle. `runId` is the governed Controller run, not DSH's
 * process-local run id. `sessionId` is opaque and exists only for the
 * transition from the initial renderer.
 */
export interface WorkRunHandle extends RuntimeRunHandle {}

/** Runtime-shaped events use the governed Controller run id. */
export type StudioEvent = RuntimeEvent

export interface CreativeRsiApi {
  getStatus(): Promise<StudioStatus>
  credentials: {
    configure(input: ConfigureCredentialInput): Promise<CredentialPublicStatus>
    status(): Promise<CredentialPublicStatus>
    delete(): Promise<CredentialPublicStatus>
  }
  model: {
    select(input: SelectModelInput): Promise<StudioStatus>
  }
  systems: {
    create(input: CreateSystemInput): Promise<SystemSnapshot>
    snapshot(): Promise<SystemSnapshot | null>
  }
  works: {
    start(input: StartWorkInput): Promise<WorkRunHandle>
    cancel(input: CancelWorkInput): Promise<void>
    submitFeedback(input: SubmitFeedbackInput): Promise<SubmitFeedbackResult>
    onEvent(listener: (event: StudioEvent) => void): () => void
  }
  /** Governed compatibility surface for the initial renderer. */
  runtime: {
    status(): Promise<RuntimeStatus>
    start(input: string): Promise<WorkRunHandle>
    cancel(runId: string): Promise<void>
    stop(): Promise<void>
    onEvent(listener: (event: StudioEvent) => void): () => void
  }
}
