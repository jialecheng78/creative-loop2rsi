import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { MethodCandidateSnapshot } from '../shared/ipc.js'
import { App, CredentialView, LearningPage, NewMethodsPage } from './App.js'
import type { StudioViewStatus } from './renderer-api.js'

describe('App shell', () => {
  it('renders the four plain-language destinations before any bridge call', () => {
    const html = renderToStaticMarkup(<App />)
    expect(html).toContain('创作')
    expect(html).toContain('它学到了什么')
    expect(html).toContain('新方式')
    expect(html).toContain('版本')
    expect(html).toContain('aria-label="主要功能"')
  })

  it('does not expose implementation vocabulary in the initial interface', () => {
    const html = renderToStaticMarkup(<App />)
    expect(html).not.toMatch(/Prompt|DAG|DSH|Token/u)
  })

  it('makes the session-only credential choice explicit when protected storage is unavailable', () => {
    const unavailable = renderToStaticMarkup(
      <CredentialView
        error=""
        message="可以继续"
        onConfigured={() => undefined}
        secureStorageAvailable={false}
      />,
    )
    expect(unavailable).toContain('只保留在本次应用内存中')
    expect(unavailable).toContain('关闭应用后失效')
    expect(unavailable).toContain('>仅本次验证并继续</button>')

    const protectedStorage = renderToStaticMarkup(
      <CredentialView
        error=""
        message="可以继续"
        onConfigured={() => undefined}
        secureStorageAvailable
      />,
    )
    expect(protectedStorage).toContain('由系统安全存储')
    expect(protectedStorage).toContain('>验证并继续</button>')
    expect(protectedStorage).not.toContain('>仅本次验证并继续</button>')
  })

  it('only offers crash-recovery adoption when Controller marks it pending', () => {
    const pending = renderNewMethod({ adoptionPending: true, rolledBack: false })
    expect(pending).toContain('等待完成采用')
    expect(pending).toContain('>完成采用</button>')
    expect(pending).not.toContain('>拒绝</button>')

    const ordinaryPromoted = renderNewMethod({ adoptionPending: false, rolledBack: false })
    expect(ordinaryPromoted).toContain('已采用')
    expect(ordinaryPromoted).not.toContain('>完成采用</button>')
  })

  it('shows a rolled-back method as history without any adoption action', () => {
    const html = renderNewMethod({ adoptionPending: false, rolledBack: true })
    expect(html).toContain('历史已回滚')
    expect(html).toContain('不能直接重新采用')
    expect(html).not.toContain('>完成采用</button>')
    expect(html).not.toContain('>采用新方式</button>')
    expect(html).not.toContain('>拒绝</button>')
  })

  it('explains why identical feedback can be counted in separate model baselines', () => {
    const observation = {
      findingCode: 'APP-FEEDBACK-ONE',
      feedback: '更早建立风险。',
      independentWorks: 2,
      independentRuns: 2,
      independentTasks: 2,
      readyForCandidate: false,
    }
    const status = {
      learning: {
        observations: [
          { ...observation, id: 'observation-epoch-one' },
          { ...observation, id: 'observation-epoch-two', independentWorks: 1 },
        ],
        adoptedPrinciples: [],
      },
    } as unknown as StudioViewStatus
    const html = renderToStaticMarkup(
      <LearningPage onStatusChange={() => undefined} status={status} />,
    )
    expect(html.match(/生成基线已变化，这些证据会分开累计。/gu)).toHaveLength(2)
  })

  it('continues only a resumable preparation and routes later active states to New Methods', () => {
    const resumable = learningAction({
      status: 'CANDIDATE',
      completedGenerationCount: 2,
      resumable: true,
    })
    expect(resumable).toContain('继续准备盲比（2/4）')
    expect(resumable).not.toContain('disabled=""')

    const blockedPreparation = learningAction({
      status: 'CANDIDATE',
      completedGenerationCount: 2,
      resumable: false,
    })
    expect(blockedPreparation).toContain('请到“新方式”放弃本次准备')
    expect(blockedPreparation).toContain('disabled=""')

    const evaluating = learningAction({ status: 'EVALUATING' })
    expect(evaluating).toContain('请到“新方式”完成比较')
    expect(evaluating).toContain('disabled=""')

    const ready = learningAction({ status: 'READY_FOR_HUMAN', ready: true })
    expect(ready).toContain('请到“新方式”作最终决定')
    expect(ready).toContain('disabled=""')

    const adoptionPending = learningAction({
      status: 'PROMOTED',
      adoptionPending: true,
    })
    expect(adoptionPending).toContain('请到“新方式”完成采用')
    expect(adoptionPending).toContain('disabled=""')
  })

  it('starts a fresh candidate after terminal attempts but never restarts an adopted method', () => {
    for (const terminal of [
      { status: 'BLOCKED' as const },
      { status: 'REJECTED' as const },
      { status: 'PROMOTED' as const, rolledBack: true },
    ]) {
      const action = learningAction(terminal)
      expect(action).toContain('重新提出并比较新方法')
      expect(action).not.toContain('disabled=""')
      expect(action).not.toContain('继续准备盲比')
    }

    const adopted = learningAction({ status: 'PROMOTED', rolledBack: false })
    expect(adopted).toContain('新方式已采用')
    expect(adopted).toContain('disabled=""')
  })

  it('offers durable preparation resume and immutable abandonment before blind comparison', () => {
    const html = renderCandidate({
      status: 'CANDIDATE',
      ready: false,
      completedGenerationCount: 2,
      resumable: true,
      comparisons: [],
    })
    expect(html).toContain('准备 2/4')
    expect(html).toContain('候选指导和已完成结果已封存；只会补安全缺项')
    expect(html).toContain('已完成 2/4 项生成')
    expect(html).toContain('>继续准备</button>')
    expect(html).toContain('>放弃本次准备</button>')
    expect(html).not.toContain('盲比 1/3')
    expect(html).not.toContain('>采用新方式</button>')
  })

  it('keeps an irrecoverable preparation actionable without calling it complete', () => {
    const html = renderCandidate({
      status: 'CANDIDATE',
      ready: false,
      completedGenerationCount: 0,
      resumable: false,
      preparationBlockedReason: '固定生成基线已变化；为避免重复调用，本次准备只能放弃。',
      preparationFailureKind: 'METHOD_EPOCH_CHANGED',
      comparisons: [],
    })
    expect(html).toContain('准备已阻止')
    expect(html).toContain('本次准备的不可变证据已经保留')
    expect(html).toContain('已封存 0/4')
    expect(html).toContain('失败类型：<code>METHOD_EPOCH_CHANGED</code>')
    expect(html).toContain('固定生成基线已变化')
    expect(html).not.toMatch(/fingerprint|Profile|DSH/u)
    expect(html).toContain('>放弃本次准备</button>')
    expect(html).not.toContain('>继续准备</button>')
    expect(html).not.toContain('候选指导和已完成结果已封存')
  })

  it('shows an exact heldout failure count and only the abandonment action', () => {
    const html = renderCandidate({
      status: 'CANDIDATE',
      ready: false,
      completedGenerationCount: 3,
      resumable: false,
      preparationBlockedReason: '候选生成已明确失败；已封存进度仍保留，本次准备只能放弃。',
      preparationFailureKind: 'RUNTIME_FAILED',
      comparisons: [],
    })

    expect(html).toContain('已封存 3/4')
    expect(html).toContain('失败类型：<code>RUNTIME_FAILED</code>')
    expect(html).toContain('>放弃本次准备</button>')
    expect(html).not.toContain('>继续准备</button>')
    expect(html).not.toMatch(/作品没有|安全保存|检查磁盘/u)
  })

  it('never turns zero comparisons or a blocked decision into blind comparison 4/3', () => {
    const empty = renderCandidate({
      status: 'EVALUATING',
      ready: false,
      comparisons: [],
    })
    expect(empty).toContain('比较材料不完整')
    expect(empty).not.toContain('可以决定')
    expect(empty).not.toContain('>采用新方式</button>')

    const blocked = renderCandidate({
      status: 'BLOCKED',
      ready: false,
      comparisons: [
        { phase: 'targeted', left: 'A1', right: 'B1', choice: 'B' },
        { phase: 'regression', left: 'A2', right: 'B2', choice: 'A' },
        { phase: 'heldout', left: 'A3', right: 'B3', choice: 'TIE' },
      ],
    })
    expect(blocked).toContain('未通过比较')
    expect(blocked).not.toContain('盲比 4/3')
    expect(blocked).not.toContain('>采用新方式</button>')
  })

  it('makes both blind-comparison texts named, keyboard-focusable scroll regions', () => {
    const html = renderCandidate({
      status: 'EVALUATING',
      ready: false,
      completedGenerationCount: 4,
      comparisons: [
        { phase: 'targeted', left: 'A 正文', right: 'B 正文', choice: null },
        { phase: 'regression', left: '回归 A', right: '回归 B', choice: null },
        { phase: 'heldout', left: '留出 A', right: '留出 B', choice: null },
      ],
    })

    expect(html.match(/role="region"/gu)).toHaveLength(2)
    expect(html.match(/tabindex="0"/gu)).toHaveLength(2)
    expect(html).toContain('aria-label="版本 A 正文"')
    expect(html).toContain('aria-label="版本 B 正文"')
    expect(html).toContain('正文较长时，请在 A/B 正文框内滚动至末尾再选择。')
  })
})

function renderNewMethod(flags: Pick<MethodCandidateSnapshot, 'adoptionPending' | 'rolledBack'>): string {
  return renderCandidate({ ...flags })
}

function candidateSnapshot(overrides: Partial<MethodCandidateSnapshot>): MethodCandidateSnapshot {
  return {
    id: 'method-one',
    observationId: 'observation-one',
    title: '减少解释的新方式',
    summary: '更早用行动建立冲突。',
    tradeoff: '可能减少必要说明。',
    status: 'PROMOTED',
    ready: false,
    completedGenerationCount: 4,
    generationTotal: 4,
    resumable: false,
    preparationBlockedReason: null,
    preparationFailureKind: null,
    comparisons: [],
    adoptionPending: false,
    rolledBack: false,
    ...overrides,
  }
}

function renderCandidate(overrides: Partial<MethodCandidateSnapshot>): string {
  const candidate = candidateSnapshot(overrides)
  const status = {
    newMethods: [candidate],
    method: {
      activeVersion: 'baseline-v1',
      activeGuidance: null,
      currentName: '通用起步方法',
      stageLabel: '正在了解方向',
      history: [],
    },
  } as unknown as StudioViewStatus
  return renderToStaticMarkup(<NewMethodsPage onStatusChange={() => undefined} status={status} />)
}

function learningAction(overrides: Partial<MethodCandidateSnapshot>): string {
  const observationId = 'observation-one'
  const status = {
    learning: {
      observations: [{
        id: observationId,
        findingCode: 'APP-FEEDBACK-ONE',
        feedback: '更早建立风险。',
        independentWorks: 3,
        independentRuns: 3,
        independentTasks: 3,
        readyForCandidate: true,
      }],
      adoptedPrinciples: [],
    },
    newMethods: [candidateSnapshot({ observationId, ...overrides })],
  } as unknown as StudioViewStatus
  const html = renderToStaticMarkup(
    <LearningPage onStatusChange={() => undefined} status={status} />,
  )
  const action = html.match(/<button class="secondary-button"[^>]*>[^<]+<\/button>/u)?.[0]
  if (action === undefined) throw new Error('Learning action button was not rendered')
  return action
}
