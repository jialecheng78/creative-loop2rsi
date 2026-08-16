import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'

import {
  IPC_CHANNELS,
  type CandidateIpcErrorCode,
  type CandidateIpcResult,
  type StudioEvent,
} from '../shared/ipc.js'
import {
  isTrustedIpcSender,
  type TrustedIpcBoundary,
} from './ipc-security.js'
import {
  validateCancelWorkInput,
  validateCandidateDecisionInput,
  validateCompareCandidateInput,
  validateCreateSystemInput,
  validateCredentialInput,
  validateFeedbackInput,
  validateModelInput,
  validateStartWorkInput,
  validatePrepareCandidateInput,
  validateRollbackMethodInput,
} from './ipc-validation.js'
import { StudioServiceError, type StudioService } from './studio-service.js'

export { isTrustedIpcSender, type TrustedIpcBoundary } from './ipc-security.js'

export function registerIpc(
  service: StudioService,
  boundary: () => TrustedIpcBoundary,
): () => void {
  handle(IPC_CHANNELS.appStatus, boundary, args => {
    noArguments(args)
    return service.getStatus()
  })
  handle(IPC_CHANNELS.credentialsStatus, boundary, args => {
    noArguments(args)
    return service.credentialStatus()
  })
  handle(IPC_CHANNELS.credentialsConfigure, boundary, args => {
    const [input] = oneArgument(args)
    const credential = validateCredentialInput(input)
    return service.configureCredential(credential.apiKey, credential.allowSessionOnly)
  })
  handle(IPC_CHANNELS.credentialsDelete, boundary, args => {
    noArguments(args)
    return service.deleteCredential()
  })
  handle(IPC_CHANNELS.modelSelect, boundary, args => {
    const [input] = oneArgument(args)
    return service.selectModel(validateModelInput(input).model)
  })
  handle(IPC_CHANNELS.systemsCreate, boundary, args => {
    const [input] = oneArgument(args)
    return service.createSystem(validateCreateSystemInput(input))
  })
  handle(IPC_CHANNELS.systemsSnapshot, boundary, args => {
    noArguments(args)
    return service.systemSnapshot()
  })
  handle(IPC_CHANNELS.worksStart, boundary, args => {
    const [input] = oneArgument(args)
    return service.startWork(validateStartWorkInput(input).task)
  })
  handle(IPC_CHANNELS.worksCancel, boundary, args => {
    const [input] = oneArgument(args)
    return service.cancelWork(validateCancelWorkInput(input).runId)
  })
  handle(IPC_CHANNELS.worksSubmitFeedback, boundary, args => {
    const [input] = oneArgument(args)
    return service.submitFeedback(validateFeedbackInput(input))
  })
  handleCandidate(IPC_CHANNELS.candidatesPrepare, boundary, args => {
    const [input] = oneArgument(args)
    return service.prepareMethodCandidate(validatePrepareCandidateInput(input).observationId)
  })
  handleCandidate(IPC_CHANNELS.candidatesCompare, boundary, args => {
    const [input] = oneArgument(args)
    return service.submitMethodComparison(validateCompareCandidateInput(input))
  })
  handleCandidate(IPC_CHANNELS.candidatesAdopt, boundary, args => {
    const [input] = oneArgument(args)
    return service.adoptMethodCandidate(validateCandidateDecisionInput(input).candidateId)
  })
  handleCandidate(IPC_CHANNELS.candidatesReject, boundary, args => {
    const [input] = oneArgument(args)
    return service.rejectMethodCandidate(validateCandidateDecisionInput(input).candidateId)
  })
  handle(IPC_CHANNELS.releasesRollback, boundary, args => {
    const [input] = oneArgument(args)
    return service.rollbackMethod(validateRollbackMethodInput(input).version)
  })

  return () => {
    for (const channel of Object.values(IPC_CHANNELS)) {
      if (channel !== IPC_CHANNELS.studioEvent) ipcMain.removeHandler(channel)
    }
  }
}

function handleCandidate<T>(
  channel: string,
  boundary: () => TrustedIpcBoundary,
  action: (args: readonly unknown[]) => T | Promise<T>,
): void {
  ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (!isTrustedIpcSender(event, boundary())) throw new Error('IPC 调用来源不受信任。')
    try {
      return { ok: true, value: await action(args) } satisfies CandidateIpcResult<T>
    } catch (error) {
      return { ok: false, error: candidatePublicError(error) } satisfies CandidateIpcResult<T>
    }
  })
}

export function candidatePublicError(error: unknown): {
  readonly code: CandidateIpcErrorCode
  readonly message: string
} {
  const rawCode = error instanceof StudioServiceError
    ? error.code
    : error instanceof TypeError
      ? 'CANDIDATE_REQUEST_INVALID'
      : 'CANDIDATE_OPERATION_FAILED'
  const code = candidatePublicCode(rawCode)
  const messages: Record<CandidateIpcErrorCode, string> = {
    ACCOUNT_BALANCE: 'DeepSeek 账户余额不足，新方式准备已停止。请在新方式页放弃本次准备。',
    APPLICATION_CLOSED: '应用正在关闭，没有开始下一项候选生成。',
    CANDIDATE_OPERATION_FAILED: '新方式操作的最终状态还没有确认。请到“新方式”查看已封存状态；显示可继续时可继续，显示已阻止时再放弃。',
    CANDIDATE_PREPARATION_BLOCKED: '这次新方式准备已被安全阻止，不会自动重复调用模型。请查看失败类型并放弃本次准备。',
    CANDIDATE_REQUEST_INVALID: '新方式请求格式无效，本机记录没有改变。',
    CREDENTIAL_REJECTED: 'DeepSeek 未接受当前连接信息，新方式准备已停止。请放弃本次准备。',
    CREDENTIAL_REQUIRED: '请先连接 DeepSeek API Key，再处理新方式。',
    DEEPSEEK_FIRST_EVENT_TIMEOUT: 'DeepSeek 在开始返回前超时，本次新方式准备已停止。请放弃本次准备。',
    DEEPSEEK_STREAM_IDLE_TIMEOUT: 'DeepSeek 返回中长时间没有新进展，本次新方式准备已停止。请放弃本次准备。',
    DEEPSEEK_TIMEOUT: 'DeepSeek 明确返回超时，本次新方式准备已停止。请放弃本次准备。',
    DEEPSEEK_TOTAL_TIMEOUT: 'DeepSeek 生成达到总时限，本次新方式准备已停止。请放弃本次准备。',
    DEEPSEEK_UNAVAILABLE: 'DeepSeek 服务明确返回不可用，本次新方式准备已停止。请放弃本次准备。',
    EMPTY_OUTPUT: '候选生成已结束，但没有可比较内容。请放弃本次准备。',
    EVIDENCE_INSUFFICIENT: '这条观察还没有来自三个独立作品的证据。',
    METHOD_ACTIVE: '当前有创作或新方式操作正在进行，请等待完成。',
    METHOD_EPOCH_CHANGED: '新方式的固定生成基线已变化。请放弃本次准备。',
    METHOD_EPOCH_UNVERIFIABLE: '新方式的生成来源无法唯一验证。请放弃本次准备。',
    OUTPUT_TRUNCATED: '候选生成达到输出上限，截断内容不会进入比较。请放弃本次准备。',
    RATE_LIMITED: 'DeepSeek 明确返回请求过于频繁，本次新方式准备已停止。请放弃本次准备。',
    RUNTIME_FAILED: '候选生成已明确失败。已封存进度仍保留，请放弃本次准备。',
  }
  return { code, message: messages[code] }
}

function candidatePublicCode(code: string): CandidateIpcErrorCode {
  if (code === 'CONTROLLER_BLOCK' || code === 'CONTROLLER_PROTOCOL') {
    return 'CANDIDATE_PREPARATION_BLOCKED'
  }
  const allowed = new Set<CandidateIpcErrorCode>([
    'ACCOUNT_BALANCE',
    'APPLICATION_CLOSED',
    'CANDIDATE_REQUEST_INVALID',
    'CREDENTIAL_REJECTED',
    'CREDENTIAL_REQUIRED',
    'DEEPSEEK_FIRST_EVENT_TIMEOUT',
    'DEEPSEEK_STREAM_IDLE_TIMEOUT',
    'DEEPSEEK_TIMEOUT',
    'DEEPSEEK_TOTAL_TIMEOUT',
    'DEEPSEEK_UNAVAILABLE',
    'EMPTY_OUTPUT',
    'EVIDENCE_INSUFFICIENT',
    'METHOD_ACTIVE',
    'METHOD_EPOCH_CHANGED',
    'METHOD_EPOCH_UNVERIFIABLE',
    'OUTPUT_TRUNCATED',
    'RATE_LIMITED',
    'RUNTIME_FAILED',
  ])
  return allowed.has(code as CandidateIpcErrorCode)
    ? code as CandidateIpcErrorCode
    : 'CANDIDATE_OPERATION_FAILED'
}

function handle(
  channel: string,
  boundary: () => TrustedIpcBoundary,
  action: (args: readonly unknown[]) => unknown,
): void {
  ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (!isTrustedIpcSender(event, boundary())) throw new Error('IPC 调用来源不受信任。')
    try {
      return await action(args)
    } catch (error) {
      if (error instanceof StudioServiceError || error instanceof TypeError) {
        throw new Error(error.message)
      }
      throw new Error('操作未完成，请重试；如果问题持续出现，请重启应用。')
    }
  })
}

function noArguments(args: readonly unknown[]): void {
  if (args.length !== 0) throw new TypeError('这个操作不接受额外参数。')
}

function oneArgument(args: readonly unknown[]): readonly [unknown] {
  if (args.length !== 1) throw new TypeError('这个操作只接受一个结构化输入。')
  return [args[0]]
}

export function broadcastStudioEvent(event: StudioEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.studioEvent, event)
  }
}

/** Kept as a source-compatible name for callers created before the business IPC. */
export const broadcastRuntimeEvent = broadcastStudioEvent
