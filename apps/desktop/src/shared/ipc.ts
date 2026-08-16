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
  candidatesPrepare: 'studio:candidates:prepare',
  candidatesCompare: 'studio:candidates:compare',
  candidatesAdopt: 'studio:candidates:adopt',
  candidatesReject: 'studio:candidates:reject',
  releasesRollback: 'studio:releases:rollback',
  studioEvent: 'studio:event',
} as const

export type ModelChoice = DshModelId
export type FeedbackAction = 'edit' | 'keep' | 'reject' | 'rewrite'

export interface CredentialPublicStatus {
  readonly secureStorageAvailable: boolean
  readonly configured: boolean
  /** `session` means Main-memory only and cannot survive process exit. */
  readonly persistence: 'none' | 'protected' | 'session'
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
  readonly methodVersion: string
  readonly methodGuidanceSha256: string | null
}

export interface MethodObservationSnapshot {
  readonly id: string
  readonly findingCode: string
  readonly feedback: string
  readonly independentWorks: number
  readonly independentRuns: number
  readonly independentTasks: number
  readonly readyForCandidate: boolean
}

export interface AdoptedPrincipleSnapshot {
  readonly version: string
  readonly guidance: string
  readonly adoptedAt: string
  readonly active: boolean
}

export type MethodComparisonPhase = 'targeted' | 'regression' | 'heldout'
export type MethodComparisonChoice = 'A' | 'B' | 'TIE'

export interface MethodComparisonSnapshot {
  readonly phase: MethodComparisonPhase
  readonly left: string
  readonly right: string
  readonly choice: MethodComparisonChoice | null
}

export interface MethodCandidateSnapshot {
  readonly id: string
  readonly title: string
  readonly summary: string
  readonly tradeoff: string
  readonly status: string
  readonly ready: boolean
  /** A promotion receipt exists, but the active pointer still needs crash recovery. */
  readonly adoptionPending: boolean
  /** This promoted method was explicitly rolled back and is history-only in v1. */
  readonly rolledBack: boolean
  readonly comparisons: readonly MethodComparisonSnapshot[]
}

export interface MethodHistorySnapshot {
  readonly action: 'PROMOTE' | 'ROLLBACK'
  readonly version: string
  readonly previousVersion: string
  readonly createdAt: string
}

export interface MethodSnapshot {
  readonly activeVersion: string
  readonly activeGuidance: string | null
  readonly history: readonly MethodHistorySnapshot[]
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
  readonly observations: readonly MethodObservationSnapshot[]
  readonly adoptedPrinciples: readonly AdoptedPrincipleSnapshot[]
  readonly method: MethodSnapshot
  readonly methodCandidates: readonly MethodCandidateSnapshot[]
}

export interface InterruptedRunSnapshot {
  readonly runId: string
  readonly workId: string
  readonly attemptId: string
  readonly dispatchId: string | null
  readonly state: string
  readonly reasonCode: string
  readonly outcome?: 'FAILED' | 'CANCELLED'
  readonly executionStatus?: 'BLOCK'
  readonly terminationClass?: 'ZERO_FILE_RUNTIME_FAILURE' | 'UNCOMMITTED_OUTPUT_FAILURE'
  readonly terminalReceipt?: string
  readonly terminalReceiptSha256?: string
  readonly contentAttemptConsumed?: boolean
  readonly findingEligible?: false
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
  /** Public projection of how the configured Key is retained; never contains the Key. */
  readonly credentialPersistence: 'none' | 'protected' | 'session'
  readonly selectedModel: ModelChoice
  readonly runtime: RuntimeStatus
  readonly activeSystem: SystemSnapshot | null
  /** Main-owned recovery outcome for a feedback transaction found on this status read. */
  readonly feedbackRecoveryState: 'none' | 'recovered' | 'retry-required'
  /** Main replay-queue outcome for a begin/termination response-loss window. */
  readonly workRecoveryState: 'none' | 'recovered' | 'retry-required'
}

export interface ConfigureCredentialInput {
  readonly apiKey: string
  /** Explicit permission for Main-memory-only use when safeStorage is unavailable. */
  readonly allowSessionOnly: boolean
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

export interface PrepareCandidateInput {
  readonly observationId: string
}

export interface CompareCandidateInput {
  readonly candidateId: string
  readonly phase: MethodComparisonPhase
  readonly choice: MethodComparisonChoice
}

export interface CandidateDecisionInput {
  readonly candidateId: string
}

export interface RollbackMethodInput {
  readonly version: string
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
  candidates: {
    prepare(input: PrepareCandidateInput): Promise<SystemSnapshot>
    compare(input: CompareCandidateInput): Promise<SystemSnapshot>
    adopt(input: CandidateDecisionInput): Promise<SystemSnapshot>
    reject(input: CandidateDecisionInput): Promise<SystemSnapshot>
  }
  releases: {
    rollback(input: RollbackMethodInput): Promise<SystemSnapshot>
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
