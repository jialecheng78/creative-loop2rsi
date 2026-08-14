import type { DshRuntimeLaunchSpec } from './types.js'

const SAFE_PARENT_KEYS = new Set([
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'WINDIR',
])

const SECRET_NAME = /(API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION)/iu
const PROXY_NAME = /^(ALL|HTTP|HTTPS|NO)_PROXY$/iu

/**
 * Replace, rather than extend, the runtime environment. The capability is a
 * local gateway credential and is deliberately stored under a Studio-owned
 * name instead of DEEPSEEK_API_KEY.
 */
export function buildRuntimeEnvironment(
  spec: DshRuntimeLaunchSpec,
  parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined || !SAFE_PARENT_KEYS.has(key)) continue
    if (SECRET_NAME.test(key) || PROXY_NAME.test(key)) continue
    env[key] = value
  }
  env.CREATIVE_RSI_GATEWAY_URL = spec.gateway.url.replace(/\/$/u, '')
  env.CREATIVE_RSI_GATEWAY_TOKEN = spec.gateway.token
  env.DSH_CWD = spec.workspaceDir
  // Force the rc.6 anonymous identity and every harness-home lookup into the
  // app-owned directory supplied by trusted Main. HOME and parent DSH_HOME
  // are deliberately absent from SAFE_PARENT_KEYS.
  env.DSH_HOME = spec.dshHome
  env.DSH_TELEMETRY_DISABLED = '1'
  // Harmless under ordinary Node; required when command is Electron's binary.
  env.ELECTRON_RUN_AS_NODE = '1'
  return env
}

export function containsDeepSeekCredential(env: NodeJS.ProcessEnv): boolean {
  return Object.keys(env).some(key => /^DEEPSEEK_(API_KEY|TOKEN)$/iu.test(key))
}
