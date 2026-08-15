import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CreativeRsiApi, StudioStatus } from '../src/shared/ipc.js'
import {
  adoptNewMethod,
  compareNewMethod,
  prepareNewMethod,
  rejectNewMethod,
  rollbackMethod,
  toViewStatus,
} from '../src/renderer/renderer-api.js'

const STATUS: StudioStatus = {
  version: '1.0.0-alpha.1',
  credential: 'configured',
  secureStorageAvailable: true,
  selectedModel: 'deepseek-v4-flash',
  runtime: { state: 'ready' },
  feedbackRecoveryState: 'none',
  workRecoveryState: 'none',
  activeSystem: {
    systemId: 'system-one',
    displayName: '克制悬疑',
    activeVersion: 'v0.1.0',
    operatingStage: 'BOOTSTRAP',
    charterConfirmed: false,
    initialIntent: '写克制的近未来悬疑',
    initialIntentSha256: '1'.repeat(64),
    lastWork: null,
    recoveryRequired: false,
    interruptedRun: null,
    feedbackRecoveryRequired: false,
    pendingFeedback: null,
    observations: [{
      id: 'app-feedback-one',
      findingCode: 'APP-FEEDBACK-ONE',
      feedback: '减少解释，用动作推进。',
      independentWorks: 3,
      independentRuns: 3,
      independentTasks: 3,
      readyForCandidate: true,
    }],
    adoptedPrinciples: [{
      version: 'method-one',
      guidance: '用可见行动推进。',
      adoptedAt: '2026-08-15T00:00:00Z',
      active: true,
    }],
    method: {
      activeVersion: 'method-one',
      activeGuidance: '用可见行动推进。',
      history: [{
        action: 'PROMOTE',
        version: 'method-one',
        previousVersion: 'baseline-v1',
        createdAt: '2026-08-15T00:00:00Z',
      }],
    },
    methodCandidates: [{
      id: 'method-one',
      title: '针对重复反馈的新方式',
      summary: '用可见行动推进。',
      tradeoff: '可能减少必要解释。',
      status: 'PROMOTED',
      ready: false,
      comparisons: [{ phase: 'targeted', left: 'A', right: 'B', choice: 'A' }],
    }],
  },
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window')
})

describe('renderer business adapter', () => {
  it('maps governed learning, candidate, active method, and history instead of empty preview placeholders', () => {
    const view = toViewStatus(STATUS)

    expect(view.learning?.observations[0]).toMatchObject({
      independentWorks: 3,
      readyForCandidate: true,
    })
    expect(view.learning?.adoptedPrinciples[0]?.active).toBe(true)
    expect(view.newMethods?.[0]?.comparisons[0]?.choice).toBe('A')
    expect(view.method).toMatchObject({
      activeVersion: 'method-one',
      activeGuidance: '用可见行动推进。',
    })
  })

  it('uses exact narrow candidate and rollback API shapes and refreshes status after each action', async () => {
    const candidates = {
      prepare: vi.fn(async () => STATUS.activeSystem!),
      compare: vi.fn(async () => STATUS.activeSystem!),
      adopt: vi.fn(async () => STATUS.activeSystem!),
      reject: vi.fn(async () => STATUS.activeSystem!),
    }
    const rollback = vi.fn(async () => STATUS.activeSystem!)
    const fakeApi = {
      getStatus: vi.fn(async () => STATUS),
      candidates,
      releases: { rollback },
    } as unknown as CreativeRsiApi
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { creativeRsi: fakeApi },
    })

    await prepareNewMethod('app-feedback-one')
    await compareNewMethod('method-one', 'heldout', 'TIE')
    await adoptNewMethod('method-one')
    await rejectNewMethod('method-two')
    await rollbackMethod('baseline-v1')

    expect(candidates.prepare).toHaveBeenCalledWith({ observationId: 'app-feedback-one' })
    expect(candidates.compare).toHaveBeenCalledWith({
      candidateId: 'method-one', phase: 'heldout', choice: 'TIE',
    })
    expect(candidates.adopt).toHaveBeenCalledWith({ candidateId: 'method-one' })
    expect(candidates.reject).toHaveBeenCalledWith({ candidateId: 'method-two' })
    expect(rollback).toHaveBeenCalledWith({ version: 'baseline-v1' })
    expect(fakeApi.getStatus).toHaveBeenCalledTimes(5)
  })
})
