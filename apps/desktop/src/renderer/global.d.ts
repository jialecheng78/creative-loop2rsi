import type { CreativeRsiApi } from '../shared/ipc.js'

declare global {
  interface Window {
    readonly creativeRsi: CreativeRsiApi
  }
}

export {}
