import { execFile as execFileCallback } from 'node:child_process'
import { createRequire } from 'node:module'
import { access, lstat, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import { buildUtilityProcessEnvironment } from '../src/main/utility-environment.js'
import { createWindowOptions } from '../src/main/window-options.js'
import { isTrustedIpcSender } from '../src/main/ipc-security.js'

const desktopRoot = fileURLToPath(new URL('..', import.meta.url))
const buildScript = fileURLToPath(new URL('../scripts/build-renderer.mjs', import.meta.url))
const smokeScript = fileURLToPath(new URL('../scripts/preload-smoke.mjs', import.meta.url))
const preloadBundlePath = fileURLToPath(new URL('../dist/preload/index.cjs', import.meta.url))
const obsoletePreloadPath = fileURLToPath(new URL('../dist/preload/index.js', import.meta.url))
const rendererPath = fileURLToPath(new URL('../dist/renderer/index.html', import.meta.url))
const execFile = promisify(execFileCallback)
let buildArtifacts: Promise<void> | undefined

describe('desktop security defaults', () => {
  it('sandboxes the renderer and disables Node integration', () => {
    const options = createWindowOptions(resolve('/tmp', 'preload.js'))
    expect(options.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    })
  })

  it('builds the sandboxed preload as one CommonJS bundle', async () => {
    await ensureRendererArtifacts()
    const [mainSource, buildSource, buildConfig, bundle, stat] = await Promise.all([
      readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8'),
      readFile(new URL('../scripts/build-renderer.mjs', import.meta.url), 'utf8'),
      readFile(new URL('../tsconfig.build.json', import.meta.url), 'utf8'),
      readFile(preloadBundlePath, 'utf8'),
      lstat(preloadBundlePath),
    ])
    expect(mainSource).toContain("new URL('../preload/index.cjs', import.meta.url)")
    expect(buildSource).toContain("format: 'cjs'")
    expect(buildSource).toContain("external: ['electron']")
    expect(buildConfig).toContain('src/preload/**/*.ts')
    expect(stat.isFile()).toBe(true)
    expect(stat.isSymbolicLink()).toBe(false)
    await expect(access(obsoletePreloadPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(execFile(process.execPath, ['--check', preloadBundlePath], {
      env: buildChildEnvironment(),
    })).resolves.toBeDefined()
    expect(bundle).not.toMatch(/^\s*import\s/mu)
    const requiredModules = [...bundle.matchAll(/\brequire\(\s*(["'])([^"']+)\1\s*\)/gu)]
      .map(match => match[2])
    expect(requiredModules).toEqual(['electron'])
  })

  it.skipIf(process.platform === 'linux' && process.env.DISPLAY === undefined && process.env.WAYLAND_DISPLAY === undefined)(
    'loads the real renderer through a hidden sandboxed Electron window',
    async () => {
      await ensureRendererArtifacts()
      const temporaryRoot = await mkdtemp(join(tmpdir(), 'creative-rsi-preload-smoke-'))
      try {
        const electronExecutable = createRequire(import.meta.url)('electron') as unknown
        expect(typeof electronExecutable).toBe('string')
        const { stdout } = await execFile(electronExecutable as string, [
          smokeScript,
          '--preload', preloadBundlePath,
          '--renderer', rendererPath,
          '--user-data-dir', join(temporaryRoot, 'user-data'),
        ], {
          cwd: desktopRoot,
          encoding: 'utf8',
          env: electronChildEnvironment(temporaryRoot),
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        })
        const reports = stdout.split(/\r?\n/u)
          .map(line => line.trim())
          .filter(Boolean)
          .flatMap(line => {
            try {
              return [JSON.parse(line) as Record<string, unknown>]
            } catch {
              return []
            }
          })
        const report = reports.at(-1)
        expect(report).toMatchObject({
          status: 'PASS',
          preload_error: false,
          api_keys: ['candidates', 'credentials', 'getStatus', 'model', 'releases', 'runtime', 'systems', 'works'],
          network_requests: 0,
          raw_globals_exposed: false,
          renderer_visible_text: true,
        })
        expect(report?.status_invocations).toEqual(expect.any(Number))
        expect(report?.status_invocations as number).toBeGreaterThanOrEqual(2)
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true })
      }
    },
  )

  it('replaces the utility environment and strips secrets and proxies', () => {
    expect(buildUtilityProcessEnvironment({
      PATH: '/usr/bin',
      DEEPSEEK_API_KEY: 'forbidden',
      CREATIVE_RSI_GATEWAY_TOKEN: 'forbidden-parent-token',
      HTTPS_PROXY: 'http://proxy.invalid',
      HOME: '/private/user-home',
      DSH_HOME: '/private/parent-dsh-home',
      LANG: 'zh_CN.UTF-8',
    })).toEqual({
      PATH: '/usr/bin',
      LANG: 'zh_CN.UTF-8',
      DSH_TELEMETRY_DISABLED: '1',
    })
  })

  it('ships a strict renderer CSP with no network access', async () => {
    const html = await readFile(new URL('../src/renderer/index.html', import.meta.url), 'utf8')
    expect(html).toContain("default-src 'self'")
    expect(html).toContain("connect-src 'none'")
    expect(html).toContain("object-src 'none'")
    expect(html).not.toContain('unsafe-inline')
    expect(html).not.toContain('unsafe-eval')
  })

  it('accepts only the main frame of the expected renderer webContents', () => {
    const boundary = { rendererUrl: 'file:///app/dist/renderer/index.html', webContentsId: 7 }
    const trusted = {
      sender: { id: 7 },
      senderFrame: { parent: null, url: boundary.rendererUrl },
    } as unknown as Parameters<typeof isTrustedIpcSender>[0]
    expect(isTrustedIpcSender(trusted, boundary)).toBe(true)
    expect(isTrustedIpcSender({
      sender: { id: 7 },
      senderFrame: { parent: {}, url: boundary.rendererUrl },
    } as unknown as Parameters<typeof isTrustedIpcSender>[0], boundary)).toBe(false)
    expect(isTrustedIpcSender({
      sender: { id: 8 },
      senderFrame: { parent: null, url: boundary.rendererUrl },
    } as unknown as Parameters<typeof isTrustedIpcSender>[0], boundary)).toBe(false)
  })
})

async function ensureRendererArtifacts(): Promise<void> {
  buildArtifacts ??= execFile(process.execPath, [buildScript], {
    cwd: desktopRoot,
    env: buildChildEnvironment(),
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  }).then(() => undefined)
  await buildArtifacts
}

function buildChildEnvironment(): NodeJS.ProcessEnv {
  return withOperatingSystemEnvironment({
    PATH: process.env.PATH ?? '',
    LANG: process.env.LANG ?? 'C.UTF-8',
  })
}

function electronChildEnvironment(temporaryRoot: string): NodeJS.ProcessEnv {
  const environment = withOperatingSystemEnvironment({
    PATH: process.env.PATH ?? '',
    HOME: temporaryRoot,
    USERPROFILE: temporaryRoot,
    TMPDIR: temporaryRoot,
    TEMP: temporaryRoot,
    TMP: temporaryRoot,
    APPDATA: temporaryRoot,
    LOCALAPPDATA: temporaryRoot,
    XDG_CACHE_HOME: join(temporaryRoot, 'cache'),
    XDG_CONFIG_HOME: join(temporaryRoot, 'config'),
    LANG: process.env.LANG ?? 'C.UTF-8',
    DSH_TELEMETRY_DISABLED: '1',
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
  })
  for (const name of ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS'] as const) {
    const value = process.env[name]
    if (value !== undefined) environment[name] = value
  }
  return environment
}

function withOperatingSystemEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const name of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT'] as const) {
    const value = process.env[name]
    if (value !== undefined) environment[name] = value
  }
  return environment
}
