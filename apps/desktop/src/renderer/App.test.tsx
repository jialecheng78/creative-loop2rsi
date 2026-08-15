import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { MethodCandidateSnapshot } from '../shared/ipc.js'
import { App, LearningPage, NewMethodsPage } from './App.js'
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
})

function renderNewMethod(flags: Pick<MethodCandidateSnapshot, 'adoptionPending' | 'rolledBack'>): string {
  const candidate: MethodCandidateSnapshot = {
    id: 'method-one',
    title: '减少解释的新方式',
    summary: '更早用行动建立冲突。',
    tradeoff: '可能减少必要说明。',
    status: 'PROMOTED',
    ready: false,
    comparisons: [],
    ...flags,
  }
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
