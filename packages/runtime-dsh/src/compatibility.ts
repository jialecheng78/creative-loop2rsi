import { createRequire } from 'node:module'

import { DshRuntimeError } from './errors.js'
import { SUPPORTED_DSH_SDK_VERSION, SUPPORTED_DSH_VERSION } from './types.js'

interface PackageManifest {
  readonly name?: unknown
  readonly version?: unknown
  readonly bin?: unknown
  readonly exports?: unknown
}

export interface DshCompatibility {
  readonly cliVersion: string
  readonly sdkVersion: string
}

const require = createRequire(import.meta.url)

function readManifest(packageName: string): PackageManifest {
  try {
    return require(`${packageName}/package.json`) as PackageManifest
  } catch (error) {
    throw new DshRuntimeError(
      'UNSUPPORTED_DSH',
      `缺少受支持的 ${packageName} 发布包。`,
      { cause: error },
    )
  }
}

export function assertDshCompatibility(
  cli: PackageManifest = readManifest('@deepseek-ai/dsh'),
  sdk: PackageManifest = readManifest('@deepseek-ai/dsh-sdk-client'),
): DshCompatibility {
  if (cli.name !== '@deepseek-ai/dsh'
    || cli.version !== SUPPORTED_DSH_VERSION
    || typeof cli.bin !== 'object'
    || cli.bin === null
    || !('dsh' in cli.bin)) {
    throw new DshRuntimeError(
      'UNSUPPORTED_DSH',
      `DSH CLI 必须精确为 ${SUPPORTED_DSH_VERSION}，且保留公开 dsh bin。`,
    )
  }
  if (sdk.name !== '@deepseek-ai/dsh-sdk-client'
    || sdk.version !== SUPPORTED_DSH_SDK_VERSION
    || typeof sdk.exports !== 'object'
    || sdk.exports === null
    || !('.' in sdk.exports)) {
    throw new DshRuntimeError(
      'UNSUPPORTED_DSH',
      `DSH SDK 必须精确为 ${SUPPORTED_DSH_SDK_VERSION}，且保留公开根导出。`,
    )
  }
  return {
    cliVersion: SUPPORTED_DSH_VERSION,
    sdkVersion: SUPPORTED_DSH_SDK_VERSION,
  }
}
