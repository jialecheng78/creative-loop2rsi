import { randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

const SETTINGS_FILE_NAME = 'studio-settings.json'
const MAX_SETTINGS_BYTES = 16 * 1024
const MODEL_CHOICES = new Set(['deepseek-v4-pro', 'deepseek-v4-flash'])
const SETTING_KEYS = new Set(['selectedModel', 'activeSystemId', 'learningPaused'])
const SYSTEM_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export type SelectedModel = 'deepseek-v4-pro' | 'deepseek-v4-flash'

export interface DesktopSettings {
  readonly selectedModel: SelectedModel
  readonly activeSystemId: string | null
  readonly learningPaused: boolean
}

type DesktopSettingsPatch = { -readonly [Key in keyof DesktopSettings]?: DesktopSettings[Key] }

export const DEFAULT_DESKTOP_SETTINGS: Readonly<DesktopSettings> = Object.freeze({
  selectedModel: 'deepseek-v4-pro',
  activeSystemId: null,
  learningPaused: false,
})

export class SettingsStore {
  private readonly directory: string
  private readonly settingsPath: string
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(userDataPath: string) {
    if (typeof userDataPath !== 'string' || !isAbsolute(userDataPath) || userDataPath.includes('\0')) {
      throw new TypeError('userDataPath 必须是可信的绝对路径。')
    }
    this.directory = resolve(userDataPath)
    this.settingsPath = join(this.directory, SETTINGS_FILE_NAME)
  }

  async load(): Promise<DesktopSettings> {
    await this.mutationQueue
    return await this.loadFromDisk()
  }

  async update(patch: unknown): Promise<DesktopSettings> {
    const operation = this.mutationQueue.then(async () => {
      const validatedPatch = validatePatch(patch)
      const current = await this.loadFromDisk()
      const next = validateSettings({ ...current, ...validatedPatch })
      await mkdir(this.directory, { recursive: true })
      await atomicWriteJson(this.directory, this.settingsPath, next)
      return next
    })
    this.mutationQueue = operation.then(() => undefined, () => undefined)
    return await operation
  }

  private async loadFromDisk(): Promise<DesktopSettings> {
    try {
      const info = await lstat(this.settingsPath)
      if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_SETTINGS_BYTES) {
        return defaultSettings()
      }
      const text = await readFile(this.settingsPath, 'utf8')
      return validateSettings(JSON.parse(text) as unknown)
    } catch {
      // Missing, malformed, oversized, or otherwise unreadable settings are
      // never repaired implicitly: return safe defaults without clobbering.
      return defaultSettings()
    }
  }
}

function validatePatch(value: unknown): DesktopSettingsPatch {
  if (!isPlainRecord(value)) throw new TypeError('设置更新必须是普通对象。')
  for (const key of Object.keys(value)) {
    if (!SETTING_KEYS.has(key)) throw new TypeError(`不支持的设置字段：${key}`)
  }
  const patch: DesktopSettingsPatch = {}
  if ('selectedModel' in value) {
    if (!isModelChoice(value.selectedModel)) throw new TypeError('selectedModel 无效。')
    patch.selectedModel = value.selectedModel
  }
  if ('activeSystemId' in value) {
    if (!isSystemId(value.activeSystemId)) throw new TypeError('activeSystemId 必须是标识符，不能是路径。')
    patch.activeSystemId = value.activeSystemId
  }
  if ('learningPaused' in value) {
    if (typeof value.learningPaused !== 'boolean') throw new TypeError('learningPaused 必须是布尔值。')
    patch.learningPaused = value.learningPaused
  }
  return patch
}

function validateSettings(value: unknown): DesktopSettings {
  if (!isPlainRecord(value) || Object.keys(value).length !== SETTING_KEYS.size) {
    throw new TypeError('设置文件结构无效。')
  }
  for (const key of Object.keys(value)) {
    if (!SETTING_KEYS.has(key)) throw new TypeError('设置文件包含未知字段。')
  }
  if (!isModelChoice(value.selectedModel)
    || !isSystemId(value.activeSystemId)
    || typeof value.learningPaused !== 'boolean') {
    throw new TypeError('设置文件内容无效。')
  }
  return {
    selectedModel: value.selectedModel,
    activeSystemId: value.activeSystemId,
    learningPaused: value.learningPaused,
  }
}

function isModelChoice(value: unknown): value is SelectedModel {
  return typeof value === 'string' && MODEL_CHOICES.has(value)
}

function isSystemId(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && SYSTEM_ID_PATTERN.test(value))
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

function defaultSettings(): DesktopSettings {
  return { ...DEFAULT_DESKTOP_SETTINGS }
}

async function atomicWriteJson(directory: string, target: string, value: DesktopSettings): Promise<void> {
  const temporary = join(directory, `.settings-${randomBytes(16).toString('hex')}.tmp`)
  const data = `${JSON.stringify(value, null, 2)}\n`
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    // wx makes the temporary creation no-clobber; rename publishes one whole
    // JSON document, so readers never observe a partial settings file.
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(data, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await bestEffortPrivateMode(temporary)
    await rename(temporary, target)
    await bestEffortPrivateMode(target)
  } finally {
    await handle?.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function bestEffortPrivateMode(path: string): Promise<void> {
  await chmod(path, 0o600).catch(() => undefined)
}
