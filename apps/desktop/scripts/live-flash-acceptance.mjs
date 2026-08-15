#!/usr/bin/env node

import { spawnSync, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, readFileSync } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const SCRIPT_DIR = dirname(SCRIPT_PATH)
const REPOSITORY_ROOT = resolve(SCRIPT_DIR, '..', '..', '..')
const MAX_KEY_FILE_BYTES = 4 * 1024
const FLASH_MODEL = 'deepseek-v4-flash'
const TERMINAL_TIMEOUT_MS = 240_000

if (process.versions.electron === undefined) {
  try {
    await runLauncher()
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: 'BLOCK', error: publicError(error) })}\n`)
    process.exitCode = 1
  }
} else {
  await runElectronPhase()
}

async function runLauncher() {
  const keyFile = requiredOption('--key-file')
  const keepTemporary = process.argv.includes('--keep-temp')
  const keyInfo = await lstat(keyFile)
  if (!keyInfo.isFile() || keyInfo.isSymbolicLink()) throw new Error('key file must be a regular file')
  if (keyInfo.size <= 0 || keyInfo.size > MAX_KEY_FILE_BYTES) throw new Error('key file size is invalid')
  if (process.platform !== 'win32' && (keyInfo.mode & 0o077) !== 0) {
    throw new Error('key file permissions must be 0600 or stricter')
  }

  const require = createRequire(import.meta.url)
  const electronBinary = require('electron')
  const sourceBefore = sourceIdentity()
  if (!sourceBefore.working_tree_clean) {
    throw new Error('live acceptance requires a clean committed worktree')
  }
  const stateDirectory = await mkdtemp(join(tmpdir(), 'creative-rsi-flash-live-'))
  let finalReport
  let keyHandle
  try {
    await chmod(stateDirectory, 0o700)
    keyHandle = await open(keyFile, 'r')
    const produced = runPhase(electronBinary, 'produce', stateDirectory, keyHandle.fd)
    await keyHandle.close()
    keyHandle = undefined
    if (produced.status !== 'PASS') throw phaseError('produce', produced)

    const restarted = runPhase(electronBinary, 'restart', stateDirectory)
    if (restarted.status !== 'PASS') throw phaseError('restart', restarted)

    const sourceAfter = sourceIdentity()
    if (JSON.stringify(sourceBefore) !== JSON.stringify(sourceAfter)) {
      throw new Error('repository changed during live acceptance')
    }
    finalReport = {
      status: 'PASS',
      test: 'creative-rsi-studio-flash-live-acceptance',
      source: sourceAfter,
      credential: produced.credential,
      model_discovery: produced.model_discovery,
      success: produced.success,
      cancellation: produced.cancellation,
      restart: restarted.restart,
      privacy: {
        ...produced.privacy,
        restart_plaintext_key_matches: restarted.privacy.plaintext_key_matches,
        restart_session_artifacts: restarted.privacy.session_artifacts,
      },
      limitations: [
        'renderer-preload-ipc-not-exercised',
        'pro-model-not-called',
        'os-network-sandbox-not-present',
        'installer-not-exercised',
      ],
    }
  } finally {
    await keyHandle?.close().catch(() => undefined)
    if (!keepTemporary) await removeValidatedTemporaryDirectory(stateDirectory)
  }
  process.stdout.write(`${JSON.stringify(finalReport)}\n`)
}

function runPhase(electronBinary, phase, stateDirectory, keyFd) {
  const args = [SCRIPT_PATH, '--phase', phase, '--state-directory', stateDirectory]
  const stdio = keyFd === undefined
    ? ['ignore', 'pipe', 'pipe']
    : ['ignore', 'pipe', 'pipe', keyFd]
  const result = spawnSync(electronBinary, args, {
    cwd: REPOSITORY_ROOT,
    env: launcherEnvironment(),
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    stdio,
    timeout: 720_000,
  })
  const report = parseLastJsonLine(result.stdout)
  if (result.error !== undefined) throw new Error(`electron ${phase} failed to launch`)
  if (report === null) {
    throw new Error(`electron ${phase} failed without a valid report`)
  }
  if (result.status !== 0 && report.status !== 'BLOCK') {
    throw new Error(`electron ${phase} exited inconsistently`)
  }
  return report
}

async function runElectronPhase() {
  const phase = requiredOption('--phase')
  const stateDirectory = resolve(requiredOption('--state-directory'))
  if (!stateDirectory.startsWith(resolve(tmpdir()) + '/creative-rsi-flash-live-')) {
    throw new Error('state directory is outside the acceptance namespace')
  }
  const { app, safeStorage } = await import('electron')
  app.setName('Creative RSI Studio Live Acceptance')
  app.setPath('userData', stateDirectory)
  await app.whenReady()
  try {
    const report = phase === 'produce'
      ? await producePhase({ app, safeStorage, stateDirectory })
      : phase === 'restart'
        ? await restartPhase({ app, safeStorage, stateDirectory })
        : fail('unknown acceptance phase')
    await writeElectronReport(app, report, 0)
  } catch (error) {
    await writeElectronReport(app, {
      status: 'BLOCK',
      error: publicError(error),
    }, 1)
  }
}

async function producePhase({ app, safeStorage, stateDirectory }) {
  let sourceBuffer
  try {
    sourceBuffer = readFileSync(3)
  } finally {
    closeSync(3)
  }
  let apiKey = extractApiKey(sourceBuffer.toString('utf8'))
  const keyBytes = Buffer.from(apiKey, 'utf8')
  const context = await createLiveContext({ app, safeStorage, stateDirectory })
  try {
    if (!safeStorage.isEncryptionAvailable()) fail('Electron safeStorage is unavailable')
    const configured = await context.service.configureCredential(apiKey)
    apiKey = ''
    if (!configured.configured || !configured.secureStorageAvailable) fail('credential was not securely configured')

    const selected = await context.service.selectModel(FLASH_MODEL)
    if (selected.selectedModel !== FLASH_MODEL) fail('Flash model selection did not persist')
    const system = await context.service.createSystem({
      displayName: '真实 Flash 验收系统',
      intent: '创作克制、可信、用行动推进的中文微型悬疑故事。',
    })
    const work = await context.service.startWork(
      '写一篇 180 至 260 个汉字的完整微型悬疑故事。只输出正文；用可见动作和细节推进，结尾要完成一次合理反转。',
    )
    const terminal = await waitForStudioTerminal(context, work.runId)
    if (terminal.state !== 'completed') fail(`successful work ended as ${terminal.state}`)
    if (context.runtimeFailure !== undefined) throw context.runtimeFailure

    const reviewSnapshot = await context.service.systemSnapshot()
    const original = reviewSnapshot?.lastWork
    if (original === null || original === undefined || original.runId !== work.runId) {
      fail('completed work is absent from Controller snapshot')
    }
    if (original.output.trim() === '' || original.sealed) fail('completed work review state is invalid')
    const projectDirectory = join(stateDirectory, 'systems', system.systemId)
    const provenancePath = await oneFileNamed(
      join(projectDirectory, 'creative-system', 'runs', work.runId),
      'runtime-provenance.json',
    )
    const provenanceBytes = await readFile(provenancePath)
    const provenance = JSON.parse(provenanceBytes.toString('utf8'))
    validateSuccessfulProvenance(provenance, original, provenanceBytes)

    const editedOutput = `${original.output}\n\n【用户验收编辑：保留这个结尾。】`
    const feedback = await context.service.submitFeedback({
      runId: work.runId,
      action: 'edit',
      editedText: editedOutput,
      feedbackText: '验证用户直接编辑可封存并跨进程恢复。',
    })
    if (feedback.outcome !== 'submitted') fail('feedback was not submitted')
    const sealed = feedback.snapshot.lastWork
    if (sealed === null || !sealed.sealed || sealed.output !== editedOutput) {
      fail('edited work was not sealed exactly')
    }
    if (sealed.artifactSha256 !== sha256Text(editedOutput)) {
      fail('sealed edited artifact hash differs from the exact user revision')
    }
    const manifestPath = await oneFileNamed(
      join(projectDirectory, 'creative-system', 'runs', work.runId),
      'manifest.json',
    )
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (manifest.quality_status !== 'NOT_EVALUATED') fail('human edit was misreported as machine quality PASS')

    const successLease = context.loopback.leases[0]
    if (successLease === undefined) fail('successful model lease is absent')
    const successLedger = successLease.provenance()
    const cancelWork = await context.service.startWork(
      '写一篇超过一万字的连续叙事长篇，不要提前结束；这是取消边界验收，模型开始返回后会立即停止。',
    )
    const cancelLease = context.loopback.leases[1]
    if (cancelLease === undefined) fail('cancellation model lease is absent')
    await waitUntil(() => cancelLease.provenance().requests.some(item => item.status === 'STARTED'), 30_000)
    await context.service.cancelWork(cancelWork.runId)
    const cancelTerminal = await waitForStudioTerminal(context, cancelWork.runId)
    if (cancelTerminal.state !== 'cancelled') fail('cancelled work did not end as cancelled')
    const cancelLedger = cancelLease.provenance()
    const cancelErrorCodes = cancelLedger.requests.map(item => item.errorCode).filter(Boolean)
    if (cancelLedger.requestCount < 1
      || cancelLedger.completedRequests !== 0
      || cancelLedger.requests.some(item => item.status === 'STARTED')
      || cancelLedger.failedRequests < 1
      || !cancelErrorCodes.includes('LEASE_REVOKED')) {
      fail('cancelled request ledger is incomplete')
    }
    const countAfterCancel = cancelLedger.requestCount
    await delay(5_000)
    if (cancelLease.provenance().requestCount !== countAfterCancel) fail('model requests continued after cancellation')
    const cancelledSnapshot = await context.service.systemSnapshot()
    if (cancelledSnapshot?.lastWork?.runId !== work.runId
      || cancelledSnapshot.lastWork.output !== editedOutput
      || cancelledSnapshot.interruptedRun?.runId !== cancelWork.runId) {
      fail('cancellation damaged the sealed work or lost interrupted-run evidence')
    }

    await writePrivateJson(join(stateDirectory, 'live-acceptance-expected.json'), {
      system_id: system.systemId,
      run_id: work.runId,
      work_id: sealed.workId,
      edited_sha256: sha256Text(editedOutput),
      artifact_sha256: sealed.artifactSha256,
      runtime_provenance_sha256: sealed.runtimeProvenanceSha256,
      review_subject_sha256: sealed.reviewSubjectSha256,
      interrupted_run_id: cancelWork.runId,
      selected_model: FLASH_MODEL,
    })
    await context.service.shutdown()
    context.shutdown = true

    const privacy = await privacyEvidence(stateDirectory, keyBytes)
    const repositoryMatches = await publicRepositoryKeyMatches(keyBytes)
    if (privacy.plaintext_key_matches !== 0 || repositoryMatches !== 0) fail('plaintext key was persisted')
    if (privacy.session_artifacts !== 0 || privacy.raw_reasoning_fields !== 0) fail('reasoning/session data was persisted')
    if (Object.values(process.env).some(value => value?.includes(keyBytes.toString('utf8')))
      || process.argv.some(value => value.includes(keyBytes.toString('utf8')))) {
      fail('plaintext key entered argv or environment')
    }
    const encryptedFileMode = await fileMode(join(stateDirectory, 'deepseek-api-key.enc'))
    if (process.platform !== 'win32' && encryptedFileMode !== '600') {
      fail('encrypted credential file permissions are not private')
    }

    return {
      status: 'PASS',
      credential: {
        source: 'external-file-descriptor',
        source_mode: '0600',
        safe_storage_live_verified: true,
        plaintext_loaded_to_env: false,
        encrypted_file_mode: encryptedFileMode,
      },
      model_discovery: {
        official_models_endpoint_verified: true,
        required_models_available: [FLASH_MODEL, 'deepseek-v4-pro'],
      },
      success: {
        selected_model: FLASH_MODEL,
        requested_model: provenance.requested_model,
        returned_model: provenance.returned_model,
        system_fingerprint: provenance.system_fingerprint,
        response_id_sha256: sha256Text(provenance.response_id),
        usage: provenance.usage,
        request_count: provenance.request_count,
        completed_requests: provenance.completed_requests,
        failed_requests: provenance.failed_requests,
        sse_done_verified: true,
        dsh_version: provenance.dsh_version,
        profile_sha256: provenance.profile_sha256,
        controller_authority: provenance.authority,
        reasoning_content_persisted: provenance.reasoning_content_persisted,
        output_utf8_bytes: Buffer.byteLength(original.output, 'utf8'),
        output_sha256: sha256Text(original.output),
        edited_output_sha256: sha256Text(editedOutput),
        sealed: sealed.sealed,
        quality_status: manifest.quality_status,
        normalized_events: summarizeEvents(context.studioEvents, work.runId),
        gateway_ledger: summarizeLedger(successLedger),
      },
      cancellation: {
        run_state: cancelTerminal.state,
        request_count: cancelLedger.requestCount,
        completed_requests: cancelLedger.completedRequests,
        failed_requests: cancelLedger.failedRequests,
        error_codes: cancelErrorCodes,
        no_new_requests_after_five_seconds: true,
        sealed_work_preserved: true,
        interrupted_run_linked: true,
      },
      privacy: {
        ...privacy,
        public_repository_plaintext_key_matches: repositoryMatches,
        argv_plaintext_key_matches: 0,
        environment_plaintext_key_matches: 0,
      },
    }
  } finally {
    apiKey = ''
    sourceBuffer.fill(0)
    keyBytes.fill(0)
    if (!context.shutdown) await context.service.shutdown().catch(() => undefined)
  }
}

async function restartPhase({ app, safeStorage, stateDirectory }) {
  const originalFetch = globalThis.fetch
  let modelFetchAttempts = 0
  globalThis.fetch = async () => {
    modelFetchAttempts += 1
    throw new Error('model API access is forbidden during restart recovery')
  }
  const context = await createLiveContext({ app, safeStorage, stateDirectory })
  let decrypted = ''
  let keyBytes = Buffer.alloc(0)
  try {
    decrypted = await context.credentials.get() ?? ''
    if (decrypted === '') fail('safeStorage credential did not survive process restart')
    keyBytes = Buffer.from(decrypted, 'utf8')
    decrypted = ''
    const expected = JSON.parse(await readFile(join(stateDirectory, 'live-acceptance-expected.json'), 'utf8'))
    const status = await context.service.getStatus()
    const work = status.activeSystem?.lastWork
    if (status.credential !== 'configured'
      || status.selectedModel !== FLASH_MODEL
      || status.activeSystem?.systemId !== expected.system_id
      || work?.runId !== expected.run_id
      || work.workId !== expected.work_id
      || !work.sealed
      || sha256Text(work.output) !== expected.edited_sha256
      || work.artifactSha256 !== expected.artifact_sha256
      || work.runtimeProvenanceSha256 !== expected.runtime_provenance_sha256
      || work.reviewSubjectSha256 !== expected.review_subject_sha256
      || status.activeSystem?.interruptedRun?.runId !== expected.interrupted_run_id
      || status.activeSystem.feedbackRecoveryRequired
      || status.activeSystem.pendingFeedback !== null) {
      fail('cross-process restored snapshot differs from the sealed evidence')
    }
    if (modelFetchAttempts !== 0 || context.loopback.leases.length !== 0) {
      fail('restart recovery attempted a model request')
    }
    await context.service.shutdown()
    context.shutdown = true
    const privacy = await privacyEvidence(stateDirectory, keyBytes)
    if (privacy.plaintext_key_matches !== 0 || privacy.session_artifacts !== 0 || privacy.raw_reasoning_fields !== 0) {
      fail('restart privacy scan failed')
    }
    return {
      status: 'PASS',
      restart: {
        new_electron_process: true,
        credential_decryption_verified: true,
        selected_model: status.selectedModel,
        sealed_work_sha256_equal: true,
        governance_hashes_equal: true,
        interrupted_run_link_equal: true,
        model_api_fetch_attempts: modelFetchAttempts,
        model_gateway_leases_issued: context.loopback.leases.length,
      },
      privacy,
    }
  } finally {
    decrypted = ''
    keyBytes.fill(0)
    if (!context.shutdown) await context.service.shutdown().catch(() => undefined)
    globalThis.fetch = originalFetch
  }
}

async function createLiveContext({ app, safeStorage, stateDirectory }) {
  const [
    { loadControllerBridge },
    { EncryptedCredentialStore },
    { LoopbackModelGateway },
    { RuntimeWorkerManager },
    { SettingsStore },
    { StudioService },
  ] = await Promise.all([
    import('../dist/main/controller-loader.js'),
    import('../dist/main/credential-store.js'),
    import('../dist/main/loopback-gateway.js'),
    import('../dist/main/runtime-worker-manager.js'),
    import('../dist/main/settings-store.js'),
    import('../dist/main/studio-service.js'),
  ])
  const credentials = new EncryptedCredentialStore(stateDirectory, safeStorage)
  const settings = new SettingsStore(stateDirectory)
  const actualLoopback = new LoopbackModelGateway({ keyStore: credentials })
  const loopback = new ObservingLoopback(actualLoopback)
  await loopback.start()
  const controller = await loadControllerBridge({
    file: '/usr/bin/python3',
    fixedArguments: ['-B', '-m', 'creative_loop2rsi'],
    cwd: join(REPOSITORY_ROOT, 'python'),
  })
  const runtimeEvents = []
  const studioEvents = []
  let service
  const runtime = new RuntimeWorkerManager({
    workerPath: join(REPOSITORY_ROOT, 'apps', 'desktop', 'dist', 'worker', 'index.js'),
    onEvent: event => {
      runtimeEvents.push(eventSummary(event))
      void service?.acceptRuntimeEvent(event).catch(error => { context.runtimeFailure = error })
    },
  })
  const context = {
    app,
    credentials,
    loopback,
    runtime,
    runtimeEvents,
    studioEvents,
    runtimeFailure: undefined,
    service: undefined,
    shutdown: false,
  }
  service = new StudioService({
    appVersion: '1.0.0-alpha.1',
    userDataPath: stateDirectory,
    nodeExecutable: process.execPath,
    controller,
    credentials,
    settings,
    runtime,
    loopback,
    emit: event => studioEvents.push(eventSummary(event)),
  })
  context.service = service
  return context
}

class ObservingLoopback {
  leases = []
  constructor(actual) { this.actual = actual }
  start() { return this.actual.start() }
  close() { return this.actual.close() }
  issueLease(...args) {
    const lease = this.actual.issueLease(...args)
    this.leases.push(lease)
    return lease
  }
}

function validateSuccessfulProvenance(provenance, snapshot, provenanceBytes) {
  if (provenance.kind !== 'RuntimeProvenance'
    || provenance.requested_model !== FLASH_MODEL
    || provenance.returned_model !== FLASH_MODEL
    || typeof provenance.system_fingerprint !== 'string'
    || provenance.system_fingerprint === ''
    || typeof provenance.response_id !== 'string'
    || provenance.response_id === ''
    || provenance.dsh_version !== '0.1.0-rc.6'
    || provenance.authority !== 'main-observed-model-gateway'
    || provenance.reasoning_content_persisted !== false
    || provenance.parameters?.thinking !== 'enabled'
    || provenance.parameters?.reasoning_effort !== 'high'
    || provenance.parameters?.max_tokens !== 16_384
    || provenance.request_count !== provenance.requests?.length
    || provenance.completed_requests < 1
    || provenance.requests.some(item => item.status === 'STARTED')
    || provenance.requests.filter(item => item.status === 'COMPLETED').some(item => item.returned_model !== FLASH_MODEL)
    || !positiveUsage(provenance.usage)) {
    fail('successful RuntimeProvenance does not satisfy the live contract')
  }
  const expectedProfile = sha256FileSync(join(REPOSITORY_ROOT, 'packages', 'runtime-dsh', 'profiles', 'studio.cordis.yml'))
  if (provenance.profile_sha256 !== expectedProfile) fail('runtime profile digest differs from the trusted profile')
  if (snapshot.runtimeProvenanceSha256 !== sha256Bytes(provenanceBytes)) {
    fail('snapshot RuntimeProvenance hash differs from disk')
  }
  if (snapshot.artifactSha256 !== sha256Text(snapshot.output)) fail('snapshot artifact hash differs from output')
}

function positiveUsage(usage) {
  return usage !== null
    && typeof usage === 'object'
    && Number.isInteger(usage.prompt_tokens)
    && usage.prompt_tokens > 0
    && Number.isInteger(usage.completion_tokens)
    && usage.completion_tokens > 0
    && Number.isInteger(usage.total_tokens)
    && usage.total_tokens === usage.prompt_tokens + usage.completion_tokens
}

async function privacyEvidence(root, keyBytes) {
  const files = await allRegularFiles(root)
  let plaintextKeyMatches = 0
  let sessionArtifacts = 0
  let rawReasoningFields = 0
  for (const file of files) {
    const bytes = await readFile(file)
    if (keyBytes.length > 0 && bytes.includes(keyBytes)) plaintextKeyMatches += 1
    const name = file.toLowerCase()
    if (/session.*\.jsonl|\.zst$|checkpoint|transcript/u.test(name)) sessionArtifacts += 1
    if (bytes.includes(Buffer.from('"reasoning_content"', 'utf8'))) rawReasoningFields += 1
  }
  return {
    plaintext_key_matches: plaintextKeyMatches,
    session_artifacts: sessionArtifacts,
    raw_reasoning_fields: rawReasoningFields,
  }
}

async function publicRepositoryKeyMatches(keyBytes) {
  const output = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'buffer',
    maxBuffer: 8 * 1024 * 1024,
  })
  let matches = 0
  for (const relative of output.toString('utf8').split('\0').filter(Boolean)) {
    const file = join(REPOSITORY_ROOT, relative)
    const info = await lstat(file).catch(() => undefined)
    if (info?.isFile() !== true || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) continue
    if ((await readFile(file)).includes(keyBytes)) matches += 1
  }
  return matches
}

async function allRegularFiles(root) {
  const result = []
  const visit = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) fail('acceptance state contains a symlink')
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) result.push(path)
    }
  }
  await visit(root)
  return result
}

async function oneFileNamed(root, name) {
  const matches = (await allRegularFiles(root)).filter(path => path.endsWith(`/${name}`))
  if (matches.length !== 1) fail(`${name} count is not exactly one`)
  return matches[0]
}

async function waitForStudioTerminal(context, runId) {
  return await waitUntil(() => context.studioEvents.find(event =>
    event.type === 'state'
      && event.runId === runId
      && ['completed', 'failed', 'cancelled'].includes(event.state)), TERMINAL_TIMEOUT_MS)
}

async function waitUntil(producer, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = producer()
    if (value) return value
    await delay(20)
  }
  fail('live acceptance timed out')
}

function eventSummary(event) {
  return {
    type: event.type,
    runId: event.runId,
    ...(event.type === 'state' ? { state: event.state } : {}),
    ...(event.type === 'progress' ? { phase: event.phase } : {}),
    ...(event.type === 'error' ? { code: event.code } : {}),
    ...(event.type === 'output' ? { utf8Bytes: Buffer.byteLength(event.text, 'utf8') } : {}),
  }
}

function summarizeEvents(events, runId) {
  return events.filter(event => event.runId === runId).map(event => ({
    type: event.type,
    ...(event.state === undefined ? {} : { state: event.state }),
    ...(event.utf8Bytes === undefined ? {} : { utf8_bytes: event.utf8Bytes }),
  }))
}

function summarizeLedger(ledger) {
  return {
    request_count: ledger.requestCount,
    completed_requests: ledger.completedRequests,
    failed_requests: ledger.failedRequests,
    statuses: ledger.requests.map(item => item.status),
    returned_models: ledger.returnedModels,
  }
}

function extractApiKey(text) {
  const values = []
  for (const line of text.split(/\r?\n/u)) {
    const match = line.match(/^\s*(?:export\s+)?api_key\s*=\s*(.*?)\s*$/u)
    if (match !== null) values.push(unquote(match[1]))
  }
  if (values.length !== 1) fail('key file must contain exactly one api_key assignment')
  const value = values[0]
  if (value.length === 0 || value !== value.trim() || /[\r\n\0]/u.test(value) || Buffer.byteLength(value) > MAX_KEY_FILE_BYTES) {
    fail('api_key value is invalid')
  }
  return value
}

function unquote(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

function sourceIdentity() {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPOSITORY_ROOT, encoding: 'utf8' }).trim()
  const status = execFileSync('git', ['status', '--porcelain=v1', '-z'], { cwd: REPOSITORY_ROOT })
  const diff = execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: REPOSITORY_ROOT })
  return {
    commit,
    working_tree_clean: status.length === 0,
    working_tree_status_sha256: sha256Bytes(status),
    tracked_patch_sha256: sha256Bytes(diff),
    platform: `${process.platform}-${process.arch}`,
    electron: packageVersion('electron'),
    dsh: packageFileVersion(join(
      REPOSITORY_ROOT,
      'packages',
      'runtime-dsh',
      'node_modules',
      '@deepseek-ai',
      'dsh',
      'package.json',
    )),
  }
}

function packageVersion(name) {
  const require = createRequire(import.meta.url)
  return require(`${name}/package.json`).version
}

function packageFileVersion(path) {
  const value = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof value.version !== 'string' || value.version === '') fail('package version is unavailable')
  return value.version
}

function launcherEnvironment() {
  const result = { DSH_TELEMETRY_DISABLED: '1' }
  for (const key of ['HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'PATH', 'TEMP', 'TMP', 'TMPDIR']) {
    if (process.env[key] !== undefined) result[key] = process.env[key]
  }
  return result
}

function requiredOption(name) {
  const index = process.argv.indexOf(name)
  if (index < 0 || index + 1 >= process.argv.length) throw new Error(`missing ${name}`)
  return process.argv[index + 1]
}

function parseLastJsonLine(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]) } catch { /* keep looking */ }
  }
  return null
}

function phaseError(phase, report) {
  const code = report.error?.code ?? 'UNKNOWN'
  const message = report.error?.message ?? 'phase returned no public error message'
  return new Error(`${phase} phase blocked [${code}]: ${message}`)
}

function publicError(error) {
  return {
    name: error instanceof Error ? error.name : 'Error',
    code: typeof error?.code === 'string' ? error.code : 'LIVE_ACCEPTANCE_BLOCKED',
    message: redactError(error instanceof Error ? error.message : 'live acceptance blocked'),
  }
}

function redactError(value) {
  return value
    .replaceAll(REPOSITORY_ROOT, '[repository]')
    .replace(/\/Users\/[^/\s]+\/[^\s"'`]+/gu, '[local-path]')
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+\\[^\s"'`]+/gu, '[local-path]')
    .replace(/sk-[A-Za-z0-9_-]{8,}/gu, '[redacted]')
    .slice(0, 500)
}

async function writeElectronReport(app, value, code) {
  await new Promise(resolve => process.stdout.write(`${JSON.stringify(value)}\n`, resolve))
  app.exit(code)
}

async function writePrivateJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  await chmod(path, 0o600)
}

async function fileMode(path) {
  return (await lstat(path)).mode.toString(8).slice(-3)
}

async function removeValidatedTemporaryDirectory(path) {
  const resolved = resolve(path)
  if (!resolved.startsWith(resolve(tmpdir()) + '/creative-rsi-flash-live-')) fail('refusing unsafe temporary cleanup')
  await rm(resolved, { recursive: true, force: true })
}

function sha256FileSync(path) {
  const require = createRequire(import.meta.url)
  return createHash('sha256').update(require('node:fs').readFileSync(path)).digest('hex')
}

function sha256Text(value) { return sha256Bytes(Buffer.from(value, 'utf8')) }
function sha256Bytes(value) { return createHash('sha256').update(value).digest('hex') }
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
function fail(message) { throw new Error(message) }
