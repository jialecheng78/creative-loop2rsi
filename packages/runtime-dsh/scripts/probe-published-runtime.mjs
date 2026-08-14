import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const runtimeEntry = require.resolve('@deepseek-ai/dsh-sdk-jsonrpc-demo/bin')
const config = resolve(packageRoot, 'profiles/studio.cordis.yml')
const work = await mkdtemp(join(tmpdir(), 'creative-rsi-dsh-probe-'))
const appOwnedDshHome = join(work, 'app-runtime', 'dsh-home', 'production')
const child = spawn(process.execPath, [runtimeEntry, config], {
  cwd: work,
  env: {
    PATH: process.env.PATH,
    CREATIVE_RSI_GATEWAY_URL: 'http://127.0.0.1:43123',
    CREATIVE_RSI_GATEWAY_TOKEN: 'probe-capability-not-a-provider-key',
    DSH_CWD: work,
    DSH_HOME: appOwnedDshHome,
    HOME: join(work, 'forbidden-parent-home'),
    DSH_TELEMETRY_DISABLED: '1',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
})

let stderr = ''
let stdout = ''
let initialized = false
child.stderr.setEncoding('utf8')
child.stderr.on('data', chunk => { stderr += chunk })
child.stdout.setEncoding('utf8')
child.stdout.on('data', chunk => {
  stdout += chunk
  for (;;) {
    const newline = stdout.indexOf('\n')
    if (newline < 0) break
    const line = stdout.slice(0, newline)
    stdout = stdout.slice(newline + 1)
    if (line === '') continue
    const frame = JSON.parse(line)
    if (frame.id === 1) {
      initialized = frame.result?.serverInfo?.name === 'deepseek-harness-sdk-runtime'
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'shutdown', params: {} })}\n`)
    }
  }
})

const timer = setTimeout(() => child.kill('SIGKILL'), 15_000)
child.stdin.write(`${JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    cwd: work,
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    maxTokens: 128,
  },
})}\n`)

const code = await new Promise(resolveExit => child.once('exit', resolveExit))
clearTimeout(timer)
const createdEntries = await readdir(work, { recursive: true })
const wroteSessionTranscript = createdEntries.some(entry => /(?:^|[/\\])session\.jsonl(?:\.zstd)?$/u.test(entry))
const escapedAnonymousId = createdEntries.some(entry =>
  /(?:^|[/\\])\.anonymous-user-id$/u.test(entry)
  && resolve(work, entry) !== join(appOwnedDshHome, '.anonymous-user-id'))
await rm(work, { recursive: true, force: true })
if (!initialized || code !== 0 || wroteSessionTranscript || escapedAnonymousId) {
  process.stderr.write(`DSH published runtime probe failed: exit=${String(code)} ${stderr.slice(0, 1000)}\n`)
  process.exitCode = 1
} else {
  process.stdout.write('DSH published runtime probe passed.\n')
}
