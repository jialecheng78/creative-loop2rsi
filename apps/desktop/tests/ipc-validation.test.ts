import { describe, expect, it } from 'vitest'

import {
  validateCancelWorkInput,
  validateCreateSystemInput,
  validateCredentialInput,
  validateFeedbackInput,
  validateModelInput,
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

  it('never accepts credential configuration fields besides the transient key', () => {
    expect(validateCredentialInput({ apiKey: 'sk-example' })).toEqual({ apiKey: 'sk-example' })
    expect(() => validateCredentialInput({ apiKey: 'sk-example', endpoint: 'https://example.invalid' })).toThrow()
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
})
