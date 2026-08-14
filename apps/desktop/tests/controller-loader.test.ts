import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { resolveControllerExecutable } from '../src/main/controller-loader.js'

describe('trusted Controller executable resolution', () => {
  it('uses the source Python package without accepting renderer paths', () => {
    expect(resolveControllerExecutable({
      appPath: '/repo/apps/desktop',
      resourcesPath: '/unused',
      isPackaged: false,
      platform: 'darwin',
    })).toEqual({
      file: '/usr/bin/python3',
      fixedArguments: ['-B', '-m', 'creative_loop2rsi'],
      cwd: resolve('/repo/python'),
    })
  })

  it('uses a fixed bundled sidecar location in packaged builds', () => {
    expect(resolveControllerExecutable({
      appPath: 'C:\\app',
      resourcesPath: 'C:\\trusted-resources',
      isPackaged: true,
      platform: 'win32',
    }).file).toBe(join('C:\\trusted-resources', 'controller', 'creative-rsi-controller.exe'))
  })
})
