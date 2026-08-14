import { contextBridge, ipcRenderer } from 'electron'

import {
  IPC_CHANNELS,
  type CancelWorkInput,
  type ConfigureCredentialInput,
  type CreateSystemInput,
  type CreativeRsiApi,
  type SelectModelInput,
  type StartWorkInput,
  type StudioEvent,
  type SubmitFeedbackInput,
} from '../shared/ipc.js'

function subscribe(listener: (event: StudioEvent) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, value: unknown): void => {
    if (typeof value === 'object' && value !== null && 'type' in value) {
      listener(value as StudioEvent)
    }
  }
  ipcRenderer.on(IPC_CHANNELS.studioEvent, handler)
  return () => ipcRenderer.removeListener(IPC_CHANNELS.studioEvent, handler)
}

const api: CreativeRsiApi = Object.freeze({
  getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.appStatus),
  credentials: Object.freeze({
    configure: (input: ConfigureCredentialInput) => ipcRenderer.invoke(IPC_CHANNELS.credentialsConfigure, input),
    status: () => ipcRenderer.invoke(IPC_CHANNELS.credentialsStatus),
    delete: () => ipcRenderer.invoke(IPC_CHANNELS.credentialsDelete),
  }),
  model: Object.freeze({
    select: (input: SelectModelInput) => ipcRenderer.invoke(IPC_CHANNELS.modelSelect, input),
  }),
  systems: Object.freeze({
    create: (input: CreateSystemInput) => ipcRenderer.invoke(IPC_CHANNELS.systemsCreate, input),
    snapshot: () => ipcRenderer.invoke(IPC_CHANNELS.systemsSnapshot),
  }),
  works: Object.freeze({
    start: (input: StartWorkInput) => ipcRenderer.invoke(IPC_CHANNELS.worksStart, input),
    cancel: (input: CancelWorkInput) => ipcRenderer.invoke(IPC_CHANNELS.worksCancel, input),
    submitFeedback: (input: SubmitFeedbackInput) => ipcRenderer.invoke(IPC_CHANNELS.worksSubmitFeedback, input),
    onEvent: subscribe,
  }),
  runtime: Object.freeze({
    status: async () => (await ipcRenderer.invoke(IPC_CHANNELS.appStatus)).runtime,
    start: async (input: string) => {
      const status = await ipcRenderer.invoke(IPC_CHANNELS.appStatus)
      if (status.activeSystem === null) {
        await ipcRenderer.invoke(IPC_CHANNELS.systemsCreate, { intent: input })
      }
      return ipcRenderer.invoke(IPC_CHANNELS.worksStart, { task: input })
    },
    cancel: (runId: string) => ipcRenderer.invoke(IPC_CHANNELS.worksCancel, { runId }),
    stop: () => ipcRenderer.invoke(IPC_CHANNELS.worksCancel, { runId: 'active' }),
    onEvent: subscribe,
  }),
})

contextBridge.exposeInMainWorld('creativeRsi', api)
