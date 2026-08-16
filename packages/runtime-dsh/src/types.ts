export const SUPPORTED_DSH_RUNTIME_VERSION = '0.1.0-rc.6' as const
export const SUPPORTED_DSH_SDK_VERSION = '0.1.0-rc.6' as const
export const MAX_DSH_OUTPUT_TOKENS = 32_768 as const

export const DSH_MODEL_IDS = ['deepseek-v4-pro', 'deepseek-v4-flash'] as const
export type DshModelId = (typeof DSH_MODEL_IDS)[number]

export const RUNTIME_ROLES = ['production', 'candidate', 'evaluator'] as const
export type RuntimeRole = (typeof RUNTIME_ROLES)[number]

export type RuntimeState =
  | 'unconfigured'
  | 'starting'
  | 'ready'
  | 'running'
  | 'stopping'
  | 'failed'
  | 'disposed'

export interface RuntimeGatewayCapability {
  /** A loopback-only URL owned by the trusted desktop main process. */
  readonly url: string
  /** Short-lived gateway capability. This is not a DeepSeek API key. */
  readonly token: string
}

/**
 * Trusted launch facts assembled by Electron main. None of these fields may
 * come from Renderer input.
 */
export interface DshRuntimeLaunchSpec {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly workspaceDir: string
  /** App-owned harness home; never inherited from HOME or parent DSH_HOME. */
  readonly dshHome: string
  readonly sessionRoot: string
  readonly role: RuntimeRole
  readonly model: DshModelId
  readonly gateway: RuntimeGatewayCapability
  readonly maxTokens?: number
}

export interface RuntimeRunRequest {
  readonly input: string
  readonly sessionId?: string
}

export interface RuntimeRunHandle {
  readonly runId: string
  readonly sessionId: string
}

export type RuntimeEvent =
  | {
      readonly type: 'state'
      readonly runId: string
      readonly state: 'running' | 'cancelled' | 'completed' | 'failed'
    }
  | {
      readonly type: 'progress'
      readonly runId: string
      readonly phase: 'queued' | 'working' | 'idle'
    }
  | {
      readonly type: 'output'
      readonly runId: string
      readonly text: string
    }
  | {
      readonly type: 'error'
      readonly runId: string
      readonly code: RuntimeErrorCode
      readonly message: string
    }

export type RuntimeErrorCode =
  | 'NOT_CONFIGURED'
  | 'UNSUPPORTED_DSH'
  | 'INVALID_LAUNCH'
  | 'BUSY'
  | 'RUN_NOT_FOUND'
  | 'TRANSPORT_CLOSED'
  | 'CREDENTIAL_REJECTED'
  | 'ACCOUNT_BALANCE'
  | 'RATE_LIMITED'
  | 'DEEPSEEK_UNAVAILABLE'
  | 'DEEPSEEK_FIRST_EVENT_TIMEOUT'
  | 'DEEPSEEK_STREAM_IDLE_TIMEOUT'
  | 'DEEPSEEK_TOTAL_TIMEOUT'
  /** Fallback for a timeout raised outside Studio's classified Gateway. */
  | 'DEEPSEEK_TIMEOUT'
  | 'COMMIT_FAILED'
  | 'WORK_TERMINATION_PENDING'
  | 'OUTPUT_TRUNCATED'
  | 'RUNTIME_FAILED'
  | 'DISPOSED'

export interface RuntimeStatus {
  readonly state: RuntimeState
  readonly role?: RuntimeRole
  readonly model?: DshModelId
  readonly activeRunId?: string
  readonly lastErrorCode?: RuntimeErrorCode
}
