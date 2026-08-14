import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  CredentialStoreError,
  EncryptedCredentialStore,
  type SafeStoragePort,
} from '../src/main/credential-store.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('EncryptedCredentialStore', () => {
  it('fails closed when platform encryption is unavailable', async () => {
    const directory = await temporaryDirectory()
    const store = new EncryptedCredentialStore(directory, fakeSafeStorage(false))

    expect(store.isAvailable()).toBe(false)
    await expect(store.status()).resolves.toEqual({ secureStorageAvailable: false, configured: false })
    await expect(store.set('synthetic-credential-value')).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    await expect(store.get()).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    await expect(readdir(directory)).resolves.toEqual([])
  })

  it('writes only ciphertext atomically with private permissions', async () => {
    const directory = await temporaryDirectory()
    const store = new EncryptedCredentialStore(directory, fakeSafeStorage(true))
    const value = 'synthetic-credential-value'

    await store.set(value)
    const files = await readdir(directory)
    expect(files).toHaveLength(1)
    expect(files[0]).not.toContain('.tmp')
    const file = join(directory, files[0] ?? '')
    const bytes = await readFile(file)
    expect(bytes.toString('utf8')).not.toContain(value)
    expect(bytes.toString('utf8')).toContain('encrypted:')
    await expect(store.status()).resolves.toEqual({ secureStorageAvailable: true, configured: true })
    await expect(store.get()).resolves.toBe(value)
    if (process.platform !== 'win32') {
      expect((await stat(file)).mode & 0o777).toBe(0o600)
    }
  })

  it.each([
    ['', 'empty'],
    ['   ', 'blank'],
    [' padded-value ', 'padded'],
    ['contains\0nul', 'nul'],
    ['x'.repeat(4 * 1024 + 1), 'long'],
  ])('rejects invalid credential values (%s)', async (value) => {
    const directory = await temporaryDirectory()
    const store = new EncryptedCredentialStore(directory, fakeSafeStorage(true))
    await expect(store.set(value)).rejects.toBeInstanceOf(CredentialStoreError)
    await expect(readdir(directory)).resolves.toEqual([])
  })

  it('deletes idempotently without requiring encryption availability', async () => {
    const directory = await temporaryDirectory()
    const storage = fakeSafeStorage(true)
    const store = new EncryptedCredentialStore(directory, storage)
    await store.set('synthetic-credential-value')

    await store.delete()
    await store.delete()
    await expect(store.status()).resolves.toEqual({ secureStorageAvailable: true, configured: false })

    storage.available = false
    await expect(store.delete()).resolves.toBeUndefined()
  })
})

function fakeSafeStorage(available: boolean): SafeStoragePort & { available: boolean } {
  return {
    available,
    isEncryptionAvailable() {
      return this.available
    },
    encryptString(value) {
      return Buffer.from(`encrypted:${Buffer.from(value, 'utf8').toString('base64')}`, 'utf8')
    },
    decryptString(value) {
      const encoded = value.toString('utf8')
      if (!encoded.startsWith('encrypted:')) throw new Error('invalid ciphertext')
      return Buffer.from(encoded.slice('encrypted:'.length), 'base64').toString('utf8')
    },
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'creative-rsi-credential-test-'))
  temporaryDirectories.push(directory)
  return directory
}
