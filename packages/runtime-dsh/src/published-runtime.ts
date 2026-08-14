import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { DshRuntimeError } from './errors.js'
import type { DshRuntimeLaunchSpec } from './types.js'

const require = createRequire(import.meta.url)

export interface PublishedRuntimeInput extends Omit<DshRuntimeLaunchSpec, 'command' | 'args'> {
  /** Absolute Node or Electron executable supplied by trusted desktop main. */
  readonly nodeExecutable: string
}

/**
 * Resolve only documented public package exports. No source-tree or private
 * `lib/*` path is guessed. A missing export blocks runtime configuration.
 */
export function resolvePublishedRuntime(input: PublishedRuntimeInput): DshRuntimeLaunchSpec {
  let runtimeEntry: string
  try {
    runtimeEntry = require.resolve('@deepseek-ai/dsh-sdk-jsonrpc-demo/bin')
  } catch (error) {
    throw new DshRuntimeError(
      'UNSUPPORTED_DSH',
      'DSH rc.6 没有可解析的公开 JSON-RPC runtime bin，运行已阻止。',
      { cause: error },
    )
  }
  const config = fileURLToPath(new URL('../profiles/studio.cordis.yml', import.meta.url))
  return {
    command: input.nodeExecutable,
    args: [runtimeEntry, config],
    cwd: input.cwd,
    workspaceDir: input.workspaceDir,
    dshHome: input.dshHome,
    sessionRoot: input.sessionRoot,
    role: input.role,
    model: input.model,
    gateway: input.gateway,
    ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
  }
}
