import { createHash } from 'node:crypto'
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import ts from 'typescript'

const EXPECTED_NODE = 'v24.19.0'
const EXPECTED_PNPM = '11.7.0'
const PRODUCT_NAME = 'Creative RSI Studio'
const APP_ID = 'org.creativeloop2rsi.studio'
const CONTROLLER_SIDECAR_NAME = 'creative-rsi-controller'
const PACKAGE_MANAGER_METADATA_NAMES = new Set([
  '.modules.yaml',
  '.npmrc',
  '.package-lock.json',
  '.package-map.json',
  '.pnp.cjs',
  '.pnp.data.json',
  '.pnp.loader.mjs',
  '.pnpm-debug.log',
  '.pnpmfile.cjs',
  '.pnpm-workspace-state-v1.json',
  '.yarnrc',
  '.yarnrc.yml',
  '.yarn-integrity',
  'npm-debug.log',
  'npm-shrinkwrap.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'pnpm-debug.log',
  'pnpm-workspace.yaml',
  'yarn-error.log',
  'yarn-debug.log',
  'yarn.lock',
])
const PUBLIC_REGISTRY_HOSTS = new Set([
  'npm.pkg.github.com',
  'registry.npmjs.org',
  'registry.npmmirror.com',
  'registry.yarnpkg.com',
])
const GENERIC_POSIX_HOME_PATH = /(?:^|[\s"'`<>{}\[\](),;:=])(?:\/(?:Users|home)\/[^/\u0000\s"'<>:]+|\/root(?:\/[^/\u0000\s"'<>:]+)?)(?:\/|(?=$|[\s"'<>:,}\]]))/
const GENERIC_LOCAL_URI_HOME_PATH = /(?:file|webpack):\/{3,}(?:(?:Users|home)\/[^/\u0000\s"'<>:]+|root(?:\/[^/\u0000\s"'<>:]+)?)(?:\/|(?=$|[\s"'<>:,}\]]))/i
const GENERIC_WINDOWS_HOME_PATH = /(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]+Users[\\/]+[^\\/\u0000\s"'<>:]+(?:[\\/]+|(?=$|[\s"'<>:,}\]]))/i
const POSIX_PACKAGE_STORE_PATH = /\/(?:[^/\u0000\s"'<>:]+\/)*(?:\.pnpm-store|pnpm\/store|npm-cache|npm\/cache|yarn-cache|yarn\/cache)\//i
const WINDOWS_PACKAGE_STORE_PATH = /(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]+(?:[^\\/\u0000\s"'<>:]+[\\/]+)*(?:\.pnpm-store|pnpm[\\/]+store|npm-cache|npm[\\/]+cache|yarn-cache|yarn[\\/]+cache)[\\/]+/i
const TEXT_EXTENSIONS = new Set([
  '.bat', '.cfg', '.cjs', '.cmd', '.conf', '.css', '.html', '.ini', '.js', '.json', '.lock',
  '.md', '.mjs', '.plist', '.properties', '.ps1', '.py', '.sh', '.toml', '.ts', '.tsx', '.txt', '.xml',
  '.yaml', '.yml',
])
const TEXT_BASENAMES = new Set(['license', 'notice', 'readme'])
const NON_RUNTIME_DOCUMENT_PREFIXES = [
  'authors',
  'changelog',
  'changes',
  'code-of-conduct',
  'code_of_conduct',
  'contributing',
  'contributors',
  'history',
  'readme',
  'security',
]
const NON_RUNTIME_DOCUMENT_EXTENSIONS = new Set(['adoc', 'markdown', 'md', 'rst', 'txt'])
const SOURCE_COMMENT_EXTENSIONS = new Set(['.cjs', '.css', '.js', '.mjs'])
const DEPENDENCY_TEST_DIRECTORIES = new Set(['__tests__', 'spec', 'specs', 'test', 'tests'])
const DEPENDENCY_TEST_FILE = /\.(?:spec|test)\.(?:cjs|js|mjs|ts|tsx)$/i

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
  const packageStorePath = (await run(process.execPath, [pnpmCli, 'store', 'path'], { cwd: root })).stdout.trim()
  if (!isAbsolute(packageStorePath)) throw new Error('pnpm store path must be absolute')

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
    await restoreLegacyWorkspaceRuntimeDependencies(deployed, workspace)
    await reduceDeployedApp(deployed)
    await auditPackagedTree(deployed, { platform, packageStorePaths: [packageStorePath] })
    await verifyDeployedRuntimeResolution(deployed)
    await probeDeployedRuntime(deployed)

    const electronDist = join(electronPackage, 'dist')
    await assertRegularDirectory(electronDist, 'Electron distribution')
    const bundle = platform === 'darwin'
      ? await stageMacBundle(electronDist, stagingRoot, deployed, sidecarDirectory, source, root)
      : await stageWindowsBundle(electronDist, stagingRoot, deployed, sidecarDirectory, source, root)
    const inventory = await auditPackagedTree(bundle, { platform, packageStorePaths: [packageStorePath] })
    await assertPreviewEntrypoints(bundle, platform)
    const treeSha256 = sha256(Buffer.from(JSON.stringify(inventory), 'utf8'))
    await rename(bundle, outputRoot)
    const manifestPath = `${outputRoot}.manifest.json`
    await writeJson(manifestPath, {
      schema_version: '2',
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

export async function inventoryTree(root, options = {}) {
  const resolvedRoot = resolve(root)
  const realRoot = await realpath(resolvedRoot)
  const platform = options.platform ?? process.platform
  const rootInfo = await lstat(resolvedRoot)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('inventory root must be a regular directory')
  const result = [{ path: '.', type: 'directory', mode: targetMode(rootInfo.mode, platform) }]
  async function visit(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name)
      const info = await lstat(path)
      const relativePath = relative(resolvedRoot, path).split(sep).join('/')
      if (info.isSymbolicLink()) {
        const target = await readlink(path)
        if (isAbsolute(target)) throw new Error(`symlink target must be relative: ${relativePath}`)
        let resolvedTarget
        try {
          resolvedTarget = await realpath(path)
        } catch {
          throw new Error(`symlink is broken: ${relativePath}`)
        }
        if (!inside(realRoot, resolvedTarget)) throw new Error(`symlink escapes preview root: ${relativePath}`)
        result.push({ path: relativePath, type: 'symlink', target, mode: targetMode(info.mode, platform) })
      } else if (info.isDirectory()) {
        result.push({ path: relativePath, type: 'directory', mode: targetMode(info.mode, platform) })
        await visit(path)
      } else if (info.isFile()) {
        result.push({
          path: relativePath,
          type: 'file',
          bytes: info.size,
          sha256: sha256(await readFile(path)),
          mode: targetMode(info.mode, platform),
        })
      } else {
        throw new Error(`unsupported preview entry: ${relativePath}`)
      }
    }
  }
  await visit(resolvedRoot)
  return result.sort((left, right) => left.path === right.path ? 0 : left.path < right.path ? -1 : 1)
}

export async function validateSidecarEvidence(directory, evidence, options) {
  const expectedPlatform = options.platform === 'darwin'
    ? { system: 'Darwin', machine: 'arm64' }
    : { system: 'Windows', machine: 'AMD64' }
  const acceptedMachines = options.platform === 'darwin' ? ['arm64'] : ['AMD64', 'x86_64']
  if (evidence?.schema_version !== '2'
    || evidence?.kind !== 'ControllerSidecarBuildManifest'
    || evidence?.platform?.system !== expectedPlatform.system
    || !acceptedMachines.includes(evidence?.platform?.machine)
    || typeof evidence?.python !== 'string'
    || !evidence.python.startsWith('3.11.')
    || evidence?.pyinstaller !== '6.22.0'
    || evidence?.sidecar_name !== CONTROLLER_SIDECAR_NAME
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
  const actual = await inventoryTree(directory, { platform: options.platform })
  const declaredFiles = evidence.files
  if (declaredFiles === null || typeof declaredFiles !== 'object' || Array.isArray(declaredFiles)) {
    throw new Error('controller sidecar file inventory is invalid')
  }
  const declared = Object.entries(declaredFiles).map(([path, value]) => {
    if (value?.type === 'file') {
      const validMode = options.platform === 'win32'
        ? value.mode === null
        : typeof value.mode === 'string' && /^[0-7]{4}$/.test(value.mode)
      if (Object.keys(value).sort().join(',') !== 'bytes,mode,sha256,type'
        || !Number.isSafeInteger(value.bytes)
        || value.bytes < 0
        || typeof value.sha256 !== 'string'
        || !/^[0-9a-f]{64}$/.test(value.sha256)
        || !validMode) {
        throw new Error(`controller sidecar file declaration is invalid: ${path}`)
      }
      return { path, type: 'file', bytes: value.bytes, sha256: value.sha256, mode: value.mode }
    }
    if (value?.type === 'directory') {
      const validMode = options.platform === 'win32'
        ? value.mode === null
        : typeof value.mode === 'string' && /^[0-7]{4}$/.test(value.mode)
      if (Object.keys(value).sort().join(',') !== 'mode,type' || !validMode) {
        throw new Error(`controller sidecar file declaration is invalid: ${path}`)
      }
      return { path, type: 'directory', mode: value.mode }
    }
    const validMode = options.platform === 'win32'
      ? value?.mode === null
      : typeof value?.mode === 'string' && /^[0-7]{4}$/.test(value.mode)
    if (value?.type !== 'symlink'
      || Object.keys(value).sort().join(',') !== 'mode,target,type'
      || typeof value.target !== 'string'
      || !validMode) {
      throw new Error(`controller sidecar file declaration is invalid: ${path}`)
    }
    return { path, type: 'symlink', target: value.target, mode: value.mode }
  }).sort((left, right) => left.path === right.path ? 0 : left.path < right.path ? -1 : 1)
  const executableName = options.platform === 'win32'
    ? `${CONTROLLER_SIDECAR_NAME}.exe`
    : CONTROLLER_SIDECAR_NAME
  const executable = declared.find(entry => entry.path === executableName)
  if (executable?.type !== 'file'
    || (options.platform !== 'win32' && executable.mode !== '0755')) {
    throw new Error('controller sidecar executable declaration is invalid')
  }
  if (JSON.stringify(declared) !== JSON.stringify(actual)) {
    throw new Error('controller sidecar bytes or modes differ from its manifest')
  }
}

export async function removePackageManagerMetadata(root) {
  const resolvedRoot = resolve(root)
  const rootInfo = await lstat(resolvedRoot)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error('packaged tree root must be a regular directory')
  }
  async function visit(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name)
      const info = await lstat(path)
      const relativePath = relative(resolvedRoot, path).split(sep).join('/')
      if (isPackageManagerMetadata(relativePath)) {
        await rm(path, { force: true, recursive: info.isDirectory() && !info.isSymbolicLink() })
      } else if (info.isDirectory() && !info.isSymbolicLink()) {
        await visit(path)
      }
    }
  }
  await visit(resolvedRoot)
}

export async function auditPackagedTree(root, options = {}) {
  const inventory = await inventoryTree(root, options)
  const rawLocalPathNeedles = [
    ...buildHomeNeedles(homedir()),
    ...buildAbsolutePathNeedles(options.packageStorePaths ?? []),
  ]
  for (const entry of inventory) {
    if (isPackageManagerMetadata(entry.path)) {
      throw new Error(`packaged tree contains forbidden package-manager metadata: ${entry.path}`)
    }
    if (entry.type !== 'file') continue
    const bytes = await readFile(join(resolve(root), ...entry.path.split('/')))
    if (rawLocalPathNeedles.some(needle => bytes.includes(needle))) {
      throw new Error(`packaged tree contains a local build path: ${entry.path}`)
    }
    const text = decodeStrictText(entry.path, bytes)
    if (text === null) continue
    if (GENERIC_POSIX_HOME_PATH.test(text)
      || GENERIC_LOCAL_URI_HOME_PATH.test(text)
      || GENERIC_WINDOWS_HOME_PATH.test(text)) {
      throw new Error(`packaged tree contains a generic user home path: ${entry.path}`)
    }
    if (POSIX_PACKAGE_STORE_PATH.test(text) || WINDOWS_PACKAGE_STORE_PATH.test(text)) {
      throw new Error(`packaged tree contains an absolute package-store path: ${entry.path}`)
    }
    for (const registry of registryAssignments(entry.path, text)) {
      if (!isApprovedRegistry(registry)) {
        throw new Error(`packaged tree contains unapproved registry metadata: ${entry.path}`)
      }
    }
  }
  return inventory
}

export async function assertPreviewEntrypoints(root, platform) {
  const relativePaths = platform === 'darwin'
    ? [
        join('Contents', 'MacOS', PRODUCT_NAME),
        join('Contents', 'Resources', 'controller', CONTROLLER_SIDECAR_NAME),
      ]
    : [
        `${PRODUCT_NAME}.exe`,
        join('resources', 'controller', `${CONTROLLER_SIDECAR_NAME}.exe`),
      ]
  for (const relativePath of relativePaths) {
    const path = join(resolve(root), relativePath)
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`preview executable must be a regular file: ${relativePath}`)
    }
    if (platform === 'darwin' && posixMode(info.mode) !== '0755') {
      throw new Error(`preview executable mode must be 0755: ${relativePath}`)
    }
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
  await removeRuntimeBuildMetadata(directory)
  await removePackageManagerMetadata(directory)
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

export async function restoreLegacyWorkspaceRuntimeDependencies(deployed, workspace) {
  const definitions = [
    { name: '@creative-loop2rsi/desktop', source: join(workspace, 'apps', 'desktop'), target: deployed },
    {
      name: '@creative-loop2rsi/controller-bridge',
      source: join(workspace, 'packages', 'controller-bridge'),
      target: join(deployed, 'node_modules', '@creative-loop2rsi', 'controller-bridge'),
    },
    {
      name: '@creative-loop2rsi/model-gateway',
      source: join(workspace, 'packages', 'model-gateway'),
      target: join(deployed, 'node_modules', '@creative-loop2rsi', 'model-gateway'),
    },
    {
      name: '@creative-loop2rsi/runtime-dsh',
      source: join(workspace, 'packages', 'runtime-dsh'),
      target: join(deployed, 'node_modules', '@creative-loop2rsi', 'runtime-dsh'),
    },
  ]
  const byName = new Map(definitions.map(definition => [definition.name, definition]))
  const workspaceRoot = await realpath(workspace)
  const workspaceVirtualStore = await realpath(join(workspace, 'node_modules', '.pnpm'))
  const deployedRoot = await realpath(deployed)
  const lexicalDeployedRoot = resolve(deployed)
  const deployedNodeModules = join(deployed, 'node_modules')
  const deployedVirtualStore = join(deployedNodeModules, '.pnpm')
  const replacementStore = join(deployedNodeModules, '.pnpm-fresh')
  if (await exists(replacementStore)) throw new Error('fresh virtual store target already exists')

  const manifests = new Map()
  for (const definition of definitions) {
    await assertRegularDirectory(definition.source, `workspace package ${definition.name}`)
    const manifest = JSON.parse(await readFile(join(definition.source, 'package.json'), 'utf8'))
    if (manifest.name !== definition.name
      || manifest.dependencies === null
      || (manifest.dependencies !== undefined
        && (typeof manifest.dependencies !== 'object' || Array.isArray(manifest.dependencies)))) {
      throw new Error(`workspace package manifest is invalid: ${definition.name}`)
    }
    manifests.set(definition.name, manifest)
  }

  const closure = new Set()
  const addStoreTarget = async (link, label) => {
    const info = await lstat(link)
    if (!info.isSymbolicLink()) throw new Error(`${label} is not a pnpm symlink`)
    const target = await realpath(link)
    if (!inside(workspaceVirtualStore, target)) {
      if (inside(workspaceRoot, target)) return
      throw new Error(`${label} escapes the fresh workspace`)
    }
    closure.add(relative(workspaceVirtualStore, target).split(sep)[0])
  }

  for (const definition of definitions) {
    for (const dependency of Object.keys(manifests.get(definition.name).dependencies ?? {}).sort()) {
      if (byName.has(dependency)) continue
      await addStoreTarget(
        join(definition.source, 'node_modules', ...dependency.split('/')),
        `${definition.name} dependency ${dependency}`,
      )
    }
  }

  const queued = [...closure]
  for (let index = 0; index < queued.length; index += 1) {
    const entry = queued[index]
    const nodeModules = join(workspaceVirtualStore, entry, 'node_modules')
    await assertRegularDirectory(nodeModules, `pnpm entry ${entry}`)
    for (const name of (await readdir(nodeModules)).sort()) {
      const path = join(nodeModules, name)
      const info = await lstat(path)
      const links = name.startsWith('@') && info.isDirectory() && !info.isSymbolicLink()
        ? (await readdir(path)).sort().map(child => join(path, child))
        : [path]
      for (const link of links) {
        const linkInfo = await lstat(link)
        if (!linkInfo.isSymbolicLink()) continue
        const target = await realpath(link)
        if (!inside(workspaceVirtualStore, target)) {
          if (inside(workspaceRoot, target)) continue
          throw new Error(`pnpm dependency link escapes the fresh workspace: ${link}`)
        }
        const targetEntry = relative(workspaceVirtualStore, target).split(sep)[0]
        if (!closure.has(targetEntry)) {
          closure.add(targetEntry)
          queued.push(targetEntry)
        }
      }
    }
  }

  await mkdir(replacementStore)
  for (const entry of [...closure].sort()) {
    await cp(join(workspaceVirtualStore, entry), join(replacementStore, entry), {
      recursive: true,
      verbatimSymlinks: true,
    })
  }
  const workspaceHoist = join(workspaceVirtualStore, 'node_modules')
  const replacementHoist = join(replacementStore, 'node_modules')
  await mkdir(replacementHoist)
  for (const name of (await readdir(workspaceHoist)).sort()) {
    const source = join(workspaceHoist, name)
    const info = await lstat(source)
    const links = name.startsWith('@') && info.isDirectory() && !info.isSymbolicLink()
      ? (await readdir(source)).sort().map(child => join(source, child))
      : [source]
    for (const link of links) {
      const linkInfo = await lstat(link)
      if (!linkInfo.isSymbolicLink()) continue
      const target = await realpath(link)
      if (!inside(workspaceVirtualStore, target)) continue
      const targetEntry = relative(workspaceVirtualStore, target).split(sep)[0]
      if (!closure.has(targetEntry)) continue
      const destination = join(replacementHoist, relative(workspaceHoist, link))
      await mkdir(dirname(destination), { recursive: true })
      await symlink(await readlink(link), destination)
    }
  }
  await rm(deployedVirtualStore, { force: true, recursive: true })
  await rename(replacementStore, deployedVirtualStore)

  for (const definition of definitions.filter(item => item.name !== '@creative-loop2rsi/desktop')) {
    if (!inside(lexicalDeployedRoot, resolve(definition.target))) {
      throw new Error(`workspace package target escapes deployed application: ${definition.name}`)
    }
    await rm(definition.target, { force: true, recursive: true })
    await mkdir(definition.target, { recursive: true })
    for (const name of (await readdir(definition.source)).sort()) {
      if (name === 'node_modules') continue
      await cp(join(definition.source, name), join(definition.target, name), {
        recursive: true,
        verbatimSymlinks: true,
      })
    }
  }

  for (const definition of definitions) {
    for (const dependency of Object.keys(manifests.get(definition.name).dependencies ?? {}).sort()) {
      const destination = join(definition.target, 'node_modules', ...dependency.split('/'))
      const local = byName.get(dependency)
      if (local !== undefined) {
        if (resolve(destination) !== resolve(local.target)) {
          throw new Error(`workspace dependency target differs: ${dependency}`)
        }
        await assertRegularDirectory(local.target, `deployed workspace dependency ${dependency}`)
        continue
      }
      const workspaceTarget = await realpath(join(
        definition.source,
        'node_modules',
        ...dependency.split('/'),
      ))
      const storeRelative = relative(workspaceVirtualStore, workspaceTarget)
      const deployedTarget = join(deployedVirtualStore, storeRelative)
      await assertRegularDirectory(deployedTarget, `deployed dependency ${dependency}`)
      await rm(destination, { force: true, recursive: true })
      await mkdir(dirname(destination), { recursive: true })
      await symlink(relative(dirname(destination), deployedTarget), destination)
    }
  }
}

export async function verifyDeployedRuntimeResolution(deployed) {
  const deployedRoot = await realpath(deployed)
  const runtimePackage = await realpath(join(deployed, 'node_modules', '@creative-loop2rsi', 'runtime-dsh'))
  if (!inside(deployedRoot, runtimePackage)) throw new Error('deployed runtime package escapes application root')
  const require = createRequire(join(runtimePackage, 'package.json'))
  for (const request of ['@deepseek-ai/dsh-sdk-client', '@deepseek-ai/dsh-sdk-jsonrpc-demo/bin']) {
    const resolved = require.resolve(request)
    if (!inside(deployedRoot, resolved)) throw new Error(`deployed DSH resolution escapes application root: ${request}`)
  }
}

export async function probeDeployedRuntime(deployed) {
  const runtimePackage = await realpath(join(
    deployed,
    'node_modules',
    '@creative-loop2rsi',
    'runtime-dsh',
  ))
  const require = createRequire(join(runtimePackage, 'package.json'))
  const runtimeEntry = require.resolve('@deepseek-ai/dsh-sdk-jsonrpc-demo/bin')
  const profile = join(runtimePackage, 'profiles', 'studio.cordis.yml')
  await assertRegularFile(profile, 'deployed DSH profile')
  const work = await mkdtemp(join(tmpdir(), 'creative-rsi-packaged-runtime-probe-'))
  try {
    const child = spawn(process.execPath, [runtimeEntry, profile], {
      cwd: work,
      env: {
        PATH: process.env.PATH,
        CREATIVE_RSI_GATEWAY_URL: 'http://127.0.0.1:43123',
        CREATIVE_RSI_GATEWAY_TOKEN: 'packaged-runtime-probe-capability',
        DSH_CWD: work,
        DSH_HOME: join(work, 'dsh-home'),
        DSH_TELEMETRY_DISABLED: '1',
      },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let initialized = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr += chunk })
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
          child.stdin.write(`${JSON.stringify({
            jsonrpc: '2.0', id: 2, method: 'shutdown', params: {},
          })}\n`)
        }
      }
    })
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
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000)
    const code = await new Promise(resolveExit => child.once('exit', resolveExit))
    clearTimeout(timer)
    if (!initialized || code !== 0) {
      throw new Error(`deployed DSH initialize probe failed: exit=${String(code)} ${stderr.slice(0, 500)}`)
    }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

export async function removeRuntimeBuildMetadata(directory, options = {}) {
  const dependencyTree = options.dependencyTree === true || basename(directory).toLowerCase() === 'node_modules'
  for (const name of await readdir(directory)) {
    const path = join(directory, name)
    const info = await lstat(path)
    if (info.isDirectory() && !info.isSymbolicLink()) {
      if (dependencyTree
        && !isDependencyPackageContainer(directory)
        && DEPENDENCY_TEST_DIRECTORIES.has(name.toLowerCase())) {
        await rm(path, { force: true, recursive: true })
      } else {
        await removeRuntimeBuildMetadata(path, { dependencyTree })
      }
    } else if (name.endsWith('.map')
      || name.endsWith('.d.ts')
      || name.endsWith('.d.mts')
      || name.endsWith('.d.cts')
      || (dependencyTree && DEPENDENCY_TEST_FILE.test(name))
      || (dependencyTree && isNonRuntimeDocumentation(name))) {
      await rm(path, { force: true })
    } else if (info.isFile() && SOURCE_COMMENT_EXTENSIONS.has(extensionOf(name))) {
      await removeLocalSourceComments(path)
    }
  }
}

function isDependencyPackageContainer(directory) {
  if (basename(directory).toLowerCase() === 'node_modules') return true
  return basename(directory).startsWith('@')
    && basename(dirname(directory)).toLowerCase() === 'node_modules'
}

function isNonRuntimeDocumentation(name) {
  const normalized = name.toLowerCase()
  const dot = normalized.lastIndexOf('.')
  const extension = dot < 0 ? null : normalized.slice(dot + 1)
  if (extension !== null && !NON_RUNTIME_DOCUMENT_EXTENSIONS.has(extension)) return false
  const stem = dot < 0 ? normalized : normalized.slice(0, dot)
  return NON_RUNTIME_DOCUMENT_PREFIXES.some(prefix => stem === prefix
    || stem.startsWith(`${prefix}-`)
    || stem.startsWith(`${prefix}_`)
    || stem.startsWith(`${prefix}.`))
}

async function removeLocalSourceComments(path) {
  const bytes = await readFile(path)
  if (bytes.includes(0)) return
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return
  }
  const ranges = sourceCommentRanges(text, { css: extensionOf(path) === '.css' })
  const localRanges = ranges.filter(({ pos, end }) => containsGenericHome(text.slice(pos, end)))
  if (localRanges.length === 0) return
  let sanitized = ''
  let cursor = 0
  for (const { pos, end } of localRanges) {
    sanitized += text.slice(cursor, pos)
    sanitized += normalizeCommentHomePaths(text.slice(pos, end))
    cursor = end
  }
  sanitized += text.slice(cursor)
  await replaceFileAtomically(path, sanitized)
}

function sourceCommentRanges(text, options) {
  const ranges = new Map()
  const collect = range => {
    for (const comment of range ?? []) ranges.set(`${comment.pos}:${comment.end}`, comment)
  }
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text)
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.MultiLineCommentTrivia
      || (options.css !== true && token === ts.SyntaxKind.SingleLineCommentTrivia)) {
      const comment = { pos: scanner.getTokenPos(), end: scanner.getTextPos() }
      ranges.set(`${comment.pos}:${comment.end}`, comment)
    }
  }
  if (options.css !== true) {
    const source = ts.createSourceFile(
      'runtime.js',
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    )
    const visit = node => {
      collect(ts.getLeadingCommentRanges(text, node.pos))
      collect(ts.getTrailingCommentRanges(text, node.end))
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return [...ranges.values()].sort((left, right) => left.pos - right.pos)
}

function containsGenericHome(text) {
  return GENERIC_POSIX_HOME_PATH.test(text)
    || GENERIC_LOCAL_URI_HOME_PATH.test(text)
    || GENERIC_WINDOWS_HOME_PATH.test(text)
}

function normalizeCommentHomePaths(comment) {
  const posix = /(^|[\s"'`<>{}\[\](),;:=])(\/(?:Users|home)\/[^/\u0000\s"'<>:]+|\/root)(?=\/|$|[\s"'<>:,}\]])/gim
  const localUri = /((?:file|webpack):\/{3,})(?:(?:Users|home)\/[^/\u0000\s"'<>:]+|root)(?=\/|$|[\s"'<>:,}\]])/gim
  const windows = /(^|[^A-Za-z0-9])(?:[A-Za-z]:[\\/]+Users[\\/]+[^\\/\u0000\s"'<>:]+)(?=[\\/]+|$|[\s"'<>:,}\]])/gim
  return comment
    .replace(localUri, '$1<build-home>')
    .replace(posix, '$1<build-home>')
    .replace(windows, '$1<build-home>')
}

async function replaceFileAtomically(path, content) {
  const info = await lstat(path)
  const temporaryDirectory = await mkdtemp(join(dirname(path), '.creative-rsi-sanitize-'))
  const temporaryFile = join(temporaryDirectory, basename(path))
  try {
    await writeFile(temporaryFile, content, { flag: 'wx', mode: info.mode & 0o7777 })
    await chmod(temporaryFile, info.mode & 0o7777)
    await rename(temporaryFile, path)
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true })
  }
}

function extensionOf(name) {
  const normalized = name.toLowerCase()
  const dot = normalized.lastIndexOf('.')
  return dot < 0 ? '' : normalized.slice(dot)
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

function posixMode(mode) {
  return (mode & 0o7777).toString(8).padStart(4, '0')
}

function targetMode(mode, platform) {
  return platform === 'win32' ? null : posixMode(mode)
}

function isPackageManagerMetadata(relativePath) {
  const segments = relativePath.split('/')
  const name = segments.at(-1)
  return PACKAGE_MANAGER_METADATA_NAMES.has(name)
    || /^\.pnpm-(?:workspace-)?(?:install-)?state(?:-v\d+)?\.json$/i.test(name)
    || /^(?:npm|pnpm|yarn)(?:-[\w.-]+)?-(?:debug|error)\.log(?:\.\d+)?$/i.test(name)
    || (name === 'lock.yaml' && segments.includes('.pnpm'))
}

function buildHomeNeedles(home) {
  if (!isAbsolute(home)) return []
  const normalized = home.replace(/[\\/]+$/, '')
  const slash = normalized.replace(/\\/g, '/')
  const backslash = normalized.replace(/\//g, '\\')
  return [...new Set([
    `${slash}/`,
    slash,
    `${backslash}\\`,
    backslash,
    `${backslash.replace(/\\/g, '\\\\')}\\\\`,
    backslash.replace(/\\/g, '\\\\'),
  ])].filter(value => value.length > 1).map(value => Buffer.from(value, 'utf8'))
}

function buildAbsolutePathNeedles(paths) {
  const values = []
  for (const path of paths) {
    if (typeof path !== 'string' || !isAbsolute(path)) continue
    const normalized = path.replace(/[\\/]+$/, '')
    const slash = normalized.replace(/\\/g, '/')
    const backslash = normalized.replace(/\//g, '\\')
    values.push(`${slash}/`, slash, `${backslash}\\`, backslash)
    values.push(`${backslash.replace(/\\/g, '\\\\')}\\\\`, backslash.replace(/\\/g, '\\\\'))
  }
  return [...new Set(values)].filter(value => value.length > 1).map(value => Buffer.from(value, 'utf8'))
}

function decodeStrictText(relativePath, bytes) {
  const name = basename(relativePath).toLowerCase()
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.')) : ''
  if (!TEXT_EXTENSIONS.has(extension) && !TEXT_BASENAMES.has(name)) return null
  if (bytes.includes(0)) return null
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
  return /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) ? null : text
}

function registryAssignments(relativePath, text) {
  const normalized = text.replace(/^\uFEFF/, '').replaceAll('\\/', '/').replace(/\\u002f/gi, '/')
  const name = basename(relativePath).toLowerCase()
  if (name.endsWith('.json')) {
    const values = []
    try {
      collectJsonRegistryAssignments(JSON.parse(normalized), values)
    } catch {
      return jsonConfigRegistryAssignments(normalized)
    }
    return values
  }
  if (name.endsWith('.yaml') || name.endsWith('.yml')) return yamlRegistryAssignments(normalized)
  if (name.endsWith('.toml')) return tomlRegistryAssignments(normalized)
  if (name.endsWith('.ini')
    || name.endsWith('.cfg')
    || name.endsWith('.conf')
    || name.endsWith('.properties')
    || name === '.npmrc') {
    return propertyRegistryAssignments(normalized)
  }
  if (['.js', '.ts', '.tsx', '.cjs', '.mjs', '.py', '.sh', '.ps1', '.bat', '.cmd']
    .some(extension => name.endsWith(extension))) {
    return ['.js', '.ts', '.tsx', '.cjs', '.mjs'].some(extension => name.endsWith(extension))
      ? javascriptRegistryAssignments(name, normalized)
      : lineSourceRegistryAssignments(name, normalized)
  }
  return []
}

function collectJsonRegistryAssignments(value, values) {
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) collectJsonRegistryAssignments(item, values)
    return
  }
  for (const [key, nested] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase()
    if (isDirectRegistryKey(normalizedKey)) {
      values.push(typeof nested === 'string' ? nested : '')
    } else if (normalizedKey === 'registries' && nested !== null && typeof nested === 'object') {
      const defaultValue = nested.default
      if (defaultValue !== undefined) values.push(typeof defaultValue === 'string' ? defaultValue : '')
    }
    collectJsonRegistryAssignments(nested, values)
  }
}

function jsonConfigRegistryAssignments(text) {
  const tokens = configTokens(text, { slashComments: true })
  const values = []
  for (let index = 0; index < tokens.length; index += 1) {
    const key = tokenKey(tokens[index])
    if (key === null || tokens[index + 1]?.value !== ':') continue
    if (isDirectRegistryKey(key)) {
      values.push(configTokenValue(tokens[index + 2]))
      continue
    }
    if (key !== 'registries' || tokens[index + 2]?.value !== '{') continue
    let depth = 1
    for (let nested = index + 3; nested < tokens.length && depth > 0; nested += 1) {
      if (tokens[nested].value === '{') depth += 1
      else if (tokens[nested].value === '}') depth -= 1
      else if (depth === 1
        && tokenKey(tokens[nested]) === 'default'
        && tokens[nested + 1]?.value === ':') {
        values.push(configTokenValue(tokens[nested + 2]))
      }
    }
  }
  return values
}

function yamlRegistryAssignments(text) {
  const lines = text.split(/\r?\n/)
  const values = []
  let registriesIndent = null
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^\s*(?:#.*)?$/.test(line)) continue
    const indent = leadingWhitespace(line)
    if (registriesIndent !== null && indent <= registriesIndent) registriesIndent = null

    const inline = line.match(/^\s*["']?registries["']?\s*:\s*\{\s*["']?default["']?\s*:\s*([^}]+)\}/i)
    if (inline !== null) {
      values.push(configScalar(inline[1]))
      continue
    }
    if (/^\s*["']?registries["']?\s*:\s*$/.test(line.toLowerCase())) {
      registriesIndent = indent
      continue
    }

    const direct = line.match(/^\s*(?:["']?(?:@[^:\s"']+:)?(?:registry|registry-url|registryurl|registries\.default)["']?)\s*:\s*(.*)$/i)
    const nested = registriesIndent !== null && indent > registriesIndent
      ? line.match(/^\s*["']?default["']?\s*:\s*(.*)$/i)
      : null
    const match = direct ?? nested
    if (match === null) continue
    const raw = match[1].trim()
    if (/^[>|][-+]?\s*(?:#.*)?$/.test(raw)) {
      const block = []
      let blockIndex = index + 1
      for (; blockIndex < lines.length; blockIndex += 1) {
        const blockLine = lines[blockIndex]
        if (blockLine.trim() !== '' && leadingWhitespace(blockLine) <= indent) break
        block.push(blockLine.trim())
      }
      values.push(block.filter(Boolean).join(raw.startsWith('>') ? ' ' : '\n').trim())
      index = blockIndex - 1
    } else {
      values.push(configScalar(raw))
    }
  }
  return values
}

function tomlRegistryAssignments(text) {
  const values = []
  let registriesSection = false
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(?:#.*)?$/.test(line)) continue
    const section = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/)
    if (section !== null) {
      registriesSection = unquotedConfigKey(section[1]) === 'registries'
      continue
    }
    const assignment = line.match(/^\s*((?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s=]+))\s*=\s*(.*)$/)
    if (assignment === null) continue
    const key = unquotedConfigKey(assignment[1])
    const raw = assignment[2]
    if (isDirectRegistryKey(key) || (registriesSection && key === 'default')) {
      values.push(configScalar(raw))
      continue
    }
    if (key === 'registries') {
      const inline = raw.match(/^\s*\{[\s\S]*?(?:"default"|'default'|default)\s*=\s*([^,}]+)[\s\S]*\}/i)
      if (inline !== null) values.push(configScalar(inline[1]))
    }
  }
  return values
}

function propertyRegistryAssignments(text) {
  const values = []
  let registriesSection = false
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(?:[#;].*)?$/.test(line)) continue
    const section = line.match(/^\s*\[([^\]]+)\]\s*$/)
    if (section !== null) {
      registriesSection = section[1].trim().toLowerCase() === 'registries'
      continue
    }
    const direct = line.match(/^\s*(?:@[^:\s=]+:)?(?:registry|registry-url|registryurl|registries\.default)\s*[:=]\s*(.*)$/i)
    const nested = registriesSection ? line.match(/^\s*default\s*[:=]\s*(.*)$/i) : null
    const match = direct ?? nested
    if (match !== null) values.push(configScalar(match[1]))
  }
  return values
}

function javascriptRegistryAssignments(name, text) {
  const values = []
  const scriptKind = name.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : name.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, scriptKind)
  const literal = node => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : null
  const propertyKey = node => {
    if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return node.text
    }
    if (ts.isComputedPropertyName(node)
      && (ts.isStringLiteral(node.expression) || ts.isNoSubstitutionTemplateLiteral(node.expression))) {
      return node.expression.text
    }
    return null
  }
  const assignmentKey = node => {
    if (ts.isIdentifier(node)) return node.text
    if (ts.isPropertyAccessExpression(node)) return node.name.text
    if (ts.isElementAccessExpression(node)
      && node.argumentExpression !== undefined
      && (ts.isStringLiteral(node.argumentExpression)
        || ts.isNoSubstitutionTemplateLiteral(node.argumentExpression))) {
      return node.argumentExpression.text
    }
    return null
  }
  const collectLiteral = (key, initializer) => {
    if (key === null || !isDirectRegistryKey(key)) return
    const value = initializer === undefined ? null : literal(initializer)
    if (value !== null) values.push(value)
  }
  const visit = node => {
    if (ts.isPropertyAssignment(node)) {
      const key = propertyKey(node.name)
      collectLiteral(key, node.initializer)
      if (key?.toLowerCase() === 'registries' && ts.isObjectLiteralExpression(node.initializer)) {
        for (const property of node.initializer.properties) {
          if (ts.isPropertyAssignment(property)
            && propertyKey(property.name)?.toLowerCase() === 'default') {
            const value = literal(property.initializer)
            if (value !== null) values.push(value)
          }
        }
      }
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      collectLiteral(node.name.text, node.initializer)
    } else if (ts.isPropertyDeclaration(node)) {
      collectLiteral(propertyKey(node.name), node.initializer)
    } else if (ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      collectLiteral(assignmentKey(node.left), node.right)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return values
}

function lineSourceRegistryAssignments(name, text) {
  const values = []
  const unquotedEndpoints = ['.sh', '.ps1', '.bat', '.cmd'].some(extension => name.endsWith(extension))
  const python = name.endsWith('.py')
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(?:REM\b|::)/i.test(line)) continue
    const tokens = configTokens(line, { hashComments: true })
    for (let index = 0; index < tokens.length; index += 1) {
      const key = tokenKey(tokens[index])
      if (key === null || !isDirectRegistryKey(key)) continue
      let delimiter = index + 1
      if (tokens[delimiter]?.value === '?') delimiter += 1
      if (![':', '='].includes(tokens[delimiter]?.value)) continue
      if (python && tokens[delimiter].value === ':' && tokens[index].type !== 'string') {
        const initializer = tokens.findIndex((token, candidate) => candidate > delimiter && token.value === '=')
        if (initializer < 0) continue
        delimiter = initializer
      }
      const value = tokens[delimiter + 1]
      if (value?.type === 'string') {
        if (['|', '+'].includes(tokens[delimiter + 2]?.value)) continue
        if (value.quote === '`' && value.interpolated) continue
        if (value.value.includes('${') || value.value.includes('$(')) continue
        values.push(value.value)
      } else if (unquotedEndpoints && value !== undefined) {
        const raw = line.slice(value.start, tokens.at(-1).end).trim()
        const endpoint = unquotedRegistryEndpoint(raw)
        if (endpoint !== null) values.push(endpoint)
      }
    }
  }
  return values
}

function unquotedRegistryEndpoint(raw) {
  const match = raw.match(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s;]+|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?::\d+)?(?:\/[^\s;]*)?)(?=$|[\s;])/)
  return match?.[1] ?? null
}

function configTokens(text, options = {}) {
  const tokens = []
  const punctuation = new Set(['{', '}', '[', ']', ':', '=', ',', ';', '?', '|', '+'])
  for (let index = 0; index < text.length;) {
    const character = text[index]
    if (/\s/.test(character)) {
      index += 1
      continue
    }
    if (options.hashComments === true && character === '#') break
    if (options.slashComments === true && text.startsWith('//', index)) {
      const newline = text.indexOf('\n', index + 2)
      index = newline < 0 ? text.length : newline + 1
      continue
    }
    if (options.slashComments === true && text.startsWith('/*', index)) {
      const end = text.indexOf('*/', index + 2)
      index = end < 0 ? text.length : end + 2
      continue
    }
    if (['"', "'", '`'].includes(character)) {
      const start = index
      const quote = character
      let value = ''
      let escaped = false
      let closed = false
      let interpolated = false
      index += 1
      for (; index < text.length; index += 1) {
        const nested = text[index]
        if (escaped) {
          value += nested
          escaped = false
        } else if (nested === '\\') {
          escaped = true
        } else if (nested === quote) {
          closed = true
          index += 1
          break
        } else {
          if (quote === '`' && nested === '$' && text[index + 1] === '{') interpolated = true
          value += nested
        }
      }
      tokens.push({ type: closed ? 'string' : 'invalid-string', value, quote, interpolated, start, end: index })
      continue
    }
    if (punctuation.has(character)) {
      tokens.push({ type: 'punctuation', value: character, start: index, end: index + 1 })
      index += 1
      continue
    }
    const start = index
    while (index < text.length
      && !/\s/.test(text[index])
      && !punctuation.has(text[index])
      && !(options.hashComments === true && text[index] === '#')
      && !(options.slashComments === true && (text.startsWith('//', index) || text.startsWith('/*', index)))) {
      index += 1
    }
    if (index === start) index += 1
    else tokens.push({ type: 'word', value: text.slice(start, index), start, end: index })
  }
  return tokens
}

function tokenKey(token) {
  if (token === undefined || !['string', 'word'].includes(token.type)) return null
  return token.value.replace(/^\$/, '').toLowerCase()
}

function isDirectRegistryKey(key) {
  const normalized = key.toLowerCase()
  return ['registry', 'registry-url', 'registryurl', 'registries.default'].includes(normalized)
    || /^@[^:]+:registry$/.test(normalized)
}

function configTokenValue(token) {
  if (token === undefined || !['string', 'word'].includes(token.type)) return ''
  return token.value
}

function sourceStringLiteral(raw) {
  const value = raw.trimStart()
  const quote = value[0]
  if (!['"', "'", '`'].includes(quote)) return null
  let escaped = false
  let result = ''
  for (let index = 1; index < value.length; index += 1) {
    const character = value[index]
    if (escaped) {
      result += character
      escaped = false
    } else if (character === '\\') {
      escaped = true
    } else if (character === quote) {
      if (quote === '`' && result.includes('${')) return null
      if (/^\s*\|/.test(value.slice(index + 1))) return null
      return result
    } else {
      result += character
    }
  }
  return null
}

function configScalar(raw) {
  const value = raw.trim()
  if (value.startsWith('"') || value.startsWith("'")) {
    const parsed = sourceStringLiteral(value)
    return parsed ?? ''
  }
  return value.replace(/\s+[;#].*$/, '').replace(/[;,]\s*$/, '').trim()
}

function leadingWhitespace(line) {
  return line.match(/^\s*/)[0].length
}

function unquotedConfigKey(raw) {
  const value = raw.trim()
  if ((value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).toLowerCase()
  }
  return value.toLowerCase()
}

function isApprovedRegistry(value) {
  let registry
  try {
    registry = new URL(value)
  } catch {
    return false
  }
  return registry.protocol === 'https:'
    && registry.username === ''
    && registry.password === ''
    && registry.port === ''
    && PUBLIC_REGISTRY_HOSTS.has(registry.hostname.toLowerCase())
    && registry.pathname === '/'
    && registry.search === ''
    && registry.hash === ''
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
