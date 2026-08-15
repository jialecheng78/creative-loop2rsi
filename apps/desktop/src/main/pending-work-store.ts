import { createHash, randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

const SUPERVISOR_DIRECTORY = 'supervisor'
const PENDING_WORK_FILE = 'pending-work.json'
const MAX_PENDING_WORK_BYTES = 1024 * 1024
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u

type JsonRecord = Readonly<Record<string, unknown>>

export interface PendingBeginPayload {
  readonly run_id: string
  readonly work_id: string
  readonly task: string
  readonly loop: string
  readonly dispatch_id: string
  readonly context_id: string
  readonly context_sha256: string
  readonly recovery_of?: string
}

export interface PendingBeginExpectation {
  readonly method_version: string
  readonly method_guidance_sha256: string | null
}

export interface PendingTerminationExpectation {
  readonly outcome: 'FAILED' | 'CANCELLED'
  readonly reason: string
  readonly error_code: string | null
  readonly runtime_provenance: JsonRecord | null
}

export interface PendingWorkIntent {
  readonly schema_version: 1
  readonly created_at: string
  readonly content_hash: string
  readonly phase: 'LAUNCHING' | 'TERMINATION_REQUIRED'
  readonly system_id: string
  readonly run_id: string
  readonly work_id: string
  readonly dispatch_id: string
  readonly context_id: string
  readonly begin_payload: PendingBeginPayload
  readonly begin_expectation: PendingBeginExpectation
  readonly termination_expectation: PendingTerminationExpectation | null
}

export interface CreatePendingWorkInput {
  readonly createdAt: string
  readonly systemId: string
  readonly beginPayload: PendingBeginPayload
  readonly beginExpectation: PendingBeginExpectation
}

export class PendingWorkStoreError extends Error {
  constructor(readonly code: 'PENDING_WORK_CONFLICT' | 'PENDING_WORK_INVALID', message: string) {
    super(message)
    this.name = 'PendingWorkStoreError'
  }
}

/**
 * Main-owned replay queue for one foreground governed work.
 *
 * This is deliberately not a governance record. The Controller remains the
 * source of truth; this file only survives a Main/Controller response-loss
 * window long enough to replay the exact begin/termination operation.
 */
export class PendingWorkStore {
  readonly path: string
  private readonly directory: string
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(userDataPath: string) {
    if (typeof userDataPath !== 'string' || !isAbsolute(userDataPath) || userDataPath.includes('\0')) {
      throw new TypeError('userDataPath 必须是可信的绝对路径。')
    }
    this.directory = resolve(userDataPath, SUPERVISOR_DIRECTORY)
    this.path = join(this.directory, PENDING_WORK_FILE)
  }

  async load(): Promise<PendingWorkIntent | null> {
    await this.mutationQueue
    return await this.loadFromDisk()
  }

  async createLaunching(input: CreatePendingWorkInput): Promise<PendingWorkIntent> {
    return await this.mutate(async () => {
      const existing = await this.loadFromDisk()
      if (existing !== null) {
        throw new PendingWorkStoreError('PENDING_WORK_CONFLICT', '已有创作恢复意图尚未处理。')
      }
      const intent = sealIntent({
        schema_version: 1,
        created_at: validTimestamp(input.createdAt),
        phase: 'LAUNCHING',
        system_id: validId(input.systemId, 'system_id'),
        run_id: validId(input.beginPayload.run_id, 'run_id'),
        work_id: validId(input.beginPayload.work_id, 'work_id'),
        dispatch_id: validId(input.beginPayload.dispatch_id, 'dispatch_id'),
        context_id: validId(input.beginPayload.context_id, 'context_id'),
        begin_payload: validateBeginPayload(input.beginPayload),
        begin_expectation: validateBeginExpectation(input.beginExpectation),
        termination_expectation: null,
      })
      await this.write(intent)
      return intent
    })
  }

  async requireTermination(
    launching: PendingWorkIntent,
    expectation: PendingTerminationExpectation,
  ): Promise<PendingWorkIntent> {
    return await this.mutate(async () => {
      const validatedLaunching = validateIntent(launching)
      const existing = await this.loadFromDisk()
      if (existing !== null && !sameWork(existing, validatedLaunching)) {
        throw new PendingWorkStoreError('PENDING_WORK_CONFLICT', '恢复意图与当前创作不一致。')
      }
      if (existing?.phase === 'TERMINATION_REQUIRED') return existing
      const source = existing ?? validatedLaunching
      const intent = sealIntent({
        schema_version: 1,
        created_at: source.created_at,
        phase: 'TERMINATION_REQUIRED',
        system_id: source.system_id,
        run_id: source.run_id,
        work_id: source.work_id,
        dispatch_id: source.dispatch_id,
        context_id: source.context_id,
        begin_payload: source.begin_payload,
        begin_expectation: source.begin_expectation,
        termination_expectation: validateTerminationExpectation(expectation),
      })
      await this.write(intent)
      return intent
    })
  }

  async clear(expected: Pick<PendingWorkIntent, 'system_id' | 'run_id' | 'dispatch_id'>): Promise<void> {
    await this.mutate(async () => {
      const existing = await this.loadFromDisk()
      if (existing === null) return
      if (existing.system_id !== expected.system_id
        || existing.run_id !== expected.run_id
        || existing.dispatch_id !== expected.dispatch_id) {
        throw new PendingWorkStoreError('PENDING_WORK_CONFLICT', '拒绝清除另一条创作恢复意图。')
      }
      const info = await lstat(this.path)
      if (!info.isFile() || info.isSymbolicLink()) throw invalidStore()
      await rm(this.path)
    })
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.mutationQueue.then(operation)
    this.mutationQueue = pending.then(() => undefined, () => undefined)
    return await pending
  }

  private async loadFromDisk(): Promise<PendingWorkIntent | null> {
    try {
      const directoryInfo = await lstat(this.directory)
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw invalidStore()
    } catch (error) {
      if (isMissing(error)) return null
      if (error instanceof PendingWorkStoreError) throw error
      throw invalidStore()
    }
    let info
    try {
      info = await lstat(this.path)
    } catch (error) {
      if (isMissing(error)) return null
      throw invalidStore()
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_PENDING_WORK_BYTES) {
      throw invalidStore()
    }
    try {
      return validateIntent(JSON.parse(await readFile(this.path, 'utf8')) as unknown)
    } catch (error) {
      if (error instanceof PendingWorkStoreError) throw error
      throw invalidStore()
    }
  }

  private async write(intent: PendingWorkIntent): Promise<void> {
    await ensurePrivateDirectory(this.directory)
    try {
      const existing = await lstat(this.path)
      if (!existing.isFile() || existing.isSymbolicLink()) throw invalidStore()
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    const temporary = join(this.directory, `.pending-work-${randomBytes(16).toString('hex')}.tmp`)
    const data = `${JSON.stringify(intent, null, 2)}\n`
    if (Buffer.byteLength(data, 'utf8') > MAX_PENDING_WORK_BYTES) throw invalidStore()
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(temporary, 'wx', 0o600)
      await handle.writeFile(data, 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      await enforcePrivateMode(temporary, 0o600)
      await rename(temporary, this.path)
      await enforcePrivateMode(this.path, 0o600)
    } finally {
      await handle?.close().catch(() => undefined)
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }
}

function sealIntent(value: Omit<PendingWorkIntent, 'content_hash'>): PendingWorkIntent {
  const content_hash = createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
  return { ...value, content_hash }
}

function validateIntent(value: unknown): PendingWorkIntent {
  if (!isPlainRecord(value)) throw invalidStore()
  exactKeys(value, [
    'schema_version', 'created_at', 'content_hash', 'phase', 'system_id', 'run_id', 'work_id',
    'dispatch_id', 'context_id', 'begin_payload', 'begin_expectation', 'termination_expectation',
  ])
  if (value.schema_version !== 1
    || (value.phase !== 'LAUNCHING' && value.phase !== 'TERMINATION_REQUIRED')) throw invalidStore()
  const phase: PendingWorkIntent['phase'] = value.phase
  const termination = value.termination_expectation === null
    ? null
    : validateTerminationExpectation(value.termination_expectation)
  if ((phase === 'LAUNCHING') !== (termination === null)) throw invalidStore()
  const unsigned = {
    schema_version: 1 as const,
    created_at: validTimestamp(value.created_at),
    phase,
    system_id: validId(value.system_id, 'system_id'),
    run_id: validId(value.run_id, 'run_id'),
    work_id: validId(value.work_id, 'work_id'),
    dispatch_id: validId(value.dispatch_id, 'dispatch_id'),
    context_id: validId(value.context_id, 'context_id'),
    begin_payload: validateBeginPayload(value.begin_payload),
    begin_expectation: validateBeginExpectation(value.begin_expectation),
    termination_expectation: termination,
  }
  if (unsigned.begin_payload.run_id !== unsigned.run_id
    || unsigned.begin_payload.work_id !== unsigned.work_id
    || unsigned.begin_payload.dispatch_id !== unsigned.dispatch_id
    || unsigned.begin_payload.context_id !== unsigned.context_id) throw invalidStore()
  const sealed = sealIntent(unsigned)
  if (value.content_hash !== sealed.content_hash || !SHA256_PATTERN.test(value.content_hash)) throw invalidStore()
  return sealed
}

function validateBeginPayload(value: unknown): PendingBeginPayload {
  if (!isPlainRecord(value)) throw invalidStore()
  const required = ['run_id', 'work_id', 'task', 'loop', 'dispatch_id', 'context_id', 'context_sha256']
  exactKeys(value, value.recovery_of === undefined ? required : [...required, 'recovery_of'])
  if (typeof value.task !== 'string'
    || value.task.length === 0
    || Buffer.byteLength(value.task, 'utf8') > 100_000) throw invalidStore()
  const base = {
    run_id: validId(value.run_id, 'run_id'),
    work_id: validId(value.work_id, 'work_id'),
    task: value.task,
    loop: validId(value.loop, 'loop'),
    dispatch_id: validId(value.dispatch_id, 'dispatch_id'),
    context_id: validId(value.context_id, 'context_id'),
    context_sha256: validSha256(value.context_sha256),
  }
  return value.recovery_of === undefined
    ? base
    : { ...base, recovery_of: validId(value.recovery_of, 'recovery_of') }
}

function validateBeginExpectation(value: unknown): PendingBeginExpectation {
  if (!isPlainRecord(value)) throw invalidStore()
  exactKeys(value, ['method_version', 'method_guidance_sha256'])
  if (typeof value.method_version !== 'string' || !ID_PATTERN.test(value.method_version)) throw invalidStore()
  return {
    method_version: value.method_version,
    method_guidance_sha256: value.method_guidance_sha256 === null
      ? null
      : validSha256(value.method_guidance_sha256),
  }
}

function validateTerminationExpectation(value: unknown): PendingTerminationExpectation {
  if (!isPlainRecord(value)) throw invalidStore()
  exactKeys(value, ['outcome', 'reason', 'error_code', 'runtime_provenance'])
  if (value.outcome !== 'FAILED' && value.outcome !== 'CANCELLED') throw invalidStore()
  if (typeof value.reason !== 'string' || value.reason.length === 0 || value.reason.length > 500) throw invalidStore()
  const errorCode = value.error_code
  if ((value.outcome === 'FAILED' && (typeof errorCode !== 'string' || errorCode.length === 0 || errorCode.length > 160))
    || (value.outcome === 'CANCELLED' && errorCode !== null)) throw invalidStore()
  const provenance = value.runtime_provenance === null
    ? null
    : validateSafeJsonRecord(value.runtime_provenance)
  return {
    outcome: value.outcome,
    reason: value.reason,
    error_code: errorCode as string | null,
    runtime_provenance: provenance,
  }
}

function validateSafeJsonRecord(value: unknown): JsonRecord {
  if (!isPlainRecord(value)) throw invalidStore()
  validateSafeJson(value, 0)
  return value
}

function validateSafeJson(value: unknown, depth: number): void {
  if (depth > 20) throw invalidStore()
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (Array.isArray(value)) {
    for (const item of value) validateSafeJson(item, depth + 1)
    return
  }
  if (!isPlainRecord(value)) throw invalidStore()
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/-/gu, '_')
    if (new Set([
      'authorization', 'api_key', 'apikey', 'secret', 'token', 'access_token',
      'bearer_token', 'capability_token', 'reasoning', 'reasoning_content',
      'gateway_url', 'base_url', 'project', 'project_path', 'environment', 'env',
    ]).has(normalized)) throw invalidStore()
    validateSafeJson(item, depth + 1)
  }
}

function sameWork(left: PendingWorkIntent, right: PendingWorkIntent): boolean {
  return left.system_id === right.system_id
    && left.run_id === right.run_id
    && left.work_id === right.work_id
    && left.dispatch_id === right.dispatch_id
    && left.context_id === right.context_id
    && JSON.stringify(left.begin_payload) === JSON.stringify(right.begin_payload)
    && JSON.stringify(left.begin_expectation) === JSON.stringify(right.begin_expectation)
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  try {
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw invalidStore()
  } catch (error) {
    if (!isMissing(error)) throw error
    await mkdir(directory, { recursive: false, mode: 0o700 })
    const created = await lstat(directory)
    if (!created.isDirectory() || created.isSymbolicLink()) throw invalidStore()
  }
  await enforcePrivateMode(directory, 0o700)
}

async function enforcePrivateMode(path: string, expected: 0o600 | 0o700): Promise<void> {
  if (process.platform === 'win32') return
  try {
    await chmod(path, expected)
    const info = await lstat(path)
    if ((info.mode & 0o777) !== expected) throw invalidStore()
  } catch (error) {
    if (error instanceof PendingWorkStoreError) throw error
    throw invalidStore()
  }
}

function validTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw invalidStore()
  return value
}

function validId(value: unknown, _label: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw invalidStore()
  return value
}

function validSha256(value: unknown): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) throw invalidStore()
  return value
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw invalidStore()
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { readonly code?: unknown }).code === 'ENOENT'
}

function invalidStore(): PendingWorkStoreError {
  return new PendingWorkStoreError('PENDING_WORK_INVALID', '创作恢复记录无效；为避免覆盖证据，系统已停止继续写入。')
}
