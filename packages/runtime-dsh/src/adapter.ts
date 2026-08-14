import { randomUUID } from 'node:crypto'

import { AsyncQueue } from './async-queue.js'
import { assertDshCompatibility } from './compatibility.js'
import { buildRuntimeEnvironment } from './environment.js'
import { DshRuntimeError, publicRuntimeError } from './errors.js'
import type {
  DshRuntimeLaunchSpec,
  RuntimeEvent,
  RuntimeRunHandle,
  RuntimeRunRequest,
  RuntimeStatus,
} from './types.js'
import { validateLaunchSpec } from './validation.js'

interface HarnessNotificationLike {
  readonly method: string
  readonly params: Record<string, unknown>
}

interface HarnessRunResultLike {
  readonly sessionId: string
  readonly finalResponse: string
  /** Public SDK session events, retained in wire order. */
  readonly events: readonly unknown[]
}

interface HarnessLike {
  start(): Promise<void>
  run(
    input: string,
    options: {
      readonly sessionId: string
      readonly onNotification: (notification: HarnessNotificationLike) => void
    },
  ): Promise<HarnessRunResultLike>
  close(): Promise<void>
}

export type HarnessFactory = (spec: DshRuntimeLaunchSpec) => Promise<HarnessLike>

async function publishedHarnessFactory(spec: DshRuntimeLaunchSpec): Promise<HarnessLike> {
  const { DeepSeekHarness } = await import('@deepseek-ai/dsh-sdk-client')
  return new DeepSeekHarness({
    launch: {
      command: spec.command,
      args: [...spec.args],
      cwd: spec.cwd,
      env: buildRuntimeEnvironment(spec),
      requestTimeoutMs: 180_000,
      shutdownTimeoutMs: 1_000,
      disposeEofGraceMs: 6_000,
      disposeGraceMs: 3_000,
    },
    cwd: spec.workspaceDir,
    provider: 'deepseek-official',
    model: spec.model,
    ...(spec.maxTokens === undefined ? {} : { maxTokens: spec.maxTokens }),
  })
}

interface ActiveRun {
  readonly handle: RuntimeRunHandle
  readonly events: AsyncQueue<RuntimeEvent>
  cancelled: boolean
  task: Promise<void>
}

/**
 * Runtime-neutral facade over the public DSH SDK client. Raw DSH notification
 * objects never leave this package.
 */
export class DshRuntimeAdapter {
  private harness: HarnessLike | undefined
  private active: ActiveRun | undefined
  private readonly streams = new Map<string, AsyncQueue<RuntimeEvent>>()
  private statusValue: RuntimeStatus = { state: 'unconfigured' }
  private disposed = false

  constructor(
    private readonly spec: DshRuntimeLaunchSpec,
    private readonly harnessFactory: HarnessFactory = publishedHarnessFactory,
    private readonly compatibilityCheck: () => unknown = assertDshCompatibility,
  ) {
    validateLaunchSpec(spec)
    this.statusValue = { state: 'ready', role: spec.role, model: spec.model }
  }

  status(): RuntimeStatus {
    return { ...this.statusValue }
  }

  async startRun(request: RuntimeRunRequest): Promise<RuntimeRunHandle> {
    this.assertUsable()
    if (this.active !== undefined) {
      throw new DshRuntimeError('BUSY', '当前 DSH Worker 已有正在运行的任务。')
    }
    if (request.input.trim() === '') {
      throw new DshRuntimeError('INVALID_LAUNCH', '创作输入不能为空。')
    }
    this.compatibilityCheck()
    this.statusValue = { state: 'starting', role: this.spec.role, model: this.spec.model }
    let harness: HarnessLike
    try {
      harness = await this.ensureHarness()
      await harness.start()
    } catch (error) {
      const safe = publicRuntimeError(error)
      this.statusValue = {
        state: 'failed',
        role: this.spec.role,
        model: this.spec.model,
        lastErrorCode: safe.code,
      }
      throw safe
    }

    const runId = `run-${randomUUID()}`
    const sessionId = request.sessionId ?? `session-${randomUUID().replaceAll('-', '')}`
    const handle = { runId, sessionId }
    const events = new AsyncQueue<RuntimeEvent>()
    const active: ActiveRun = {
      handle,
      events,
      cancelled: false,
      task: Promise.resolve(),
    }
    this.active = active
    this.streams.set(runId, events)
    this.statusValue = {
      state: 'running',
      role: this.spec.role,
      model: this.spec.model,
      activeRunId: runId,
    }
    events.push({ type: 'state', runId, state: 'running' })
    events.push({ type: 'progress', runId, phase: 'queued' })
    active.task = this.completeRun(active, harness, request.input)
    return handle
  }

  resumeRun(sessionId: string, input: string): Promise<RuntimeRunHandle> {
    if (sessionId.trim() === '') {
      return Promise.reject(new DshRuntimeError('INVALID_LAUNCH', 'sessionId 不能为空。'))
    }
    return this.startRun({ sessionId, input })
  }

  streamEvents(runId: string): AsyncIterable<RuntimeEvent> {
    const events = this.streams.get(runId)
    if (events === undefined) {
      throw new DshRuntimeError('RUN_NOT_FOUND', '找不到当前 DSH 运行。')
    }
    return this.consumeEvents(runId, events)
  }

  async cancelRun(runId: string): Promise<void> {
    const active = this.active
    if (active === undefined || active.handle.runId !== runId) {
      throw new DshRuntimeError('RUN_NOT_FOUND', '找不到可取消的 DSH 运行。')
    }
    active.cancelled = true
    this.statusValue = {
      state: 'stopping',
      role: this.spec.role,
      model: this.spec.model,
      activeRunId: runId,
    }
    const harness = this.harness
    this.harness = undefined
    if (harness !== undefined) await harness.close()
    await active.task
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const active = this.active
    if (active !== undefined) active.cancelled = true
    const harness = this.harness
    this.harness = undefined
    if (harness !== undefined) await harness.close()
    if (active !== undefined) await active.task
    this.statusValue = { state: 'disposed' }
  }

  private async ensureHarness(): Promise<HarnessLike> {
    this.harness ??= await this.harnessFactory(this.spec)
    return this.harness
  }

  private async completeRun(active: ActiveRun, harness: HarnessLike, input: string): Promise<void> {
    const { runId, sessionId } = active.handle
    try {
      const result = await harness.run(input, {
        sessionId,
        onNotification: notification => {
          const phase = phaseFromNotification(notification)
          if (phase !== undefined) active.events.push({ type: 'progress', runId, phase })
        },
      })
      if (active.cancelled) {
        active.events.push({ type: 'state', runId, state: 'cancelled' })
      } else {
        const resolvedError = resolvedHarnessRunError(result.events)
        if (resolvedError !== undefined) throw resolvedError
        active.events.push({ type: 'output', runId, text: result.finalResponse })
        active.events.push({ type: 'state', runId, state: 'completed' })
      }
    } catch (error) {
      if (active.cancelled) {
        active.events.push({ type: 'state', runId, state: 'cancelled' })
      } else {
        const safe = publicRuntimeError(error)
        active.events.push({ type: 'error', runId, code: safe.code, message: safe.message })
        active.events.push({ type: 'state', runId, state: 'failed' })
        this.statusValue = {
          state: 'failed',
          role: this.spec.role,
          model: this.spec.model,
          lastErrorCode: safe.code,
        }
      }
    } finally {
      active.events.close()
      if (this.active === active) this.active = undefined
      if (!this.disposed && this.statusValue.state !== 'failed') {
        this.statusValue = { state: 'ready', role: this.spec.role, model: this.spec.model }
      }
    }
  }

  private assertUsable(): void {
    if (this.disposed) throw new DshRuntimeError('DISPOSED', 'DSH Adapter 已关闭。')
  }

  private async * consumeEvents(runId: string, events: AsyncQueue<RuntimeEvent>): AsyncGenerator<RuntimeEvent> {
    try {
      yield* events
    } finally {
      this.streams.delete(runId)
    }
  }
}

/**
 * rc.6 reports model failures as a resolved run whose last turn/end carries a
 * structured error. Route only on its code/status; provider text is never
 * copied into a RuntimeEvent.
 */
function resolvedHarnessRunError(events: readonly unknown[]): DshRuntimeError | undefined {
  let lastTurnEnd: Record<string, unknown> | undefined
  for (const event of events) {
    if (!isRecord(event) || event.type !== 'turn/end' || !isRecord(event.data)) continue
    lastTurnEnd = event.data
  }
  if (lastTurnEnd === undefined || !isRecord(lastTurnEnd.reason)) {
    return new DshRuntimeError('RUNTIME_FAILED', 'DSH 未返回可验证的完成状态，本次未保存。')
  }
  const reason = lastTurnEnd.reason
  if (reason.kind === 'completed') return undefined
  if (reason.kind === 'max-tokens') {
    return new DshRuntimeError('OUTPUT_TRUNCATED', '内容达到本次生成上限，未保存为完整版本；请缩小本次任务后重试。')
  }
  if (reason.kind !== 'error') {
    return new DshRuntimeError('RUNTIME_FAILED', '本次创作未完整结束，不会保存为完成版本。')
  }
  if (!isRecord(reason.error)) {
    return new DshRuntimeError('RUNTIME_FAILED', 'DeepSeek 未能完成本次创作，请重试。')
  }
  return publicResolvedModelError(reason.error)
}

function publicResolvedModelError(failure: Record<string, unknown>): DshRuntimeError {
  const code = typeof failure.code === 'string' ? failure.code.toUpperCase() : ''
  const status = typeof failure.status === 'number' && Number.isSafeInteger(failure.status)
    ? failure.status
    : undefined
  if (status === 401 || status === 403
    || code === 'AUTH' || code === 'INVALID_CREDENTIAL' || code === 'MISSING_CREDENTIAL') {
    return new DshRuntimeError('CREDENTIAL_REJECTED', 'DeepSeek 未接受当前 API Key，请在设置中重新配置。')
  }
  if (status === 402 || code === 'QUOTA') {
    return new DshRuntimeError('ACCOUNT_BALANCE', 'DeepSeek 账户余额不足，请充值后重试。')
  }
  if (status === 429 || code === 'RATE_LIMIT') {
    return new DshRuntimeError('RATE_LIMITED', 'DeepSeek 当前请求较多，请稍后重试。')
  }
  if (status !== undefined && status >= 500 && status <= 599) {
    return new DshRuntimeError('DEEPSEEK_UNAVAILABLE', 'DeepSeek 服务暂时不可用，请稍后重试。')
  }
  if (code === 'TIMEOUT' || code === 'ETIMEDOUT') {
    return new DshRuntimeError('DEEPSEEK_TIMEOUT', 'DeepSeek 响应超时，请重试。')
  }
  return new DshRuntimeError('RUNTIME_FAILED', 'DeepSeek 未能完成本次创作，请重试。')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function phaseFromNotification(notification: HarnessNotificationLike): 'working' | 'idle' | undefined {
  if (notification.method !== 'session.status') return undefined
  const status = notification.params.status
  if (status === 'idle') return 'idle'
  if (status === 'running' || status === 'busy') return 'working'
  return undefined
}
