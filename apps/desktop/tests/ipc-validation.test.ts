import { describe, expect, it } from 'vitest'

import {
  validateCancelWorkInput,
  validateCandidateDecisionInput,
  validateCompareCandidateInput,
  validateCreateSystemInput,
  validateCredentialInput,
  validateFeedbackInput,
  validateModelInput,
  validatePrepareCandidateInput,
  validateRollbackMethodInput,
  validateStartWorkInput,
} from '../src/main/ipc-validation.js'

describe('business IPC validation', () => {
  it('accepts only the two public models and exact input keys', () => {
    expect(validateModelInput({ model: 'deepseek-v4-pro' })).toEqual({ model: 'deepseek-v4-pro' })
    expect(validateModelInput({ model: 'deepseek-v4-flash' })).toEqual({ model: 'deepseek-v4-flash' })
    expect(() => validateModelInput({ model: 'other' })).toThrow()
    expect(() => validateModelInput({ model: 'deepseek-v4-pro', baseUrl: 'https://example.invalid' })).toThrow()
  })

  it('allows a 100000-byte creative input but no caller-controlled path', () => {
    const boundary = 'a'.repeat(100_000)
    expect(validateCreateSystemInput({ intent: boundary }).intent).toHaveLength(100_000)
    expect(validateStartWorkInput({ task: boundary }).task).toHaveLength(100_000)
    expect(() => validateCreateSystemInput({ intent: 'x', project: '/tmp/escape' })).toThrow()
    expect(() => validateStartWorkInput({ task: 'a'.repeat(100_001) })).toThrow()
  })

  it('requires an explicit session-only decision and accepts no other credential fields', () => {
    expect(validateCredentialInput({ apiKey: 'sk-example', allowSessionOnly: false })).toEqual({
      apiKey: 'sk-example', allowSessionOnly: false,
    })
    expect(validateCredentialInput({ apiKey: 'sk-example', allowSessionOnly: true })).toEqual({
      apiKey: 'sk-example', allowSessionOnly: true,
    })
    expect(() => validateCredentialInput({ apiKey: 'sk-example' })).toThrow()
    expect(() => validateCredentialInput({ apiKey: 'sk-example', allowSessionOnly: 'yes' })).toThrow()
    expect(() => validateCredentialInput({
      apiKey: 'sk-example', allowSessionOnly: true, endpoint: 'https://example.invalid',
    })).toThrow()
  })

  it('binds feedback shape to its action', () => {
    expect(validateFeedbackInput({ runId: 'run-a1', action: 'keep' })).toEqual({
      runId: 'run-a1', action: 'keep',
    })
    expect(validateFeedbackInput({
      runId: 'run-a1', action: 'edit', editedText: '用户改稿', feedbackText: '更克制',
    })).toMatchObject({ action: 'edit', editedText: '用户改稿' })
    expect(() => validateFeedbackInput({ runId: 'run-a1', action: 'edit' })).toThrow()
    expect(() => validateFeedbackInput({ runId: 'run-a1', action: 'reject' })).toThrow()
    expect(() => validateFeedbackInput({ runId: 'run-a1', action: 'keep', editedText: 'x' })).toThrow()
  })

  it('allows only governed run ids or the compatibility active marker', () => {
    expect(validateCancelWorkInput({ runId: 'run-1234-abcd' })).toEqual({ runId: 'run-1234-abcd' })
    expect(validateCancelWorkInput({ runId: 'active' })).toEqual({ runId: 'active' })
    expect(() => validateCancelWorkInput({ runId: '../../run' })).toThrow()
  })

  it('keeps method candidate, blind comparison, and rollback IPC narrow', () => {
    expect(validatePrepareCandidateInput({ observationId: 'app-feedback-one' })).toEqual({
      observationId: 'app-feedback-one',
    })
    expect(validateCompareCandidateInput({
      candidateId: 'method-one', phase: 'heldout', choice: 'TIE',
    })).toEqual({ candidateId: 'method-one', phase: 'heldout', choice: 'TIE' })
    expect(validateCandidateDecisionInput({ candidateId: 'method-one' })).toEqual({
      candidateId: 'method-one',
    })
    expect(validateRollbackMethodInput({ version: 'baseline-v1' })).toEqual({
      version: 'baseline-v1',
    })
    expect(() => validateCompareCandidateInput({
      candidateId: 'method-one', phase: 'heldout', choice: 'A', mapping: 'candidate=A',
    })).toThrow()
    expect(() => validateCompareCandidateInput({
      candidateId: 'method-one', phase: 'unknown', choice: 'A',
    })).toThrow()
    expect(() => validateCandidateDecisionInput({ candidateId: '../../method' })).toThrow()
    expect(() => validateRollbackMethodInput({ version: '/tmp/version' })).toThrow()
  })
})
