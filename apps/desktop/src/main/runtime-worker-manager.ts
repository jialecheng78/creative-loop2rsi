import { randomUUID } from 'node:crypto'

import type {
  DshRuntimeLaunchSpec,
  RuntimeErrorCode,
  RuntimeEvent,
  RuntimeRunHandle,
  RuntimeStatus,
} from '@creative-loop2rsi/runtime-dsh'
import type {
  RuntimeWorkerRequest,
  RuntimeWorkerResponse,
} from '@creative-loop2rsi/runtime-dsh/worker-protocol'
import { isRuntimeWorkerResponse } from '@creative-loop2rsi/runtime-dsh/worker-protocol'
import type { UtilityProcess } from 'electron'
import { utilityProcess } from 'electron'

import { buildUtilityProcessEnvironment } from './utility-environment.js'

interface Deferred {
  resolve(value: unknown): void
  reject(error: Error): void
  readonly timer: NodeJS.Timeout
}

export interface RuntimeWorkerManagerOptions {
  readonly workerPath: string
  readonly processFactory?: typeof utilityProcess.fork
  readonly onEvent?: (event: RuntimeEvent) => void
}

export class RuntimeWorkerManager {
  private process: UtilityProcess | undefined
  private spawnTask: Promise<UtilityProcess> | undefined
  private readonly expectedExits = new WeakSet<UtilityProcess>()
  private readonly pending = new Map<string, Deferred>()
  private configuredSpec: DshRuntimeLaunchSpec | undefined
  private lastStatus: RuntimeStatus = { state: 'unconfigured' }
  private readonly runErrorCodes = new Map<string, RuntimeErrorCode>()

  constructor(private readonly options: RuntimeWorkerManagerOptions) {}

  configure(spec: DshRuntimeLaunchSpec): void {
    this.configuredSpec = spec
    this.lastStatus = { state: 'ready', role: spec.role, model: spec.model }
  }

  status(): RuntimeStatus {
    return { ...this.lastStatus }
  }

  async startRun(input: string): Promise<RuntimeRunHandle> {
    const spec = this.configuredSpec
    if (spec === undefined) throw new Error('运行环境尚未安全连接，请先完成 DeepSeek 连接。')
    const child = await this.ensureProcess()
    await this.request(child, { id: randomUUID(), method: 'configure', spec })
    const result = await this.request(child, { id: randomUUID(), method: 'startRun', input })
    if (!isRunHandle(result)) throw new Error('DSH Worker 返回了无效的运行标识。')
    this.lastStatus = {
      state: 'running',
      role: spec.role,
      model: spec.model,
      activeRunId: result.runId,
    }
    return result
  }

  async cancelRun(runId: string): Promise<void> {
    const child = this.process
    if (child === undefined) throw new Error('没有可取消的运行。')
    await this.request(child, { id: randomUUID(), method: 'cancelRun', runId })
  }

  async stop(): Promise<void> {
    const child = this.process
    if (child === undefined) return
    try {
      await this.request(child, { id: randomUUID(), method: 'dispose' })
    } finally {
      this.expectedExits.add(child)
      child.kill()
      this.process = undefined
      this.spawnTask = undefined
      this.rejectPending(new Error('DSH Worker 已关闭。'))
      this.lastStatus = this.configuredSpec === undefined
        ? { state: 'unconfigured' }
        : {
            state: 'ready',
            role: this.configuredSpec.role,
            model: this.configuredSpec.model,
          }
    }
  }

  /** Drop every in-memory capability after the worker has stopped. */
  async clearConfiguration(): Promise<void> {
    await this.stop()
    this.configuredSpec = undefined
    this.lastStatus = { state: 'unconfigured' }
  }

  private ensureProcess(): Promise<UtilityProcess> {
    if (this.process !== undefined) return Promise.resolve(this.process)
    this.spawnTask ??= new Promise((resolve, reject) => {
      const fork = this.options.processFactory ?? utilityProcess.fork
      const child = fork(this.options.workerPath, [], {
        env: buildUtilityProcessEnvironment(process.env),
        serviceName: 'Creative RSI DSH Adapter',
        stdio: 'pipe',
      })
      child.stdout?.resume()
      child.stderr?.resume()
      child.once('spawn', () => {
        this.process = child
        this.attach(child)
        resolve(child)
      })
      child.once('error', type => {
        reject(new Error(`DSH utility process fatal error: ${type}`))
      })
      child.once('exit', code => {
        if (this.process === undefined) reject(new Error(`DSH utility process exited before spawn: ${code}`))
      })
    })
    return this.spawnTask
  }

  private attach(child: UtilityProcess): void {
    child.on('message', value => {
      if (isRuntimeEventEnvelope(value)) {
        this.options.onEvent?.(value.event)
        if (value.event.type === 'error') this.runErrorCodes.set(value.event.runId, value.event.code)
        if (value.event.type === 'state') this.updateStatusFromEvent(value.event)
        return
      }
      if (!isRuntimeWorkerResponse(value)) return
      const deferred = this.pending.get(value.id)
      if (deferred === undefined) return
      this.pending.delete(value.id)
      clearTimeout(deferred.timer)
      if (value.ok) deferred.resolve(value.result)
      else deferred.reject(new Error(value.error.message))
    })
    child.once('exit', () => {
      if (this.expectedExits.delete(child)) return
      const interruptedRunId = this.lastStatus.state === 'running'
        ? this.lastStatus.activeRunId
        : undefined
      this.process = undefined
      this.spawnTask = undefined
      this.rejectPending(new Error('DSH Worker 意外停止，本次运行未记为成功。'))
      this.lastStatus = {
        state: 'failed',
        ...(this.configuredSpec === undefined
          ? {}
          : { role: this.configuredSpec.role, model: this.configuredSpec.model }),
        lastErrorCode: 'TRANSPORT_CLOSED',
      }
      if (interruptedRunId !== undefined) {
        this.options.onEvent?.({
          type: 'error',
          runId: interruptedRunId,
          code: 'TRANSPORT_CLOSED',
          message: 'DSH Worker 意外停止，本次运行未记为成功。',
        })
        this.options.onEvent?.({ type: 'state', runId: interruptedRunId, state: 'failed' })
      }
    })
  }

  private request(child: UtilityProcess, request: RuntimeWorkerRequest): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id)
        reject(new Error('DSH Worker 控制请求超时，未记为成功。'))
      }, 30_000)
      this.pending.set(request.id, { resolve, reject, timer })
      try {
        child.postMessage(request)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(request.id)
        reject(error instanceof Error ? error : new Error('无法向 DSH Worker 发送请求。'))
      }
    })
  }

  private rejectPending(error: Error): void {
    for (const deferred of this.pending.values()) {
      clearTimeout(deferred.timer)
      deferred.reject(error)
    }
    this.pending.clear()
  }

  private updateStatusFromEvent(event: Extract<RuntimeEvent, { type: 'state' }>): void {
    const spec = this.configuredSpec
    if (spec === undefined) return
    if (event.state === 'running') {
      this.lastStatus = { state: 'running', role: spec.role, model: spec.model, activeRunId: event.runId }
    } else if (event.state === 'failed') {
      this.lastStatus = {
        state: 'failed',
        role: spec.role,
        model: spec.model,
        lastErrorCode: this.runErrorCodes.get(event.runId) ?? 'RUNTIME_FAILED',
      }
      this.runErrorCodes.delete(event.runId)
    } else {
      this.runErrorCodes.delete(event.runId)
      this.lastStatus = { state: 'ready', role: spec.role, model: spec.model }
    }
  }
}

function isRuntimeEventEnvelope(value: unknown): value is { type: 'runtime-event'; event: RuntimeEvent } {
  return typeof value === 'object'
    && value !== null
    && 'type' in value
    && value.type === 'runtime-event'
    && 'event' in value
    && typeof value.event === 'object'
    && value.event !== null
}

function isRunHandle(value: unknown): value is RuntimeRunHandle {
  return typeof value === 'object'
    && value !== null
    && 'runId' in value
    && typeof value.runId === 'string'
    && 'sessionId' in value
    && typeof value.sessionId === 'string'
}
