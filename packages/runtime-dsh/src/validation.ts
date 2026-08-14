import { isAbsolute, relative, resolve } from 'node:path'

import { DshRuntimeError } from './errors.js'
import {
  DSH_MODEL_IDS,
  RUNTIME_ROLES,
  type DshRuntimeLaunchSpec,
} from './types.js'

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u

function assertAbsoluteDirectory(value: string, field: string): void {
  if (!isAbsolute(value)) {
    throw new DshRuntimeError('INVALID_LAUNCH', `${field} 必须是由主进程解析的绝对路径。`)
  }
}

export function isPathInside(root: string, target: string): boolean {
  const candidate = relative(resolve(root), resolve(target))
  return candidate === '' || (!candidate.startsWith('..') && !isAbsolute(candidate))
}

export function isLoopbackGateway(value: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:') return false
  if (parsed.username !== '' || parsed.password !== '') return false
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') return false
  return parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]'
}

export function validateLaunchSpec(spec: DshRuntimeLaunchSpec): void {
  if (!isAbsolute(spec.command)) {
    throw new DshRuntimeError('INVALID_LAUNCH', 'DSH runtime command 必须是绝对路径。')
  }
  assertAbsoluteDirectory(spec.cwd, 'cwd')
  assertAbsoluteDirectory(spec.workspaceDir, 'workspaceDir')
  assertAbsoluteDirectory(spec.dshHome, 'dshHome')
  assertAbsoluteDirectory(spec.sessionRoot, 'sessionRoot')
  if (!isPathInside(spec.workspaceDir, spec.cwd) && !isPathInside(spec.cwd, spec.workspaceDir)) {
    throw new DshRuntimeError('INVALID_LAUNCH', 'DSH cwd 必须与受信任 workspace 属于同一路径树。')
  }
  if (!RUNTIME_ROLES.includes(spec.role)) {
    throw new DshRuntimeError('INVALID_LAUNCH', '未知的 DSH runtime role。')
  }
  if (!DSH_MODEL_IDS.includes(spec.model)) {
    throw new DshRuntimeError('INVALID_LAUNCH', '只允许 DeepSeek V4 Pro 或 V4 Flash。')
  }
  if (!isLoopbackGateway(spec.gateway.url)) {
    throw new DshRuntimeError('INVALID_LAUNCH', 'DSH 只能连接主进程提供的 loopback Model Gateway。')
  }
  if (spec.gateway.token.length < 24 || CONTROL_CHARACTER.test(spec.gateway.token)) {
    throw new DshRuntimeError('INVALID_LAUNCH', 'Model Gateway capability 无效。')
  }
  if (spec.args.some(argument => CONTROL_CHARACTER.test(argument))) {
    throw new DshRuntimeError('INVALID_LAUNCH', 'DSH runtime 参数包含非法控制字符。')
  }
  if (spec.maxTokens !== undefined
    && (!Number.isSafeInteger(spec.maxTokens) || spec.maxTokens < 1 || spec.maxTokens > 16_384)) {
    throw new DshRuntimeError('INVALID_LAUNCH', 'maxTokens 必须是 1 到 16384 的整数。')
  }
}
