import { join, resolve } from 'node:path'

import {
  ControllerBridge,
  type ControllerExecutable,
} from '@creative-loop2rsi/controller-bridge'

import type { ControllerPort } from './studio-service.js'

export type ControllerExecutableSpec = ControllerExecutable

export interface ControllerLocationInput {
  readonly appPath: string
  readonly resourcesPath: string
  readonly isPackaged: boolean
  readonly platform: NodeJS.Platform
}

/** All paths come from Electron main; Renderer cannot choose an executable. */
export function resolveControllerExecutable(input: ControllerLocationInput): ControllerExecutableSpec {
  if (input.isPackaged) {
    const executable = input.platform === 'win32'
      ? 'creative-rsi-controller.exe'
      : 'creative-rsi-controller'
    return { file: join(input.resourcesPath, 'controller', executable) }
  }
  const repositoryRoot = resolve(input.appPath, '..', '..')
  const pythonRoot = join(repositoryRoot, 'python')
  const interpreter = input.platform === 'win32'
    ? join(repositoryRoot, '.venv', 'Scripts', 'python.exe')
    : '/usr/bin/python3'
  return {
    file: interpreter,
    fixedArguments: ['-B', '-m', 'creative_loop2rsi'],
    cwd: pythonRoot,
  }
}

export async function loadControllerBridge(
  executable: ControllerExecutableSpec,
): Promise<ControllerPort> {
  const instance = new ControllerBridge(executable, {
    timeoutMs: 30_000,
    maxRequestBytes: 2 * 1024 * 1024,
    maxOutputBytes: 4 * 1024 * 1024,
  })
  return instance as unknown as ControllerPort
}
