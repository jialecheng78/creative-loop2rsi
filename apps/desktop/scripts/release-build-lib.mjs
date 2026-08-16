import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import {
  MAC_BUNDLE_BUILD_VERSION,
  MAC_BUNDLE_SHORT_VERSION,
  PACKAGED_NOTICE_MAPPINGS,
  auditPackagedTree,
  inventoryTree,
  previewOutputPath,
  validateElectronRuntimeEvidence,
  validateSidecarEvidence,
  validateSidecarRuntimeComponents,
} from './preview-build-lib.mjs'

export const RELEASE_VERSION = '1.0.0-alpha.1'
export const RELEASE_TAG = `studio-v${RELEASE_VERSION}`
export const PRODUCT_NAME = 'Creative RSI Studio'
export const MAIN_ARCHIVE_NAME = `Creative-RSI-Studio-${RELEASE_VERSION}-macos-arm64.zip`
export const EVIDENCE_ARCHIVE_NAME = `Creative-RSI-Studio-${RELEASE_VERSION}-evidence.zip`
export const CHECKSUMS_NAME = 'SHA256SUMS.txt'
const EXPECTED_NODE = 'v24.19.0'
const EXPECTED_PNPM = '11.7.0'
const EVIDENCE_DIRECTORY_NAME = `Creative-RSI-Studio-${RELEASE_VERSION}-evidence`
const REQUIRED_DSH_COMPONENTS = [
  '@deepseek-ai/dsh-agent-spine-demo',
  '@deepseek-ai/dsh-llm-deepseek',
  '@deepseek-ai/dsh-sdk-client',
  '@deepseek-ai/dsh-sdk-jsonrpc-demo',
  '@deepseek-ai/dsh-sdk-jsonrpc-server',
]
const REQUIRED_DSH_VERSION = '0.1.0-rc.6'
const PACKAGE_NOTICE_NAME = /^(?:licen[cs]e|notice|copying)(?:$|[._-])/i
const SHARP_LIBVIPS_PACKAGE = '@img/sharp-libvips-darwin-arm64'
const SHARP_LIBVIPS_VERSION = '1.3.2'
const SHARP_LIBVIPS_VERSIONS_SHA256 = '71e22ad5154a3891e09291e2f316b3d9b0d0f405459144a94897a203580df055'
const SHARP_LIBVIPS_NOTICE_SHA256 = '47083f1ae7e990f74a56f576bcb8434051cb84ed1982fa57932720869e5147fe'
const SHARP_LIBVIPS_AGGREGATE_VERSION_KEYS = {
  aom: 'aom',
  cairo: 'cairo',
  cgif: 'cgif',
  expat: 'expat',
  fontconfig: 'fontconfig',
  freetype: 'freetype',
  fribidi: 'fribidi',
  glib: 'glib',
  harfbuzz: 'harfbuzz',
  highway: 'highway',
  lcms: 'lcms',
  libarchive: 'archive',
  libexif: 'exif',
  libffi: 'ffi',
  libheif: 'heif',
  libimagequant: 'imagequant',
  libnsgif: null,
  libpng: 'png',
  librsvg: 'rsvg',
  libtiff: 'tiff',
  libultrahdr: 'uhdr',
  libvips: 'vips',
  libwebp: 'webp',
  libxml2: 'xml2',
  mozjpeg: 'mozjpeg',
  pango: 'pango',
  pixman: 'pixman',
  'proxy-libintl': 'proxy-libintl',
  'zlib-ng': 'zlib-ng',
}
const MAC_ICON_FILE = 'CreativeRSIStudio.icns'
const UNUSED_MAC_PRIVACY_KEYS = [
  'NSAudioCaptureUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
  'NSBluetoothPeripheralUsageDescription',
  'NSCameraUsageDescription',
  'NSMicrophoneUsageDescription',
]

export function releaseOutputPath(root) {
  return join(resolve(root), 'dist', 'releases', `studio-v${RELEASE_VERSION}`)
}

export async function buildMacRelease(options) {
  const root = resolve(options.root)
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('macOS release packaging requires Darwin arm64')
  }
  await assertRegularDirectory(root, 'repository root')
  await assertCleanGitTree(root)
  await assertReleaseVersions(root)
  const pnpmCli = await pinnedPnpmCli(root)
  const python = process.env.PYTHON?.trim() || 'python3'
  await assertPython311(python, root)

  const app = resolve(options.appPath ?? previewOutputPath(root, 'darwin', 'arm64'))
  const appManifestPath = resolve(options.appManifestPath ?? `${app}.manifest.json`)
  const sidecarManifestPath = resolve(
    options.sidecarManifestPath ?? join(root, 'dist', 'controller-sidecar-macos-arm64.manifest.json'),
  )
  const outputRoot = resolve(options.outputRoot ?? releaseOutputPath(root))
  await assertMissing(outputRoot, 'release output')
  await assertRegularDirectory(app, 'standard macOS preview app')
  await assertRegularFile(appManifestPath, 'standard macOS preview manifest')
  await assertRegularFile(sidecarManifestPath, 'controller sidecar manifest')
  const realRoot = await realpath(root)
  for (const [path, label] of [
    [app, 'standard macOS preview app'],
    [appManifestPath, 'standard macOS preview manifest'],
    [sidecarManifestPath, 'controller sidecar manifest'],
  ]) {
    if (!inside(realRoot, await realpath(path))) throw new Error(`${label} escapes the repository`)
  }

  const packageStorePath = (await run(process.execPath, [pnpmCli, 'store', 'path'], { cwd: root })).stdout.trim()
  if (!isAbsolute(packageStorePath)) throw new Error('pnpm store path must be absolute')
  const appManifest = JSON.parse(await readFile(appManifestPath, 'utf8'))
  const identity = await gitIdentity(root)
  const inventory = await validateReleasePreview({
    root,
    app,
    appManifest,
    sidecarManifestPath,
    identity,
    packageStorePath,
  })
  const spctl = await expectedUnsignedSpctl(app)

  const outputParent = dirname(outputRoot)
  if (!inside(root, outputRoot)) throw new Error('release output must stay inside the repository')
  await assertNoSymlinkAncestors(root, outputParent)
  await mkdir(outputParent, { recursive: true })
  if (!inside(realRoot, await realpath(outputParent))) {
    throw new Error('release output parent escapes the repository')
  }
  const work = await mkdtemp(join(tmpdir(), 'creative-rsi-release-'))
  let outputStaging
  let published = false
  try {
    outputStaging = await mkdtemp(join(outputParent, '.creative-rsi-release-'))
    const mainArchive = join(outputStaging, MAIN_ARCHIVE_NAME)
    const mainArtifact = await archiveMacApp({
      app,
      archive: mainArchive,
      expectedInventory: inventory,
      packagedSmoke: unpackedApp => packagedSmoke(root, unpackedApp),
    })

    const evidenceRoot = join(work, EVIDENCE_DIRECTORY_NAME)
    await mkdir(evidenceRoot, { mode: 0o755 })
    const evidence = await buildEvidence({
      root,
      work,
      evidenceRoot,
      app,
      appManifestPath,
      appManifest,
      sidecarManifestPath,
      identity,
      mainArtifact,
      smoke: mainArtifact.packaged_smoke,
      spctl,
      python,
    })
    const evidenceArchive = join(outputStaging, EVIDENCE_ARCHIVE_NAME)
    await archiveEvidence(evidenceRoot, evidenceArchive, evidence.expectedFiles)
    const evidenceArtifact = await artifactIdentity(evidenceArchive)
    const checksums = join(outputStaging, CHECKSUMS_NAME)
    await writeFile(
      checksums,
      renderChecksums(mainArtifact, evidenceArtifact),
      { encoding: 'utf8', flag: 'wx', mode: 0o644 },
    )

    const publicEntries = (await readdir(outputStaging)).sort()
    const expectedEntries = [CHECKSUMS_NAME, EVIDENCE_ARCHIVE_NAME, MAIN_ARCHIVE_NAME].sort()
    if (JSON.stringify(publicEntries) !== JSON.stringify(expectedEntries)) {
      throw new Error(`release output contains unexpected files: ${publicEntries.join(', ')}`)
    }
    await assertMissing(outputRoot, 'release output')
    await rename(outputStaging, outputRoot)
    published = true
    return {
      outputRoot,
      mainArchive: join(outputRoot, MAIN_ARCHIVE_NAME),
      evidenceArchive: join(outputRoot, EVIDENCE_ARCHIVE_NAME),
      checksums: join(outputRoot, CHECKSUMS_NAME),
      source: identity,
      mainArtifact,
      evidenceArtifact,
    }
  } finally {
    await rm(work, { force: true, recursive: true })
    if (!published && outputStaging !== undefined) {
      await rm(outputStaging, { force: true, recursive: true })
    }
  }
}

export async function validateReleasePreview(options) {
  const { root, app, appManifest, sidecarManifestPath, identity, packageStorePath } = options
  if (appManifest?.schema_version !== '2'
    || appManifest?.kind !== 'StudioPreviewBuildManifest'
    || appManifest?.product !== PRODUCT_NAME
    || appManifest?.source?.app_version !== RELEASE_VERSION
    || appManifest?.source?.git_commit !== identity.git_commit
    || appManifest?.source?.git_tree !== identity.git_tree
    || appManifest?.platform?.os !== 'darwin'
    || appManifest?.platform?.arch !== 'arm64'
    || appManifest?.unsigned !== true
    || appManifest?.developer_id_signed !== false
    || appManifest?.notarized !== false
    || appManifest?.adhoc_sealed !== true
    || appManifest?.strict_codesign !== 'PASS'
    || typeof appManifest?.runtime_components_sha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(appManifest.runtime_components_sha256)
    || appManifest?.packaged_path !== `${PRODUCT_NAME}.app`
    || !Array.isArray(appManifest?.files)
    || !Number.isSafeInteger(appManifest?.file_count)
    || typeof appManifest?.tree_sha256 !== 'string') {
    throw new Error('standard macOS preview manifest is not release eligible')
  }
  const sidecarManifestBytes = await readFile(sidecarManifestPath)
  if (sha256(sidecarManifestBytes) !== appManifest.controller_sidecar_manifest_sha256) {
    throw new Error('controller sidecar manifest differs from the preview binding')
  }
  const embeddedSource = JSON.parse(await readFile(
    join(app, 'Contents', 'Resources', 'build-source.json'),
    'utf8',
  ))
  if (JSON.stringify(embeddedSource) !== JSON.stringify(appManifest.source)) {
    throw new Error('embedded preview source identity differs from the app manifest')
  }
  const resources = join(app, 'Contents', 'Resources')
  const runtimeComponentBytes = await readFile(join(resources, 'runtime-components.json'))
  if (sha256(runtimeComponentBytes) !== appManifest.runtime_components_sha256) {
    throw new Error('Electron runtime component evidence differs from the preview binding')
  }
  await validateElectronRuntimeEvidence(resources, JSON.parse(runtimeComponentBytes.toString('utf8')))
  const sidecarManifest = JSON.parse(sidecarManifestBytes.toString('utf8'))
  await validateSidecarEvidence(
    join(resources, 'controller'),
    sidecarManifest,
    { root, source: appManifest.source, platform: 'darwin', arch: 'arm64' },
  )
  const actual = await auditPackagedTree(app, {
    platform: 'darwin',
    packageStorePaths: [packageStorePath],
  })
  const treeSha256 = sha256(Buffer.from(JSON.stringify(actual), 'utf8'))
  if (appManifest.file_count !== actual.length
    || appManifest.tree_sha256 !== treeSha256
    || JSON.stringify(appManifest.files) !== JSON.stringify(actual)) {
    throw new Error('standard macOS preview bytes or modes differ from its manifest')
  }
  await validateMacMetadata(app)
  await strictCodesign(app)
  return actual
}

export async function archiveMacApp(options) {
  const app = resolve(options.app)
  const archive = resolve(options.archive)
  await assertRegularDirectory(app, 'macOS app bundle')
  await assertMissing(archive, 'macOS release archive')
  await mkdir(dirname(archive), { recursive: true })
  await dittoCreate(app, archive)
  await assertZipContainsOnly(archive, `${PRODUCT_NAME}.app`)
  const artifact = await artifactIdentity(archive)
  const extracted = await mkdtemp(join(tmpdir(), 'creative-rsi-release-roundtrip-'))
  try {
    await dittoExtract(archive, extracted)
    const entries = await readdir(extracted)
    if (entries.length !== 1 || entries[0] !== `${PRODUCT_NAME}.app`) {
      throw new Error(`macOS archive root is invalid: ${entries.sort().join(', ')}`)
    }
    const unpackedApp = join(extracted, `${PRODUCT_NAME}.app`)
    await assertNoArchivedMacMetadata(unpackedApp)
    const actual = await inventoryTree(unpackedApp, { platform: 'darwin' })
    if (JSON.stringify(actual) !== JSON.stringify(options.expectedInventory)) {
      throw new Error('macOS archive round-trip inventory differs from the app manifest')
    }
    await strictCodesign(unpackedApp)
    if (typeof options.packagedSmoke !== 'function') {
      throw new Error('macOS archive round-trip requires packaged smoke verification')
    }
    const smoke = await options.packagedSmoke(unpackedApp)
    if (smoke?.status !== 'PASS'
      || smoke?.packaged !== true
      || smoke?.credential !== 'not-configured'
      || smoke?.model_requests !== 0) {
      throw new Error('macOS archive round-trip packaged smoke is invalid')
    }
    return {
      ...artifact,
      round_trip_inventory: 'PASS',
      strict_codesign: 'PASS',
      packaged_smoke: smoke,
    }
  } finally {
    await rm(extracted, { force: true, recursive: true })
  }
}

export async function collectPackagedNodeComponents(payloadRoot) {
  const root = resolve(payloadRoot)
  await assertRegularDirectory(root, 'packaged application payload')
  const occurrences = []
  const visit = async (directory, relativeDirectory) => {
    if (isPackagedNodePackageRoot(relativeDirectory)) {
      const manifestPath = join(directory, 'package.json')
      await assertRegularFile(manifestPath, `packaged Node package ${relativeDirectory}`)
      const manifestBytes = await readFile(manifestPath)
      let manifest
      try {
        manifest = JSON.parse(manifestBytes.toString('utf8'))
      } catch (error) {
        throw new Error(`packaged Node package manifest is invalid JSON: ${relativeDirectory}`, { cause: error })
      }
      if (typeof manifest?.name !== 'string'
        || !/^(?:@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+$/.test(manifest.name)
        || typeof manifest?.version !== 'string'
        || manifest.version.trim() === '') {
        throw new Error(`packaged Node package identity is invalid: ${relativeDirectory}`)
      }
      const packageJsonPath = relativeDirectory === '.'
        ? 'package.json'
        : `${relativeDirectory}/package.json`
      const notices = []
      for (const name of (await readdir(directory)).sort()) {
        if (!PACKAGE_NOTICE_NAME.test(name)) continue
        const path = join(directory, name)
        const info = await lstat(path)
        if (!info.isFile() || info.isSymbolicLink()) continue
        const bytes = await readFile(path)
        notices.push({
          path: relativeDirectory === '.' ? name : `${relativeDirectory}/${name}`,
          bytes: bytes.length,
          sha256: sha256(bytes),
        })
      }
      occurrences.push({
        name: manifest.name,
        version: manifest.version,
        repository: packageRepositoryUrl(manifest),
        repository_directory: packageRepositoryDirectory(manifest),
        licenses: declaredPackageLicenses(manifest),
        dependencies: manifestDependencyNames(manifest, 'dependencies'),
        peer_dependencies: requiredPeerDependencyNames(manifest),
        optional_dependencies: manifestDependencyNames(manifest, 'optionalDependencies'),
        package_json: {
          path: packageJsonPath,
          bytes: manifestBytes.length,
          sha256: sha256(manifestBytes),
        },
        notices,
      })
    }
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name)
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink()) continue
      const child = relativeDirectory === '.' ? name : `${relativeDirectory}/${name}`
      await visit(path, child)
    }
  }
  await visit(root, '.')

  const grouped = new Map()
  for (const occurrence of occurrences) {
    const key = `${occurrence.name}\u0000${occurrence.version}`
    const component = grouped.get(key) ?? {
      name: occurrence.name,
      version: occurrence.version,
      licenses: new Set(),
      dependencies: new Set(),
      peer_dependencies: new Set(),
      optional_dependencies: new Set(),
      repositories: new Set(),
      repository_directories: new Set(),
      metadata_signatures: new Set(),
      package_jsons: [],
      notices: [],
    }
    for (const value of occurrence.licenses) component.licenses.add(value)
    for (const value of occurrence.dependencies) component.dependencies.add(value)
    for (const value of occurrence.peer_dependencies) component.peer_dependencies.add(value)
    for (const value of occurrence.optional_dependencies) component.optional_dependencies.add(value)
    if (occurrence.repository !== undefined) component.repositories.add(occurrence.repository)
    if (occurrence.repository_directory !== undefined) {
      component.repository_directories.add(occurrence.repository_directory)
    }
    component.metadata_signatures.add(JSON.stringify({
      licenses: occurrence.licenses,
      dependencies: occurrence.dependencies,
      peer_dependencies: occurrence.peer_dependencies,
      optional_dependencies: occurrence.optional_dependencies,
      repository: occurrence.repository,
      repository_directory: occurrence.repository_directory,
    }))
    component.package_jsons.push(occurrence.package_json)
    component.notices.push(...occurrence.notices)
    grouped.set(key, component)
  }
  return [...grouped.values()].map(component => {
    if (component.metadata_signatures.size > 1
      || component.repositories.size > 1
      || component.repository_directories.size > 1) {
      throw new Error(`packaged Node component metadata conflicts: ${component.name}@${component.version}`)
    }
    return {
      name: component.name,
      version: component.version,
      repository: [...component.repositories][0],
      repository_directory: [...component.repository_directories][0],
      licenses: [...component.licenses].sort(),
      dependencies: [...component.dependencies].sort(),
      peer_dependencies: [...component.peer_dependencies].sort(),
      optional_dependencies: [...component.optional_dependencies].sort(),
      package_jsons: uniqueFileEvidence(component.package_jsons),
      notices: uniqueFileEvidence(component.notices),
    }
  }).sort(compareComponentIdentity)
}

export function assertRequiredDshProductionClosure(components) {
  const byName = new Map()
  for (const component of components) {
    const values = byName.get(component.name) ?? []
    values.push(component)
    byName.set(component.name, values)
  }
  const queue = []
  for (const name of REQUIRED_DSH_COMPONENTS) {
    const matches = (byName.get(name) ?? []).filter(component => component.version === REQUIRED_DSH_VERSION)
    if (matches.length === 0) {
      throw new Error(`packaged release is missing required DSH component: ${name}@${REQUIRED_DSH_VERSION}`)
    }
    queue.push(...matches)
  }
  const closure = new Map()
  while (queue.length !== 0) {
    const component = queue.shift()
    const key = `${component.name}@${component.version}`
    if (closure.has(key)) continue
    closure.set(key, component)
    for (const dependency of [...component.dependencies, ...component.peer_dependencies].sort()) {
      const matches = byName.get(dependency) ?? []
      if (matches.length === 0) {
        throw new Error(`packaged DSH production dependency is missing: ${component.name} -> ${dependency}`)
      }
      queue.push(...matches)
    }
  }
  return [...closure.keys()].sort()
}

export async function buildPackagedReleaseEvidence(options) {
  const app = resolve(options.app)
  const resources = join(app, 'Contents', 'Resources')
  const payload = join(resources, 'app')
  const controller = join(resources, 'controller')
  await assertRegularDirectory(app, 'macOS app bundle')
  const electronEvidence = await validateElectronRuntimeEvidence(resources)
  const sidecarManifest = options.sidecarManifest
  await validateSidecarRuntimeComponents(controller, sidecarManifest?.runtime_components, {
    python: sidecarManifest?.python,
    pyinstaller: sidecarManifest?.pyinstaller,
  })
  const rawNodeComponents = await collectPackagedNodeComponents(payload)
  const dshProductionClosure = assertRequiredDshProductionClosure(rawNodeComponents)
  const electronRuntimeIdentity = await appFileEvidence(
    app,
    'Contents/Resources/runtime-components.json',
  )
  const nodePackages = rawNodeComponents.map(component => ({
    ...component,
    package_jsons: component.package_jsons.map(file => prefixFileEvidence(
      'Contents/Resources/app',
      file,
    )),
    notices: component.notices.map(file => prefixFileEvidence(
      'Contents/Resources/app',
      file,
    )),
  }))
  const licenseProvenance = await validatePackagedLicenseProvenance(app, nodePackages)
  const aggregateComponents = await collectSharpLibvipsAggregate(app, nodePackages)
  const includesSharpAggregate = aggregateComponents.length !== 0
  const runtimeComponents = [
    ...electronEvidence.components.map(component => ({
      name: component.name,
      version: component.version,
      license: component.license,
      identity_files: [electronRuntimeIdentity],
      notices: component.notices.map(file => prefixFileEvidence('Contents/Resources', file)),
    })),
    ...sidecarManifest.runtime_components.map(component => ({
      name: component.name,
      version: component.version,
      license: component.license,
      identity_files: [],
      notices: [prefixFileEvidence('Contents/Resources/controller', component.notice)],
    })),
  ].sort(compareComponentIdentity)
  const requiredRuntime = new Map(runtimeComponents.map(component => [component.name, component.version]))
  if (requiredRuntime.get('Electron') !== '43.4.0'
    || typeof requiredRuntime.get('Node.js') !== 'string'
    || typeof requiredRuntime.get('Chromium') !== 'string'
    || !String(requiredRuntime.get('CPython')).startsWith('3.11.')
    || requiredRuntime.get('PyInstaller') !== '6.22.0') {
    throw new Error('packaged runtime component closure is incomplete')
  }
  const applicationNotices = await Promise.all([
    'Contents/Resources/LICENSE',
    'Contents/Resources/THIRD_PARTY_NOTICES.md',
    'Contents/Resources/third_party/licenses/deepseek-harness-MIT.txt',
  ].map(relativePath => appFileEvidence(app, relativePath)))
  const licenseComponents = [
    ...nodePackages.map(component => {
      if (component.licenses.length !== 1 || component.notices.length === 0) {
        throw new Error(`packaged Node component license evidence is incomplete: ${component.name}@${component.version}`)
      }
      const mappedSources = licenseProvenance.sources.get(nodeBomRef(component)) ?? []
      return {
        bom_ref: nodeBomRef(component),
        name: component.name,
        version: component.version,
        license: component.licenses[0],
        identity_files: component.package_jsons,
        notices: component.notices,
        notice_sources: mappedSources.length === 0
          ? [{
              kind: 'packaged-package-root',
              target_package_jsons: component.package_jsons,
              installed_notices: component.notices,
            }]
          : mappedSources,
      }
    }),
    ...runtimeComponents.map(component => ({
      bom_ref: runtimeBomRef(component),
      name: component.name,
      version: component.version,
      license: component.license,
      identity_files: component.identity_files,
      notices: component.notices,
    })),
    ...aggregateComponents.map(component => ({
      bom_ref: aggregateBomRef(component),
      name: component.name,
      ...(component.version === undefined ? {} : { version: component.version }),
      license: component.license,
      identity_files: component.identity_files,
      notices: component.notices,
      notice_sources: [{
        kind: 'upstream-aggregate-declaration',
        parent_component: `${SHARP_LIBVIPS_PACKAGE}@${SHARP_LIBVIPS_VERSION}`,
        upstream_library_key: component.upstream_library_key,
        upstream_library_name: component.upstream_library_name,
        upstream_license_declaration: component.upstream_license_declaration,
        version_evidence: component.version_evidence,
        identity_files: component.identity_files,
        installed_notices: component.notices,
        evidence_scope: 'aggregate-version-and-license-declaration',
        component_level_license_text_complete: false,
      }],
    })),
  ].sort((left, right) => left.bom_ref < right.bom_ref ? -1 : left.bom_ref > right.bom_ref ? 1 : 0)
  const licenses = {
    schema_version: '1',
    kind: 'PackagedLicenseEvidence',
    scope: 'final-macos-app',
    components: licenseComponents,
    application_notices: applicationNotices,
    provenance_files: [licenseProvenance.file],
    dsh_production_closure: dshProductionClosure,
    evidence_granularity: includesSharpAggregate
      ? 'physical-npm-package-roots-plus-explicit-runtimes-plus-sharp-libvips-aggregate-declarations'
      : 'physical-npm-package-roots-plus-explicit-runtime-components',
    known_limitations: includesSharpAggregate
      ? [{
          component: `${SHARP_LIBVIPS_PACKAGE}@${SHARP_LIBVIPS_VERSION}`,
          status: 'NON_BLOCKING_ALPHA_GAP',
          scope: '29 upstream license declarations and 28 versions are bound; libnsgif has no version in versions.json and per-library complete license texts are not claimed',
        }]
      : [],
  }
  const sbom = createPackagedCycloneDx({
    nodePackages,
    runtimeComponents,
    aggregateComponents,
    dshProductionClosure,
  })
  assertSbomLicenseComponentParity(sbom, licenses)
  assertPathFreeEvidenceJson(licenses)
  assertPathFreeEvidenceJson(sbom)
  return { licenses, sbom }
}

export async function validatePackagedLicenseProvenance(app, nodePackages) {
  const relativePath = 'Contents/Resources/app/release-license-provenance.json'
  const file = await appFileEvidence(app, relativePath)
  const value = JSON.parse(await readFile(join(app, ...relativePath.split('/')), 'utf8'))
  assertPathFreeEvidenceJson(value)
  const packageIdentities = new Set(nodePackages.map(component => `${component.name}@${component.version}`))
  const activeMappings = PACKAGED_NOTICE_MAPPINGS.filter(mapping => (
    packageIdentities.has(`${mapping.target.name}@${mapping.target.version}`)
  ))
  if (value?.schema_version !== '1'
    || value?.kind !== 'PackagedLicenseProvenance'
    || !Array.isArray(value?.mappings)
    || value.mappings.length !== activeMappings.length) {
    throw new Error('packaged license provenance is invalid')
  }
  const packagesByIdentity = new Map(nodePackages.map(component => [
    `${component.name}@${component.version}`,
    component,
  ]))
  const expectedByIdentity = new Map(activeMappings.map(mapping => [
    `${mapping.target.name}@${mapping.target.version}`,
    mapping,
  ]))
  const sources = new Map()
  for (const record of value.mappings) {
    const identity = record?.target?.component
    const expected = expectedByIdentity.get(identity)
    const component = packagesByIdentity.get(identity)
    if (expected === undefined || component === undefined) {
      throw new Error(`packaged license provenance target is unexpected: ${String(identity)}`)
    }
    const expectedTarget = {
      component: identity,
      license: expected.target.license,
      repository: expected.target.repository,
      ...(expected.target.declared_repository_directory === undefined
        ? {}
        : { declared_repository_directory: expected.target.declared_repository_directory }),
    }
    const expectedSource = expected.source.kind === 'tracked'
      ? {
          kind: 'tracked-canonical-license',
          file: expected.source.file,
          sha256: expected.source.sha256,
        }
      : {
          kind: 'pinned-package-file',
          component: `${expected.source.name}@${expected.source.version}`,
          file: expected.source.file,
          sha256: expected.source.sha256,
        }
    if (JSON.stringify(record.target) !== JSON.stringify(expectedTarget)
      || JSON.stringify(record.source) !== JSON.stringify(expectedSource)
      || JSON.stringify(record.upstream) !== JSON.stringify(expected.upstream)
      || component.licenses.length !== 1
      || component.licenses[0] !== expected.target.license
      || component.repository !== expected.target.repository
      || component.repository_directory !== expected.target.declared_repository_directory
      || !Array.isArray(record.installed_notices)
      || !Array.isArray(record.evidence_files)) {
      throw new Error(`packaged license provenance differs from the pinned mapping: ${identity}`)
    }
    const roots = component.package_jsons.map(packageJson => (
      packageJson.path.slice(0, -'/package.json'.length)
    )).sort()
    const expectedNoticePaths = roots.map(root => `${root}/${expected.destination}`).sort()
    const installedNotices = []
    const installedNoticePaths = new Set()
    for (const installed of record.installed_notices) {
      const normalized = prefixFileEvidence('Contents/Resources/app', installed)
      if (installedNoticePaths.has(normalized.path)
        || normalized.sha256 !== expected.source.sha256
        || !component.notices.some(notice => JSON.stringify(notice) === JSON.stringify(normalized))) {
        throw new Error(`packaged license provenance notice is invalid: ${identity}`)
      }
      installedNoticePaths.add(normalized.path)
      const actual = await appFileEvidence(app, normalized.path)
      if (JSON.stringify(actual) !== JSON.stringify(normalized)) {
        throw new Error(`packaged license provenance notice bytes differ: ${identity}`)
      }
      installedNotices.push(normalized)
    }
    if (JSON.stringify([...installedNoticePaths].sort()) !== JSON.stringify(expectedNoticePaths)) {
      throw new Error(`packaged license provenance notice set is incomplete: ${identity}`)
    }
    const expectedEvidencePaths = roots.flatMap(root => (expected.evidence_files ?? []).map(evidence => ({
      path: `${root}/${evidence.file}`,
      sha256: evidence.sha256,
    }))).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    const evidenceFiles = []
    const evidenceFilePaths = new Set()
    for (const evidence of record.evidence_files) {
      const normalized = prefixFileEvidence('Contents/Resources/app', evidence)
      const expectedEvidence = expectedEvidencePaths.find(item => item.path === normalized.path)
      const actual = await appFileEvidence(app, normalized.path)
      if (evidenceFilePaths.has(normalized.path)
        || expectedEvidence === undefined
        || normalized.sha256 !== expectedEvidence.sha256
        || JSON.stringify(actual) !== JSON.stringify(normalized)) {
        throw new Error(`packaged license provenance component evidence is invalid: ${identity}`)
      }
      evidenceFilePaths.add(normalized.path)
      evidenceFiles.push(normalized)
    }
    if (JSON.stringify([...evidenceFilePaths].sort())
      !== JSON.stringify(expectedEvidencePaths.map(item => item.path))) {
      throw new Error(`packaged license provenance component evidence is incomplete: ${identity}`)
    }
    const values = sources.get(nodeBomRef(component)) ?? []
    values.push({
      kind: record.source.kind,
      target: {
        name: component.name,
        version: component.version,
        license: expected.target.license,
        repository: expected.target.repository,
        ...(expected.target.declared_repository_directory === undefined
          ? {}
          : { declared_repository_directory: expected.target.declared_repository_directory }),
        package_jsons: component.package_jsons,
      },
      source: record.source,
      ...(record.upstream === undefined ? {} : { upstream: record.upstream }),
      installed_notices: installedNotices,
      evidence_files: evidenceFiles,
    })
    sources.set(nodeBomRef(component), values)
    expectedByIdentity.delete(identity)
  }
  if (expectedByIdentity.size !== 0) {
    throw new Error(`packaged license provenance is missing mappings: ${[...expectedByIdentity.keys()].sort().join(', ')}`)
  }
  return { file, sources }
}

export async function collectSharpLibvipsAggregate(app, nodePackages) {
  const parent = nodePackages.find(component => (
    component.name === SHARP_LIBVIPS_PACKAGE && component.version === SHARP_LIBVIPS_VERSION
  ))
  if (parent === undefined) return []
  const expectedKeys = Object.values(SHARP_LIBVIPS_AGGREGATE_VERSION_KEYS)
    .filter(value => value !== null)
    .sort()
  const versionsFiles = []
  let observedVersions
  let observedDeclarations
  for (const packageJson of parent.package_jsons) {
    const root = packageJson.path.slice(0, -'/package.json'.length)
    const versionsPath = `${root}/versions.json`
    const identity = await appFileEvidence(app, versionsPath)
    if (identity.sha256 !== SHARP_LIBVIPS_VERSIONS_SHA256) {
      throw new Error('sharp-libvips aggregate versions.json hash differs')
    }
    const parsed = JSON.parse(await readFile(join(app, ...versionsPath.split('/')), 'utf8'))
    if (JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify(expectedKeys)
      || Object.values(parsed).some(version => typeof version !== 'string' || version === '')) {
      throw new Error('sharp-libvips aggregate versions.json key set is invalid')
    }
    if (observedVersions !== undefined && JSON.stringify(observedVersions) !== JSON.stringify(parsed)) {
      throw new Error('sharp-libvips aggregate versions conflict across package roots')
    }
    observedVersions = parsed
    versionsFiles.push(identity)
  }
  const notices = parent.notices.filter(notice => notice.sha256 === SHARP_LIBVIPS_NOTICE_SHA256)
  if (notices.length !== parent.package_jsons.length) {
    throw new Error('sharp-libvips aggregate README notice is missing or unbound')
  }
  for (const notice of notices) {
    const declarations = parseSharpLibvipsLicenseDeclarations(
      await readFile(join(app, ...notice.path.split('/')), 'utf8'),
    )
    if (observedDeclarations !== undefined
      && JSON.stringify(observedDeclarations) !== JSON.stringify(declarations)) {
      throw new Error('sharp-libvips aggregate license declarations conflict across package roots')
    }
    observedDeclarations = declarations
  }
  return Object.entries(SHARP_LIBVIPS_AGGREGATE_VERSION_KEYS).map(([library, versionKey]) => ({
    name: `sharp-libvips:${library}`,
    ...(versionKey === null ? {} : { version: observedVersions[versionKey] }),
    license: observedDeclarations[library],
    upstream_library_key: versionKey,
    upstream_library_name: library,
    upstream_license_declaration: observedDeclarations[library],
    version_evidence: versionKey === null
      ? { status: 'not-declared-in-versions.json' }
      : { status: 'bound-to-versions.json', key: versionKey, version: observedVersions[versionKey] },
    parent_bom_ref: nodeBomRef(parent),
    identity_files: uniqueFileEvidence(versionsFiles),
    notices: uniqueFileEvidence(notices),
  }))
}

function parseSharpLibvipsLicenseDeclarations(readme) {
  const declarations = {}
  for (const line of readme.split(/\r?\n/)) {
    const match = /^\|\s*([^|]+?)\s*\|\s*(.*?)\s*\|$/.exec(line)
    if (match === null) continue
    const library = match[1].trim()
    const declaration = match[2].trim()
    if (library === 'Library' || /^-+$/.test(library)) continue
    if (!Object.prototype.hasOwnProperty.call(SHARP_LIBVIPS_AGGREGATE_VERSION_KEYS, library)
      || declaration === ''
      || Object.prototype.hasOwnProperty.call(declarations, library)) {
      throw new Error(`sharp-libvips aggregate license table is invalid: ${library}`)
    }
    declarations[library] = declaration
  }
  const actual = Object.keys(declarations).sort()
  const expected = Object.keys(SHARP_LIBVIPS_AGGREGATE_VERSION_KEYS).sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('sharp-libvips aggregate license declaration set is invalid')
  }
  return declarations
}

export function assertSbomLicenseComponentParity(sbom, licenses) {
  const sbomRefs = [sbom?.metadata?.component, ...(sbom?.components ?? [])]
    .map(component => component?.['bom-ref'])
    .sort()
  const licenseRefs = (licenses?.components ?? []).map(component => component?.bom_ref).sort()
  if (sbomRefs.some(value => typeof value !== 'string')
    || licenseRefs.some(value => typeof value !== 'string')
    || JSON.stringify(sbomRefs) !== JSON.stringify(licenseRefs)) {
    throw new Error('SBOM and license evidence component sets differ')
  }
}

export function assertPackagedEvidenceBoundToAppManifest(licenses, appManifest) {
  if (!Array.isArray(appManifest?.files)) {
    throw new Error('app manifest inventory is unavailable for packaged evidence')
  }
  const appFiles = new Map(appManifest.files
    .filter(entry => entry?.type === 'file')
    .map(entry => [entry.path, entry]))
  const identities = []
  const visit = value => {
    if (value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (typeof value.path === 'string'
      && Number.isSafeInteger(value.bytes)
      && typeof value.sha256 === 'string') {
      identities.push(value)
    }
    Object.values(value).forEach(visit)
  }
  visit(licenses)
  if (identities.length === 0) throw new Error('packaged license evidence contains no file identities')
  for (const identity of identities) {
    const declared = appFiles.get(identity.path)
    if (declared === undefined
      || declared.bytes !== identity.bytes
      || declared.sha256 !== identity.sha256) {
      throw new Error(`packaged license evidence is not bound to the app manifest: ${identity.path}`)
    }
  }
}

export function createPackagedCycloneDx(input) {
  const nodeRefsByName = new Map()
  for (const component of input.nodePackages) {
    const values = nodeRefsByName.get(component.name) ?? []
    values.push(nodeBomRef(component))
    nodeRefsByName.set(component.name, values)
  }
  const rootPackage = input.nodePackages.find(component => component.name === '@creative-loop2rsi/desktop')
  if (rootPackage === undefined || rootPackage.version !== RELEASE_VERSION) {
    throw new Error('packaged desktop root component is missing from the release closure')
  }
  const rootComponent = cycloneDxNodeComponent(rootPackage, 'application')
  const runtime = input.runtimeComponents.map(component => ({
    type: component.name === 'Electron' ? 'framework' : 'library',
    'bom-ref': runtimeBomRef(component),
    name: component.name,
    version: component.version,
    licenses: [{ license: { name: component.license } }],
    properties: [
      ...component.identity_files.flatMap(file => [
        { name: 'creative-rsi:identity-path', value: file.path },
        { name: 'creative-rsi:identity-sha256', value: file.sha256 },
      ]),
      ...component.notices.flatMap(notice => [
        { name: 'creative-rsi:notice-path', value: notice.path },
        { name: 'creative-rsi:notice-sha256', value: notice.sha256 },
      ]),
    ],
  })).sort((left, right) => left['bom-ref'].localeCompare(right['bom-ref']))
  const aggregate = input.aggregateComponents.map(component => ({
    type: 'library',
    'bom-ref': aggregateBomRef(component),
    name: component.name,
    ...(component.version === undefined ? {} : { version: component.version }),
    licenses: [{ license: { name: component.license } }],
    properties: [
      { name: 'creative-rsi:aggregate-parent', value: component.parent_bom_ref },
      { name: 'creative-rsi:aggregate-library-name', value: component.upstream_library_name },
      ...(component.upstream_library_key === null
        ? []
        : [{ name: 'creative-rsi:aggregate-version-key', value: component.upstream_library_key }]),
      { name: 'creative-rsi:upstream-license-declaration', value: component.upstream_license_declaration },
      { name: 'creative-rsi:version-evidence-status', value: component.version_evidence.status },
      { name: 'creative-rsi:evidence-scope', value: 'aggregate-version-and-license-declaration' },
      { name: 'creative-rsi:component-level-license-text-complete', value: 'false' },
      ...component.identity_files.flatMap(file => [
        { name: 'creative-rsi:identity-path', value: file.path },
        { name: 'creative-rsi:identity-sha256', value: file.sha256 },
      ]),
      ...component.notices.flatMap(notice => [
        { name: 'creative-rsi:notice-path', value: notice.path },
        { name: 'creative-rsi:notice-sha256', value: notice.sha256 },
      ]),
    ],
  })).sort((left, right) => left['bom-ref'].localeCompare(right['bom-ref']))
  const dependencies = input.nodePackages.map(component => {
    const names = [...component.dependencies, ...component.peer_dependencies, ...component.optional_dependencies]
    const dependsOn = names.flatMap(name => nodeRefsByName.get(name) ?? [])
    if (component.name === '@creative-loop2rsi/desktop') {
      dependsOn.push(...runtime.map(value => value['bom-ref']))
    }
    if (component.name === SHARP_LIBVIPS_PACKAGE && component.version === SHARP_LIBVIPS_VERSION) {
      dependsOn.push(...aggregate.map(value => value['bom-ref']))
    }
    return { ref: nodeBomRef(component), dependsOn: [...new Set(dependsOn)].sort() }
  }).sort((left, right) => left.ref.localeCompare(right.ref))
  dependencies.push(...runtime.map(component => ({
    ref: component['bom-ref'],
    dependsOn: component.name === 'Electron'
      ? runtime.filter(value => value.name === 'Node.js' || value.name === 'Chromium')
        .map(value => value['bom-ref']).sort()
      : [],
  })))
  dependencies.push(...aggregate.map(component => ({ ref: component['bom-ref'], dependsOn: [] })))
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: { component: rootComponent },
    components: [
      ...input.nodePackages
        .filter(component => component !== rootPackage)
        .map(component => cycloneDxNodeComponent(component, 'library')),
      ...runtime,
      ...aggregate,
    ].sort((left, right) => left['bom-ref'].localeCompare(right['bom-ref'])),
    dependencies: dependencies.sort((left, right) => left.ref.localeCompare(right.ref)),
    properties: [
      {
        name: 'creative-rsi:evidence-granularity',
        value: aggregate.length === 0
          ? 'physical-npm-package-roots-plus-explicit-runtime-components'
          : 'physical-npm-package-roots-plus-explicit-runtimes-plus-sharp-libvips-aggregate-declarations',
      },
      ...(aggregate.length === 0
        ? []
        : [{
            name: 'creative-rsi:sharp-libvips-aggregate-limitation',
            value: '29 upstream license declarations and 28 versions are bound; libnsgif has no version in versions.json and per-library complete license texts are not claimed',
          }]),
      { name: 'creative-rsi:dsh-production-closure', value: input.dshProductionClosure.join(',') },
    ],
  }
}

export function createDeliveryManifest(input) {
  if (input.spctl !== 'REJECTED_UNSIGNED_EXPECTED'
    && input.spctl !== 'REJECTED_ADHOC_UNATTRIBUTED') {
    throw new Error('spctl release assessment classification is invalid')
  }
  const manifest = {
    schema_version: '1',
    kind: 'ReleaseDeliveryManifest',
    product: PRODUCT_NAME,
    version: RELEASE_VERSION,
    tag: RELEASE_TAG,
    platform: {
      os: 'macos',
      arch: 'arm64',
      minimum_macos: '13.0',
    },
    signing: {
      developer_id_signed: false,
      notarized: false,
      adhoc_sealed: true,
      strict_codesign: 'PASS',
      spctl: input.spctl,
    },
    source: {
      git_commit: input.identity.git_commit,
      git_tree: input.identity.git_tree,
    },
    artifacts: {
      main_archive: {
        filename: MAIN_ARCHIVE_NAME,
        bytes: input.mainArtifact.bytes,
        sha256: input.mainArtifact.sha256,
      },
      evidence_archive: {
        filename: EVIDENCE_ARCHIVE_NAME,
        digest_bound_by: CHECKSUMS_NAME,
      },
    },
    evidence: input.evidence,
    verification: {
      archive_round_trip_inventory: input.mainArtifact.round_trip_inventory,
      archive_round_trip_codesign: input.mainArtifact.strict_codesign,
      packaged_smoke: input.smoke,
    },
  }
  assertPathFreeManifest(manifest)
  return manifest
}

export function renderChecksums(mainArtifact, evidenceArtifact) {
  for (const [label, artifact] of [
    ['main archive', mainArtifact],
    ['evidence archive', evidenceArtifact],
  ]) {
    if (!Number.isSafeInteger(artifact?.bytes)
      || artifact.bytes < 0
      || typeof artifact?.sha256 !== 'string'
      || !/^[0-9a-f]{64}$/.test(artifact.sha256)) {
      throw new Error(`${label} identity is invalid`)
    }
  }
  return [
    `${mainArtifact.sha256}  ${MAIN_ARCHIVE_NAME}`,
    `${evidenceArtifact.sha256}  ${EVIDENCE_ARCHIVE_NAME}`,
    '',
  ].join('\n')
}

export function isExpectedUnsignedSpctlAssessment(code, value) {
  return classifyAdhocSpctlAssessment(code, value) !== null
}

export function classifyAdhocSpctlAssessment(code, value, diagnostic = '') {
  if (code !== 3 || typeof value !== 'string' || typeof diagnostic !== 'string') return null
  const primary = value.trim()
  const detail = diagnostic.trim()
  const assessment = [primary, detail].filter(Boolean).join('\n')
  if (assessment === ''
    || /malware|malicious|revoked|damaged|resource envelope|no resources|developer id|notari[sz]ed/i
      .test(assessment)) {
    return null
  }
  const rawAssessment = /<key>\s*assessment:verdict\s*<\/key>/i.test(primary)
  if (rawAssessment) {
    const diagnosticLines = detail.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    const bareDiagnostic = diagnosticLines.length === 1 && /^.+:\s*rejected$/.test(diagnosticLines[0])
    if (!bareDiagnostic
      || !/<key>\s*assessment:verdict\s*<\/key>\s*<false\s*\/>/i.test(primary)
      || !/<key>\s*assessment:authority\.flags\s*<\/key>\s*<integer>\s*0\s*<\/integer>/i.test(primary)
      || !/<key>\s*assessment:remote\s*<\/key>\s*<(?:true|false)\s*\/>/i.test(primary)) {
      return null
    }
    const keys = [...primary.matchAll(/<key>\s*([^<]+?)\s*<\/key>/gi)].map(match => match[1].trim())
    const allowedKeys = new Set([
      'assessment:authority.flags',
      'assessment:authority:source',
      'assessment:remote',
      'assessment:verdict',
    ])
    if (keys.length < 3
      || new Set(keys).size !== keys.length
      || keys.some(key => !allowedKeys.has(key))) {
      return null
    }
    const sourceKeyPresent = keys.includes('assessment:authority:source')
    if (!sourceKeyPresent) return 'REJECTED_ADHOC_UNATTRIBUTED'
    const rawSource = /<key>\s*assessment:authority:source\s*<\/key>\s*<string>\s*([^<]+?)\s*<\/string>/i
      .exec(primary)?.[1]?.trim()
    return rawSource?.toLowerCase() === 'no usable signature'
      ? 'REJECTED_UNSIGNED_EXPECTED'
      : null
  }
  const lines = assessment.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (lines.length === 1 && /^.+:\s*rejected$/.test(lines[0])) {
    return 'REJECTED_ADHOC_UNATTRIBUTED'
  }
  return lines.length === 2
    && /^.+:\s*rejected$/.test(lines[0])
    && lines[1].toLowerCase() === 'source=no usable signature'
    ? 'REJECTED_UNSIGNED_EXPECTED'
    : null
}

export function assertPathFreeManifest(value) {
  assertPathFreeJson(value, { rejectPlaceholders: true })
}

function assertPathFreeEvidenceJson(value) {
  assertPathFreeJson(value, { rejectPlaceholders: false })
}

function assertPathFreeJson(value, options) {
  const encoded = JSON.stringify(value)
  const normalized = encoded.replaceAll('\\\\', '\\')
  const forbidden = [
    /(?:^|["'\s:=])\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+/i,
    /(?:^|["'\s:=])\/[A-Za-z0-9._-]+(?=$|["'\s,}])/i,
    /[A-Za-z]:[\\/][^\\/"'\s]+(?:[\\/][^\\/"'\s]+)*/i,
    /(?:^|["'\s:=])\\\\[^\\/"'\s]+\\[^\\/"'\s]+/i,
    /(?:file|webpack):\/\/\//i,
  ]
  if (normalized.includes(homedir()) || forbidden.some(pattern => pattern.test(normalized))) {
    throw new Error('release evidence contains a local path (absolute)')
  }
  if (options.rejectPlaceholders === true
    && /(?:<[^>]+>|\b(?:PENDING|PLACEHOLDER|REPLACE_ME|TODO|UNKNOWN)\b)/i.test(encoded)) {
    throw new Error('release delivery manifest contains a placeholder')
  }
  if (containsForbiddenEvidenceField(value)) {
    throw new Error('release evidence contains forbidden credential or userData fields')
  }
}

function containsForbiddenEvidenceField(value) {
  if (value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(containsForbiddenEvidenceField)
  return Object.entries(value).some(([key, nested]) => (
    /^(?:api[_-]?key|credential_value|userData)$/i.test(key)
    || containsForbiddenEvidenceField(nested)
  ))
}

async function buildEvidence(options) {
  const {
    root,
    work,
    evidenceRoot,
    app,
    appManifestPath,
    appManifest,
    sidecarManifestPath,
    identity,
    mainArtifact,
    smoke,
    spctl,
    python,
  } = options
  const files = {
    app_manifest: 'studio-preview.manifest.json',
    sidecar_manifest: 'controller-sidecar.manifest.json',
    sbom: 'creative-rsi-studio.cdx.json',
    licenses: 'licenses.json',
    source_archive: 'creative-loop2rsi-source.tar',
    source_manifest: 'source.manifest.json',
    delivery_manifest: 'release-delivery-manifest.json',
  }
  await copyEvidenceFile(appManifestPath, join(evidenceRoot, files.app_manifest))
  await copyEvidenceFile(sidecarManifestPath, join(evidenceRoot, files.sidecar_manifest))

  const sidecarManifest = JSON.parse(await readFile(sidecarManifestPath, 'utf8'))
  const packagedEvidence = await buildPackagedReleaseEvidence({ app, sidecarManifest })
  assertPackagedEvidenceBoundToAppManifest(packagedEvidence.licenses, appManifest)
  await writeFile(
    join(evidenceRoot, files.sbom),
    `${JSON.stringify(packagedEvidence.sbom, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx', mode: 0o644 },
  )
  await writeFile(
    join(evidenceRoot, files.licenses),
    `${JSON.stringify(packagedEvidence.licenses, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx', mode: 0o644 },
  )
  await run(python, [
    join(root, 'tools', 'audit_release_archive.py'),
    root,
    '--treeish', identity.git_commit,
    '--output', join(evidenceRoot, files.source_archive),
    '--manifest', join(evidenceRoot, files.source_manifest),
  ], { cwd: root, timeoutMs: 300_000 })
  await validateSourceArchiveEvidence(
    join(evidenceRoot, files.source_archive),
    join(evidenceRoot, files.source_manifest),
    identity,
  )

  for (const name of Object.values(files).filter(name => name !== files.delivery_manifest)) {
    await chmod(join(evidenceRoot, name), 0o644)
  }
  const componentEvidence = {}
  for (const [key, name] of Object.entries(files)) {
    if (key === 'delivery_manifest') continue
    const artifact = await artifactIdentity(join(evidenceRoot, name))
    componentEvidence[key] = { filename: name, ...artifact }
  }
  componentEvidence.app_tree = {
    file_count: appManifest.file_count,
    tree_sha256: appManifest.tree_sha256,
  }
  const delivery = createDeliveryManifest({
    identity,
    mainArtifact,
    evidence: componentEvidence,
    smoke,
    spctl,
  })
  await writeFile(
    join(evidenceRoot, files.delivery_manifest),
    `${JSON.stringify(delivery, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx', mode: 0o644 },
  )
  for (const name of Object.values(files).filter(name => name.endsWith('.json'))) {
    const parsed = JSON.parse(await readFile(join(evidenceRoot, name), 'utf8'))
    if (name === files.delivery_manifest) assertPathFreeManifest(parsed)
    else assertPathFreeEvidenceJson(parsed)
  }
  const textAuditRoot = join(work, 'public-evidence-text')
  const textAuditFiles = await preparePublicEvidenceAuditTree({
    evidenceRoot,
    auditRoot: textAuditRoot,
    files: Object.values(files),
    sourceArchive: files.source_archive,
  })
  const maxEvidenceBytes = Math.max(...await Promise.all(
    textAuditFiles.map(async name => (await lstat(join(textAuditRoot, name))).size),
  ))
  await run(python, [
    join(root, 'tools', 'audit_public_tree.py'),
    textAuditRoot,
    '--mode', 'full',
    '--max-bytes', String(maxEvidenceBytes),
  ], { cwd: root, timeoutMs: 300_000 })
  return { expectedFiles: Object.values(files).sort() }
}

export async function validateSourceArchiveEvidence(archivePath, manifestPath, identity) {
  await assertRegularFile(archivePath, 'audited source archive')
  await assertRegularFile(manifestPath, 'audited source archive manifest')
  const archiveBytes = await readFile(archivePath)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest?.schema_version !== '1'
    || manifest?.kind !== 'ReleaseArchiveAudit'
    || manifest?.commit !== identity?.git_commit
    || manifest?.tree !== identity?.git_tree
    || manifest?.archive_format !== 'tar'
    || manifest?.archive_sha256 !== sha256(archiveBytes)
    || !Number.isSafeInteger(manifest?.file_count)
    || manifest.file_count <= 0
    || manifest?.scanned_file_count !== manifest.file_count
    || !Array.isArray(manifest?.files)
    || manifest.files.length !== manifest.file_count) {
    throw new Error('audited source archive differs from its manifest or release identity')
  }
  const seen = new Set()
  for (const file of manifest.files) {
    if (file === null
      || typeof file !== 'object'
      || Array.isArray(file)
      || typeof file.path !== 'string'
      || file.path === ''
      || isAbsolute(file.path)
      || file.path.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
      || !/^(?:100644|100755)$/.test(file.mode ?? '')
      || !/^[0-9a-f]{40}$/.test(file.git_blob ?? '')
      || !Number.isSafeInteger(file.bytes)
      || file.bytes < 0
      || !/^[0-9a-f]{64}$/.test(file.sha256 ?? '')
      || seen.has(file.path)) {
      throw new Error('audited source archive file inventory is invalid')
    }
    seen.add(file.path)
  }
  assertPathFreeEvidenceJson(manifest)
  return manifest
}

export async function preparePublicEvidenceAuditTree(options) {
  const evidenceRoot = resolve(options.evidenceRoot)
  const auditRoot = resolve(options.auditRoot)
  await assertRegularDirectory(evidenceRoot, 'release evidence root')
  await assertMissing(auditRoot, 'public evidence text audit root')
  const files = [...new Set(options.files)].sort()
  if (!files.includes(options.sourceArchive)
    || files.some(name => typeof name !== 'string'
      || name === ''
      || isAbsolute(name)
      || name.includes('/')
      || name.includes('\\'))) {
    throw new Error('release evidence audit file contract is invalid')
  }
  await mkdir(auditRoot, { mode: 0o755 })
  const textFiles = files.filter(name => name !== options.sourceArchive)
  for (const name of textFiles) {
    await copyEvidenceFile(join(evidenceRoot, name), join(auditRoot, name))
  }
  return textFiles
}

async function archiveEvidence(evidenceRoot, archive, expectedFiles) {
  await assertMissing(archive, 'release evidence archive')
  await dittoCreate(evidenceRoot, archive)
  await assertZipContainsOnly(archive, EVIDENCE_DIRECTORY_NAME)
  const extracted = await mkdtemp(join(tmpdir(), 'creative-rsi-evidence-roundtrip-'))
  try {
    await dittoExtract(archive, extracted)
    const roots = await readdir(extracted)
    if (roots.length !== 1 || roots[0] !== EVIDENCE_DIRECTORY_NAME) {
      throw new Error(`evidence archive root is invalid: ${roots.sort().join(', ')}`)
    }
    const actualFiles = (await readdir(join(extracted, EVIDENCE_DIRECTORY_NAME))).sort()
    if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
      throw new Error(`evidence archive files differ: ${actualFiles.join(', ')}`)
    }
    await assertNoArchivedMacMetadata(join(extracted, EVIDENCE_DIRECTORY_NAME))
    for (const name of expectedFiles) {
      const source = await artifactIdentity(join(evidenceRoot, name))
      const unpacked = await artifactIdentity(join(extracted, EVIDENCE_DIRECTORY_NAME, name))
      if (JSON.stringify(source) !== JSON.stringify(unpacked)) {
        throw new Error(`evidence archive changed file bytes: ${name}`)
      }
    }
  } finally {
    await rm(extracted, { force: true, recursive: true })
  }
}

async function validateMacMetadata(app) {
  const plist = join(app, 'Contents', 'Info.plist')
  const result = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist])
  const parsed = JSON.parse(result.stdout)
  if (parsed.CFBundleIconFile !== MAC_ICON_FILE
    || parsed.LSMinimumSystemVersion !== '13.0'
    || parsed.CFBundleIdentifier !== 'org.creativeloop2rsi.studio'
    || parsed.CFBundleDisplayName !== PRODUCT_NAME
    || parsed.CFBundleExecutable !== PRODUCT_NAME
    || parsed.CFBundleName !== PRODUCT_NAME
    || parsed.CFBundleShortVersionString !== MAC_BUNDLE_SHORT_VERSION
    || parsed.CFBundleVersion !== MAC_BUNDLE_BUILD_VERSION
    || parsed.NSAppTransportSecurity?.NSAllowsArbitraryLoads !== false) {
    throw new Error('macOS release metadata is invalid')
  }
  const remaining = UNUSED_MAC_PRIVACY_KEYS.filter(key => Object.hasOwn(parsed, key))
  if (remaining.length !== 0) {
    throw new Error(`macOS release retains unused privacy declarations: ${remaining.join(', ')}`)
  }
  await assertRegularFile(join(app, 'Contents', 'Resources', MAC_ICON_FILE), 'macOS app icon')
}

async function packagedSmoke(root, app) {
  const result = await run(process.execPath, [
    join(root, 'apps', 'desktop', 'scripts', 'packaged-smoke.mjs'),
    app,
  ], { cwd: root, timeoutMs: 90_000 })
  const receipt = JSON.parse(result.stdout)
  if (receipt.status !== 'PASS'
    || receipt.app_version !== RELEASE_VERSION
    || receipt.packaged !== true
    || receipt.credential !== 'not-configured'
    || receipt.model_requests !== 0) {
    throw new Error('packaged smoke did not meet the release contract')
  }
  return {
    status: 'PASS',
    app_version: receipt.app_version,
    packaged: true,
    credential: 'not-configured',
    model_requests: 0,
  }
}

async function expectedUnsignedSpctl(app) {
  const signature = await run('/usr/bin/codesign', ['--display', '--verbose=4', app])
  const signatureDetail = `${signature.stdout}\n${signature.stderr}`
  if (!/\bflags=0x2\(adhoc\)(?:\s|$)/.test(signatureDetail)
    || !/^Signature=adhoc$/m.test(signatureDetail)
    || !/^TeamIdentifier=not set$/m.test(signatureDetail)
    || /^Authority=/m.test(signatureDetail)) {
    throw new Error('macOS preview root signature is not the expected anonymous ad-hoc seal')
  }
  const rawResult = await run('/usr/sbin/spctl', [
    '--assess', '--type', 'execute', '--verbose=4', '--raw', app,
  ], {
    allowFailure: true,
    timeoutMs: 60_000,
  })
  const rawAssessment = `${rawResult.stdout}\n${rawResult.stderr}`.trim()
  const rawClassification = classifyAdhocSpctlAssessment(
    rawResult.code,
    rawResult.stdout,
    rawResult.stderr,
  )
  if (rawClassification !== null) return rawClassification
  const rawUnsupported = rawResult.code !== 3
    && /(?:unknown|unrecognized|illegal|invalid).{0,40}(?:option|argument).{0,40}(?:--)?raw|usage:/i
      .test(rawAssessment)
  if (!rawUnsupported) {
    throw new Error(`ad-hoc macOS preview has an unexpected raw spctl assessment; exit=${String(rawResult.code)}`)
  }
  const result = await run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', app], {
    allowFailure: true,
    timeoutMs: 60_000,
  })
  const assessment = `${result.stdout}\n${result.stderr}`.trim()
  const classification = classifyAdhocSpctlAssessment(result.code, result.stdout, result.stderr)
  if (classification === null) {
    throw new Error(`ad-hoc macOS preview has an unexpected spctl assessment; exit=${String(result.code)}`)
  }
  return classification
}

async function strictCodesign(app) {
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { timeoutMs: 300_000 })
}

async function dittoCreate(source, archive) {
  await run('/usr/bin/ditto', [
    '-c',
    '-k',
    '--keepParent',
    '--norsrc',
    '--noextattr',
    '--noqtn',
    '--noacl',
    '--nopersistRootless',
    source,
    archive,
  ], { timeoutMs: 300_000 })
}

async function dittoExtract(archive, destination) {
  await run('/usr/bin/ditto', [
    '-x',
    '-k',
    '--norsrc',
    '--noextattr',
    '--noqtn',
    '--noacl',
    '--nopersistRootless',
    archive,
    destination,
  ], { timeoutMs: 300_000 })
}

async function assertZipContainsOnly(archive, expectedRoot) {
  const result = await run('/usr/bin/unzip', ['-Z1', archive])
  const entries = result.stdout.split(/\r?\n/).filter(Boolean)
  if (entries.length === 0
    || entries.some(entry => entry !== `${expectedRoot}/` && !entry.startsWith(`${expectedRoot}/`))
    || entries.some(entry => entry.split('/').some(segment => segment === '__MACOSX' || segment.startsWith('._')))) {
    throw new Error(`ZIP contains entries outside ${expectedRoot}`)
  }
}

async function assertNoArchivedMacMetadata(root) {
  const result = await run('/usr/bin/xattr', ['-lr', root], { allowFailure: true })
  // macOS may assign com.apple.provenance to newly created extraction targets;
  // reject only metadata that could have been carried by the archive itself.
  if (result.code !== 0
    || /com\.apple\.(?:quarantine|ResourceFork|FinderInfo):/i.test(result.stdout)) {
    throw new Error(`ZIP round-trip retained forbidden macOS metadata: ${basename(root)}`)
  }
}

async function pinnedPnpmCli(root) {
  if (process.version !== EXPECTED_NODE) {
    throw new Error(`release packaging requires Node ${EXPECTED_NODE}; observed ${process.version}`)
  }
  const pnpmCli = process.env.npm_execpath
  if (pnpmCli === undefined || !isAbsolute(pnpmCli)) {
    throw new Error('release packaging must run from the pinned pnpm script')
  }
  await assertRegularFile(pnpmCli, 'pnpm CLI')
  const version = (await run(process.execPath, [pnpmCli, '--version'], { cwd: root })).stdout.trim()
  if (version !== EXPECTED_PNPM) {
    throw new Error(`release packaging requires pnpm ${EXPECTED_PNPM}; observed ${version}`)
  }
  return pnpmCli
}

async function assertReleaseVersions(root) {
  for (const relativePath of ['package.json', join('apps', 'desktop', 'package.json')]) {
    const manifest = JSON.parse(await readFile(join(root, relativePath), 'utf8'))
    if (manifest?.version !== RELEASE_VERSION) {
      throw new Error(`release version differs in ${relativePath}: ${String(manifest?.version)}`)
    }
  }
}

async function assertPython311(python, root) {
  const result = await run(python, [
    '-c',
    'import json,platform,sys; print(json.dumps({"version":platform.python_version(),"minor":list(sys.version_info[:2])}))',
  ], { cwd: root })
  const identity = JSON.parse(result.stdout)
  if (JSON.stringify(identity.minor) !== '[3,11]') {
    throw new Error(`release packaging requires CPython 3.11; observed ${String(identity.version)}`)
  }
}

async function gitIdentity(root) {
  return {
    git_commit: (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim(),
    git_tree: (await run('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root })).stdout.trim(),
  }
}

async function assertCleanGitTree(root) {
  const status = (await run('git', [
    'status', '--porcelain=v1', '--untracked-files=all',
  ], { cwd: root })).stdout
  if (status !== '') throw new Error('release packaging requires a clean tracked and untracked source tree')
}

async function copyEvidenceFile(source, destination) {
  await assertRegularFile(source, `release evidence ${basename(source)}`)
  await cp(source, destination, { force: false, errorOnExist: true })
  await chmod(destination, 0o644)
}

function isPackagedNodePackageRoot(relativeDirectory) {
  if (relativeDirectory === '.') return true
  const segments = relativeDirectory.split('/')
  const nodeModules = segments.lastIndexOf('node_modules')
  if (nodeModules < 0) return false
  const tail = segments.slice(nodeModules + 1)
  return (tail.length === 1 && !tail[0].startsWith('.') && !tail[0].startsWith('@'))
    || (tail.length === 2 && tail[0].startsWith('@') && !tail[1].startsWith('.'))
}

function manifestDependencyNames(manifest, field) {
  const value = manifest[field]
  if (value === undefined) return []
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`packaged Node package ${field} field is invalid: ${manifest.name}`)
  }
  const names = Object.keys(value).sort()
  if (names.some(name => !/^(?:@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+$/.test(name))) {
    throw new Error(`packaged Node package ${field} name is invalid: ${manifest.name}`)
  }
  return names
}

function requiredPeerDependencyNames(manifest) {
  const names = manifestDependencyNames(manifest, 'peerDependencies')
  const metadata = manifest.peerDependenciesMeta
  if (metadata !== undefined && (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata))) {
    throw new Error(`packaged Node package peer dependency metadata is invalid: ${manifest.name}`)
  }
  return names.filter(name => metadata?.[name]?.optional !== true)
}

function declaredPackageLicenses(manifest) {
  const values = []
  const add = value => {
    if (typeof value === 'string' && value.trim() !== '') values.push(value.trim())
    else if (value?.type !== undefined) add(value.type)
  }
  add(manifest.license)
  if (Array.isArray(manifest.licenses)) manifest.licenses.forEach(add)
  return [...new Set(values)].sort()
}

function packageRepositoryUrl(manifest) {
  return typeof manifest.repository === 'string'
    ? manifest.repository
    : manifest.repository?.url
}

function packageRepositoryDirectory(manifest) {
  return typeof manifest.repository === 'object' && manifest.repository !== null
    ? manifest.repository.directory
    : undefined
}

function uniqueFileEvidence(values) {
  const byPath = new Map()
  for (const value of values) {
    const existing = byPath.get(value.path)
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(value)) {
      throw new Error(`packaged evidence has conflicting bytes for ${value.path}`)
    }
    byPath.set(value.path, value)
  }
  return [...byPath.values()].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
}

function prefixFileEvidence(prefix, file) {
  if (typeof file?.path !== 'string'
    || file.path === ''
    || isAbsolute(file.path)
    || file.path.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('packaged file evidence path is invalid')
  }
  return { ...file, path: `${prefix}/${file.path}` }
}

async function appFileEvidence(app, relativePath) {
  if (isAbsolute(relativePath)
    || relativePath.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('application notice path is invalid')
  }
  const path = join(app, ...relativePath.split('/'))
  await assertRegularFile(path, `application notice ${relativePath}`)
  const bytes = await readFile(path)
  return { path: relativePath, bytes: bytes.length, sha256: sha256(bytes) }
}

function compareComponentIdentity(left, right) {
  if (left.name !== right.name) return left.name < right.name ? -1 : 1
  if (left.version !== right.version) return left.version < right.version ? -1 : 1
  return 0
}

function nodeBomRef(component) {
  return `npm:${component.name}@${component.version}`
}

function runtimeBomRef(component) {
  return `runtime:${component.name}@${component.version}`
}

function aggregateBomRef(component) {
  return `aggregate:${SHARP_LIBVIPS_PACKAGE}/${component.upstream_library_name}`
}

function cycloneDxNodeComponent(component, type) {
  const properties = [
    ...component.package_jsons.flatMap(file => [
      { name: 'creative-rsi:package-json-path', value: file.path },
      { name: 'creative-rsi:package-json-sha256', value: file.sha256 },
    ]),
    ...component.notices.flatMap(file => [
      { name: 'creative-rsi:notice-path', value: file.path },
      { name: 'creative-rsi:notice-sha256', value: file.sha256 },
    ]),
  ]
  return {
    type,
    'bom-ref': nodeBomRef(component),
    name: component.name,
    version: component.version,
    ...(component.licenses.length === 0
      ? {}
      : { licenses: component.licenses.map(name => ({ license: { name } })) }),
    properties,
  }
}

async function artifactIdentity(path) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`release artifact must be a regular file: ${path}`)
  return { bytes: info.size, sha256: sha256(await readFile(path)) }
}

async function assertRegularDirectory(path, label) {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a regular directory`)
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

async function assertNoSymlinkAncestors(root, target) {
  let current = root
  for (const segment of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, segment)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`release output ancestor must be a regular directory: ${current}`)
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function inside(root, target) {
  const value = relative(root, target)
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value))
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
      const result = {
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }
      if (code !== 0 && options.allowFailure !== true) {
        rejectPromise(new Error(`${basename(command)} failed with exit ${String(code)}: ${result.stderr.slice(0, 2000)}`))
      } else resolvePromise(result)
    })
  })
}
