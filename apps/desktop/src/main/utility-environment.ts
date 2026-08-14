const UTILITY_ENV_ALLOWLIST = new Set([
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

const SENSITIVE = /(API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION)/iu
const PROXY = /^(ALL|HTTP|HTTPS|NO)_PROXY$/iu

export function buildUtilityProcessEnvironment(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined || !UTILITY_ENV_ALLOWLIST.has(key)) continue
    if (SENSITIVE.test(key) || PROXY.test(key)) continue
    result[key] = value
  }
  result.DSH_TELEMETRY_DISABLED = '1'
  return result
}
