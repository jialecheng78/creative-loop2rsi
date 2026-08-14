import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

import { app, BrowserWindow, safeStorage, session } from 'electron'

import {
  loadControllerBridge,
  resolveControllerExecutable,
} from './controller-loader.js'
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
let shutdownStarted = false

const preloadPath = fileURLToPath(new URL('../preload/index.js', import.meta.url))
const workerPath = fileURLToPath(new URL('../worker/index.js', import.meta.url))
const rendererPath = fileURLToPath(new URL('../renderer/index.html', import.meta.url))

const runtime = new RuntimeWorkerManager({
  workerPath,
  onEvent: event => {
    void service?.acceptRuntimeEvent(event).catch(() => undefined)
  },
})

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow(createWindowOptions(preloadPath))
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.once('ready-to-show', () => window.show())
  void window.loadFile(rendererPath)
  return window
}

await app.whenReady()

session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
session.defaultSession.setPermissionCheckHandler(() => false)

const userDataPath = app.getPath('userData')
const credentials = new EncryptedCredentialStore(userDataPath, safeStorage)
const settings = new SettingsStore(userDataPath)
const loopback = new LoopbackModelGateway({ keyStore: credentials })
await loopback.start()
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
  loopback,
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
mainWindow = createMainWindow()

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', event => {
  if (shutdownStarted) return
  event.preventDefault()
  shutdownStarted = true
  void service?.shutdown().finally(() => {
    removeIpc?.()
    app.exit(0)
  })
})
