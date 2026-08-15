import { isAbsolute } from 'node:path'

import { app, BrowserWindow, ipcMain, session } from 'electron'

const preloadPath = requiredAbsoluteOption('--preload')
const rendererPath = requiredAbsoluteOption('--renderer')
const userDataPath = requiredAbsoluteOption('--user-data-dir')
const STATUS_CHANNEL = 'studio:status'
const EXPECTED_TOP_LEVEL_API = [
  'credentials',
  'getStatus',
  'model',
  'runtime',
  'systems',
  'works',
]

let completed = false
let mainWindow
let networkRequestCount = 0
let statusInvocationCount = 0
let preloadError = false

app.disableHardwareAcceleration()
app.setPath('userData', userDataPath)

process.on('uncaughtException', () => finish(1, { status: 'FAIL', code: 'UNCAUGHT_EXCEPTION' }))
process.on('unhandledRejection', () => finish(1, { status: 'FAIL', code: 'UNHANDLED_REJECTION' }))

// Do not top-level await app.whenReady(): Electron waits for this ESM module to
// finish evaluating before emitting ready.
void run().catch(() => finish(1, { status: 'FAIL', code: 'SMOKE_RUNTIME_FAILED' }))

async function run() {
  await app.whenReady()

  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (_details, callback) => {
      networkRequestCount += 1
      callback({ cancel: true })
    },
  )

  ipcMain.handle(STATUS_CHANNEL, () => {
    statusInvocationCount += 1
    return {
      version: 'preload-smoke',
      credential: 'not-configured',
      secureStorageAvailable: true,
      selectedModel: 'deepseek-v4-flash',
      runtime: { state: 'unconfigured' },
      activeSystem: null,
      feedbackRecoveryState: 'none',
    }
  })

  mainWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
    },
  })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', event => event.preventDefault())
  mainWindow.webContents.on('preload-error', () => {
    preloadError = true
  })

  await mainWindow.loadFile(rendererPath)
  await waitUntil(async () => await mainWindow.webContents.executeJavaScript(
    "document.body.innerText.includes('先连接 DeepSeek')",
    true,
  ))
  const probe = await mainWindow.webContents.executeJavaScript(`
    (async () => {
      const api = window.creativeRsi
      const status = await api.getStatus()
      return {
        apiType: typeof api,
        topLevelKeys: Object.keys(api).sort(),
        getStatusType: typeof api.getStatus,
        worksOnEventType: typeof api.works?.onEvent,
        rootFrozen: Object.isFrozen(api),
        credentialsFrozen: Object.isFrozen(api.credentials),
        worksFrozen: Object.isFrozen(api.works),
        rawRequireType: typeof window.require,
        rawProcessType: typeof window.process,
        rawIpcRendererType: typeof window.ipcRenderer,
        legacyStudioType: typeof window.studio,
        statusVersion: status.version,
        bodyText: document.body.innerText,
      }
    })()
  `, true)

  const checks = {
    no_preload_error: !preloadError,
    api_object: probe.apiType === 'object',
    api_keys_exact: JSON.stringify(probe.topLevelKeys) === JSON.stringify(EXPECTED_TOP_LEVEL_API),
    expected_functions: probe.getStatusType === 'function' && probe.worksOnEventType === 'function',
    api_frozen: probe.rootFrozen && probe.credentialsFrozen && probe.worksFrozen,
    no_raw_globals: probe.rawRequireType === 'undefined'
      && probe.rawProcessType === 'undefined'
      && probe.rawIpcRendererType === 'undefined'
      && probe.legacyStudioType === 'undefined',
    narrow_status_roundtrip: probe.statusVersion === 'preload-smoke' && statusInvocationCount >= 2,
    renderer_visible_text: probe.bodyText.includes('先连接 DeepSeek'),
    no_network_requests: networkRequestCount === 0,
  }
  if (Object.values(checks).some(value => !value)) {
    finish(1, { status: 'FAIL', code: 'PRELOAD_BOUNDARY_MISMATCH', checks })
    return
  }

  finish(0, {
    status: 'PASS',
    preload_error: false,
    api_keys: EXPECTED_TOP_LEVEL_API,
    status_invocations: statusInvocationCount,
    network_requests: networkRequestCount,
    raw_globals_exposed: false,
    renderer_visible_text: true,
  })
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('renderer did not reach the credential page')
}

function requiredAbsoluteOption(name) {
  const index = process.argv.indexOf(name)
  const value = index < 0 ? undefined : process.argv[index + 1]
  if (value === undefined || !isAbsolute(value)) throw new Error(`invalid ${name}`)
  return value
}

function finish(exitCode, result) {
  if (completed) return
  completed = true
  try {
    ipcMain.removeHandler(STATUS_CHANNEL)
  } catch {
    // The handler may not have been installed yet.
  }
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) mainWindow.destroy()
  process.stdout.write(`${JSON.stringify(result)}\n`, () => app.exit(exitCode))
}
