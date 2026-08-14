import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@creative-loop2rsi/controller-bridge',
        replacement: fileURLToPath(new URL('../../packages/controller-bridge/src/index.ts', import.meta.url)),
      },
      {
        find: '@creative-loop2rsi/runtime-dsh/worker-protocol',
        replacement: fileURLToPath(new URL('../../packages/runtime-dsh/src/worker-protocol.ts', import.meta.url)),
      },
      {
        find: '@creative-loop2rsi/runtime-dsh',
        replacement: fileURLToPath(new URL('../../packages/runtime-dsh/src/index.ts', import.meta.url)),
      },
      {
        find: '@creative-loop2rsi/model-gateway',
        replacement: fileURLToPath(new URL('../../packages/model-gateway/src/index.ts', import.meta.url)),
      },
    ],
  },
})
