import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const bundle = resolve(process.argv[2] ?? '')
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('local packaged smoke currently supports macOS arm64 only')
}
const executable = join(bundle, 'Contents', 'MacOS', 'Creative RSI Studio')
if (!(await stat(executable)).isFile()) throw new Error('packaged executable is missing')
const userData = await mkdtemp(join(tmpdir(), 'creative-rsi-packaged-smoke-'))
try {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, [
      '--packaged-smoke',
      `--user-data-dir=${userData}`,
      '--disable-gpu',
    ], {
      env: minimalEnvironment(),
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    const stderr = []
    child.stderr.on('data', chunk => stderr.push(chunk))
    const timer = setTimeout(() => child.kill('SIGKILL'), 45_000)
    child.once('error', rejectPromise)
    child.once('close', code => {
      clearTimeout(timer)
      if (code === 0) resolvePromise()
      else rejectPromise(new Error(`packaged app exited ${code}: ${Buffer.concat(stderr).toString('utf8').slice(0, 1000)}`))
    })
  })
  const receipt = JSON.parse(await readFile(join(userData, 'packaged-smoke.json'), 'utf8'))
  if (receipt.status !== 'PASS'
    || receipt.packaged !== true
    || receipt.model_requests !== 0
    || receipt.credential !== 'not-configured') {
    throw new Error('packaged smoke receipt is invalid')
  }
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
} finally {
  await rm(userData, { force: true, recursive: true })
}

function minimalEnvironment() {
  const allowed = ['LANG', 'LC_ALL', 'LC_CTYPE', 'PATH', 'SHELL', 'TMPDIR', 'TZ']
  return Object.fromEntries(allowed.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]))
}
