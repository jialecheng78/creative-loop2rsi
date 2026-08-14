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

export function actionableError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const text = raw.toLocaleLowerCase('zh-CN')

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
  if (system?.interruptedRun !== null && system?.interruptedRun !== undefined) {
    return {
      blocked: false,
      canRetry: false,
      message: '上次运行中断，但已经封存的作品仍在。本次会重新生成，并保留与中断记录的关联；不会续写未完成的模型推理。',
      tone: 'attention',
    }
  }
  return null
}
