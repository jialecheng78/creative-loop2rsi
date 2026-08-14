import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_DESKTOP_SETTINGS, SettingsStore } from '../src/main/settings-store.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('SettingsStore', () => {
  it('returns safe defaults without creating or clobbering a file', async () => {
    const directory = await temporaryDirectory()
    const store = new SettingsStore(directory)

    await expect(store.load()).resolves.toEqual(DEFAULT_DESKTOP_SETTINGS)
    await expect(readdir(directory)).resolves.toEqual([])
  })

  it('atomically persists only the three allowed settings', async () => {
    const directory = await temporaryDirectory()
    const store = new SettingsStore(directory)
    await store.update({ selectedModel: 'deepseek-v4-flash' })
    await store.update({ activeSystemId: 'system-01', learningPaused: true })

    await expect(store.load()).resolves.toEqual({
      selectedModel: 'deepseek-v4-flash',
      activeSystemId: 'system-01',
      learningPaused: true,
    })
    const files = await readdir(directory)
    expect(files).toHaveLength(1)
    expect(files[0]).not.toContain('.tmp')
    const file = join(directory, files[0] ?? '')
    expect(Object.keys(JSON.parse(await readFile(file, 'utf8')) as object).sort()).toEqual([
      'activeSystemId',
      'learningPaused',
      'selectedModel',
    ])
    if (process.platform !== 'win32') {
      expect((await stat(file)).mode & 0o777).toBe(0o600)
    }
  })

  it('serializes concurrent updates without losing either patch', async () => {
    const directory = await temporaryDirectory()
    const store = new SettingsStore(directory)
    await Promise.all([
      store.update({ activeSystemId: 'system-a' }),
      store.update({ learningPaused: true }),
    ])
    await expect(store.load()).resolves.toMatchObject({ activeSystemId: 'system-a', learningPaused: true })
  })

  it.each([
    [{ selectedModel: 'another-model' }],
    [{ activeSystemId: '/tmp/system' }],
    [{ activeSystemId: '..\\system' }],
    [{ activeSystemId: 'folder/system' }],
    [{ activeSystemId: '' }],
    [{ learningPaused: 'yes' }],
    [{ arbitraryPath: '/tmp/value' }],
  ])('rejects invalid settings and path-shaped identifiers', async (patch) => {
    const directory = await temporaryDirectory()
    const store = new SettingsStore(directory)
    await expect(store.update(patch)).rejects.toBeInstanceOf(TypeError)
    await expect(readdir(directory)).resolves.toEqual([])
  })

  it('uses defaults for corrupt JSON without overwriting the evidence', async () => {
    const directory = await temporaryDirectory()
    const file = join(directory, 'studio-settings.json')
    const corrupt = '{"selectedModel":'
    await writeFile(file, corrupt, 'utf8')
    const store = new SettingsStore(directory)

    await expect(store.load()).resolves.toEqual(DEFAULT_DESKTOP_SETTINGS)
    await expect(readFile(file, 'utf8')).resolves.toBe(corrupt)
  })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'creative-rsi-settings-test-'))
  temporaryDirectories.push(directory)
  return directory
}
