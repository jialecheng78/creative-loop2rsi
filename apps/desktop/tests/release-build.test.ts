import { createHash } from 'node:crypto'
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import {
  PACKAGED_NOTICE_MAPPINGS,
  installElectronRuntimeEvidence,
  installPackagedDependencyNotices,
  inventoryTree,
  sealMacBundle,
} from '../scripts/preview-build-lib.mjs'
import {
  CHECKSUMS_NAME,
  EVIDENCE_ARCHIVE_NAME,
  MAIN_ARCHIVE_NAME,
  RELEASE_TAG,
  archiveMacApp,
  assertPackagedEvidenceBoundToAppManifest,
  assertPathFreeManifest,
  assertSbomLicenseComponentParity,
  buildPackagedReleaseEvidence,
  classifyAdhocSpctlAssessment,
  collectPackagedNodeComponents,
  createDeliveryManifest,
  isExpectedUnsignedSpctlAssessment,
  releaseOutputPath,
  renderChecksums,
  preparePublicEvidenceAuditTree,
  validateSourceArchiveEvidence,
} from '../scripts/release-build-lib.mjs'

const temporary: string[] = []
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const requiredDsh = [
  '@deepseek-ai/dsh-agent-spine-demo',
  '@deepseek-ai/dsh-llm-deepseek',
  '@deepseek-ai/dsh-sdk-client',
  '@deepseek-ai/dsh-sdk-jsonrpc-demo',
  '@deepseek-ai/dsh-sdk-jsonrpc-server',
]

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

function physicalPackageRoot(root: string, name: string, version: string, variant = ''): string {
  const storeName = `${name.replace('/', '+')}@${version}${variant}`
  return join(root, 'node_modules', '.pnpm', storeName, 'node_modules', ...name.split('/'))
}

async function writeSyntheticPackage(
  directory: string,
  manifest: Readonly<Record<string, unknown>>,
  notice?: string,
): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeJson(join(directory, 'package.json'), manifest)
  if (notice !== undefined) await writeFile(join(directory, 'LICENSE'), notice)
}

function packagedManifestForMapping(mapping: any): Readonly<Record<string, unknown>> {
  return {
    name: mapping.target.name,
    version: mapping.target.version,
    license: mapping.target.license,
    repository: mapping.target.declared_repository_directory === undefined
      ? mapping.target.repository
      : {
          type: 'git',
          url: mapping.target.repository,
          directory: mapping.target.declared_repository_directory,
        },
  }
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(temporary.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

async function buildSyntheticPackagedEvidenceFixture() {
  const root = await mkdtemp(join(tmpdir(), 'release-packaged-evidence-'))
  temporary.push(root)
  const app = join(root, 'Creative RSI Studio.app')
  const resources = join(app, 'Contents', 'Resources')
  const payload = join(resources, 'app')
  await writeSyntheticPackage(payload, {
    name: '@creative-loop2rsi/desktop',
    version: '1.0.0-alpha.1',
    license: 'Apache-2.0',
  }, 'synthetic Apache-2.0 application license\n')
  for (const name of requiredDsh) {
    await writeSyntheticPackage(physicalPackageRoot(payload, name, '0.1.0-rc.6'), {
      name,
      version: '0.1.0-rc.6',
      license: 'MIT',
    }, `synthetic notice for ${name}\n`)
  }

  const pinnedPackageRoot = (name: string, version: string) => join(
    repositoryRoot,
    'node_modules',
    '.pnpm',
    `${name.replace('/', '+')}@${version}`,
    'node_modules',
    ...name.split('/'),
  )
  const targetRoots = new Map<string, string>()
  for (const mapping of PACKAGED_NOTICE_MAPPINGS as any[]) {
    const variants = mapping.target.name === '@aws-sdk/nested-clients'
      || mapping.target.name === '@img/sharp-libvips-darwin-arm64'
      ? ['', '_peer-copy']
      : ['']
    for (const variant of variants) {
      const targetRoot = physicalPackageRoot(payload, mapping.target.name, mapping.target.version, variant)
      if (variant === '') targetRoots.set(`${mapping.target.name}@${mapping.target.version}`, targetRoot)
      await writeSyntheticPackage(targetRoot, packagedManifestForMapping(mapping))
      for (const evidence of mapping.evidence_files ?? []) {
        await cp(
          join(pinnedPackageRoot(mapping.target.name, mapping.target.version), evidence.file),
          join(targetRoot, evidence.file),
        )
      }
    }
  }

  const workspace = join(root, 'workspace')
  for (const mapping of PACKAGED_NOTICE_MAPPINGS as any[]) {
    if (mapping.source.kind === 'tracked') {
      const destination = join(workspace, ...mapping.source.file.split('/'))
      await mkdir(dirname(destination), { recursive: true })
      await cp(join(repositoryRoot, ...mapping.source.file.split('/')), destination)
      continue
    }
    const sourceRoot = physicalPackageRoot(workspace, mapping.source.name, mapping.source.version)
    await writeSyntheticPackage(sourceRoot, {
      name: mapping.source.name,
      version: mapping.source.version,
      license: mapping.target.license,
      repository: mapping.target.repository,
    })
    await cp(
      join(pinnedPackageRoot(mapping.source.name, mapping.source.version), mapping.source.file),
      join(sourceRoot, mapping.source.file),
    )
  }
  await installPackagedDependencyNotices(payload, workspace)

  const electronDist = join(root, 'electron-dist')
  const executable = join(app, 'Contents', 'MacOS', 'Creative RSI Studio')
  await mkdir(electronDist, { recursive: true })
  await mkdir(dirname(executable), { recursive: true })
  await writeFile(join(electronDist, 'LICENSE'), 'synthetic Electron MIT license\n')
  await writeFile(join(electronDist, 'LICENSES.chromium.html'), '<html>synthetic Chromium notices</html>\n')
  await writeFile(executable, 'synthetic executable\n')
  await installElectronRuntimeEvidence({
    electronDist,
    resources,
    executable,
    runtimeVersions: {
      electron: '43.4.0',
      node: '24.18.1',
      chrome: '150.0.7871.224',
    },
  })

  const controller = join(resources, 'controller')
  const pythonNotice = Buffer.from('synthetic CPython PSF license\n')
  const pyinstallerNotice = Buffer.from('synthetic PyInstaller copying notice\n')
  await mkdir(join(controller, '_licenses'), { recursive: true })
  await writeFile(join(controller, '_licenses', 'CPython-LICENSE.txt'), pythonNotice)
  await writeFile(join(controller, '_licenses', 'PyInstaller-COPYING.txt'), pyinstallerNotice)
  const sidecarManifest = {
    python: '3.11.14',
    pyinstaller: '6.22.0',
    runtime_components: [
      {
        name: 'CPython',
        version: '3.11.14',
        license: 'PSF-2.0',
        notice: {
          path: '_licenses/CPython-LICENSE.txt',
          bytes: pythonNotice.length,
          sha256: sha256(pythonNotice),
        },
      },
      {
        name: 'PyInstaller',
        version: '6.22.0',
        license: 'GPL-2.0-or-later WITH Bootloader-exception',
        notice: {
          path: '_licenses/PyInstaller-COPYING.txt',
          bytes: pyinstallerNotice.length,
          sha256: sha256(pyinstallerNotice),
        },
      },
    ],
  }
  await writeFile(join(resources, 'LICENSE'), 'synthetic application Apache-2.0 license\n')
  await writeFile(join(resources, 'THIRD_PARTY_NOTICES.md'), 'synthetic third-party notices\n')
  const deepseekNotice = join(resources, 'third_party', 'licenses', 'deepseek-harness-MIT.txt')
  await mkdir(dirname(deepseekNotice), { recursive: true })
  await writeFile(deepseekNotice, 'synthetic DeepSeek harness MIT license\n')
  return {
    root,
    app,
    payload,
    resources,
    sidecarManifest,
    provenancePath: join(payload, 'release-license-provenance.json'),
    sharpRoot: targetRoots.get('@img/sharp-libvips-darwin-arm64@1.3.2')!,
  }
}

describe('macOS release packaging', () => {
  it('uses the fixed alpha output contract', () => {
    expect(releaseOutputPath('/repo')).toBe('/repo/dist/releases/studio-v1.0.0-alpha.1')
    expect(RELEASE_TAG).toBe('studio-v1.0.0-alpha.1')
    expect(MAIN_ARCHIVE_NAME).toBe('Creative-RSI-Studio-1.0.0-alpha.1-macos-arm64.zip')
    expect(EVIDENCE_ARCHIVE_NAME).toBe('Creative-RSI-Studio-1.0.0-alpha.1-evidence.zip')
    expect(CHECKSUMS_NAME).toBe('SHA256SUMS.txt')
  })

  it('binds the main archive and evidence payload without a recursive evidence-archive digest', () => {
    const manifest = createDeliveryManifest({
      identity: { git_commit: 'a'.repeat(40), git_tree: 'b'.repeat(40) },
      mainArtifact: {
        bytes: 123,
        sha256: 'c'.repeat(64),
        round_trip_inventory: 'PASS',
        strict_codesign: 'PASS',
      },
      evidence: {
        app_manifest: { filename: 'studio-preview.manifest.json', bytes: 456, sha256: 'd'.repeat(64) },
      },
      smoke: {
        status: 'PASS',
        app_version: '1.0.0-alpha.1',
        packaged: true,
        credential: 'not-configured',
        model_requests: 0,
      },
      spctl: 'REJECTED_UNSIGNED_EXPECTED',
    }) as any

    expect(manifest.signing).toEqual({
      developer_id_signed: false,
      notarized: false,
      adhoc_sealed: true,
      strict_codesign: 'PASS',
      spctl: 'REJECTED_UNSIGNED_EXPECTED',
    })
    expect(manifest.artifacts.main_archive).toEqual({
      filename: MAIN_ARCHIVE_NAME,
      bytes: 123,
      sha256: 'c'.repeat(64),
    })
    expect(manifest.artifacts.evidence_archive).toEqual({
      filename: EVIDENCE_ARCHIVE_NAME,
      digest_bound_by: CHECKSUMS_NAME,
    })
    expect(manifest.artifacts.evidence_archive).not.toHaveProperty('sha256')
    expect(manifest.artifacts.evidence_archive).not.toHaveProperty('bytes')
    expect(JSON.stringify(manifest)).not.toMatch(/PENDING|PLACEHOLDER|REPLACE_ME|TODO|UNKNOWN/)
  })

  it('rejects local paths, placeholders, credential material, and userData fields', () => {
    const privateTemporary = ['', 'private', 'tmp', 'build', 'app'].join('/')
    const macHome = ['', 'Users', 'synthetic', 'build', 'app'].join('/')
    const windowsHome = ['Q:', 'Users', 'synthetic', 'build', 'app'].join('\\')
    const windowsBuild = ['C:', 'build', 'app'].join('\\')
    const uncBuild = ['', '', 'server', 'share', 'app'].join('\\')
    expect(() => assertPathFreeManifest({ path: privateTemporary })).toThrow('local path')
    expect(() => assertPathFreeManifest({ path: ['', 'tmp'].join('/') })).toThrow('local path')
    expect(() => assertPathFreeManifest({ path: macHome })).toThrow('local path')
    expect(() => assertPathFreeManifest({ path: windowsHome })).toThrow('local path')
    expect(() => assertPathFreeManifest({ path: windowsBuild })).toThrow('local path')
    expect(() => assertPathFreeManifest({ path: uncBuild })).toThrow('local path')
    expect(() => assertPathFreeManifest({ digest: 'PENDING' })).toThrow('placeholder')
    expect(() => assertPathFreeManifest({ api_key: 'synthetic' })).toThrow('credential')
    expect(() => assertPathFreeManifest({ userData: 'relative-state' })).toThrow('userData')
  })

  it('writes an external checksum binding for both ZIP archives', () => {
    expect(renderChecksums(
      { bytes: 123, sha256: 'a'.repeat(64) },
      { bytes: 456, sha256: 'b'.repeat(64) },
    )).toBe([
      `${'a'.repeat(64)}  ${MAIN_ARCHIVE_NAME}`,
      `${'b'.repeat(64)}  ${EVIDENCE_ARCHIVE_NAME}`,
      '',
    ].join('\n'))
    expect(() => renderChecksums(
      { bytes: 123, sha256: 'PENDING' },
      { bytes: 456, sha256: 'b'.repeat(64) },
    )).toThrow('main archive identity is invalid')
  })

  it('keeps the audited source TAR hash-bound while public-tree auditing only text evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-source-archive-evidence-'))
    temporary.push(root)
    const evidenceRoot = join(root, 'evidence')
    const auditRoot = join(root, 'text-audit')
    await mkdir(evidenceRoot)
    const archive = Buffer.from([0x75, 0x73, 0x74, 0x61, 0x72, 0x00, 0x00, 0x01])
    const identity = { git_commit: 'a'.repeat(40), git_tree: 'b'.repeat(40) }
    await writeFile(join(evidenceRoot, 'source.tar'), archive)
    await writeJson(join(evidenceRoot, 'source.manifest.json'), {
      schema_version: '1',
      kind: 'ReleaseArchiveAudit',
      commit: identity.git_commit,
      tree: identity.git_tree,
      archive_format: 'tar',
      archive_sha256: sha256(archive),
      file_count: 1,
      scanned_file_count: 1,
      files: [{
        path: 'README.md',
        mode: '100644',
        git_blob: 'c'.repeat(40),
        bytes: 7,
        sha256: 'd'.repeat(64),
      }],
    })
    await writeJson(join(evidenceRoot, 'delivery.json'), { status: 'PASS' })
    await expect(validateSourceArchiveEvidence(
      join(evidenceRoot, 'source.tar'),
      join(evidenceRoot, 'source.manifest.json'),
      identity,
    )).resolves.toMatchObject({ archive_sha256: sha256(archive) })
    await expect(preparePublicEvidenceAuditTree({
      evidenceRoot,
      auditRoot,
      files: ['source.tar', 'source.manifest.json', 'delivery.json'],
      sourceArchive: 'source.tar',
    })).resolves.toEqual(['delivery.json', 'source.manifest.json'])
    expect(await readdir(auditRoot)).toEqual(['delivery.json', 'source.manifest.json'])
    await expect(readFile(join(auditRoot, 'source.tar'))).rejects.toMatchObject({ code: 'ENOENT' })

    await writeFile(join(evidenceRoot, 'source.tar'), Buffer.concat([archive, Buffer.from([0x02])]))
    await expect(validateSourceArchiveEvidence(
      join(evidenceRoot, 'source.tar'),
      join(evidenceRoot, 'source.manifest.json'),
      identity,
    )).rejects.toThrow('differs from its manifest')
  })

  it('distinguishes explicit unsigned spctl evidence from an unattributed bare ad-hoc rejection', () => {
    expect(classifyAdhocSpctlAssessment(
      3,
      '/Applications/Creative RSI Studio.app: rejected',
    )).toBe('REJECTED_ADHOC_UNATTRIBUTED')
    expect(isExpectedUnsignedSpctlAssessment(3, [
      '/Applications/Creative RSI Studio.app: rejected',
      'source=no usable signature',
    ].join('\n'))).toBe(true)
    expect(classifyAdhocSpctlAssessment(3, [
      '<?xml version="1.0"?>',
      '<plist><dict>',
      '<key>assessment:authority.flags</key><integer>0</integer>',
      '<key>assessment:remote</key><true/>',
      '<key>assessment:verdict</key><false/>',
      '<key>assessment:authority:source</key><string>no usable signature</string>',
      '</dict></plist>',
    ].join('\n'), 'app: rejected')).toBe('REJECTED_UNSIGNED_EXPECTED')
    expect(classifyAdhocSpctlAssessment(3, [
      '<?xml version="1.0"?>',
      '<plist><dict>',
      '<key>assessment:authority.flags</key><integer>0</integer>',
      '<key>assessment:remote</key><true/>',
      '<key>assessment:verdict</key><false/>',
      '</dict></plist>',
    ].join('\n'), '/Applications/Creative RSI Studio.app: rejected')).toBe('REJECTED_ADHOC_UNATTRIBUTED')
    expect(classifyAdhocSpctlAssessment(3, [
      '<plist><dict>',
      '<key>assessment:authority.flags</key><integer>0</integer>',
      '<key>assessment:remote</key><true/>',
      '<key>assessment:verdict</key><false/>',
      '<key>assessment:reason</key><string>policy denied</string>',
      '</dict></plist>',
    ].join('\n'), 'app: rejected')).toBeNull()
    expect(classifyAdhocSpctlAssessment(3, [
      '<plist><dict>',
      '<key>assessment:authority.flags</key><integer>0</integer>',
      '<key>assessment:remote</key><true/>',
      '<key>assessment:verdict</key><false/>',
      '</dict></plist>',
    ].join('\n'), 'app: rejected\nreason=policy denied')).toBeNull()
    expect(classifyAdhocSpctlAssessment(3, [
      '<plist><dict>',
      '<key>assessment:authority.flags</key><integer>0</integer>',
      '<key>assessment:remote</key><true/>',
      '<key>assessment:verdict</key><false/>',
      '<key>assessment:authority:source</key><string>no usable signature</string>',
      '</dict></plist>',
    ].join('\n'), 'app: rejected\nunknown extra')).toBeNull()
    expect(classifyAdhocSpctlAssessment(3, [
      'app: rejected',
      'source=no usable signature',
      'reason=policy denied',
    ].join('\n'))).toBeNull()
    expect(isExpectedUnsignedSpctlAssessment(1, 'app: rejected')).toBe(false)
    expect(isExpectedUnsignedSpctlAssessment(3, 'app: rejected\nsource=Unnotarized Developer ID')).toBe(false)
    expect(isExpectedUnsignedSpctlAssessment(3, 'app: rejected\nmalware detected')).toBe(false)
    expect(() => createDeliveryManifest({
      identity: { git_commit: 'a'.repeat(40), git_tree: 'b'.repeat(40) },
      mainArtifact: {
        bytes: 1, sha256: 'c'.repeat(64), round_trip_inventory: 'PASS', strict_codesign: 'PASS',
      },
      evidence: {},
      smoke: { status: 'PASS' },
      spctl: 'REJECTED_FOR_UNKNOWN_REASON',
    })).toThrow('classification is invalid')
  })

  it.runIf(process.platform !== 'win32')(
    'scans only physical package roots, ignores fixtures and symlinks, and rejects duplicate metadata drift',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'release-package-roots-'))
      temporary.push(root)
      await writeSyntheticPackage(root, {
        name: '@creative-loop2rsi/desktop', version: '1.0.0-alpha.1', license: 'Apache-2.0',
      }, 'root license\n')
      await writeSyntheticPackage(physicalPackageRoot(root, 'plain-runtime', '1.2.3'), {
        name: 'plain-runtime', version: '1.2.3', license: 'MIT',
      }, 'plain license\n')
      await writeSyntheticPackage(physicalPackageRoot(root, '@scope/scoped-runtime', '2.0.0'), {
        name: '@scope/scoped-runtime', version: '2.0.0', license: 'BSD-3-Clause',
      }, 'scoped license\n')
      const duplicateOne = physicalPackageRoot(root, 'duplicate-runtime', '3.0.0', '_peer-one')
      const duplicateTwo = physicalPackageRoot(root, 'duplicate-runtime', '3.0.0', '_peer-two')
      const duplicateManifest = {
        name: 'duplicate-runtime',
        version: '3.0.0',
        license: 'ISC',
        repository: { url: 'https://example.invalid/duplicate.git', directory: 'packages/runtime' },
      }
      await writeSyntheticPackage(duplicateOne, duplicateManifest, 'duplicate license\n')
      await writeSyntheticPackage(duplicateTwo, duplicateManifest, 'duplicate license\n')
      await writeJson(join(duplicateOne, 'fixtures', 'package.json'), {
        name: 'fixture-that-must-not-be-a-component', version: '9.9.9', license: 'MIT',
      })
      const linkedSource = join(root, 'linked-source')
      await writeSyntheticPackage(linkedSource, {
        name: 'linked-runtime', version: '1.0.0', license: 'MIT',
      }, 'linked license\n')
      await mkdir(join(root, 'node_modules'), { recursive: true })
      await symlink(linkedSource, join(root, 'node_modules', 'linked-runtime'))

      const components = await collectPackagedNodeComponents(root)
      expect(components.map(component => `${component.name}@${component.version}`)).toEqual([
        '@creative-loop2rsi/desktop@1.0.0-alpha.1',
        '@scope/scoped-runtime@2.0.0',
        'duplicate-runtime@3.0.0',
        'plain-runtime@1.2.3',
      ])
      const duplicate = components.find(component => component.name === 'duplicate-runtime')!
      expect(duplicate.package_jsons).toHaveLength(2)
      expect(components.some(component => component.name === 'fixture-that-must-not-be-a-component')).toBe(false)
      expect(components.some(component => component.name === 'linked-runtime')).toBe(false)

      await writeJson(join(duplicateTwo, 'package.json'), {
        ...duplicateManifest,
        repository: { url: 'https://example.invalid/drift.git', directory: 'packages/runtime' },
      })
      await expect(collectPackagedNodeComponents(root)).rejects.toThrow('metadata conflicts')
    },
  )

  it('builds path-free SBOM and license evidence from the final App package roots and explicit runtimes', async () => {
    const fixture = await buildSyntheticPackagedEvidenceFixture()
    const evidence = await buildPackagedReleaseEvidence({
      app: fixture.app,
      sidecarManifest: fixture.sidecarManifest,
    })
    expect(() => assertSbomLicenseComponentParity(evidence.sbom, evidence.licenses)).not.toThrow()
    const serialized = JSON.stringify(evidence)
    expect(serialized).not.toContain(fixture.root)
    expect(serialized).not.toContain('@undefined')
    expect(evidence.licenses.evidence_granularity).toBe(
      'physical-npm-package-roots-plus-explicit-runtimes-plus-sharp-libvips-aggregate-declarations',
    )

    const componentNames = new Set(evidence.licenses.components.map((component: any) => component.name))
    for (const name of [
      ...requiredDsh,
      'Electron',
      'Node.js',
      'Chromium',
      'CPython',
      'PyInstaller',
    ]) expect(componentNames.has(name)).toBe(true)
    const aggregates = evidence.licenses.components.filter((component: any) => (
      component.bom_ref.startsWith('aggregate:@img/sharp-libvips-darwin-arm64/')
    ))
    expect(aggregates).toHaveLength(29)
    expect(aggregates.filter((component: any) => component.version !== undefined)).toHaveLength(28)
    expect(aggregates.find((component: any) => component.name === 'sharp-libvips:libnsgif')).toMatchObject({
      license: 'MIT License',
      notice_sources: [{
        upstream_library_name: 'libnsgif',
        upstream_license_declaration: 'MIT License',
        version_evidence: { status: 'not-declared-in-versions.json' },
        component_level_license_text_complete: false,
      }],
    })
    expect(aggregates.find((component: any) => component.name === 'sharp-libvips:libvips')).toMatchObject({
      version: '8.18.3',
      license: 'LGPLv3',
    })
    expect(evidence.licenses.known_limitations).toEqual([
      expect.objectContaining({ status: 'NON_BLOCKING_ALPHA_GAP' }),
    ])
    const nestedAws = evidence.licenses.components.find((component: any) => (
      component.name === '@aws-sdk/nested-clients'
    ))
    expect(nestedAws.notice_sources[0]).toMatchObject({
      target: { declared_repository_directory: 'packages/nested-clients' },
      upstream: {
        tag: 'v3.1108.0',
        tag_object: 'b187769e33bdccafdedf93d5c4ceca8436cc6cff',
        commit: '26b0eb790ff86399b7af7b74ce8c188f25512cc6',
        verified_source_directory: 'packages-internal/nested-clients',
      },
    })
    expect(evidence.licenses.application_notices.map((notice: any) => notice.path)).toContain(
      'Contents/Resources/third_party/licenses/deepseek-harness-MIT.txt',
    )

    const inventory = await inventoryTree(fixture.app, { platform: 'darwin' })
    expect(() => assertPackagedEvidenceBoundToAppManifest(evidence.licenses, { files: inventory })).not.toThrow()
    const firstNotice = evidence.licenses.application_notices[0]
    const tamperedInventory = inventory.map(entry => entry.path === firstNotice.path
      ? { ...entry, sha256: '0'.repeat(64) }
      : entry)
    expect(() => assertPackagedEvidenceBoundToAppManifest(evidence.licenses, { files: tamperedInventory }))
      .toThrow('not bound to the app manifest')
  })

  it('fails closed when packaged provenance, canonical notices, or sharp aggregate evidence drift', async () => {
    const fixture = await buildSyntheticPackagedEvidenceFixture()
    const originalProvenance = JSON.parse(await readFile(fixture.provenancePath, 'utf8'))
    const assertProvenanceDriftRejected = async (mutate: (value: any) => void) => {
      const value = structuredClone(originalProvenance)
      mutate(value)
      await writeJson(fixture.provenancePath, value)
      await expect(buildPackagedReleaseEvidence({
        app: fixture.app,
        sidecarManifest: fixture.sidecarManifest,
      })).rejects.toThrow('pinned mapping')
      await writeJson(fixture.provenancePath, originalProvenance)
    }
    const nestedIndex = originalProvenance.mappings.findIndex((record: any) => (
      record.target.component === '@aws-sdk/nested-clients@3.997.42'
    ))
    await assertProvenanceDriftRejected(value => { value.mappings[nestedIndex].upstream.commit = '0'.repeat(40) })
    await assertProvenanceDriftRejected(value => { value.mappings[nestedIndex].upstream.path = 'OTHER-LICENSE' })
    await assertProvenanceDriftRejected(value => { value.mappings[nestedIndex].source.sha256 = '0'.repeat(64) })
    await assertProvenanceDriftRejected(value => {
      value.mappings[nestedIndex].target.declared_repository_directory = 'packages-internal/nested-clients'
    })

    const duplicatedNotice = structuredClone(originalProvenance)
    expect(duplicatedNotice.mappings[nestedIndex].installed_notices).toHaveLength(2)
    duplicatedNotice.mappings[nestedIndex].installed_notices[1] = structuredClone(
      duplicatedNotice.mappings[nestedIndex].installed_notices[0],
    )
    await writeJson(fixture.provenancePath, duplicatedNotice)
    await expect(buildPackagedReleaseEvidence({
      app: fixture.app,
      sidecarManifest: fixture.sidecarManifest,
    })).rejects.toThrow(/provenance notice/)
    await writeJson(fixture.provenancePath, originalProvenance)

    const sharpIndex = originalProvenance.mappings.findIndex((record: any) => (
      record.target.component === '@img/sharp-libvips-darwin-arm64@1.3.2'
    ))
    const duplicatedEvidence = structuredClone(originalProvenance)
    expect(duplicatedEvidence.mappings[sharpIndex].evidence_files).toHaveLength(2)
    duplicatedEvidence.mappings[sharpIndex].evidence_files[1] = structuredClone(
      duplicatedEvidence.mappings[sharpIndex].evidence_files[0],
    )
    await writeJson(fixture.provenancePath, duplicatedEvidence)
    await expect(buildPackagedReleaseEvidence({
      app: fixture.app,
      sidecarManifest: fixture.sidecarManifest,
    })).rejects.toThrow('provenance component evidence')
    await writeJson(fixture.provenancePath, originalProvenance)

    const versionsPath = join(fixture.sharpRoot, 'versions.json')
    const originalVersions = await readFile(versionsPath)
    await writeFile(versionsPath, `${originalVersions.toString('utf8').trimEnd()} \n`)
    await expect(buildPackagedReleaseEvidence({
      app: fixture.app,
      sidecarManifest: fixture.sidecarManifest,
    })).rejects.toThrow(/component evidence is invalid|versions\.json hash differs/)
    await writeFile(versionsPath, originalVersions)

    const noticePath = join(fixture.sharpRoot, 'NOTICE.md')
    const originalNotice = await readFile(noticePath)
    await writeFile(noticePath, Buffer.concat([originalNotice, Buffer.from('\n')]))
    await expect(buildPackagedReleaseEvidence({
      app: fixture.app,
      sidecarManifest: fixture.sidecarManifest,
    })).rejects.toThrow(/provenance notice|README notice/)
  })

  it.runIf(process.platform === 'darwin')('round-trips an ad-hoc sealed app with exact bytes, links, and modes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-roundtrip-test-'))
    temporary.push(root)
    const app = join(root, 'Creative RSI Studio.app')
    const contents = join(app, 'Contents')
    const executable = join(contents, 'MacOS', 'Creative RSI Studio')
    const resources = join(contents, 'Resources')
    await mkdir(dirname(executable), { recursive: true })
    await mkdir(resources)
    await cp('/usr/bin/true', executable)
    await chmod(executable, 0o755)
    await writeFile(join(resources, 'payload.txt'), 'release-payload\n')
    await symlink('payload.txt', join(resources, 'payload-link.txt'))
    await writeFile(join(contents, 'Info.plist'), [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      '<key>CFBundleExecutable</key><string>Creative RSI Studio</string>',
      '<key>CFBundleIdentifier</key><string>org.creativeloop2rsi.release-test</string>',
      '<key>CFBundlePackageType</key><string>APPL</string>',
      '</dict></plist>',
      '',
    ].join('\n'))
    await sealMacBundle(app)
    const inventory = await inventoryTree(app, { platform: 'darwin' })
    const archive = join(root, 'release.zip')
    let smokeTarget = ''
    const packagedSmoke = async (unpackedApp: string) => {
      smokeTarget = unpackedApp
      return {
        status: 'PASS' as const,
        app_version: '1.0.0-alpha.1',
        packaged: true as const,
        credential: 'not-configured' as const,
        model_requests: 0 as const,
      }
    }
    const artifact = await archiveMacApp({ app, archive, expectedInventory: inventory, packagedSmoke })
    expect(artifact).toEqual({
      bytes: expect.any(Number),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      round_trip_inventory: 'PASS',
      strict_codesign: 'PASS',
      packaged_smoke: {
        status: 'PASS',
        app_version: '1.0.0-alpha.1',
        packaged: true,
        credential: 'not-configured',
        model_requests: 0,
      },
    })
    expect(smokeTarget).not.toBe(app)
    expect(smokeTarget).toContain('creative-rsi-release-roundtrip-')
    expect((await lstat(archive)).isFile()).toBe(true)
    expect((await readFile(archive)).length).toBe(artifact.bytes)
    await expect(archiveMacApp({ app, archive, expectedInventory: inventory, packagedSmoke }))
      .rejects.toThrow('already exists')
  })
})
