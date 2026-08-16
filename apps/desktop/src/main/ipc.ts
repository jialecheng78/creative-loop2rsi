import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'

import { IPC_CHANNELS, type StudioEvent } from '../shared/ipc.js'
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
  handle(IPC_CHANNELS.candidatesPrepare, boundary, args => {
    const [input] = oneArgument(args)
    return service.prepareMethodCandidate(validatePrepareCandidateInput(input).observationId)
  })
  handle(IPC_CHANNELS.candidatesCompare, boundary, args => {
    const [input] = oneArgument(args)
    return service.submitMethodComparison(validateCompareCandidateInput(input))
  })
  handle(IPC_CHANNELS.candidatesAdopt, boundary, args => {
    const [input] = oneArgument(args)
    return service.adoptMethodCandidate(validateCandidateDecisionInput(input).candidateId)
  })
  handle(IPC_CHANNELS.candidatesReject, boundary, args => {
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
