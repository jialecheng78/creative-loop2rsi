import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { buildUtilityProcessEnvironment } from '../src/main/utility-environment.js'
import { createWindowOptions } from '../src/main/window-options.js'
import { isTrustedIpcSender } from '../src/main/ipc-security.js'

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
