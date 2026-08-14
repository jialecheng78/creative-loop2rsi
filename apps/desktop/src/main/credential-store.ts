import { randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

const CREDENTIAL_FILE_NAME = 'deepseek-api-key.enc'
const MAX_API_KEY_BYTES = 4 * 1024
const MAX_CIPHERTEXT_BYTES = 1024 * 1024

/** The subset of Electron safeStorage used by this module. */
export interface SafeStoragePort {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encryptedValue: Buffer): string
}

export interface CredentialStatus {
  readonly secureStorageAvailable: boolean
  readonly configured: boolean
}

export class CredentialStoreError extends Error {
  constructor(
    readonly code: 'UNAVAILABLE' | 'INVALID_VALUE' | 'CORRUPT',
    message: string,
  ) {
    super(message)
    this.name = 'CredentialStoreError'
  }
}

/**
 * Main-process-only DeepSeek credential storage.
 *
 * The public UI may consume `status`, `set`, and `delete`. `get` exists only for
 * the trusted Model Gateway and must never cross IPC.
 */
export class EncryptedCredentialStore {
  private readonly directory: string
  private readonly credentialPath: string

  constructor(
    userDataPath: string,
    private readonly safeStorage: SafeStoragePort,
  ) {
    if (typeof userDataPath !== 'string' || !isAbsolute(userDataPath) || userDataPath.includes('\0')) {
      throw new TypeError('userDataPath 必须是可信的绝对路径。')
    }
    this.directory = resolve(userDataPath)
    this.credentialPath = join(this.directory, CREDENTIAL_FILE_NAME)
  }

  isAvailable(): boolean {
    try {
      return this.safeStorage.isEncryptionAvailable() === true
    } catch {
      return false
    }
  }

  async status(): Promise<CredentialStatus> {
    const secureStorageAvailable = this.isAvailable()
    if (!secureStorageAvailable) {
      return { secureStorageAvailable: false, configured: false }
    }
    return {
      secureStorageAvailable: true,
      configured: await this.hasUsableCiphertextFile(),
    }
  }

  async set(value: string): Promise<void> {
    this.assertAvailable()
    validateApiKey(value)

    let ciphertext: Buffer
    try {
      ciphertext = Buffer.from(this.safeStorage.encryptString(value))
    } catch {
      throw new CredentialStoreError('UNAVAILABLE', '系统安全存储无法加密凭证。')
    }
    if (ciphertext.length === 0 || ciphertext.length > MAX_CIPHERTEXT_BYTES) {
      throw new CredentialStoreError('CORRUPT', '系统安全存储返回了无效密文。')
    }

    await mkdir(this.directory, { recursive: true })
    await atomicWritePrivateFile(this.directory, this.credentialPath, ciphertext)
  }

  /** Trusted Model Gateway use only. Never expose this method through IPC. */
  async get(): Promise<string | null> {
    this.assertAvailable()
    let ciphertext: Buffer
    try {
      const info = await lstat(this.credentialPath)
      if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_CIPHERTEXT_BYTES) {
        throw new CredentialStoreError('CORRUPT', '凭证文件无效。')
      }
      ciphertext = await readFile(this.credentialPath)
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return null
      if (error instanceof CredentialStoreError) throw error
      throw new CredentialStoreError('CORRUPT', '无法读取加密凭证。')
    }

    try {
      const value = this.safeStorage.decryptString(ciphertext)
      validateApiKey(value)
      return value
    } catch (error) {
      if (error instanceof CredentialStoreError && error.code === 'INVALID_VALUE') {
        throw new CredentialStoreError('CORRUPT', '加密凭证内容无效。')
      }
      throw new CredentialStoreError('CORRUPT', '系统安全存储无法解密凭证。')
    }
  }

  async delete(): Promise<void> {
    try {
      await rm(this.credentialPath, { force: true })
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
    }
  }

  private assertAvailable(): void {
    if (!this.isAvailable()) {
      throw new CredentialStoreError('UNAVAILABLE', '系统安全存储不可用，凭证操作已阻止。')
    }
  }

  private async hasUsableCiphertextFile(): Promise<boolean> {
    try {
      const info = await lstat(this.credentialPath)
      return info.isFile()
        && !info.isSymbolicLink()
        && info.size > 0
        && info.size <= MAX_CIPHERTEXT_BYTES
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return false
      return false
    }
  }
}

function validateApiKey(value: string): void {
  if (typeof value !== 'string'
    || value.trim().length === 0
    || value !== value.trim()
    || value.includes('\0')
    || Buffer.byteLength(value, 'utf8') > MAX_API_KEY_BYTES) {
    throw new CredentialStoreError('INVALID_VALUE', 'API Key 为空、过长或包含非法字符。')
  }
}

async function atomicWritePrivateFile(directory: string, target: string, data: Buffer): Promise<void> {
  const temporary = join(directory, `.credential-${randomBytes(16).toString('hex')}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(data)
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

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code
}
