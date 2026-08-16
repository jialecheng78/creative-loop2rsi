import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DeepSeekGateway } from '@creative-loop2rsi/model-gateway'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
  it('requires explicit session permission and loses the fallback on restart', async () => {
    const directory = await temporaryDirectory()
    const store = new EncryptedCredentialStore(directory, fakeSafeStorage(false))
    const value = 'synthetic-session-credential'

    expect(store.isAvailable()).toBe(false)
    await expect(store.status()).resolves.toEqual({
      secureStorageAvailable: false, configured: false, persistence: 'none',
    })
    await expect(store.set(value)).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    await expect(store.get()).resolves.toBeNull()

    await store.set(value, { allowSessionOnly: true })
    expect(store.isAvailable()).toBe(true)
    await expect(store.status()).resolves.toEqual({
      secureStorageAvailable: false, configured: true, persistence: 'session',
    })
    await expect(store.get()).resolves.toBe(value)
    await expect(readdir(directory)).resolves.toEqual([])

    const restarted = new EncryptedCredentialStore(directory, fakeSafeStorage(false))
    expect(restarted.isAvailable()).toBe(false)
    await expect(restarted.status()).resolves.toEqual({
      secureStorageAvailable: false, configured: false, persistence: 'none',
    })
    await expect(restarted.get()).resolves.toBeNull()
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
    await expect(store.status()).resolves.toEqual({
      secureStorageAvailable: true, configured: true, persistence: 'protected',
    })
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
    await expect(store.status()).resolves.toEqual({
      secureStorageAvailable: true, configured: false, persistence: 'none',
    })

    storage.available = false
    await expect(store.delete()).resolves.toBeUndefined()
  })

  it('does not modify protected ciphertext while using a session override', async () => {
    const directory = await temporaryDirectory()
    const storage = fakeSafeStorage(true)
    const store = new EncryptedCredentialStore(directory, storage)
    await store.set('protected-value')
    const [name] = await readdir(directory)
    const file = join(directory, name ?? '')
    const before = await readFile(file)

    storage.available = false
    await store.set('session-value', { allowSessionOnly: true })
    await expect(store.get()).resolves.toBe('session-value')
    expect(await readFile(file)).toEqual(before)

    store.clearSession()
    expect(store.isAvailable()).toBe(false)
    storage.available = true
    await expect(store.get()).resolves.toBe('protected-value')
  })

  it('presents the session value to the Main-owned Model Gateway without network access', async () => {
    const directory = await temporaryDirectory()
    const store = new EncryptedCredentialStore(directory, fakeSafeStorage(false))
    const value = 'synthetic-session-gateway-key'
    await store.set(value, { allowSessionOnly: true })
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${value}`)
      return new Response(JSON.stringify({ object: 'list', data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    await expect(new DeepSeekGateway({ keyStore: store, fetch }).listModels()).resolves.toEqual({
      object: 'list', data: [],
    })
    expect(fetch).toHaveBeenCalledOnce()
    await expect(readdir(directory)).resolves.toEqual([])
  })

  it('never silently falls back when safeStorage reports available but encryption fails', async () => {
    const directory = await temporaryDirectory()
    const storage = fakeSafeStorage(true)
    storage.encryptString = () => { throw new Error('synthetic encryption failure') }
    const store = new EncryptedCredentialStore(directory, storage)

    await expect(store.set('synthetic-value', { allowSessionOnly: true })).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    })
    await expect(store.status()).resolves.toEqual({
      secureStorageAvailable: true, configured: false, persistence: 'none',
    })
    await expect(readdir(directory)).resolves.toEqual([])
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
