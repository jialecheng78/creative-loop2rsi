import { describe, expect, it } from 'vitest'

import { RunResolutionTracker } from '../src/renderer/run-resolution.js'
import { primaryFeedbackAction } from '../src/renderer/ui-model.js'

describe('RunResolutionTracker', () => {
  it('does not reactivate a run that completed before its start promise resolved', () => {
    const tracker = new RunResolutionTracker()

    tracker.markTerminal('run-fast')

    expect(tracker.shouldActivate('run-fast')).toBe(false)
    expect(tracker.shouldActivate('run-next')).toBe(true)
  })

  it('consumes the terminal marker once', () => {
    const tracker = new RunResolutionTracker()
    tracker.markTerminal('run-once')

    expect(tracker.shouldActivate('run-once')).toBe(false)
    expect(tracker.shouldActivate('run-once')).toBe(true)
  })
})

describe('primary feedback action', () => {
  it('submits a user edit instead of silently keeping the original text', () => {
    expect(primaryFeedbackAction('原稿', '用户改稿')).toBe('edit')
    expect(primaryFeedbackAction('原稿', '原稿')).toBe('keep')
  })
})
