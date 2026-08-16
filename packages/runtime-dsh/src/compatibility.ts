import { createRequire } from 'node:module'

import { DshRuntimeError } from './errors.js'
import {
  SUPPORTED_DSH_RUNTIME_VERSION,
  SUPPORTED_DSH_SDK_VERSION,
} from './types.js'

interface PackageManifest {
  readonly name?: unknown
  readonly version?: unknown
  readonly bin?: unknown
  readonly exports?: unknown
}

export interface DshCompatibility {
  readonly runtimeVersion: string
  readonly sdkVersion: string
}

export interface DshRuntimePackageSet {
  readonly runtime: PackageManifest
  readonly sdkClient: PackageManifest
  readonly sdkServer: PackageManifest
  readonly llmDeepSeek: PackageManifest
  readonly agentSpine: PackageManifest
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
  packages: DshRuntimePackageSet = {
    runtime: readManifest('@deepseek-ai/dsh-sdk-jsonrpc-demo'),
    sdkClient: readManifest('@deepseek-ai/dsh-sdk-client'),
    sdkServer: readManifest('@deepseek-ai/dsh-sdk-jsonrpc-server'),
    llmDeepSeek: readManifest('@deepseek-ai/dsh-llm-deepseek'),
    agentSpine: readManifest('@deepseek-ai/dsh-agent-spine-demo'),
  },
): DshCompatibility {
  const runtime = packages.runtime
  if (!hasPackageIdentity(runtime, '@deepseek-ai/dsh-sdk-jsonrpc-demo', SUPPORTED_DSH_RUNTIME_VERSION)
    || !hasStringEntry(runtime.bin, 'dsh-jsonrpc-agent')
    || !hasEntry(runtime.exports, './bin')) {
    throw new DshRuntimeError(
      'UNSUPPORTED_DSH',
      `DSH JSON-RPC runtime 必须精确为 ${SUPPORTED_DSH_RUNTIME_VERSION}，且保留公开 dsh-jsonrpc-agent bin 与 ./bin 导出。`,
    )
  }
  if (!hasPackageIdentity(packages.sdkClient, '@deepseek-ai/dsh-sdk-client', SUPPORTED_DSH_SDK_VERSION)
    || !hasEntry(packages.sdkClient.exports, '.')) {
    throw new DshRuntimeError(
      'UNSUPPORTED_DSH',
      `DSH SDK client 必须精确为 ${SUPPORTED_DSH_SDK_VERSION}，且保留公开根导出。`,
    )
  }
  assertRootExport(
    packages.sdkServer,
    '@deepseek-ai/dsh-sdk-jsonrpc-server',
    'DSH SDK JSON-RPC server',
  )
  assertRootExport(
    packages.llmDeepSeek,
    '@deepseek-ai/dsh-llm-deepseek',
    'DSH DeepSeek LLM adapter',
  )
  assertRootExport(
    packages.agentSpine,
    '@deepseek-ai/dsh-agent-spine-demo',
    'DSH agent spine',
  )
  return {
    runtimeVersion: SUPPORTED_DSH_RUNTIME_VERSION,
    sdkVersion: SUPPORTED_DSH_SDK_VERSION,
  }
}

function assertRootExport(
  manifest: PackageManifest,
  packageName: string,
  label: string,
): void {
  if (!hasPackageIdentity(manifest, packageName, SUPPORTED_DSH_RUNTIME_VERSION)
    || !hasEntry(manifest.exports, '.')) {
    throw new DshRuntimeError(
      'UNSUPPORTED_DSH',
      `${label} 必须精确为 ${SUPPORTED_DSH_RUNTIME_VERSION}，且保留公开根导出。`,
    )
  }
}

function hasPackageIdentity(
  manifest: PackageManifest,
  packageName: string,
  version: string,
): boolean {
  return manifest.name === packageName && manifest.version === version
}

function hasEntry(value: unknown, key: string): boolean {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.prototype.hasOwnProperty.call(value, key)
}

function hasStringEntry(value: unknown, key: string): boolean {
  if (!hasEntry(value, key)) return false
  const entry = (value as Record<string, unknown>)[key]
  return typeof entry === 'string' && entry.length > 0
}
