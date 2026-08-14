import {
  DshRuntimeAdapter,
  DshRuntimeError,
  type DshRuntimeLaunchSpec,
  type RuntimeEvent,
} from '@creative-loop2rsi/runtime-dsh'
import type {
  RuntimeWorkerRequest,
  RuntimeWorkerResponse,
} from '@creative-loop2rsi/runtime-dsh/worker-protocol'

export interface WorkerRuntime {
  status(): ReturnType<DshRuntimeAdapter['status']>
  startRun(request: { input: string; sessionId?: string }): ReturnType<DshRuntimeAdapter['startRun']>
  streamEvents(runId: string): ReturnType<DshRuntimeAdapter['streamEvents']>
  cancelRun(runId: string): Promise<void>
  dispose(): Promise<void>
}

export type WorkerRuntimeFactory = (spec: DshRuntimeLaunchSpec) => WorkerRuntime

export class RuntimeWorkerService {
  private runtime: WorkerRuntime | undefined

  constructor(
    private readonly factory: WorkerRuntimeFactory = spec => new DshRuntimeAdapter(spec),
  ) {}

  async handle(
    request: RuntimeWorkerRequest,
    emit: (event: RuntimeEvent) => void,
  ): Promise<RuntimeWorkerResponse> {
    try {
      switch (request.method) {
        case 'configure':
          if (this.runtime !== undefined) await this.runtime.dispose()
          this.runtime = this.factory(request.spec)
          return { id: request.id, ok: true, result: this.runtime.status() }
        case 'status':
          return {
            id: request.id,
            ok: true,
            result: this.runtime?.status() ?? { state: 'unconfigured' },
          }
        case 'startRun': {
          const runtime = this.requireRuntime()
          const handle = await runtime.startRun({
            input: request.input,
            ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
          })
          void this.forward(runtime.streamEvents(handle.runId), emit)
          return { id: request.id, ok: true, result: handle }
        }
        case 'cancelRun':
          await this.requireRuntime().cancelRun(request.runId)
          return { id: request.id, ok: true, result: null }
        case 'dispose':
          await this.runtime?.dispose()
          this.runtime = undefined
          return { id: request.id, ok: true, result: null }
      }
    } catch (error) {
      const safe = error instanceof DshRuntimeError
        ? error
        : new DshRuntimeError('RUNTIME_FAILED', 'DSH Worker 请求失败。')
      return {
        id: request.id,
        ok: false,
        error: { code: safe.code, message: safe.message },
      }
    }
  }

  private requireRuntime(): WorkerRuntime {
    if (this.runtime === undefined) {
      throw new DshRuntimeError('NOT_CONFIGURED', 'DSH Worker 尚未配置。')
    }
    return this.runtime
  }

  private async forward(events: AsyncIterable<RuntimeEvent>, emit: (event: RuntimeEvent) => void): Promise<void> {
    try {
      for await (const event of events) emit(event)
    } catch {
      // Adapter emits a sanitized terminal failure before closing its stream.
    }
  }
}
