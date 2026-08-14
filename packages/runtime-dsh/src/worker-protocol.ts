import type {
  DshRuntimeLaunchSpec,
  RuntimeEvent,
  RuntimeRunHandle,
  RuntimeStatus,
} from './types.js'

export type RuntimeWorkerRequest =
  | { readonly id: string; readonly method: 'configure'; readonly spec: DshRuntimeLaunchSpec }
  | { readonly id: string; readonly method: 'status' }
  | { readonly id: string; readonly method: 'startRun'; readonly input: string; readonly sessionId?: string }
  | { readonly id: string; readonly method: 'cancelRun'; readonly runId: string }
  | { readonly id: string; readonly method: 'dispose' }

export type RuntimeWorkerSuccess =
  | { readonly id: string; readonly ok: true; readonly result: RuntimeStatus }
  | { readonly id: string; readonly ok: true; readonly result: RuntimeRunHandle }
  | { readonly id: string; readonly ok: true; readonly result: null }

export interface RuntimeWorkerFailure {
  readonly id: string
  readonly ok: false
  readonly error: {
    readonly code: string
    readonly message: string
  }
}

export type RuntimeWorkerResponse = RuntimeWorkerSuccess | RuntimeWorkerFailure

export interface RuntimeWorkerEventMessage {
  readonly type: 'runtime-event'
  readonly event: RuntimeEvent
}

export function isRuntimeWorkerRequest(value: unknown): value is RuntimeWorkerRequest {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.method !== 'string') return false
  switch (value.method) {
    case 'configure':
      return isRecord(value.spec)
    case 'status':
    case 'dispose':
      return true
    case 'startRun':
      return typeof value.input === 'string'
        && (value.sessionId === undefined || typeof value.sessionId === 'string')
    case 'cancelRun':
      return typeof value.runId === 'string'
    default:
      return false
  }
}

export function isRuntimeWorkerResponse(value: unknown): value is RuntimeWorkerResponse {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.ok === 'boolean'
    && (value.ok ? 'result' in value : isRecord(value.error))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
