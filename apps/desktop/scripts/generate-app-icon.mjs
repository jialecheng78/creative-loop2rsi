import { spawn } from 'node:child_process'
import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DEFAULT_SOURCE = fileURLToPath(new URL('../assets/app-icon.svg', import.meta.url))
const ICONSET_SIZES = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
]

export async function generateMacIcns(output, options = {}) {
  if (process.platform !== 'darwin') throw new Error('macOS icon generation requires Darwin')
  const source = resolve(options.source ?? DEFAULT_SOURCE)
  const target = resolve(output)
  await assertRegularFile(source, 'app icon SVG')
  await assertMissing(target, 'app icon output')
  await mkdir(dirname(target), { recursive: true })
  const work = await mkdtemp(join(tmpdir(), 'creative-rsi-icon-'))
  try {
    const master = join(work, 'master.png')
    const iconset = join(work, 'CreativeRSIStudio.iconset')
    await mkdir(iconset)
    await run('/usr/bin/sips', ['-s', 'format', 'png', source, '--out', master])
    for (const [name, size] of ICONSET_SIZES) {
      await run('/usr/bin/sips', ['-z', String(size), String(size), master, '--out', join(iconset, name)])
    }
    await run('/usr/bin/iconutil', ['--convert', 'icns', '--output', target, iconset])
    await assertRegularFile(target, 'generated app icon')
    return target
  } catch (error) {
    await rm(target, { force: true })
    throw error
  } finally {
    await rm(work, { force: true, recursive: true })
  }
}

async function assertRegularFile(path, label) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file`)
}

async function assertMissing(path, label) {
  try {
    await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  throw new Error(`${label} already exists: ${path}`)
}

async function run(command, args) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stderr = []
    child.stderr.on('data', chunk => stderr.push(chunk))
    child.once('error', rejectPromise)
    child.once('close', code => {
      if (code === 0) resolvePromise()
      else rejectPromise(new Error(`${basename(command)} failed with exit ${String(code)}: ${Buffer.concat(stderr).toString('utf8').slice(0, 2000)}`))
    })
  })
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const output = process.argv[2]
  if (output === undefined || process.argv.length !== 3) {
    throw new Error('usage: node generate-app-icon.mjs OUTPUT.icns')
  }
  const generated = await generateMacIcns(output)
  process.stdout.write(`${JSON.stringify({ status: 'PASS', output: generated })}\n`)
}
