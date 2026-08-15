import { execFile as execFileCallback } from 'node:child_process'
import { access, cp, lstat, mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(root, 'dist/renderer')
const preloadOutput = resolve(root, 'dist/preload')
const preloadBundlePath = resolve(preloadOutput, 'index.cjs')
const obsoletePreloadPath = resolve(preloadOutput, 'index.js')
const execFile = promisify(execFileCallback)
await rm(preloadOutput, { recursive: true, force: true })
await Promise.all([
  mkdir(output, { recursive: true }),
  mkdir(preloadOutput, { recursive: true }),
])
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
  build({
    entryPoints: [resolve(root, 'src/preload/index.ts')],
    outfile: preloadBundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node24',
    external: ['electron'],
    minify: false,
    sourcemap: false,
    logLevel: 'info',
  }),
])

const preloadStat = await lstat(preloadBundlePath)
if (!preloadStat.isFile() || preloadStat.isSymbolicLink()) {
  throw new Error('sandboxed preload must be a regular file')
}
await access(obsoletePreloadPath).then(
  () => { throw new Error('obsolete ESM preload artifact must not exist') },
  error => {
    if (error?.code !== 'ENOENT') throw error
  },
)

const preloadBundle = await readFile(preloadBundlePath, 'utf8')
const requiredModules = [...preloadBundle.matchAll(/\brequire\(\s*(["'])([^"']+)\1\s*\)/gu)]
  .map(match => match[2])
if (
  /^\s*import\s/mu.test(preloadBundle)
  || requiredModules.length !== 1
  || requiredModules[0] !== 'electron'
) {
  throw new Error('sandboxed preload must be emitted as a CommonJS bundle')
}
await execFile(process.execPath, ['--check', preloadBundlePath])
