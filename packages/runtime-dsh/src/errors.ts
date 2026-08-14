import type { RuntimeErrorCode } from './types.js'

export class DshRuntimeError extends Error {
  constructor(
    readonly code: RuntimeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'DshRuntimeError'
  }
}

export function publicRuntimeError(error: unknown): DshRuntimeError {
  if (error instanceof DshRuntimeError) return error
  if (error instanceof Error && error.name === 'TransportClosedError') {
    return new DshRuntimeError('TRANSPORT_CLOSED', 'DSH 运行进程已停止，请重新开始本次创作。')
  }
  return new DshRuntimeError('RUNTIME_FAILED', 'DSH 运行失败，未保存为成功结果。')
}
