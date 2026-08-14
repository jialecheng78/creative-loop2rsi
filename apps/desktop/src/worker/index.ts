import { isRuntimeWorkerRequest } from '@creative-loop2rsi/runtime-dsh/worker-protocol'

import { RuntimeWorkerService } from './service.js'

interface ParentPortLike {
  on(event: 'message', listener: (event: { data: unknown }) => void): void
  postMessage(value: unknown): void
}

const parentPort = (process as NodeJS.Process & { parentPort?: ParentPortLike }).parentPort
if (parentPort === undefined) throw new Error('DSH utility worker requires Electron parentPort.')

const service = new RuntimeWorkerService()
parentPort.on('message', event => {
  if (!isRuntimeWorkerRequest(event.data)) return
  void service.handle(event.data, runtimeEvent => {
    parentPort.postMessage({ type: 'runtime-event', event: runtimeEvent })
  }).then(response => parentPort.postMessage(response))
})
