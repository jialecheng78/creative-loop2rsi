import { cp, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(root, 'dist/renderer')
await mkdir(output, { recursive: true })
await Promise.all([
  cp(resolve(root, 'src/renderer/index.html'), resolve(output, 'index.html')),
  cp(resolve(root, 'src/renderer/styles.css'), resolve(output, 'styles.css')),
  build({
    entryPoints: [resolve(root, 'src/renderer/index.tsx')],
    outfile: resolve(output, 'index.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    sourcemap: false,
    logLevel: 'info',
  }),
])
