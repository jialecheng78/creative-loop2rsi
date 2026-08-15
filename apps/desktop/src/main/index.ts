import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { app, BrowserWindow, safeStorage, session } from 'electron'

import {
  loadControllerBridge,
  resolveControllerExecutable,
} from './controller-loader.js'
import { launchDesktopLifecycle } from './application-lifecycle.js'
import { EncryptedCredentialStore } from './credential-store.js'
import { broadcastStudioEvent, registerIpc } from './ipc.js'
import { LoopbackModelGateway } from './loopback-gateway.js'
import { RuntimeWorkerManager } from './runtime-worker-manager.js'
import { SettingsStore } from './settings-store.js'
import { StudioService } from './studio-service.js'
import { createWindowOptions } from './window-options.js'

let mainWindow: BrowserWindow | undefined
let removeIpc: (() => void) | undefined
let service: StudioService | undefined
let loopback: LoopbackModelGateway | undefined

const preloadPath = fileURLToPath(new URL('../preload/index.cjs', import.meta.url))
const workerPath = fileURLToPath(new URL('../worker/index.js', import.meta.url))
const rendererPath = fileURLToPath(new URL('../renderer/index.html', import.meta.url))

const runtime = new RuntimeWorkerManager({
  workerPath,
  onEvent: event => {
    void service?.acceptRuntimeEvent(event).catch(() => undefined)
  },
})

function createMainWindow(showWhenReady = true): BrowserWindow {
  const window = new BrowserWindow(createWindowOptions(preloadPath))
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  if (showWhenReady) window.once('ready-to-show', () => window.show())
  void window.loadFile(rendererPath)
  return window
}

function focusMainWindow(): void {
  const window = mainWindow
  if (window === undefined || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

async function bootstrapDesktop(): Promise<void> {
  await app.whenReady()

  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)

  const userDataPath = app.getPath('userData')
  const credentials = new EncryptedCredentialStore(userDataPath, safeStorage)
  const settings = new SettingsStore(userDataPath)
  const startedLoopback = new LoopbackModelGateway({ keyStore: credentials })
  loopback = startedLoopback
  await startedLoopback.start()
  const controller = await loadControllerBridge(resolveControllerExecutable({
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
    platform: process.platform,
  }))

  service = new StudioService({
    appVersion: app.getVersion(),
    userDataPath,
    nodeExecutable: process.execPath,
    controller,
    credentials,
    settings,
    runtime,
    loopback: startedLoopback,
    emit: broadcastStudioEvent,
  })

  removeIpc = registerIpc(service, () => {
    if (mainWindow === undefined || mainWindow.isDestroyed()) {
      return { rendererUrl: pathToFileURL(rendererPath).href, webContentsId: -1 }
    }
    return {
      rendererUrl: pathToFileURL(rendererPath).href,
      webContentsId: mainWindow.webContents.id,
    }
  })
  const packagedSmoke = app.isPackaged && process.argv.includes('--packaged-smoke')
  mainWindow = createMainWindow(!packagedSmoke)

  if (packagedSmoke) {
    await runPackagedSmoke(mainWindow, service)
    setImmediate(() => app.quit())
    return
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

async function runPackagedSmoke(window: BrowserWindow, activeService: StudioService): Promise<void> {
  if (window.webContents.isLoadingMainFrame()) {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      window.webContents.once('did-finish-load', () => resolvePromise())
      window.webContents.once('did-fail-load', (_event, code) => rejectPromise(new Error(`PACKAGED_RENDERER_LOAD_FAILED_${code}`)))
    })
  }
  const renderer = await window.webContents.executeJavaScript(`(() => {
    const api = window.creativeRsi;
    return {
      hasApi: typeof api === 'object' && api !== null,
      status: typeof api?.getStatus === 'function',
      configure: typeof api?.credentials?.configure === 'function',
      start: typeof api?.works?.start === 'function',
      feedback: typeof api?.works?.submitFeedback === 'function',
      nodeGlobalsAbsent: typeof window.require === 'undefined' && typeof window.process === 'undefined',
    };
  })()`, true) as Record<string, unknown>
  if (Object.values(renderer).some(value => value !== true)) {
    throw new Error('PACKAGED_RENDERER_CONTRACT_FAILED')
  }
  const system = await activeService.createSystem({
    intent: '只用于打包预检的纯虚构微型故事',
    displayName: '打包预检创作系统',
  })
  const status = await activeService.getStatus()
  if (status.credential !== 'not-configured'
    || status.activeSystem?.systemId !== system.systemId
    || status.runtime.state !== 'unconfigured') {
    throw new Error('PACKAGED_CONTROLLER_CONTRACT_FAILED')
  }
  await writeFile(
    join(app.getPath('userData'), 'packaged-smoke.json'),
    `${JSON.stringify({
      status: 'PASS',
      app_version: app.getVersion(),
      packaged: app.isPackaged,
      renderer,
      controller_system_id: system.systemId,
      credential: status.credential,
      model_requests: 0,
    }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
}

async function shutdownDesktop(): Promise<void> {
  try {
    removeIpc?.()
  } catch {
    // Continue cleaning the remaining trusted resources.
  }
  removeIpc = undefined

  const window = mainWindow
  mainWindow = undefined
  if (window !== undefined && !window.isDestroyed()) {
    try {
      window.destroy()
    } catch {
      // The window may have closed between the checks.
    }
  }

  const activeService = service
  const activeLoopback = loopback
  service = undefined
  loopback = undefined
  if (activeService !== undefined) {
    await activeService.shutdown().catch(() => undefined)
  }
  await runtime.clearConfiguration().catch(() => undefined)
  await activeLoopback?.close().catch(() => undefined)
}

// Deliberately not awaited: Electron's default app awaits this ESM import
// before it emits `ready`, so a top-level await on app.whenReady() deadlocks.
launchDesktopLifecycle({
  acquireSingleInstanceLock: () => app.requestSingleInstanceLock(),
  registerSecondInstance: listener => app.on('second-instance', listener),
  registerBeforeQuit: listener => app.on('before-quit', listener),
  quitDuplicateInstance: () => app.quit(),
  exit: code => app.exit(code),
  bootstrap: bootstrapDesktop,
  shutdown: shutdownDesktop,
  focusExistingWindow: focusMainWindow,
  reportDiagnostic: code => console.error(code),
})
