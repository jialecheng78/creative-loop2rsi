import { useEffect, useId, useRef, useState } from 'react'

import type {
  DshModelId,
  RuntimeEvent,
  RuntimeRunHandle,
} from '@creative-loop2rsi/runtime-dsh'

import {
  adoptNewMethod,
  cancelWork,
  compareNewMethod,
  configureCredential,
  getStudioStatus,
  prepareNewMethod,
  rejectNewMethod,
  rollbackMethod,
  selectModel,
  startWork,
  submitHumanFeedback,
  subscribeToWorkEvents,
  type FeedbackAction,
  type MainSection,
  type StudioViewStatus,
} from './renderer-api.js'
import {
  actionableError,
  canSubmitEdit,
  creationInputIssue,
  feedbackSubmissionMessage,
  NAVIGATION,
  primaryFeedbackAction,
  progressMessage,
  recoveryPresentation,
} from './ui-model.js'
import { RunResolutionTracker } from './run-resolution.js'

type OnboardingStep = 'loading' | 'credential' | 'model' | 'ready'
type WorkState = 'empty' | 'pending' | 'ready' | 'failed'
const LAUNCHING_RUN: RuntimeRunHandle = { runId: 'active', sessionId: 'launching' }

export function App(): React.JSX.Element {
  const [status, setStatus] = useState<StudioViewStatus>()
  const [step, setStep] = useState<OnboardingStep>('loading')
  const [section, setSection] = useState<MainSection>('create')
  const [message, setMessage] = useState('正在读取本机状态…')
  const [error, setError] = useState('')
  const [topic, setTopic] = useState('')
  const [run, setRun] = useState<RuntimeRunHandle>()
  const [output, setOutput] = useState('')
  const [editedOutput, setEditedOutput] = useState('')
  const [feedback, setFeedback] = useState('')
  const [feedbackBusy, setFeedbackBusy] = useState(false)
  const [recoveryBusy, setRecoveryBusy] = useState(false)
  const [lastWorkId, setLastWorkId] = useState<string>()
  const [workState, setWorkState] = useState<WorkState>('empty')
  const [reviewClosed, setReviewClosed] = useState(false)
  const activeRunId = useRef<string | undefined>(undefined)
  const runResolution = useRef(new RunResolutionTracker())
  const launchInFlight = useRef(false)
  const launchCancellationRequested = useRef(false)

  useEffect(() => {
    let active = true
    void getStudioStatus().then(value => {
      if (!active) return
      setStatus(value)
      const savedOutput = value.currentWork?.output ?? ''
      setOutput(savedOutput)
      setEditedOutput(savedOutput)
      setLastWorkId(value.currentWork?.id)
      setWorkState(savedOutput === '' ? 'empty' : 'ready')
      setReviewClosed(value.currentWork?.frozen ?? false)
      const recovery = recoveryPresentation(value)
      if (value.credential === 'configured') {
        setStep('ready')
        setMessage(recovery?.message
          ?? (savedOutput === '' ? '已安全连接，可以开始创作。' : '已恢复上次保存的作品。'))
      } else {
        setStep('credential')
        if (!value.secureStorageAvailable) {
          setError('这台设备暂时无法使用系统安全存储，因此不会保存连接信息。请先启用系统钥匙串或凭据保护，再重启应用。')
        }
        setMessage(recovery?.message ?? '连接后才能开始创作。')
      }
    }).catch(caught => {
      if (!active) return
      setStep('credential')
      setError(actionableError(caught))
      setMessage('无法读取本机状态。')
    })

    const unsubscribe = subscribeToWorkEvents(handleWorkEvent)
    return () => {
      active = false
      unsubscribe()
    }

    function handleWorkEvent(event: RuntimeEvent): void {
      if (activeRunId.current !== undefined && event.runId !== activeRunId.current) return
      if (event.type === 'progress') setMessage(progressMessage(event.phase))
      if (event.type === 'output') {
        setOutput(event.text)
        setEditedOutput(event.text)
        setLastWorkId(event.runId)
        setWorkState('pending')
        setReviewClosed(false)
      }
      if (event.type === 'error') {
        setError(actionableError(new Error(event.message)))
        setMessage('本次创作没有完成。')
      }
      if (event.type === 'state' && event.state === 'completed') {
        if (activeRunId.current === undefined) runResolution.current.markTerminal(event.runId)
        setMessage('第一个版本已保存到本机。现在由你决定保留、修改还是重写。')
        setRun(undefined)
        setWorkState('ready')
        activeRunId.current = undefined
      }
      if (event.type === 'state' && event.state === 'cancelled') {
        if (activeRunId.current === undefined) runResolution.current.markTerminal(event.runId)
        setMessage('本次创作已停止，没有保存为完成版本。')
        setRun(undefined)
        setWorkState('failed')
        activeRunId.current = undefined
      }
      if (event.type === 'state' && event.state === 'failed') {
        if (activeRunId.current === undefined) runResolution.current.markTerminal(event.runId)
        setRun(undefined)
        setWorkState('failed')
        activeRunId.current = undefined
      }
    }
  }, [])

  async function beginCreation(): Promise<void> {
    const input = topic.trim()
    const inputIssue = creationInputIssue(input)
    if (inputIssue !== '') {
      setError(inputIssue)
      return
    }
    if (run !== undefined || launchInFlight.current) return
    const recovery = recoveryPresentation(status)
    if (recovery?.blocked === true) {
      setError('原编辑仍在本机，恢复完成前不会开始新创作。请重试。')
      setMessage(recovery.message)
      return
    }
    launchInFlight.current = true
    launchCancellationRequested.current = false
    setError('')
    setMessage(status?.activeSystem?.interruptedRun === null || status?.activeSystem?.interruptedRun === undefined
      ? '已收到，正在准备创作…'
      : '已收到，正在重新生成，并保留与上次中断记录的关联…')
    setOutput('')
    setEditedOutput('')
    setFeedback('')
    setWorkState('pending')
    setReviewClosed(false)
    setRun(LAUNCHING_RUN)
    try {
      const handle = await startWork(input)
      if (!runResolution.current.shouldActivate(handle.runId)) return
      activeRunId.current = handle.runId
      setRun(handle)
    } catch (caught) {
      setRun(undefined)
      setWorkState('failed')
      if (launchCancellationRequested.current) {
        setError('')
        setMessage('本次创作已停止，没有保存为完成版本。')
      } else {
        setError(actionableError(caught))
        setMessage('本次创作没有开始。')
      }
    } finally {
      launchInFlight.current = false
      launchCancellationRequested.current = false
    }
  }

  async function stopCreation(): Promise<void> {
    if (run === undefined) return
    if (run.runId === 'active') launchCancellationRequested.current = true
    setError('')
    setMessage('正在停止，本次未完成结果不会被当作成品…')
    try {
      await cancelWork(run.runId)
    } catch (caught) {
      setError(actionableError(caught))
      setMessage('没有确认停止成功。')
    }
  }

  async function submitFeedback(action: FeedbackAction): Promise<void> {
    if (output === '' || feedbackBusy) return
    if ((action === 'rewrite' || action === 'reject') && feedback.trim() === '') {
      setError(action === 'rewrite'
        ? '请先写下希望怎样重写，系统不会替你猜。'
        : '请先写下不采用的原因，让系统知道问题在哪里。')
      return
    }
    const recovery = recoveryPresentation(status)
    if (recovery?.blocked === true) {
      setError('原编辑仍在本机，恢复完成前不会接受新的反馈。请重试。')
      setMessage(recovery.message)
      return
    }
    setError('')
    setFeedbackBusy(true)
    setMessage('正在把你的决定保存到本机…')
    try {
      const result = await submitHumanFeedback({
        action,
        text: feedback.trim(),
        ...(action === 'edit' ? { editedText: editedOutput } : {}),
        ...(lastWorkId === undefined ? {} : { workId: lastWorkId }),
      })
      const nextStatus = result.status
      setStatus(nextStatus)
      const savedWork = nextStatus.currentWork
      if (savedWork?.output !== undefined) {
        setOutput(savedWork.output)
        setEditedOutput(savedWork.output)
        setLastWorkId(savedWork.id)
        setWorkState('ready')
      }
      if (result.outcome === 'submitted') setFeedback('')
      setReviewClosed(true)
      setMessage(feedbackSubmissionMessage(result.outcome, action))
    } catch (caught) {
      setError(actionableError(caught))
      setMessage('没有确认全部保存完成；再次提交会从已记录的位置继续。')
    } finally {
      setFeedbackBusy(false)
    }
  }

  async function retryFeedbackRecovery(): Promise<void> {
    if (recoveryBusy) return
    setRecoveryBusy(true)
    setError('')
    setMessage('正在恢复上次已经保存的反馈与编辑…')
    try {
      const nextStatus = await getStudioStatus()
      setStatus(nextStatus)
      const savedWork = nextStatus.currentWork
      const savedOutput = savedWork?.output ?? ''
      setOutput(savedOutput)
      setEditedOutput(savedOutput)
      setLastWorkId(savedWork?.id)
      setWorkState(savedOutput === '' ? 'empty' : 'ready')
      setReviewClosed(savedWork?.frozen ?? false)
      const recovery = recoveryPresentation(nextStatus)
      setMessage(recovery?.message ?? '上次反馈已经恢复。')
      if (recovery?.blocked === true) {
        setError('还没有确认恢复完成。原编辑仍保留在本机，请再次重试。')
      }
    } catch (caught) {
      setError(actionableError(caught))
      setMessage('还没有确认恢复完成。原编辑仍保留在本机，请重试。')
    } finally {
      setRecoveryBusy(false)
    }
  }

  function startAnotherWork(): void {
    setTopic('')
    setOutput('')
    setEditedOutput('')
    setFeedback('')
    setLastWorkId(undefined)
    setWorkState('empty')
    setReviewClosed(false)
    setError('')
    setMessage('请描述下一次想创作什么。')
  }

  const content = step === 'loading'
    ? <LoadingView message={message} />
    : step === 'credential'
      ? <CredentialView error={error} message={message} onConfigured={(nextStatus) => {
          setStatus(nextStatus)
          setError('')
          setMessage('连接成功。选择这次创作使用的方式。')
          setStep('model')
        }} />
      : step === 'model'
        ? <ModelView
            current={status?.selectedModel ?? 'deepseek-v4-pro'}
            error={error}
            onComplete={nextStatus => {
              setStatus(nextStatus)
              setError('')
              setMessage('已准备好。告诉我你想创作什么。')
              setStep('ready')
            }}
          />
        : <StudioView
            editedOutput={editedOutput}
            error={error}
            feedback={feedback}
            feedbackBusy={feedbackBusy}
            message={message}
            onChangeEditedOutput={setEditedOutput}
            onChangeFeedback={setFeedback}
            onChangeTopic={setTopic}
            onStart={() => void beginCreation()}
            onStartAnother={startAnotherWork}
            onStop={() => void stopCreation()}
            onSubmitFeedback={action => void submitFeedback(action)}
            onRetryRecovery={() => void retryFeedbackRecovery()}
            onStatusChange={setStatus}
            output={output}
            reviewClosed={reviewClosed}
            recoveryBusy={recoveryBusy}
            run={run}
            section={section}
            status={status}
            topic={topic}
            workState={workState}
          />

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <Sidebar
        disabled={step !== 'ready'}
        onNavigate={setSection}
        section={section}
      />
      <main className="workspace" id="main-content" tabIndex={-1}>
        {content}
      </main>
    </div>
  )
}

function Sidebar(props: {
  readonly disabled: boolean
  readonly onNavigate: (section: MainSection) => void
  readonly section: MainSection
}): React.JSX.Element {
  return (
    <aside className="sidebar">
      <div className="brand-lockup">
        <div aria-hidden="true" className="brand-mark">CR</div>
        <div>
          <p className="eyebrow sidebar-eyebrow">CREATIVE RSI STUDIO</p>
          <p className="brand-promise">让创作方法<br />跟着你一起成长</p>
        </div>
      </div>
      <nav aria-label="主要功能" className="primary-nav">
        {NAVIGATION.map(item => (
          <button
            aria-current={props.section === item.id ? 'page' : undefined}
            className={props.section === item.id ? 'nav-item active' : 'nav-item'}
            disabled={props.disabled}
            key={item.id}
            onClick={() => props.onNavigate(item.id)}
            type="button"
          >
            <span aria-hidden="true">{item.number}</span>
            {item.label}
          </button>
        ))}
      </nav>
      <div className="privacy-note">
        <span aria-hidden="true" className="privacy-dot" />
        <p>作品与学习记录默认只保存在本机</p>
      </div>
    </aside>
  )
}

function LoadingView({ message }: { readonly message: string }): React.JSX.Element {
  return (
    <section aria-busy="true" className="centered-view" role="status">
      <div aria-hidden="true" className="loading-mark" />
      <p>{message}</p>
    </section>
  )
}

function CredentialView(props: {
  readonly error: string
  readonly message: string
  readonly onConfigured: (status: StudioViewStatus) => void
}): React.JSX.Element {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState('')
  const descriptionId = useId()

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const submittedKey = key
    setKey('')
    setLocalError('')
    if (submittedKey.trim() === '' || submittedKey !== submittedKey.trim()) {
      setLocalError('请粘贴完整的 DeepSeek API Key，前后不要带空格。')
      return
    }
    setBusy(true)
    try {
      props.onConfigured(await configureCredential(submittedKey))
    } catch (caught) {
      setLocalError(actionableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="onboarding-view narrow-view">
      <p className="eyebrow">第 1 步 · 安全连接</p>
      <h1>先连接 DeepSeek</h1>
      <p className="lead">你输入的创作主题和作品内容会发送给 DeepSeek 官方服务，用来完成创作。</p>
      <form className="setup-card" onSubmit={event => void submit(event)}>
        <label htmlFor="api-key">DeepSeek API Key</label>
        <p className="field-help" id={descriptionId}>只用于连接官方服务，由系统安全存储；提交后不会在页面中显示。</p>
        <input
          aria-describedby={descriptionId}
          autoComplete="off"
          autoFocus
          id="api-key"
          name="api-key"
          onChange={event => setKey(event.target.value)}
          placeholder="粘贴后即可验证"
          spellCheck={false}
          type="password"
          value={key}
        />
        <div className="setup-footer">
          <p aria-live="polite" className="inline-status" role="status">{busy ? '正在验证并安全保存…' : props.message}</p>
          <button className="primary-button" disabled={busy || key === ''} type="submit">
            {busy ? '正在连接…' : '验证并继续'}
          </button>
        </div>
      </form>
      <ErrorNotice message={localError || props.error} />
      <p className="fine-print">应用不会把你的连接信息写入作品、日志或导出文件。</p>
    </section>
  )
}

function ModelView(props: {
  readonly current: DshModelId
  readonly error: string
  readonly onComplete: (status: StudioViewStatus) => void
}): React.JSX.Element {
  const [choice, setChoice] = useState<DshModelId>(props.current)
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState('')

  async function continueToTopic(): Promise<void> {
    setBusy(true)
    setLocalError('')
    try {
      props.onComplete(await selectModel(choice))
    } catch (caught) {
      setLocalError(actionableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="onboarding-view">
      <p className="eyebrow">第 2 步 · 选择创作方式</p>
      <h1>这次想怎样创作？</h1>
      <p className="lead">不确定就选 Pro。之后可以更换，但更换后会从新的比较起点开始。</p>
      <fieldset className="model-grid">
        <legend className="visually-hidden">选择 DeepSeek 模型</legend>
        <label className={choice === 'deepseek-v4-pro' ? 'model-card selected' : 'model-card'}>
          <input
            checked={choice === 'deepseek-v4-pro'}
            name="model"
            onChange={() => setChoice('deepseek-v4-pro')}
            type="radio"
            value="deepseek-v4-pro"
          />
          <span className="model-card-top"><strong>V4 Pro</strong><em>推荐</em></span>
          <span>更适合需要推敲、结构和细节的创作。</span>
        </label>
        <label className={choice === 'deepseek-v4-flash' ? 'model-card selected' : 'model-card'}>
          <input
            checked={choice === 'deepseek-v4-flash'}
            name="model"
            onChange={() => setChoice('deepseek-v4-flash')}
            type="radio"
            value="deepseek-v4-flash"
          />
          <span className="model-card-top"><strong>V4 Flash</strong><em>更快、更省</em></span>
          <span>更适合快速起稿和轻量修改。</span>
        </label>
      </fieldset>
      <div className="continue-row">
        <button className="primary-button" disabled={busy} onClick={() => void continueToTopic()} type="button">
          {busy ? '正在准备…' : '继续创作'}
        </button>
      </div>
      <ErrorNotice message={localError || props.error} />
    </section>
  )
}

function StudioView(props: {
  readonly editedOutput: string
  readonly error: string
  readonly feedback: string
  readonly feedbackBusy: boolean
  readonly message: string
  readonly onChangeEditedOutput: (value: string) => void
  readonly onChangeFeedback: (value: string) => void
  readonly onChangeTopic: (value: string) => void
  readonly onStart: () => void
  readonly onStartAnother: () => void
  readonly onStop: () => void
  readonly onSubmitFeedback: (action: FeedbackAction) => void
  readonly onRetryRecovery: () => void
  readonly onStatusChange: (status: StudioViewStatus) => void
  readonly output: string
  readonly reviewClosed: boolean
  readonly recoveryBusy: boolean
  readonly run: RuntimeRunHandle | undefined
  readonly section: MainSection
  readonly status: StudioViewStatus | undefined
  readonly topic: string
  readonly workState: WorkState
}): React.JSX.Element {
  if (props.section === 'learning') return <LearningPage onStatusChange={props.onStatusChange} status={props.status} />
  if (props.section === 'new-methods') return <NewMethodsPage onStatusChange={props.onStatusChange} status={props.status} />
  if (props.section === 'versions') return <VersionsPage onStatusChange={props.onStatusChange} status={props.status} />
  return <CreationPage {...props} />
}

function CreationPage(props: Parameters<typeof StudioView>[0]): React.JSX.Element {
  const inputIssue = creationInputIssue(props.topic)
  const recovery = recoveryPresentation(props.status)
  const recoveryBlocked = recovery?.blocked === true
  const canStart = inputIssue === '' && props.run === undefined && !recoveryBlocked
  const hasOutput = props.output !== ''
  const decisionLocked = props.workState !== 'ready' || props.reviewClosed || recoveryBlocked
  const modelLabel = props.status?.selectedModel === 'deepseek-v4-flash' ? 'V4 Flash' : 'V4 Pro'

  return (
    <section aria-busy={props.run !== undefined} className="page-view">
      <header className="page-header">
        <div>
          <p className="eyebrow">创作</p>
          <h1>{hasOutput ? (props.workState === 'failed' ? '这是未完成草稿' : '这是你的版本') : '你想创作什么？'}</h1>
          <p>{hasOutput
            ? (props.workState === 'failed'
                ? '它没有被记为完成版本。你可以复制文字后重新开始。'
                : '文字可以直接修改。只有你的明确选择，才会影响今后的创作方法。')
            : '一句话、一段素材或一个模糊念头都可以。'}</p>
        </div>
        <span className="model-pill" title="当前选择">{modelLabel}</span>
      </header>

      {recovery === null
        ? null
        : <div className={`recovery-notice ${recovery.tone}`} role="status">
            <span>{recovery.message}</span>
            {recovery.canRetry
              ? <button
                  className="secondary-button"
                  disabled={props.recoveryBusy}
                  onClick={props.onRetryRecovery}
                  type="button"
                >{props.recoveryBusy ? '正在恢复…' : '重试恢复'}</button>
              : null}
          </div>}

      {!hasOutput
        ? <section className="composer-card">
            <label className="visually-hidden" htmlFor="creation-topic">创作方向</label>
            <textarea
              autoFocus
              disabled={props.run !== undefined}
              id="creation-topic"
              maxLength={100_000}
              onChange={event => props.onChangeTopic(event.target.value)}
              placeholder="例如：我想写一个克制、可信、带一点冷幽默的近未来悬疑短篇。"
              value={props.topic}
            />
            {props.topic !== '' && inputIssue !== '' ? <p className="input-issue" role="alert">{inputIssue}</p> : null}
            <div className="composer-actions">
              <StatusLine message={props.message} />
              {props.run === undefined
                ? <button className="primary-button" disabled={!canStart} onClick={props.onStart} type="button">开始创作</button>
                : <button className="secondary-button danger-button" onClick={props.onStop} type="button">停止本次创作</button>}
            </div>
          </section>
        : <div className="review-layout">
            <section className="work-card">
              <div className="card-heading">
                <div>
                  <p className="eyebrow">{props.workState === 'ready' ? '已保存版本' : props.workState === 'failed' ? '未保存草稿' : '正在安全保存'}</p>
                  <h2>直接在这里修改</h2>
                </div>
                <span>{props.editedOutput === props.output ? '尚未编辑' : '有未提交编辑'}</span>
              </div>
              <label className="visually-hidden" htmlFor="work-editor">作品正文</label>
              <textarea
                className="work-editor"
                id="work-editor"
                onChange={event => props.onChangeEditedOutput(event.target.value)}
                readOnly={props.workState !== 'ready' || props.reviewClosed || recoveryBlocked}
                value={props.editedOutput}
              />
            </section>
            <aside className="decision-card" aria-label="决定如何处理这个版本">
              <p className="eyebrow">你的决定</p>
              <h2>这个版本怎么样？</h2>
              {props.reviewClosed ? <p className="decision-locked">这个版本的决定已保存。开始另一项创作后，可以继续提供新反馈。</p> : null}
              {props.workState === 'pending' ? <p className="decision-locked">作品保存完成后，才能提交你的决定。</p> : null}
              {props.workState === 'failed' ? <p className="decision-locked">未完成草稿不能作为学习依据。</p> : null}
              <label htmlFor="work-feedback">想保留或改变什么？</label>
              <textarea
                disabled={recoveryBlocked}
                id="work-feedback"
                onChange={event => props.onChangeFeedback(event.target.value)}
                placeholder="例如：开头很好，但人物答应得太快，希望冲突再多一步。"
                value={props.feedback}
              />
              <div className="decision-actions">
                <button
                className="primary-button"
                  disabled={props.feedbackBusy || decisionLocked}
                  onClick={() => props.onSubmitFeedback(primaryFeedbackAction(
                    props.output,
                    props.editedOutput,
                  ))}
                  type="button"
                >{props.editedOutput === props.output ? '保留这个版本' : '保存编辑并保留'}</button>
                <button
                  className="secondary-button"
                  disabled={props.feedbackBusy || decisionLocked || props.feedback.trim() === ''}
                  onClick={() => props.onSubmitFeedback('rewrite')}
                  type="button"
                >提交重写意见</button>
                <button
                  className="secondary-button"
                  disabled={props.feedbackBusy || decisionLocked || !canSubmitEdit(props.output, props.editedOutput, props.feedback)}
                  onClick={() => props.onSubmitFeedback('edit')}
                  type="button"
                >提交编辑与反馈</button>
                <button
                  className="text-button reject-button"
                  disabled={props.feedbackBusy || decisionLocked || props.feedback.trim() === ''}
                  onClick={() => props.onSubmitFeedback('reject')}
                  type="button"
                >不采用这个版本</button>
              </div>
              <p className="decision-help">保留、拒绝、文字修改和明确反馈会先保存为证据。只有同类反馈来自三项独立创作，并经过三组盲比且由你采用，才会改变下一次创作。</p>
            </aside>
          </div>}

      <div className="page-status-area">
        {hasOutput ? <StatusLine message={props.message} /> : null}
        <ErrorNotice message={props.error} />
      </div>
      {hasOutput && props.run === undefined
        ? <button className="new-work-button" disabled={recoveryBlocked} onClick={props.onStartAnother} type="button">开始另一项创作</button>
        : null}
    </section>
  )
}

function LearningPage(props: {
  readonly onStatusChange: (status: StudioViewStatus) => void
  readonly status: StudioViewStatus | undefined
}): React.JSX.Element {
  const status = props.status
  const observations = status?.learning?.observations ?? []
  const principles = status?.learning?.adoptedPrinciples ?? []
  const [busyId, setBusyId] = useState<string>()
  const [notice, setNotice] = useState('')

  async function prepare(observationId: string): Promise<void> {
    if (busyId !== undefined) return
    setBusyId(observationId)
    setNotice('正在生成一种新方法和三组盲比内容。这会调用 Flash/Pro，但不会自动改变当前方法…')
    try {
      const nextStatus = await prepareNewMethod(observationId)
      props.onStatusChange(nextStatus)
      setNotice('三组盲比已准备好。请前往“新方式”，只按作品本身作选择。')
    } catch (caught) {
      setNotice(actionableError(caught))
    } finally {
      setBusyId(undefined)
    }
  }

  return (
    <section className="page-view">
      <header className="page-header prose-header">
        <div>
          <p className="eyebrow">它学到了什么</p>
          <h1>你仍然拥有最后决定权</h1>
          <p>系统只整理你在不同作品中反复给出的明确反馈。它可以提出新方法，但不能替你采用。</p>
        </div>
      </header>
      <div className="two-column-cards">
        <section className="evidence-card observation">
          <div className="card-heading">
            <div><h2>暂时观察</h2><p>同一句反馈必须来自三项独立创作，才有资格提出候选方法。</p></div>
            <span>{observations.length}</span>
          </div>
          {observations.length === 0
            ? <EmptyState text="还没有重复观察。先完成作品并提交明确反馈；单个作品不会改变全局方法。" />
            : <ul className="evidence-items">{observations.map(item => (
                <li key={item.id}>
                  <strong>{item.feedback}</strong>
                  <span>{item.independentWorks}/3 项独立创作</span>
                  <button
                    className="secondary-button"
                    disabled={!item.readyForCandidate || busyId !== undefined}
                    onClick={() => void prepare(item.id)}
                    type="button"
                  >{busyId === item.id ? '正在准备盲比…' : item.readyForCandidate ? '提出并比较新方法' : '证据不足'}</button>
                </li>
              ))}</ul>}
        </section>
        <section className="evidence-card principle">
          <div className="card-heading">
            <div><h2>已采用原则</h2><p>只有你完成盲比并点击采用的原则，才会进入后续创作。</p></div>
            <span>{principles.length}</span>
          </div>
          {principles.length === 0
            ? <EmptyState text="还没有已采用原则。系统的观察和候选不会自动成为规则。" />
            : <ul className="evidence-items">{principles.map(item => (
                <li key={`${item.version}-${item.adoptedAt}`}>
                  <strong>{item.guidance}</strong>
                  <span>{item.active ? '当前正在使用' : '已保留在历史中'}</span>
                </li>
              ))}</ul>}
        </section>
      </div>
      <p aria-live="polite" className="section-notice" role="status">{notice}</p>
    </section>
  )
}

function NewMethodsPage(props: {
  readonly onStatusChange: (status: StudioViewStatus) => void
  readonly status: StudioViewStatus | undefined
}): React.JSX.Element {
  const status = props.status
  const methods = status?.newMethods ?? []
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  async function decide(id: string, action: 'adopt' | 'reject'): Promise<void> {
    if (busy) return
    setBusy(true)
    setNotice('正在保存你的决定…')
    try {
      const nextStatus = action === 'adopt' ? await adoptNewMethod(id) : await rejectNewMethod(id)
      props.onStatusChange(nextStatus)
      setNotice(action === 'adopt' ? '已采用新方式，并保留了回到旧方式的入口。' : '已拒绝，新方式没有影响当前创作。')
    } catch (caught) {
      setNotice(actionableError(caught))
    } finally {
      setBusy(false)
    }
  }

  async function compare(
    candidateId: string,
    phase: 'targeted' | 'regression' | 'heldout',
    choice: 'A' | 'B' | 'TIE',
  ): Promise<void> {
    if (busy) return
    setBusy(true)
    setNotice('正在保存这组盲比选择…')
    try {
      const nextStatus = await compareNewMethod(candidateId, phase, choice)
      props.onStatusChange(nextStatus)
      const next = nextStatus.newMethods?.find(item => item.id === candidateId)
      setNotice(next?.ready === true ? '三组盲比已完成。现在可以查看候选说明并作最终决定。' : '这一组已保存，请继续下一组。')
    } catch (caught) {
      setNotice(actionableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="page-view">
      <header className="page-header prose-header">
        <div>
          <p className="eyebrow">新方式</p>
          <h1>先比较，再由你采用</h1>
          <p>只有同类问题在多项独立创作中反复出现，系统才会提出新方式。一次不满意不会改变全局。</p>
        </div>
      </header>
      {methods.length === 0
        ? <section className="large-empty-card">
            <span aria-hidden="true" className="empty-symbol">↗</span>
            <h2>目前没有等待决定的新方式</h2>
            <p>这不是故障。证据不足时，保持现有方法比仓促改变更可靠。</p>
            <p>当“它学到了什么”里出现 3/3 的观察后，你可以在那里发起候选。</p>
          </section>
        : <div className="method-list">
            {methods.map(method => {
              const unanswered = method.comparisons.find(item => item.choice === null)
              const answered = method.comparisons.filter(item => item.choice !== null).length
              const adoptionIncomplete = method.status === 'PROMOTED'
                && status?.method?.activeVersion !== method.id
              const decided = method.status === 'REJECTED'
                || (method.status === 'PROMOTED' && !adoptionIncomplete)
              return (
                <article className="method-card" key={method.id}>
                  <span>{adoptionIncomplete ? '等待完成采用' : decided ? (method.status === 'PROMOTED' ? '已采用' : '已拒绝') : method.ready ? '可以决定' : `盲比 ${answered + 1}/3`}</span>
                  {unanswered === undefined
                    ? <>
                        <h2>{method.title}</h2>
                        <p>{method.summary}</p>
                        <p className="tradeoff">可能的代价：{method.tradeoff}</p>
                        <div>
                          <button className="primary-button" disabled={(!method.ready && !adoptionIncomplete) || busy || decided} onClick={() => void decide(method.id, 'adopt')} type="button">{adoptionIncomplete ? '完成采用' : '采用新方式'}</button>
                          <button className="secondary-button" disabled={busy || decided} onClick={() => void decide(method.id, 'reject')} type="button">拒绝</button>
                        </div>
                      </>
                    : <>
                        <h2>{comparisonLabel(unanswered.phase)}</h2>
                        <p>只比较作品，不会告诉你哪一边使用了候选方法。你的选择保存后不能改写。</p>
                        <div className="blind-comparison">
                          <section><span>版本 A</span><p>{unanswered.left}</p></section>
                          <section><span>版本 B</span><p>{unanswered.right}</p></section>
                        </div>
                        <div className="comparison-actions">
                          <button className="secondary-button" disabled={busy} onClick={() => void compare(method.id, unanswered.phase, 'A')} type="button">A 更好</button>
                          <button className="secondary-button" disabled={busy} onClick={() => void compare(method.id, unanswered.phase, 'TIE')} type="button">差不多</button>
                          <button className="secondary-button" disabled={busy} onClick={() => void compare(method.id, unanswered.phase, 'B')} type="button">B 更好</button>
                        </div>
                      </>}
                </article>
              )
            })}
          </div>}
      <p aria-live="polite" className="section-notice" role="status">{notice}</p>
    </section>
  )
}

function VersionsPage(props: {
  readonly onStatusChange: (status: StudioViewStatus) => void
  readonly status: StudioViewStatus | undefined
}): React.JSX.Element {
  const status = props.status
  const history = status?.method?.history ?? []
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  async function rollback(id: string): Promise<void> {
    if (busy) return
    setBusy(true)
    setNotice('正在恢复旧方式…')
    try {
      const nextStatus = await rollbackMethod(id)
      props.onStatusChange(nextStatus)
      setNotice('已恢复旧方式，历史记录仍然保留。')
    } catch (caught) {
      setNotice(actionableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="page-view">
      <header className="page-header prose-header">
        <div>
          <p className="eyebrow">版本</p>
          <h1>每次改变都有来路，也能回去</h1>
          <p>第一次创作只是起点，不代表系统已经改进。只有经过比较并由你采用，才会形成新版本。</p>
        </div>
      </header>
      <section className="current-method-card">
        <div>
          <p className="eyebrow">当前方法</p>
          <h2>{status?.method?.currentName ?? '通用起步方法'}</h2>
          <p>{status?.method?.stageLabel ?? '正在从你的真实创作与明确反馈中了解方向'}</p>
        </div>
        <span className="current-badge">正在使用</span>
      </section>
      <section className="history-card">
        <div className="card-heading">
          <div>
            <h2>历史变化</h2>
            <p>采用过的新方式会保留在这里。</p>
          </div>
          <span>{history.length}</span>
        </div>
        {history.length === 0
          ? <EmptyState text="还没有历史变化，因此现在没有可回退的版本。" />
          : <ol className="version-list">
              {history.map(item => (
                <li key={`${item.action}-${item.version}-${item.createdAt}`}>
                  <div>
                    <strong>{item.action === 'PROMOTE' ? `采用 ${item.version}` : `回滚到 ${item.version}`}</strong>
                    <time>{item.createdAt}</time>
                  </div>
                  <button
                    className="secondary-button"
                    disabled={busy || item.previousVersion === status?.method?.activeVersion}
                    onClick={() => void rollback(item.previousVersion)}
                    type="button"
                  >恢复改变前的方法</button>
                </li>
              ))}
            </ol>}
      </section>
      <p aria-live="polite" className="section-notice" role="status">{notice}</p>
    </section>
  )
}

function comparisonLabel(phase: 'targeted' | 'regression' | 'heldout'): string {
  if (phase === 'targeted') return '比较 1：它是否解决了重复问题'
  if (phase === 'regression') return '比较 2：它有没有伤害原本正常的作品'
  return '比较 3：在未参与改进的新任务上是否仍然成立'
}

function EmptyState({ text }: { readonly text: string }): React.JSX.Element {
  return <div className="empty-state"><span aria-hidden="true">·</span><p>{text}</p></div>
}

function StatusLine({ message }: { readonly message: string }): React.JSX.Element {
  return <p aria-live="polite" className="inline-status" role="status">{message}</p>
}

function ErrorNotice({ message }: { readonly message: string }): React.JSX.Element | null {
  if (message === '') return null
  return <div className="error-notice" role="alert"><span aria-hidden="true">!</span><p>{message}</p></div>
}
