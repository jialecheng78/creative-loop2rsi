import { describe, expect, it } from 'vitest'

import { candidatePublicError } from '../src/main/ipc.js'
import { StudioServiceError } from '../src/main/studio-service.js'
import { CANDIDATE_IPC_ERROR_CODES } from '../src/shared/ipc.js'

describe('candidate IPC error boundary', () => {
  it.each([
    ['explicit runtime failure', new StudioServiceError(
      'RUNTIME_FAILED',
      'DSH worker failed at /private/userData/system with token secret-value and full response body',
    ), 'RUNTIME_FAILED'],
    ['controller detail', new StudioServiceError(
      'CONTROLLER_BLOCK',
      'Controller body at /private/userData/system contains secret-value',
    ), 'CANDIDATE_PREPARATION_BLOCKED'],
    ['unknown response loss', new Error(
      'record_method_generation response lost at /private/userData/system with token secret-value',
    ), 'CANDIDATE_OPERATION_FAILED'],
  ] as const)('returns an allowlisted fixed envelope for %s', (_name, error, expectedCode) => {
    const result = candidatePublicError(error)

    expect(result.code).toBe(expectedCode)
    expect(CANDIDATE_IPC_ERROR_CODES).toContain(result.code)
    expect(Object.keys(result).sort()).toEqual(['code', 'message'])
    expect(result.message).not.toMatch(/DSH|Controller body|private\/userData|secret-value|full response body/u)
  })
})
