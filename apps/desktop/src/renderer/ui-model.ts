import type { FeedbackAction, MainSection, StudioViewStatus } from './renderer-api.js'

export interface RecoveryPresentation {
  readonly blocked: boolean
  readonly canRetry: boolean
  readonly message: string
  readonly tone: 'attention' | 'recovered'
}

export const NAVIGATION: readonly {
  readonly id: MainSection
  readonly label: string
  readonly number: string
}[] = [
  { id: 'create', label: '创作', number: '01' },
  { id: 'learning', label: '它学到了什么', number: '02' },
  { id: 'new-methods', label: '新方式', number: '03' },
  { id: 'versions', label: '版本', number: '04' },
]

export function actionableError(error: unknown, code?: string): string {
  const raw = error instanceof Error ? error.message : String(error)
  const text = raw.toLocaleLowerCase('zh-CN')
  const requestAttempts = safeRequestAttemptSuffix(raw)

  if (code === 'DEEPSEEK_FIRST_EVENT_TIMEOUT') {
    return `DeepSeek 在两分钟内没有开始返回内容${requestAttempts}。本次没有保存，请稍后重新开始。`
  }
  if (code === 'DEEPSEEK_STREAM_IDLE_TIMEOUT') {
    return `DeepSeek 已开始生成，但九十秒没有新进展${requestAttempts}。未完成内容不会保存，请重新开始。`
  }
  if (code === 'DEEPSEEK_TOTAL_TIMEOUT') {
    return `本次生成已达到十分钟上限${requestAttempts}。未完成内容不会保存；可以缩短任务后重新开始。`
  }
  if (code === 'OUTPUT_TRUNCATED') {
    return '模型达到本次生成上限，未完成内容没有保存。请缩短篇幅或拆成更小的任务后重新开始。'
  }
  if (code === 'WORK_TERMINATION_PENDING') {
    return '生成已经停止，但失败记录还没有安全封存。请重启应用恢复；本次不会计为作品或学习证据。'
  }
  if (/失败记录.*封存|不会计为作品或学习证据/u.test(raw)) {
    return '生成已经停止，但失败记录还没有安全封存。请重启应用恢复；本次不会计为作品或学习证据。'
  }

  if (raw === 'credential') {
    return '当前安装包还没有接通安全保存。请安装包含“安全连接”功能的更新后再试。'
  }
  if (raw === 'model') {
    return '当前安装包还不能切换到这个选项。你可以继续使用当前选项，或安装新版后重试。'
  }
  if (raw === 'feedback') {
    return '当前安装包还没有接通反馈保存。请先复制你的修改，安装包含“本地学习”功能的更新后再提交。'
  }
  if (raw === 'candidate' || raw === 'rollback') {
    return '这个操作在当前技术预览中尚未开放；系统没有改动你的创作方法。'
  }
  if (/\b401\b|unauthori[sz]ed|invalid[^\n]*key|鉴权|密钥无效/u.test(text)) {
    return '连接信息没有通过验证。请到 DeepSeek 官方控制台确认后，重新输入。'
  }
  if (/\b402\b|insufficient|balance|余额|欠费/u.test(text)) {
    return '账户余额不足，本次创作没有继续。请在 DeepSeek 官方控制台充值后重试。'
  }
  if (/\b429\b|rate.?limit|too many|频率|限流/u.test(text)) {
    return '请求太频繁，本次结果没有保存。请稍等一分钟再试。'
  }
  if (/timeout|timed out|超时/u.test(text)) {
    return '等待时间过长，本次结果没有保存。请检查网络后重新开始。'
  }
  if (/\b5\d\d\b|service unavailable|server error|服务暂时/u.test(text)) {
    return 'DeepSeek 官方服务暂时不可用，本次结果没有保存。请稍后重试。'
  }
  if (/network|offline|fetch|socket|网络|断网/u.test(text)) {
    return '没有连上 DeepSeek 官方服务。请检查网络后重新开始。'
  }
  if (/disk|enospc|read-only|write|磁盘|写入/u.test(text)) {
    return '作品没有写入本机。请确认磁盘空间充足且应用有保存权限，然后重试。'
  }
  if (/busy|正在运行/u.test(text)) {
    return '上一项创作还在进行。请等待完成，或先点击“停止本次创作”。'
  }
  if (/安全存储|钥匙串|凭据保护/u.test(text)) {
    return '系统安全存储暂时不可用。请先启用系统钥匙串或凭据保护，再重启应用。'
  }
  if (/models unavailable|v4 pro|v4 flash|账号权限/u.test(text)) {
    return '当前 DeepSeek 账号还不能使用这两个选项。请到官方控制台确认账号权限后重试。'
  }
  if (/review|反馈|版本当前不能/u.test(text)) {
    return '这个版本现在不能重复提交决定。请开始另一项创作，或查看已保存版本。'
  }
  if (/保存|commit|evidence/u.test(text)) {
    return '作品没有安全保存，本次不会被算作完成。请检查磁盘空间后重新开始。'
  }
  return '操作没有完成，也没有改动已保存内容。请重试；若仍失败，请重启应用。'
}

export function candidatePreparationError(error: unknown): string {
  const code = candidateErrorCode(error)
  if (code === 'OUTPUT_TRUNCATED') {
    return '候选生成达到输出上限，截断内容不会进入盲比。请到“新方式”放弃本次准备。'
  }
  if (code === 'DEEPSEEK_FIRST_EVENT_TIMEOUT'
    || code === 'DEEPSEEK_STREAM_IDLE_TIMEOUT'
    || code === 'DEEPSEEK_TOTAL_TIMEOUT'
    || code === 'DEEPSEEK_TIMEOUT') {
    return '候选生成已明确超时。已封存进度仍保留，请到“新方式”放弃本次准备。'
  }
  if (code === 'METHOD_EPOCH_CHANGED' || code === 'METHOD_EPOCH_UNVERIFIABLE') {
    return '候选的固定生成基线无法安全复用。请到“新方式”放弃本次准备。'
  }
  if (code === 'RUNTIME_FAILED' || code === 'EMPTY_OUTPUT') {
    return '候选生成已明确失败。已封存进度仍保留，请到“新方式”放弃本次准备。'
  }
  if (code === 'CREDENTIAL_REQUIRED') {
    return '请先重新连接 DeepSeek API Key，再回到“新方式”处理本次准备。'
  }
  if (code === 'EVIDENCE_INSUFFICIENT') {
    return '这条观察还没有三项独立创作证据，不会提出候选。'
  }
  if (code === 'APPLICATION_CLOSED') {
    return '应用正在关闭，没有开始下一项候选生成。'
  }
  return '新方式的最终状态还没有确认。请到“新方式”查看已封存状态；若显示“继续准备”可继续，若显示“准备已阻止”再放弃。'
}

function candidateErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

export function isConfirmedLaunchCancellation(error: unknown): boolean {
  const raw = error instanceof Error ? error.message : String(error)
  return raw === '本次创作已停止。' || /:\s*本次创作已停止。$/u.test(raw)
}

function safeRequestAttemptSuffix(raw: string): string {
  const match = /本次共发起 ([1-9]\d*) 次请求/u.exec(raw)
  if (match === null) return ''
  const count = Number(match[1])
  if (!Number.isSafeInteger(count) || count > 12) return ''
  return `（本次共发起 ${count} 次请求）`
}

export function progressMessage(phase: 'queued' | 'working' | 'idle'): string {
  if (phase === 'queued') return '已收到，正在准备创作…'
  if (phase === 'working') return '正在写第一个版本，你可以随时停止。'
  return '正在整理作品并安全保存…'
}

export function feedbackSuccessMessage(action: FeedbackAction): string {
  if (action === 'keep') return '已记下：你保留了这个版本。'
  if (action === 'rewrite') return '重写意见已作为证据保存；当前预览不会自动用于下一次创作。'
  if (action === 'reject') return '已记下：你不采用这个版本。'
  return '你的编辑和反馈已作为证据保存。'
}

export function feedbackSubmissionMessage(
  outcome: 'submitted' | 'recovered-previous',
  action: FeedbackAction,
): string {
  if (outcome === 'recovered-previous') {
    return '已恢复上次决定和原编辑；你刚才点击的新操作没有提交。请查看恢复后的版本。'
  }
  return feedbackSuccessMessage(action)
}

export function canSubmitEdit(original: string, edited: string, feedback: string): boolean {
  return edited.trim() !== '' && (edited !== original || feedback.trim() !== '')
}

export function primaryFeedbackAction(original: string, edited: string): 'edit' | 'keep' {
  return edited === original ? 'keep' : 'edit'
}

export function creationInputIssue(value: string): string {
  if (value.trim() === '') return '请先写下你想创作什么。'
  if (new TextEncoder().encode(value.trim()).byteLength > 100_000) {
    return '内容太长，请缩短后再开始。你也可以分成几次创作。'
  }
  return ''
}

export function recoveryPresentation(status: StudioViewStatus | undefined): RecoveryPresentation | null {
  const system = status?.activeSystem
  if (status?.workRecoveryState === 'retry-required') {
    return {
      blocked: true,
      canRetry: true,
      message: '上次创作已经停止，但本机还没有确认失败记录安全封存。请重试恢复；完成前不会开始新创作或修改方法。',
      tone: 'attention',
    }
  }
  if (status?.feedbackRecoveryState === 'retry-required' || system?.feedbackRecoveryRequired === true) {
    return {
      blocked: true,
      canRetry: true,
      message: '上次反馈未完成，原编辑已保留在本机。请重试恢复；完成前不能开始新创作或提交新反馈。',
      tone: 'attention',
    }
  }
  if (status?.feedbackRecoveryState === 'recovered') {
    return {
      blocked: false,
      canRetry: false,
      message: system?.interruptedRun === null || system?.interruptedRun === undefined
        ? '上次未完成的反馈已恢复，原编辑已经安全保存。'
        : '上次未完成的反馈已恢复，原编辑已经安全保存；上次运行也曾中断，本次会重新生成并保留与中断记录的关联。',
      tone: 'recovered',
    }
  }
  if (status?.workRecoveryState === 'recovered'
    && (system?.interruptedRun === null || system?.interruptedRun === undefined)) {
    return {
      blocked: false,
      canRetry: false,
      message: '上次未完成的创作记录已经安全收敛；已封存作品没有被改动。',
      tone: 'recovered',
    }
  }
  if (system?.interruptedRun !== null && system?.interruptedRun !== undefined) {
    const reason = system.interruptedRun.reasonCode
    if (reason === 'DEEPSEEK_FIRST_EVENT_TIMEOUT') {
      return {
        blocked: false,
        canRetry: false,
        message: '上次创作因为 DeepSeek 两分钟内没有开始返回内容而结束。本次会重新生成，并保留失败记录；不会把它计为作品或学习证据。',
        tone: 'attention',
      }
    }
    if (reason === 'DEEPSEEK_STREAM_IDLE_TIMEOUT') {
      return {
        blocked: false,
        canRetry: false,
        message: '上次创作在开始生成后九十秒没有新进展，因此已安全结束。本次会重新生成；未完成内容不会计入学习。',
        tone: 'attention',
      }
    }
    if (reason === 'DEEPSEEK_TOTAL_TIMEOUT') {
      return {
        blocked: false,
        canRetry: false,
        message: '上次创作达到十分钟总时限后已安全结束。本次会重新生成；未完成内容不会计入学习。',
        tone: 'attention',
      }
    }
    return {
      blocked: false,
      canRetry: false,
      message: '上次运行中断，但已经封存的作品仍在。本次会重新生成，并保留与中断记录的关联；不会续写未完成的模型推理。',
      tone: 'attention',
    }
  }
  return null
}
