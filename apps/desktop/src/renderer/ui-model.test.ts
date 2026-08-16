import { describe, expect, it } from 'vitest'

import {
  actionableError,
  canSubmitEdit,
  creationInputIssue,
  feedbackSubmissionMessage,
  feedbackSuccessMessage,
  isConfirmedLaunchCancellation,
  NAVIGATION,
  progressMessage,
  recoveryPresentation,
} from './ui-model.js'

describe('renderer user-facing decisions', () => {
  it('keeps the four main sections stable and understandable', () => {
    expect(NAVIGATION.map(item => item.label)).toEqual([
      '创作',
      '它学到了什么',
      '新方式',
      '版本',
    ])
  })

  it('turns common service failures into a concrete next step', () => {
    expect(actionableError(new Error('401 Unauthorized'))).toContain('重新输入')
    expect(actionableError(new Error('402 insufficient balance'))).toContain('充值')
    expect(actionableError(new Error('429 rate limit'))).toContain('稍等一分钟')
    expect(actionableError(new Error('network offline'))).toContain('检查网络')
    expect(actionableError(new Error('ENOSPC disk write failed'))).toContain('磁盘空间')
  })

  it('keeps all three timeout classes and pending termination actionable', () => {
    expect(actionableError(new Error('generic'), 'DEEPSEEK_FIRST_EVENT_TIMEOUT')).toContain('两分钟')
    expect(actionableError(new Error('generic'), 'DEEPSEEK_STREAM_IDLE_TIMEOUT')).toContain('九十秒')
    expect(actionableError(new Error('generic'), 'DEEPSEEK_TOTAL_TIMEOUT')).toContain('十分钟')
    expect(actionableError(new Error('内容达到本次生成上限，未保存为完整版本'), 'OUTPUT_TRUNCATED'))
      .toContain('缩短篇幅')
    expect(actionableError(new Error('generic'), 'WORK_TERMINATION_PENDING')).toContain('不会计为作品')
    expect(actionableError(new Error('生成已经停止，但失败记录还没有安全封存；本次不会计为作品或学习证据。')))
      .toContain('请重启应用恢复')
  })

  it('preserves only a bounded sanitized request count in timeout guidance', () => {
    expect(actionableError(
      new Error('internal path omitted（本次共发起 3 次请求）'),
      'DEEPSEEK_FIRST_EVENT_TIMEOUT',
    )).toContain('本次共发起 3 次请求')
    expect(actionableError(
      new Error('本次共发起 999 次请求'),
      'DEEPSEEK_TOTAL_TIMEOUT',
    )).not.toContain('999')
  })

  it('only treats the exact launch-cancel acknowledgement as confirmed', () => {
    expect(isConfirmedLaunchCancellation(new Error('本次创作已停止。'))).toBe(true)
    expect(isConfirmedLaunchCancellation(
      new Error("Error invoking remote method 'studio:works:start': Error: 本次创作已停止。"),
    )).toBe(true)
    expect(isConfirmedLaunchCancellation(
      new Error('生成已经停止，但失败记录还没有安全封存。'),
    )).toBe(false)
  })

  it('does not report a missing preview capability as success', () => {
    expect(actionableError(new Error('feedback'))).toContain('还没有接通反馈保存')
    expect(actionableError(new Error('candidate'))).toContain('没有改动')
  })

  it('does not echo internal error details into the interface', () => {
    const message = actionableError(new Error('DSH worker at /private/path failed with token abc'))
    expect(message).not.toContain('DSH')
    expect(message).not.toContain('/private/path')
    expect(message).not.toContain('abc')
    expect(message).toContain('没有改动')
  })

  it('requires an actual edit or written feedback before submitting an edit', () => {
    expect(canSubmitEdit('原文', '原文', '')).toBe(false)
    expect(canSubmitEdit('原文', '改文', '')).toBe(true)
    expect(canSubmitEdit('原文', '原文', '保留开头')).toBe(true)
    expect(canSubmitEdit('原文', '   ', '反馈')).toBe(false)
  })

  it('checks the same UTF-8 input boundary as the trusted process', () => {
    expect(creationInputIssue('  ')).toContain('先写下')
    expect(creationInputIssue('a'.repeat(100_000))).toBe('')
    expect(creationInputIssue('中'.repeat(33_334))).toContain('太长')
  })

  it('uses clear progress and feedback receipts', () => {
    expect(progressMessage('queued')).toContain('准备')
    expect(progressMessage('working')).toContain('随时停止')
    expect(feedbackSuccessMessage('keep')).toContain('保留')
    expect(feedbackSuccessMessage('reject')).toContain('不采用')
  })

  it('does not describe a recovered previous edit as the current action succeeding', () => {
    const afterKeep = feedbackSubmissionMessage('recovered-previous', 'keep')
    const afterReject = feedbackSubmissionMessage('recovered-previous', 'reject')
    expect(afterKeep).toBe(afterReject)
    expect(afterKeep).toContain('已恢复上次决定')
    expect(afterKeep).toContain('新操作没有提交')
    expect(afterKeep).not.toContain('保留了这个版本')
    expect(afterReject).not.toContain('不采用这个版本')
  })

  it('never presents pending recovery as an ordinary ready state', () => {
    const retry = recoveryPresentation({
      feedbackRecoveryState: 'retry-required',
      activeSystem: { feedbackRecoveryRequired: true, interruptedRun: null },
    } as never)
    expect(retry).toMatchObject({ blocked: true, tone: 'attention' })
    expect(retry?.canRetry).toBe(true)
    expect(retry?.message).toContain('原编辑已保留')
    expect(retry?.message).toContain('不能开始新创作')

    const recovered = recoveryPresentation({
      feedbackRecoveryState: 'recovered',
      activeSystem: { feedbackRecoveryRequired: false, interruptedRun: null },
    } as never)
    expect(recovered).toMatchObject({ blocked: false, tone: 'recovered' })
    expect(recovered?.message).toContain('已经安全保存')

    const interrupted = recoveryPresentation({
      feedbackRecoveryState: 'none',
      activeSystem: { feedbackRecoveryRequired: false, interruptedRun: { runId: 'run-old' } },
    } as never)
    expect(interrupted?.message).toContain('封存的作品仍在')
    expect(interrupted?.message).toContain('重新生成')
    expect(interrupted?.message).toContain('不会续写未完成的模型推理')
    expect(interrupted?.message).not.toContain('继续恢复')

    const totalTimeout = recoveryPresentation({
      feedbackRecoveryState: 'none',
      activeSystem: {
        feedbackRecoveryRequired: false,
        interruptedRun: { reasonCode: 'DEEPSEEK_TOTAL_TIMEOUT' },
      },
    } as never)
    expect(totalTimeout?.message).toContain('十分钟')
    expect(totalTimeout?.message).toContain('不会计入学习')
  })

  it('blocks every creative mutation while a work termination still needs replay', () => {
    const pending = recoveryPresentation({
      feedbackRecoveryState: 'none',
      workRecoveryState: 'retry-required',
      activeSystem: { feedbackRecoveryRequired: false, interruptedRun: null },
    } as never)
    expect(pending).toMatchObject({ blocked: true, canRetry: true, tone: 'attention' })
    expect(pending?.message).toContain('失败记录安全封存')
  })
})
