import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'

const EXPECTED_NODE = 'v24.19.0'
const EXPECTED_PNPM = '11.7.0'
const PRODUCT_NAME = 'Creative RSI Studio'
const APP_ID = 'org.creativeloop2rsi.studio'

export async function buildPreview(options) {
  const root = resolve(options.root)
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  assertSupported(platform, arch)
  await assertRegularDirectory(root, 'repository root')
  await assertCleanGitTree(root)
  if (process.version !== EXPECTED_NODE) {
    throw new Error(`preview build requires Node ${EXPECTED_NODE}; observed ${process.version}`)
  }
  const pnpmCli = process.env.npm_execpath
  if (pnpmCli === undefined || !isAbsolute(pnpmCli)) {
    throw new Error('preview build must run from the pinned pnpm script')
  }
  await assertRegularFile(pnpmCli, 'pnpm CLI')
  const observedPnpm = (await run(process.execPath, [pnpmCli, '--version'], { cwd: root })).stdout.trim()
  if (observedPnpm !== EXPECTED_PNPM) {
    throw new Error(`preview build requires pnpm ${EXPECTED_PNPM}; observed ${observedPnpm}`)
  }

  const source = await sourceIdentity(root, { observedPnpm })
  const sidecarDirectory = resolve(options.sidecarDirectory ?? defaultSidecar(root, platform, arch))
  const sidecarManifest = `${sidecarDirectory}.manifest.json`
  await assertRegularDirectory(sidecarDirectory, 'controller sidecar')
  await assertRegularFile(sidecarManifest, 'controller sidecar manifest')
  const sidecarEvidence = JSON.parse(await readFile(sidecarManifest, 'utf8'))
  if (sidecarEvidence.kind !== 'ControllerSidecarBuildManifest') {
    throw new Error('controller sidecar manifest kind is invalid')
  }
  await validateSidecarEvidence(sidecarDirectory, sidecarEvidence, {
    root, source, platform, arch,
  })

  const outputRoot = resolve(options.outputRoot ?? previewOutputPath(root, platform, arch))
  if (await exists(outputRoot)) throw new Error(`refusing to overwrite preview target: ${outputRoot}`)
  await mkdir(dirname(outputRoot), { recursive: true })
  const stagingRoot = await mkdtemp(join(tmpdir(), 'creative-rsi-preview-build-'))
  try {
    const workspace = join(stagingRoot, 'workspace')
    await copyTrackedWorkspace(root, workspace)
    for (const generated of [
      'apps/desktop/dist',
      'packages/controller-bridge/dist',
      'packages/model-gateway/dist',
      'packages/runtime-dsh/dist',
    ]) {
      const sourceDirectory = join(root, generated)
      await assertRegularDirectory(sourceDirectory, `generated ${generated}`)
      await cp(sourceDirectory, join(workspace, generated), { recursive: true, verbatimSymlinks: true })
    }
    await run(process.execPath, [pnpmCli, 'install', '--frozen-lockfile'], {
      cwd: workspace,
      timeoutMs: 300_000,
      env: { ...process.env, CI: 'true' },
    })
    const electronPackageLink = join(workspace, 'apps', 'desktop', 'node_modules', 'electron')
    const electronPackage = await realpath(electronPackageLink)
    const realWorkspace = await realpath(workspace)
    if (!inside(realWorkspace, electronPackage)) throw new Error('Electron package escapes fresh workspace')
    const electronPackageJson = JSON.parse(await readFile(join(electronPackage, 'package.json'), 'utf8'))
    if (electronPackageJson.name !== 'electron' || electronPackageJson.version !== '43.4.0') {
      throw new Error('fresh workspace resolved an unexpected Electron package')
    }
    const electronInstaller = join(electronPackage, 'install.js')
    await assertRegularFile(electronInstaller, 'Electron installer')
    await run(process.execPath, [electronInstaller], {
      cwd: electronPackage,
      timeoutMs: 300_000,
      env: { ...process.env, CI: 'true' },
    })
    const deployed = join(stagingRoot, 'deployed-app')
    await run(process.execPath, [
      pnpmCli,
      '--filter',
      '@creative-loop2rsi/desktop',
      'deploy',
      '--prod',
      '--legacy',
      deployed,
    ], { cwd: workspace, timeoutMs: 300_000, env: { ...process.env, CI: 'true' } })
    await reduceDeployedApp(deployed)

    const electronDist = join(electronPackage, 'dist')
    await assertRegularDirectory(electronDist, 'Electron distribution')
    const bundle = platform === 'darwin'
      ? await stageMacBundle(electronDist, stagingRoot, deployed, sidecarDirectory, source, root)
      : await stageWindowsBundle(electronDist, stagingRoot, deployed, sidecarDirectory, source, root)
    const inventory = await inventoryTree(bundle)
    const treeSha256 = sha256(Buffer.from(JSON.stringify(inventory), 'utf8'))
    await rename(bundle, outputRoot)
    const manifestPath = `${outputRoot}.manifest.json`
    await writeJson(manifestPath, {
      schema_version: '1',
      kind: 'StudioPreviewBuildManifest',
      product: PRODUCT_NAME,
      app_id: APP_ID,
      source,
      platform: { os: platform, arch },
      unsigned: true,
      packaged_path: basename(outputRoot),
      file_count: inventory.length,
      tree_sha256: treeSha256,
      files: inventory,
      controller_sidecar_manifest_sha256: sha256(await readFile(sidecarManifest)),
    })
    return { outputRoot, manifestPath, source, inventory, treeSha256 }
  } finally {
    await rm(stagingRoot, { force: true, recursive: true })
  }
}

export function previewOutputPath(root, platform, arch) {
  const target = platform === 'darwin'
    ? `${PRODUCT_NAME}.app`
    : `${PRODUCT_NAME}-win32-x64`
  return join(resolve(root), 'dist', 'studio-preview', `${platform}-${arch}`, target)
}

export async function inventoryTree(root) {
  const resolvedRoot = resolve(root)
  const rootInfo = await lstat(resolvedRoot)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('inventory root must be a regular directory')
  const result = []
  async function visit(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name)
      const info = await lstat(path)
      const relativePath = relative(resolvedRoot, path).split(sep).join('/')
      if (info.isSymbolicLink()) {
        const target = await readlink(path)
        const resolvedTarget = resolve(dirname(path), target)
        if (!inside(resolvedRoot, resolvedTarget)) throw new Error(`symlink escapes preview root: ${relativePath}`)
        result.push({ path: relativePath, type: 'symlink', target })
      } else if (info.isDirectory()) {
        await visit(path)
      } else if (info.isFile()) {
        result.push({ path: relativePath, type: 'file', bytes: info.size, sha256: sha256(await readFile(path)) })
      } else {
        throw new Error(`unsupported preview entry: ${relativePath}`)
      }
    }
  }
  await visit(resolvedRoot)
  return result
}

export async function validateSidecarEvidence(directory, evidence, options) {
  const expectedPlatform = options.platform === 'darwin'
    ? { system: 'Darwin', machine: 'arm64' }
    : { system: 'Windows', machine: 'AMD64' }
  const acceptedMachines = options.platform === 'darwin' ? ['arm64'] : ['AMD64', 'x86_64']
  if (evidence?.kind !== 'ControllerSidecarBuildManifest'
    || evidence?.platform?.system !== expectedPlatform.system
    || !acceptedMachines.includes(evidence?.platform?.machine)
    || typeof evidence?.python !== 'string'
    || !evidence.python.startsWith('3.11.')
    || evidence?.pyinstaller !== '6.22.0'
    || evidence?.source?.git_commit !== options.source.git_commit
    || evidence?.source?.git_tree !== options.source.git_tree) {
    throw new Error('controller sidecar source or platform identity is invalid')
  }
  const builder = join(options.root, 'tools', 'build_controller_sidecar.py')
  const requirements = join(options.root, 'python', 'requirements-build-hashed.txt')
  if (evidence.source.builder_sha256 !== sha256(await readFile(builder))
    || evidence.source.requirements_sha256 !== sha256(await readFile(requirements))) {
    throw new Error('controller sidecar builder identity is invalid')
  }
  const tracked = (await run('git', [
    'ls-files', '-z', '--', 'python', 'skills/creative-loop2rsi',
  ], { cwd: options.root })).stdout.split('\0').filter(Boolean).sort()
  const sourceInputs = evidence.source.inputs
  if (sourceInputs === null || typeof sourceInputs !== 'object' || Array.isArray(sourceInputs)
    || JSON.stringify(Object.keys(sourceInputs).sort()) !== JSON.stringify(tracked)) {
    throw new Error('controller sidecar source input inventory is invalid')
  }
  for (const relativePath of tracked) {
    const path = join(options.root, relativePath)
    await assertRegularFile(path, `sidecar source ${relativePath}`)
    if (sourceInputs[relativePath] !== sha256(await readFile(path))) {
      throw new Error(`controller sidecar source hash differs: ${relativePath}`)
    }
  }
  const actual = await inventoryTree(directory)
  const declaredFiles = evidence.files
  if (declaredFiles === null || typeof declaredFiles !== 'object' || Array.isArray(declaredFiles)) {
    throw new Error('controller sidecar file inventory is invalid')
  }
  const declared = Object.entries(declaredFiles).map(([path, value]) => value?.type === 'file'
    ? { path, type: 'file', bytes: value.bytes, sha256: value.sha256 }
    : { path, type: 'symlink', target: value?.target })
    .sort((left, right) => left.path === right.path ? 0 : left.path < right.path ? -1 : 1)
  if (JSON.stringify(declared) !== JSON.stringify(actual)) {
    throw new Error('controller sidecar bytes differ from its manifest')
  }
}

async function stageMacBundle(electronDist, stagingRoot, deployed, sidecar, source, root) {
  const sourceBundle = join(electronDist, 'Electron.app')
  await assertRegularDirectory(sourceBundle, 'Electron.app')
  const bundle = join(stagingRoot, `${PRODUCT_NAME}.app`)
  await cp(sourceBundle, bundle, { recursive: true, verbatimSymlinks: true })
  const contents = join(bundle, 'Contents')
  const resources = join(contents, 'Resources')
  await rm(join(resources, 'default_app.asar'), { force: true })
  const oldExecutable = join(contents, 'MacOS', 'Electron')
  const executable = join(contents, 'MacOS', PRODUCT_NAME)
  await rename(oldExecutable, executable)
  const plist = join(contents, 'Info.plist')
  for (const [key, value] of [
    ['CFBundleDisplayName', PRODUCT_NAME],
    ['CFBundleExecutable', PRODUCT_NAME],
    ['CFBundleIdentifier', APP_ID],
    ['CFBundleName', PRODUCT_NAME],
    ['CFBundleShortVersionString', source.app_version],
    ['CFBundleVersion', source.app_version],
    ['LSApplicationCategoryType', 'public.app-category.productivity'],
    ['LSMinimumSystemVersion', '13.0'],
  ]) {
    await run('/usr/bin/plutil', ['-replace', key, '-string', value, plist])
  }
  await run('/usr/bin/plutil', ['-remove', 'ElectronAsarIntegrity', plist], { allowFailure: true })
  await run('/usr/bin/plutil', ['-replace', 'NSAppTransportSecurity.NSAllowsArbitraryLoads', '-bool', 'NO', plist])
  await installPayload(resources, deployed, sidecar, source, root)
  return bundle
}

async function stageWindowsBundle(electronDist, stagingRoot, deployed, sidecar, source, root) {
  const bundle = join(stagingRoot, `${PRODUCT_NAME}-win32-x64`)
  await cp(electronDist, bundle, { recursive: true, verbatimSymlinks: true })
  await rm(join(bundle, 'resources', 'default_app.asar'), { force: true })
  await rename(join(bundle, 'electron.exe'), join(bundle, `${PRODUCT_NAME}.exe`))
  await installPayload(join(bundle, 'resources'), deployed, sidecar, source, root)
  return bundle
}

async function installPayload(resources, deployed, sidecar, source, root) {
  await cp(deployed, join(resources, 'app'), { recursive: true, verbatimSymlinks: true })
  await cp(sidecar, join(resources, 'controller'), { recursive: true, verbatimSymlinks: true })
  await cp(join(root, 'LICENSE'), join(resources, 'LICENSE'))
  await cp(join(root, 'THIRD_PARTY_NOTICES.md'), join(resources, 'THIRD_PARTY_NOTICES.md'))
  await writeJson(join(resources, 'build-source.json'), source)
}

async function reduceDeployedApp(directory) {
  await removePnpmWorkspaceSelfReference(directory)
  for (const name of await readdir(directory)) {
    if (!['dist', 'node_modules', 'package.json'].includes(name)) {
      await rm(join(directory, name), { force: true, recursive: true })
    }
  }
  await removeBuildMetadata(join(directory, 'dist'))
  const raw = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  await writeJson(join(directory, 'package.json'), {
    name: raw.name,
    productName: raw.productName,
    version: raw.version,
    private: true,
    type: 'module',
    main: 'dist/main/index.js',
    dependencies: raw.dependencies,
  })
}

export async function removePnpmWorkspaceSelfReference(directory) {
  const link = join(
    directory,
    'node_modules',
    '.pnpm',
    'node_modules',
    '@creative-loop2rsi',
    'desktop',
  )
  if (!(await exists(link))) return false
  const info = await lstat(link)
  if (!info.isSymbolicLink()) {
    throw new Error('pnpm desktop self-reference must be a symlink')
  }
  const target = await readlink(link)
  const targetParts = target.split(/[\\/]+/).filter(Boolean)
  if (isAbsolute(target)
    || targetParts.length < 2
    || targetParts.at(-2) !== 'apps'
    || targetParts.at(-1) !== 'desktop') {
    throw new Error('pnpm desktop self-reference target is unexpected')
  }
  await rm(link)
  return true
}

async function removeBuildMetadata(directory) {
  for (const name of await readdir(directory)) {
    const path = join(directory, name)
    const info = await lstat(path)
    if (info.isDirectory()) await removeBuildMetadata(path)
    else if (name.endsWith('.map') || name.endsWith('.d.ts')) await rm(path, { force: true })
  }
}

async function sourceIdentity(root, { observedPnpm }) {
  const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
  const tree = (await run('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root })).stdout.trim()
  const packageJson = JSON.parse(await readFile(join(root, 'apps', 'desktop', 'package.json'), 'utf8'))
  const profile = join(root, 'packages', 'runtime-dsh', 'profiles', 'studio.cordis.yml')
  return {
    schema_version: '1',
    kind: 'StudioPreviewSourceIdentity',
    git_commit: head,
    git_tree: tree,
    app_version: packageJson.version,
    node: process.version,
    pnpm: observedPnpm,
    electron: packageJson.devDependencies.electron,
    dsh: '0.1.0-rc.6',
    pnpm_lock_sha256: sha256(await readFile(join(root, 'pnpm-lock.yaml'))),
    runtime_profile_sha256: sha256(await readFile(profile)),
  }
}

async function copyTrackedWorkspace(root, target) {
  await mkdir(target, { recursive: true })
  const listed = await run('git', ['ls-files', '-z'], { cwd: root })
  for (const relativePath of listed.stdout.split('\0').filter(Boolean)) {
    const source = join(root, relativePath)
    const destination = join(target, relativePath)
    const info = await lstat(source)
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`tracked preview input must be a regular file: ${relativePath}`)
    }
    await mkdir(dirname(destination), { recursive: true })
    await cp(source, destination)
  }
}

async function assertCleanGitTree(root) {
  const status = (await run('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root })).stdout
  if (status !== '') throw new Error('preview build requires a clean tracked and untracked source tree')
}

function defaultSidecar(root, platform, arch) {
  if (platform === 'darwin' && arch === 'arm64') return join(root, 'dist', 'controller-sidecar-macos-arm64')
  return join(root, 'dist', 'controller-sidecar-windows-x64')
}

function assertSupported(platform, arch) {
  if (!((platform === 'darwin' && arch === 'arm64') || (platform === 'win32' && arch === 'x64'))) {
    throw new Error(`unsupported preview target: ${platform}/${arch}`)
  }
}

async function assertRegularDirectory(path, label) {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a regular directory`)
}

async function assertRegularFile(path, label) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file`)
}

async function exists(path) {
  try { await lstat(path); return true } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function inside(root, target) {
  const value = relative(root, target)
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value))
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function run(command, args, options = {}) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    const timeout = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 60_000)
    child.stdout.on('data', chunk => stdout.push(chunk))
    child.stderr.on('data', chunk => stderr.push(chunk))
    child.once('error', rejectPromise)
    child.once('close', code => {
      clearTimeout(timeout)
      const result = { code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }
      if (code !== 0 && options.allowFailure !== true) {
        rejectPromise(new Error(`${basename(command)} failed with exit ${code}: ${result.stderr.slice(0, 2000)}`))
      } else resolvePromise(result)
    })
  })
}
