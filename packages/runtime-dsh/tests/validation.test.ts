import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  assertDshCompatibility,
  buildRuntimeEnvironment,
  containsDeepSeekCredential,
  isLoopbackGateway,
  validateLaunchSpec,
  type DshRuntimeLaunchSpec,
} from '../src/index.js'

const root = resolve('/tmp', 'creative-rsi-runtime-test')

function spec(): DshRuntimeLaunchSpec {
  return {
    command: resolve(root, 'node'),
    args: [resolve(root, 'runtime.js')],
    cwd: resolve(root, 'workspace'),
    workspaceDir: resolve(root, 'workspace'),
    dshHome: resolve(root, 'app-runtime', 'dsh-home', 'production'),
    sessionRoot: resolve(root, 'sessions'),
    role: 'production',
    model: 'deepseek-v4-pro',
    gateway: {
      url: 'http://127.0.0.1:43123',
      token: 'a'.repeat(32),
    },
    maxTokens: 16_384,
  }
}

describe('runtime launch validation', () => {
  it('accepts a loopback capability and excludes the DeepSeek API key', () => {
    const value = spec()
    expect(() => validateLaunchSpec(value)).not.toThrow()
    const env = buildRuntimeEnvironment(value, {
      PATH: '/usr/bin',
      DEEPSEEK_API_KEY: 'must-not-cross',
      HTTPS_PROXY: 'http://proxy.invalid',
      RANDOM_SECRET: 'must-not-cross',
      HOME: '/private/user-home',
      DSH_HOME: '/private/parent-dsh-home',
    })
    expect(env).toMatchObject({
      PATH: '/usr/bin',
      CREATIVE_RSI_GATEWAY_URL: 'http://127.0.0.1:43123',
      CREATIVE_RSI_GATEWAY_TOKEN: 'a'.repeat(32),
      DSH_TELEMETRY_DISABLED: '1',
      DSH_HOME: resolve(root, 'app-runtime', 'dsh-home', 'production'),
      ELECTRON_RUN_AS_NODE: '1',
    })
    expect(env).not.toHaveProperty('DEEPSEEK_API_KEY')
    expect(env).not.toHaveProperty('DSH_SESSION_ROOT')
    expect(env).not.toHaveProperty('HTTPS_PROXY')
    expect(env).not.toHaveProperty('RANDOM_SECRET')
    expect(env).not.toHaveProperty('HOME')
    expect(containsDeepSeekCredential(env)).toBe(false)
  })

  it('scopes the official rc.6 anonymous id to the app-owned DSH home', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'creative-rsi-dsh-home-'))
    const appHome = join(temporary, 'app-runtime', 'dsh-home', 'production')
    const parentHome = join(temporary, 'parent-home')
    const parentDshHome = join(temporary, 'parent-dsh-home')
    const value = { ...spec(), dshHome: appHome }
    const env = buildRuntimeEnvironment(value, {
      HOME: parentHome,
      DSH_HOME: parentDshHome,
      PATH: process.env.PATH,
    })
    const fixedId = '00000000-0000-4000-8000-000000000001'
    try {
      const anonymous = await loadOfficialAnonymousUserId()
      expect(anonymous.getOrCreateAnonymousUserId({ env, randomUUID: () => fixedId })).toBe(fixedId)
      await expect(readFile(join(appHome, '.anonymous-user-id'), 'utf8')).resolves.toBe(`${fixedId}\n`)
      await expect(exists(join(parentHome, '.dsh', '.anonymous-user-id'))).resolves.toBe(false)
      await expect(exists(join(parentDshHome, '.anonymous-user-id'))).resolves.toBe(false)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('rejects public, credentialed, and path-bearing gateway URLs', () => {
    expect(isLoopbackGateway('https://api.deepseek.com')).toBe(false)
    expect(isLoopbackGateway('http://user:pass@127.0.0.1:4000')).toBe(false)
    expect(isLoopbackGateway('http://127.0.0.1:4000/v1')).toBe(false)
    expect(isLoopbackGateway('http://127.0.0.1:4000')).toBe(true)
  })

  it('pins the real CLI and SDK package surfaces', () => {
    expect(assertDshCompatibility(
      { name: '@deepseek-ai/dsh', version: '0.1.0-rc.6', bin: { dsh: 'lib/bin.js' } },
      { name: '@deepseek-ai/dsh-sdk-client', version: '0.1.0-rc.6', exports: { '.': {} } },
    )).toEqual({ cliVersion: '0.1.0-rc.6', sdkVersion: '0.1.0-rc.6' })
    expect(() => assertDshCompatibility(
      { name: '@deepseek-ai/dsh', version: '0.1.0-rc.5', bin: { dsh: 'lib/bin.js' } },
      { name: '@deepseek-ai/dsh-sdk-client', version: '0.1.0-rc.6', exports: { '.': {} } },
    )).toThrow(/精确/u)
  })
})

interface AnonymousUserIdModule {
  getOrCreateAnonymousUserId(options: {
    readonly env: NodeJS.ProcessEnv
    readonly randomUUID: () => string
  }): string
}

async function loadOfficialAnonymousUserId(): Promise<AnonymousUserIdModule> {
  const require = createRequire(import.meta.url)
  const llmEntry = require.resolve('@deepseek-ai/dsh-llm-deepseek')
  const nestedRequire = createRequire(llmEntry)
  const entry = nestedRequire.resolve('@deepseek-ai/dsh-anonymous-user-id')
  const loaded: unknown = await import(pathToFileURL(entry).href)
  if (typeof loaded !== 'object'
    || loaded === null
    || !('getOrCreateAnonymousUserId' in loaded)
    || typeof loaded.getOrCreateAnonymousUserId !== 'function') {
    throw new TypeError('official anonymous-user-id export is unavailable')
  }
  return loaded as AnonymousUserIdModule
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
