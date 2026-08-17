import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, cp, link, lstat, mkdtemp, mkdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import {
  MAC_BUNDLE_BUILD_VERSION,
  MAC_BUNDLE_SHORT_VERSION,
  PACKAGED_NOTICE_MAPPINGS,
  auditPackagedTree,
  assertPreviewEntrypoints,
  installElectronRuntimeEvidence,
  installPackagedDependencyNotices,
  inventoryTree,
  previewOutputPath,
  removePackageManagerMetadata,
  removeRuntimeBuildMetadata,
  removePnpmWorkspaceSelfReference,
  removeUnusedMacPrivacyDeclarations,
  resolvePnpmCli,
  restoreLegacyWorkspaceRuntimeDependencies,
  sealMacBundle,
  validateElectronRuntimeEvidence,
  validateSidecarEvidence,
  verifyDeployedRuntimeResolution,
} from '../scripts/preview-build-lib.mjs'
import { generateMacIcns } from '../scripts/generate-app-icon.mjs'

const temporary: string[] = []
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(temporary.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe('preview build inventory', () => {
  it('keeps prerelease identity outside Apple numeric bundle version fields', () => {
    expect(MAC_BUNDLE_SHORT_VERSION).toBe('1.0.0')
    expect(MAC_BUNDLE_BUILD_VERSION).toBe('1')
  })

  it('uses a Finder-recognizable macOS app path', () => {
    expect(previewOutputPath('/repo', 'darwin', 'arm64'))
      .toBe(join(resolve('/repo'), 'dist', 'studio-preview', 'darwin-arm64', 'Creative RSI Studio.app'))
    expect(previewOutputPath('/repo', 'win32', 'x64'))
      .toBe(join(resolve('/repo'), 'dist', 'studio-preview', 'win32-x64', 'Creative RSI Studio-win32-x64'))
  })

  it('resolves a global pnpm launcher symlink to one regular CLI target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'preview-pnpm-cli-'))
    temporary.push(root)
    const target = join(root, 'pnpm.cjs')
    const launcher = join(root, 'pnpm')
    const directory = join(root, 'not-a-cli')
    await writeFile(target, 'console.log("11.7.0")\n')
    await symlink(target, launcher)
    await mkdir(directory)

    await expect(resolvePnpmCli(launcher)).resolves.toBe(await realpath(target))
    await expect(resolvePnpmCli(target)).resolves.toBe(await realpath(target))
    await expect(resolvePnpmCli(directory)).rejects.toThrow('resolved pnpm CLI must be a regular file')
    await expect(resolvePnpmCli(join(root, 'missing'))).rejects.toThrow('pnpm CLI target cannot be resolved')
    await expect(resolvePnpmCli('relative/pnpm')).rejects.toThrow('pnpm CLI path must be absolute')
  })

  it('hashes regular files and preserves internal symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'preview-inventory-'))
    temporary.push(root)
    await mkdir(join(root, 'real'))
    await writeFile(join(root, 'real', 'file.txt'), 'hello')
    await symlink('real/file.txt', join(root, 'link.txt'))
    const result = await inventoryTree(root)
    const rawTarget = await readlink(join(root, 'link.txt'))
    const hostMode = process.platform === 'win32'
      ? null
      : expect.stringMatching(/^[0-7]{4}$/)
    expect(result).toEqual([
      expect.objectContaining({ path: '.', type: 'directory', mode: hostMode }),
      expect.objectContaining({
        path: 'link.txt', type: 'symlink', target: rawTarget, mode: hostMode,
      }),
      expect.objectContaining({ path: 'real', type: 'directory', mode: hostMode }),
      expect.objectContaining({
        path: 'real/file.txt', type: 'file', bytes: 5, mode: hostMode,
      }),
    ])
    await expect(inventoryTree(root, { platform: 'win32' })).resolves.toEqual([
      { path: '.', type: 'directory', mode: null },
      { path: 'link.txt', type: 'symlink', target: rawTarget, mode: null },
      { path: 'real', type: 'directory', mode: null },
      expect.objectContaining({ path: 'real/file.txt', type: 'file', bytes: 5, mode: null }),
    ])
  })

  it.runIf(process.platform !== 'win32')('changes the tree identity when root, directory, or file mode changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'preview-mode-tree-'))
    temporary.push(root)
    const directory = join(root, 'payload')
    const file = join(directory, 'runtime.js')
    await mkdir(directory)
    await writeFile(file, 'export {}\n')
    const identity = async () => sha256(Buffer.from(JSON.stringify(
      await inventoryTree(root, { platform: 'darwin' }),
    )))

    const initial = await identity()
    await chmod(root, 0o750)
    const rootChanged = await identity()
    expect(rootChanged).not.toBe(initial)
    await chmod(directory, 0o700)
    const directoryChanged = await identity()
    expect(directoryChanged).not.toBe(rootChanged)
    await chmod(file, 0o600)
    await expect(identity()).resolves.not.toBe(directoryChanged)
  })

  it('removes package-manager state and fails closed if any survives', async () => {
    const root = await mkdtemp(join(tmpdir(), 'preview-package-metadata-'))
    temporary.push(root)
    const modules = join(root, 'node_modules', '.modules.yaml')
    const lock = join(root, 'node_modules', '.pnpm', 'lock.yaml')
    const workspaceState = join(root, 'node_modules', '.pnpm-workspace-state-v1.json')
    const packageMap = join(root, 'node_modules', '.package-map.json')
    const extraMetadata = [
      'pnpm-debug.log', 'yarn-debug.log', '.yarn-integrity', '.pnp.cjs',
      '.pnp.loader.mjs', '.pnp.data.json', 'pnpm-synthetic-debug.log',
    ].map(name => join(root, 'node_modules', name))
    await mkdir(dirname(lock), { recursive: true })
    await writeFile(modules, 'storeDir: /synthetic/package-store\n')
    await writeFile(lock, 'lockfileVersion: 9\n')
    await writeFile(workspaceState, '{}\n')
    await writeFile(packageMap, '{}\n')
    await Promise.all(extraMetadata.map(path => writeFile(path, 'synthetic metadata\n')))
    await writeFile(join(root, 'runtime.js'), 'export const ready = true\n')

    await expect(auditPackagedTree(root)).rejects.toThrow('package-manager metadata')
    await expect(removePackageManagerMetadata(root)).resolves.toBeUndefined()
    await expect(readFile(modules)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(lock)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(workspaceState)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(packageMap)).rejects.toMatchObject({ code: 'ENOENT' })
    for (const path of extraMetadata) {
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    }
    const inventory = await auditPackagedTree(root)
    expect(inventory).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '.', type: 'directory' }),
      expect.objectContaining({ path: 'runtime.js', type: 'file' }),
    ]))
    expect(inventory.some(entry => entry.path.endsWith('lock.yaml') || entry.path.endsWith('.modules.yaml')))
      .toBe(false)
  })

  it('pins canonical upstream notice sources and keeps declared versus verified AWS paths distinct', async () => {
    const nested = PACKAGED_NOTICE_MAPPINGS.find(mapping => (
      mapping.target.name === '@aws-sdk/nested-clients'
    ))!
    const pi = PACKAGED_NOTICE_MAPPINGS.find(mapping => mapping.target.name === '@earendil-works/pi-ai')!
    expect(nested.target).toMatchObject({
      version: '3.997.42',
      declared_repository_directory: 'packages/nested-clients',
    })
    expect(nested.upstream).toEqual({
      repository: 'https://github.com/aws/aws-sdk-js-v3.git',
      tag: 'v3.1108.0',
      tag_object: 'b187769e33bdccafdedf93d5c4ceca8436cc6cff',
      commit: '26b0eb790ff86399b7af7b74ce8c188f25512cc6',
      path: 'LICENSE',
      verified_source_directory: 'packages-internal/nested-clients',
    })
    expect(sha256(await readFile(join(repositoryRoot, nested.source.file))))
      .toBe(nested.source.sha256)
    expect(pi.upstream).toMatchObject({
      tag: 'v0.82.1',
      commit: 'b4f293684bba718d59cc1157679bcf6157b3a7f5',
      path: 'LICENSE',
    })
    expect(sha256(await readFile(join(repositoryRoot, pi.source.file)))).toBe(pi.source.sha256)
  })

  it('does not read source storage or emit stale provenance when every mapped target is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'preview-absent-notice-targets-'))
    temporary.push(root)
    const deployed = join(root, 'deployed')
    await mkdir(deployed)
    await writeFile(join(deployed, 'package.json'), JSON.stringify({
      name: '@creative-loop2rsi/desktop',
      version: '1.0.0-alpha.1',
      license: 'Apache-2.0',
    }))
    await writeFile(join(deployed, 'LICENSE'), 'synthetic app license\n')
    const missingSourceStore = join(root, 'ambient-store-must-not-be-read')
    await expect(installPackagedDependencyNotices(deployed, join(root, 'missing-workspace'), {
      sourceStore: missingSourceStore,
    })).resolves.toBeUndefined()
    await expect(lstat(missingSourceStore)).rejects.toMatchObject({ code: 'ENOENT' })
    const provenance = JSON.parse(await readFile(
      join(deployed, 'release-license-provenance.json'),
      'utf8',
    ))
    expect(provenance).toEqual({
      schema_version: '1',
      kind: 'PackagedLicenseProvenance',
      mappings: [],
    })
    expect(JSON.stringify(provenance)).not.toContain('@img/sharp-libvips-darwin-arm64')
  })

  it('installs a tracked canonical notice and fails closed on provenance or source drift', async () => {
    const root = await mkdtemp(join(tmpdir(), 'preview-canonical-notice-'))
    temporary.push(root)
    const deployed = join(root, 'deployed')
    const workspace = join(root, 'workspace')
    const sourceStore = join(workspace, 'node_modules', '.pnpm')
    const source = join(workspace, 'third_party', 'licenses', 'canonical.txt')
    const target = join(deployed, 'node_modules', 'synthetic-runtime')
    await mkdir(sourceStore, { recursive: true })
    await mkdir(dirname(source), { recursive: true })
    await mkdir(target, { recursive: true })
    await writeFile(join(deployed, 'package.json'), JSON.stringify({
      name: '@creative-loop2rsi/desktop', version: '1.0.0-alpha.1', license: 'Apache-2.0',
    }))
    await writeFile(join(deployed, 'LICENSE'), 'synthetic app license\n')
    await writeFile(join(target, 'package.json'), JSON.stringify({
      name: 'synthetic-runtime',
      version: '1.2.3',
      license: 'MIT',
      repository: { url: 'https://example.invalid/runtime.git', directory: 'packages/runtime' },
    }))
    const canonical = Buffer.from('synthetic canonical notice\n')
    await writeFile(source, canonical)
    const mapping = {
      target: {
        name: 'synthetic-runtime',
        version: '1.2.3',
        license: 'MIT',
        repository: 'https://example.invalid/runtime.git',
        declared_repository_directory: 'packages/runtime',
      },
      source: {
        kind: 'tracked',
        file: 'third_party/licenses/canonical.txt',
        sha256: sha256(canonical),
      },
      upstream: {
        repository: 'https://example.invalid/runtime.git',
        tag: 'v1.2.3',
        commit: 'a'.repeat(40),
        path: 'LICENSE',
        verified_source_directory: 'packages/runtime',
      },
      destination: 'LICENSE',
    }
    await expect(installPackagedDependencyNotices(deployed, workspace, {
      sourceStore,
      mappings: [{ ...mapping, upstream: { ...mapping.upstream, commit: 'invalid' } }],
    })).rejects.toThrow('provenance is invalid')
    await expect(installPackagedDependencyNotices(deployed, workspace, {
      sourceStore,
      mappings: [{ ...mapping, upstream: { ...mapping.upstream, path: '../LICENSE' } }],
    })).rejects.toThrow('provenance is invalid')
    await expect(installPackagedDependencyNotices(deployed, workspace, {
      sourceStore,
      mappings: [{ ...mapping, source: { ...mapping.source, sha256: 'b'.repeat(64) } }],
    })).rejects.toThrow('source hash differs')
    await expect(installPackagedDependencyNotices(deployed, workspace, {
      sourceStore,
      mappings: [{
        ...mapping,
        target: { ...mapping.target, declared_repository_directory: 'packages/other' },
      }],
    })).rejects.toThrow('target identity is invalid')

    await expect(installPackagedDependencyNotices(deployed, workspace, {
      sourceStore,
      mappings: [mapping],
    })).resolves.toBeUndefined()
    await expect(readFile(join(target, 'LICENSE'))).resolves.toEqual(canonical)
    const provenance = JSON.parse(await readFile(
      join(deployed, 'release-license-provenance.json'),
      'utf8',
    ))
    expect(JSON.stringify(provenance)).not.toContain(root)
    expect(provenance.mappings[0]).toMatchObject({
      target: { component: 'synthetic-runtime@1.2.3' },
      source: { kind: 'tracked-canonical-license', sha256: sha256(canonical) },
      upstream: mapping.upstream,
    })
  })

  it('strips non-runtime build metadata and local source-origin comments across production dependencies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'preview-runtime-metadata-'))
    temporary.push(root)
    const appDist = join(root, 'dist', 'main')
    const dependency = join(root, 'node_modules', 'synthetic-runtime', 'lib')
    const dependencyRoot = dirname(dependency)
    const dependencyTests = join(dependencyRoot, 'tests')
    await mkdir(appDist, { recursive: true })
    await mkdir(dependency, { recursive: true })
    await mkdir(dependencyTests, { recursive: true })
    const upstreamReadme = join(dependencyRoot, 'README.md')
    const removable = [
      join(appDist, 'index.d.ts'),
      join(appDist, 'index.d.mts'),
      join(appDist, 'index.d.cts'),
      join(appDist, 'index.js.map'),
      join(dependency, 'context.d.ts'),
      join(dependency, 'context.js.map'),
      upstreamReadme,
      join(dependencyRoot, 'CHANGELOG.md'),
      join(dependencyTests, 'runtime.test.js'),
      join(dependencyRoot, 'unit.spec.ts'),
    ]
    const genericUserHome = ['', 'home', 'synthetic-runner'].join('/')
    const genericUpstreamHome = `${genericUserHome}/work/runtime`
    await Promise.all(removable.map(path => writeFile(
      path,
      path === upstreamReadme
        ? `settings example: ${genericUpstreamHome}/settings.yaml\n`
        : path.endsWith('context.d.ts') ? 'export interface Context { registry: string }\n' : '{}\n',
    )))
    const preserved = {
      [join(appDist, 'index.js')]: 'export {}\n',
      [join(appDist, 'README.md')]: 'runtime-loaded app markdown\n',
      [join(dependencyRoot, 'package.json')]: '{"name":"synthetic-runtime"}\n',
      [join(dependency, 'data.json')]: '{"ready":true}\n',
      [join(dependency, 'binding.node')]: 'synthetic-native',
      [join(dependencyRoot, 'LICENSE')]: 'synthetic license\n',
      [join(dependencyRoot, 'NOTICE.md')]: 'synthetic notice\n',
      [join(dependency, 'runtime-guide.md')]: 'runtime-loaded markdown\n',
      [join(dependency, 'runtime-test-helper.js')]: 'export const helper = true\n',
    }
    await Promise.all(Object.entries(preserved).map(([path, content]) => writeFile(path, content)))
    const runtimeJavaScript = join(dependency, 'context.js')
    const runtimeBeforeSanitizing = [
      'export const before = true',
      'const message = `before ${value} after`;',
      `//#region \\0synthetic-css:${genericUpstreamHome}/source.css`,
      '/**',
      ` * Example workspace: ${genericUpstreamHome}/example.js`,
      ' */',
      `/*# source-origin=${genericUpstreamHome}/fixture.js */ globalThis.RUNTIME_SIDE_EFFECT = true; /* tail */`,
      `export const inline = true // sourceURL=${genericUpstreamHome}/inline.js`,
      `//# sourceURL=file://${genericUpstreamHome}/file-uri.js`,
      `//# sourceMappingURL=webpack://${genericUpstreamHome}/webpack-uri.js`,
      'export const after = true',
      '',
    ].join('\n')
    const runtimeAfterSanitizing = runtimeBeforeSanitizing
      .replaceAll(`file://${genericUserHome}`, 'file:///<build-home>')
      .replaceAll(`webpack://${genericUserHome}`, 'webpack:///<build-home>')
      .replaceAll(genericUserHome, '<build-home>')
    await writeFile(runtimeJavaScript, runtimeBeforeSanitizing)
    const runtimeCss = join(dependency, 'styles.css')
    const cssBeforeSanitizing = `/*# sourceURL=${genericUpstreamHome}/styles.css */\n.root { color: black; }\n`
    const cssAfterSanitizing = cssBeforeSanitizing.replaceAll(genericUserHome, '<build-home>')
    await writeFile(runtimeCss, cssBeforeSanitizing)
    if (process.platform !== 'win32') await chmod(runtimeJavaScript, 0o755)
    const externalAliasRoot = await mkdtemp(join(tmpdir(), 'preview-runtime-hardlink-'))
    temporary.push(externalAliasRoot)
    const externalAlias = join(externalAliasRoot, 'context.js')
    await link(runtimeJavaScript, externalAlias)
    const originalMode = (await lstat(runtimeJavaScript)).mode & 0o7777

    await expect(auditPackagedTree(root)).rejects.toThrow('generic user home path')
    await expect(removeRuntimeBuildMetadata(root)).resolves.toBeUndefined()
    for (const path of removable) {
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    }
    for (const [path, content] of Object.entries(preserved)) {
      await expect(readFile(path, 'utf8')).resolves.toBe(content)
    }
    await expect(readFile(runtimeJavaScript, 'utf8')).resolves.toBe(runtimeAfterSanitizing)
    await expect(readFile(runtimeCss, 'utf8')).resolves.toBe(cssAfterSanitizing)
    await expect(readFile(externalAlias, 'utf8')).resolves.toBe(runtimeBeforeSanitizing)
    expect((await lstat(runtimeJavaScript)).mode & 0o7777).toBe(originalMode)
    await expect(auditPackagedTree(root)).resolves.toBeDefined()

    await writeFile(runtimeJavaScript, `export const runtimePath = "${genericUpstreamHome}/runtime.js"\n`)
    await expect(removeRuntimeBuildMetadata(root)).resolves.toBeUndefined()
    await expect(auditPackagedTree(root)).rejects.toThrow('generic user home path')
    await writeFile(runtimeJavaScript, runtimeAfterSanitizing)

    const registryConfig = join(dependency, 'runtime-config.json')
    await writeFile(registryConfig, '{"registry":"https://packages.example.invalid/"}\n')
    await expect(auditPackagedTree(root)).rejects.toThrow('unapproved registry metadata')
  })

  it('preserves dependency package entries named spec or test while stripping their internal test directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'preview-package-entry-boundary-'))
    temporary.push(root)
    const scopedPackage = join(
      root,
      'node_modules',
      '.pnpm',
      '@standard-schema+spec@1.1.0',
      'node_modules',
      '@standard-schema',
      'spec',
    )
    const scopedTests = join(scopedPackage, 'tests')
    const consumer = join(root, 'node_modules', 'synthetic-consumer')
    const consumerLink = join(consumer, 'node_modules', '@standard-schema', 'spec')
    const unscopedPackage = join(root, 'node_modules', 'test')
    const unscopedInternalSpec = join(unscopedPackage, 'spec')
    await mkdir(scopedTests, { recursive: true })
    await mkdir(dirname(consumerLink), { recursive: true })
    await mkdir(unscopedInternalSpec, { recursive: true })
    await writeFile(join(scopedPackage, 'package.json'), JSON.stringify({
      name: '@standard-schema/spec',
      version: '1.1.0',
    }))
    await writeFile(join(scopedTests, 'runtime.test.js'), 'throw new Error("test-only")\n')
    await writeFile(join(consumer, 'package.json'), '{"name":"synthetic-consumer"}\n')
    await symlink(relative(dirname(consumerLink), scopedPackage), consumerLink)
    await writeFile(join(unscopedPackage, 'package.json'), '{"name":"test"}\n')
    await writeFile(join(unscopedInternalSpec, 'fixture.js'), 'throw new Error("test-only")\n')

    await expect(realpath(consumerLink)).resolves.toBe(await realpath(scopedPackage))
    await expect(removeRuntimeBuildMetadata(root)).resolves.toBeUndefined()

    await expect(realpath(consumerLink)).resolves.toBe(await realpath(scopedPackage))
    await expect(readFile(join(scopedPackage, 'package.json'), 'utf8')).resolves.toContain('@standard-schema/spec')
    await expect(readFile(join(scopedTests, 'runtime.test.js'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(unscopedPackage, 'package.json'), 'utf8')).resolves.toContain('"test"')
    await expect(readFile(join(unscopedInternalSpec, 'fixture.js'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(auditPackagedTree(root)).resolves.toBeDefined()
  })

  it('rejects local build-home paths and unapproved registry configuration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'preview-private-provenance-'))
    temporary.push(root)
    const metadata = join(root, 'runtime-config.json')
    await writeFile(metadata, JSON.stringify({ cache: join(homedir(), 'synthetic-cache') }))
    await expect(auditPackagedTree(root)).rejects.toThrow('local build path')

    await writeFile(metadata, homedir())
    await expect(auditPackagedTree(root)).rejects.toThrow('local build path')

    await writeFile(metadata, JSON.stringify({ registry: 'https://packages.example.invalid/' }))
    await expect(auditPackagedTree(root)).rejects.toThrow('unapproved registry metadata')

    await writeFile(metadata, JSON.stringify({ registry: 'https://registry.npmjs.org/' }))
    await expect(auditPackagedTree(root)).resolves.toHaveLength(2)

    await writeFile(metadata, JSON.stringify({ registry: 'https://registry.npmjs.org' }))
    await expect(auditPackagedTree(root)).resolves.toHaveLength(2)
  })

  it('rejects nested, escaped, or non-canonical registry metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'preview-registry-policy-'))
    temporary.push(root)
    const jsonMetadata = join(root, 'runtime-config.json')
    const yamlMetadata = join(root, 'runtime-config.yaml')
    const tomlMetadata = join(root, 'runtime-config.toml')
    const iniMetadata = join(root, 'runtime-config.ini')
    const syntheticPrivateHost = ['repo', 'example', 'internal'].join('.')
    const expectRejected = async (path: string, content: string) => {
      await writeFile(path, content)
      await expect(auditPackagedTree(root)).rejects.toThrow('unapproved registry metadata')
      await rm(path)
    }

    await expectRejected(
      jsonMetadata,
      '{"registries":{"default":"http://registry.npmjs.org/"}}\n',
    )
    await expectRejected(jsonMetadata, '{"registry":"https:\\/\\/packages.example.invalid\\/"}\n')
    await expectRejected(
      jsonMetadata,
      '{"registry":"https:\\u002f\\u002fpackages.example.invalid\\u002f"}\n',
    )
    await writeFile(jsonMetadata, [
      '{',
      '  // synthetic JSONC is accepted when it has no registry configuration',
      '  "compilerOptions": { "strict": true },',
      '  "dependency": "synthetic-typert-registry",',
      '}',
      '',
    ].join('\n'))
    await expect(auditPackagedTree(root)).resolves.toBeDefined()
    await rm(jsonMetadata)
    await writeFile(jsonMetadata, '')
    await expect(auditPackagedTree(root)).resolves.toBeDefined()
    await rm(jsonMetadata)
    await writeFile(jsonMetadata, [
      '{',
      '  /* "registry": "https://packages.example.invalid/" */',
      '  "name": "synthetic-runtime",',
      '}',
      '',
    ].join('\n'))
    await expect(auditPackagedTree(root)).resolves.toBeDefined()
    await rm(jsonMetadata)
    await expectRejected(jsonMetadata, [
      '{',
      '  // trailing commas make this JSONC instead of strict JSON',
      '  "registry": "https://packages.example.invalid/",',
      '}',
      '',
    ].join('\n'))
    await expectRejected(
      yamlMetadata,
      `registries:\n  note: ${'x'.repeat(400)}\n  default: http://registry.npmjs.org/\n`,
    )
    await expectRejected(yamlMetadata, 'registries: { default: http://registry.npmjs.org/ }\n')
    await expectRejected(yamlMetadata, `registry: ${syntheticPrivateHost}\n`)
    for (const blockStyle of ['>', '|']) {
      await expectRejected(
        yamlMetadata,
        `registry: ${blockStyle}\n  https://packages.example.invalid/\n`,
      )
    }
    await expectRejected(tomlMetadata, '[registries]\ndefault = "http://registry.npmjs.org/"\n')
    await expectRejected(
      tomlMetadata,
      '["registries"]\n"default" = "https://packages.example.invalid/"\n',
    )
    await expectRejected(
      tomlMetadata,
      '"registry-url" = "https://packages.example.invalid/"\n',
    )
    await expectRejected(iniMetadata, 'registry=ssh://packages.example.invalid/repository\n')
    await expectRejected(iniMetadata, `registry: ${syntheticPrivateHost}\n`)
    await expectRejected(iniMetadata, 'registryUrl=https://packages.example.invalid/\n')
    await expectRejected(iniMetadata, '@synthetic:registry=https://packages.example.invalid/\n')

    for (const registry of [
      'https://registry.npmjs.org/?token=synthetic',
      'https://registry.npmjs.org/#synthetic',
      'https://synthetic-user@registry.npmjs.org/',
      'https://registry.npmjs.org/private',
    ]) {
      await expectRejected(jsonMetadata, JSON.stringify({ registry }))
    }

    for (const extension of ['py', 'sh', 'ps1', 'bat', 'cmd']) {
      const scriptMetadata = join(root, `runtime_config.${extension}`)
      await expectRejected(scriptMetadata, 'registry = "https://packages.example.invalid/"\n')
    }
    await expectRejected(
      join(root, 'runtime_config.sh'),
      'registry=https://packages.example.invalid/\n',
    )
    await expectRejected(
      join(root, 'runtime_config.sh'),
      `registry=${syntheticPrivateHost}\n`,
    )
    await expectRejected(
      join(root, 'runtime_config.cmd'),
      'set registry=https://packages.example.invalid/\n',
    )
    await expectRejected(
      join(root, 'runtime_config.py'),
      'registry: str = "https://packages.example.invalid/"\n',
    )

    const typescriptMetadata = join(root, 'runtime-config.ts')
    await expectRejected(
      typescriptMetadata,
      'const config = { registry: `https://packages.example.invalid/` }\n',
    )
    await expectRejected(
      typescriptMetadata,
      'const config = { "registry-url": "https://packages.example.invalid/" }\n',
    )
    await expectRejected(
      typescriptMetadata,
      'const config = { "@synthetic:registry": "https://packages.example.invalid/" }\n',
    )
    await expectRejected(
      typescriptMetadata,
      'const registryUrl = "https://packages.example.invalid/"\n',
    )
    await writeFile(typescriptMetadata, [
      'interface RuntimeOptions {',
      '  registry: RegistryService;',
      '  registryMode: { registry: "public" | "private" };',
      '}',
      'interface LiteralRegistry { registry: "public" }',
      'const note = \'registry = "https://packages.example.invalid/"\'',
      'const ready = true // registry = "https://packages.example.invalid/"',
      'const config = { registry: `https://${host}/` }',
      '',
    ].join('\n'))
    const sidecarSource = join(root, 'loopctl.py')
    await writeFile(sidecarSource, [
      'registry: "RegistryService"',
      'registry = load_json(project / "registry.json")',
      '',
    ].join('\n'))
    const shellSource = join(root, 'runtime-safe.sh')
    await writeFile(shellSource, [
      'registry=$config.registry',
      'registry=$(load_registry)',
      '',
    ].join('\n'))
    await expect(auditPackagedTree(root)).resolves.toBeDefined()
  })

  it('rejects generic cross-platform home and package-store paths without a known username', async () => {
    const root = await mkdtemp(join(tmpdir(), 'preview-generic-paths-'))
    temporary.push(root)
    const metadata = join(root, 'runtime-config.txt')
    const macHome = ['', 'Users', 'synthetic-person', 'cache'].join('/')
    await writeFile(metadata, `cache=${macHome}/artifact\n`)
    await expect(auditPackagedTree(root)).rejects.toThrow('generic user home path')

    const windowsHome = ['Q:', 'Users', 'synthetic-person', 'cache'].join('\\')
    await writeFile(metadata, `cache=${windowsHome}\\artifact\n`)
    await expect(auditPackagedTree(root)).rejects.toThrow('generic user home path')

    const packageStore = ['', 'var', 'cache', 'pnpm', 'store', 'v11'].join('/')
    await writeFile(metadata, `storeDir=${packageStore}/files\n`)
    await expect(auditPackagedTree(root)).rejects.toThrow('absolute package-store path')

    const rootHome = ['', 'root', 'synthetic-person', 'cache'].join('/')
    await writeFile(metadata, `cache=${rootHome}/artifact\n`)
    await expect(auditPackagedTree(root)).rejects.toThrow('generic user home path')

    const macHomeWithoutSlash = ['', 'Users', 'synthetic-person'].join('/')
    await writeFile(metadata, `cache=${macHomeWithoutSlash}\n`)
    await expect(auditPackagedTree(root)).rejects.toThrow('generic user home path')

    const windowsHomeWithoutSlash = ['Q:', 'Users', 'synthetic-person'].join('\\')
    await writeFile(metadata, `cache=${windowsHomeWithoutSlash}\n`)
    await expect(auditPackagedTree(root)).rejects.toThrow('generic user home path')

    const absoluteRoot = '/' + 'root'
    for (const content of [
      `${absoluteRoot}\n`,
      `cache="${absoluteRoot}"\n`,
      `cache: ${absoluteRoot}\n`,
      `cache=${absoluteRoot}\n`,
    ]) {
      await writeFile(metadata, content)
      await expect(auditPackagedTree(root)).rejects.toThrow('generic user home path')
    }

    for (const localUri of [
      `file:///${['home', 'synthetic-person', 'work'].join('/')}/source.js`,
      `file:///${['Users', 'synthetic-person', 'work'].join('/')}/source.js`,
      `file:///${['root', 'work'].join('/')}/source.js`,
      `webpack:///${['home', 'synthetic-person', 'work'].join('/')}/source.js`,
    ]) {
      await writeFile(metadata, `source=${localUri}\n`)
      await expect(auditPackagedTree(root)).rejects.toThrow('generic user home path')
    }

    await writeFile(metadata, 'relative=./root\nslot=single/root\n')
    await expect(auditPackagedTree(root)).resolves.toBeDefined()
  })

  it('allows generic vendor paths in binaries but rejects exact build paths in raw bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'preview-binary-paths-'))
    temporary.push(root)
    const binary = join(root, 'vendor-runtime.bin')
    const genericVendorHome = ['', 'Users', 'upstream-builder', 'symbols'].join('/')
    await writeFile(binary, Buffer.concat([
      Buffer.from([0, 255, 0]),
      Buffer.from(`${genericVendorHome}/runtime`, 'utf8'),
    ]))
    await expect(auditPackagedTree(root)).resolves.toHaveLength(2)

    await writeFile(binary, Buffer.concat([
      Buffer.from([0, 255, 0]),
      Buffer.from(join(homedir(), 'private-cache'), 'utf8'),
    ]))
    await expect(auditPackagedTree(root)).rejects.toThrow('local build path')

    const syntheticStore = join(root, 'synthetic-package-store')
    await writeFile(binary, Buffer.concat([
      Buffer.from([0, 255, 0]),
      Buffer.from(syntheticStore, 'utf8'),
    ]))
    await expect(auditPackagedTree(root, { packageStorePaths: [syntheticStore] }))
      .rejects.toThrow('local build path')
  })

  it.runIf(process.platform !== 'win32')('requires 0755 macOS application and controller entrypoints', async () => {
    const root = await mkdtemp(join(tmpdir(), 'preview-entrypoints-'))
    temporary.push(root)
    const application = join(root, 'Contents', 'MacOS', 'Creative RSI Studio')
    const controller = join(root, 'Contents', 'Resources', 'controller', 'creative-rsi-controller')
    await mkdir(dirname(application), { recursive: true })
    await mkdir(dirname(controller), { recursive: true })
    await writeFile(application, 'application')
    await writeFile(controller, 'controller')
    await chmod(application, 0o755)
    await chmod(controller, 0o755)
    await expect(assertPreviewEntrypoints(root, 'darwin')).resolves.toBeUndefined()

    await chmod(controller, 0o750)
    await expect(assertPreviewEntrypoints(root, 'darwin')).rejects.toThrow('mode must be 0755')
  })

  it.runIf(process.platform === 'darwin')('generates the project CR icon as an icns file without overwriting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'preview-icon-'))
    temporary.push(root)
    const output = join(root, 'CreativeRSIStudio.icns')
    await expect(generateMacIcns(output)).resolves.toBe(output)
    expect((await lstat(output)).isFile()).toBe(true)
    expect(execFileSync('/usr/bin/sips', ['-g', 'format', output], { encoding: 'utf8' }))
      .toContain('format: icns')
    await expect(generateMacIcns(output)).rejects.toThrow('already exists')
  })

  it('installs and hash-binds Electron, Node.js, and Chromium runtime notices', async () => {
    const root = await mkdtemp(join(tmpdir(), 'preview-electron-runtime-'))
    temporary.push(root)
    const electronDist = join(root, 'electron-dist')
    const resources = join(root, 'resources')
    const executable = join(root, 'Electron')
    await mkdir(electronDist)
    await mkdir(resources)
    await writeFile(executable, 'synthetic executable')
    await writeFile(join(electronDist, 'LICENSE'), 'synthetic Electron license\n')
    await writeFile(join(electronDist, 'LICENSES.chromium.html'), '<p>synthetic Chromium and Node notices</p>\n')

    const evidence = await installElectronRuntimeEvidence({
      electronDist,
      resources,
      executable,
      runtimeVersions: {
        electron: '43.4.0',
        node: '24.18.1',
        chrome: '150.0.7871.224',
      },
    })
    expect(evidence.components.map(component => [component.name, component.version])).toEqual([
      ['Chromium', '150.0.7871.224'],
      ['Electron', '43.4.0'],
      ['Node.js', '24.18.1'],
    ])
    expect(JSON.stringify(evidence)).not.toContain(root)
    for (const component of evidence.components) {
      for (const notice of component.notices) {
        const bytes = await readFile(join(resources, ...notice.path.split('/')))
        expect(notice).toEqual({ path: notice.path, bytes: bytes.length, sha256: sha256(bytes) })
      }
    }
    await expect(validateElectronRuntimeEvidence(resources)).resolves.toEqual(evidence)

    await writeFile(join(resources, 'licenses/electron/LICENSES.chromium.html'), 'tampered\n')
    await expect(validateElectronRuntimeEvidence(resources)).rejects.toThrow('differs from its evidence')
  })

  it.runIf(process.platform === 'darwin')('removes inherited unused macOS privacy declarations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'preview-plist-'))
    temporary.push(root)
    const plist = join(root, 'Info.plist')
    await writeFile(plist, [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      '<key>CFBundleIdentifier</key><string>org.creativeloop2rsi.test</string>',
      '<key>NSAudioCaptureUsageDescription</key><string>unused</string>',
      '<key>NSBluetoothAlwaysUsageDescription</key><string>unused</string>',
      '<key>NSBluetoothPeripheralUsageDescription</key><string>unused</string>',
      '<key>NSCameraUsageDescription</key><string>unused</string>',
      '<key>NSMicrophoneUsageDescription</key><string>unused</string>',
      '</dict></plist>',
      '',
    ].join('\n'))
    await expect(removeUnusedMacPrivacyDeclarations(plist)).resolves.toBeUndefined()
    const parsed = JSON.parse(execFileSync(
      '/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' },
    ))
    expect(parsed).toEqual({ CFBundleIdentifier: 'org.creativeloop2rsi.test' })
  })

  it.runIf(process.platform === 'darwin')('ad-hoc seals a complete app and passes strict verification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'preview-seal-'))
    temporary.push(root)
    const bundle = join(root, 'Synthetic.app')
    const contents = join(bundle, 'Contents')
    const executable = join(contents, 'MacOS', 'Synthetic')
    await mkdir(dirname(executable), { recursive: true })
    await cp('/usr/bin/true', executable)
    await chmod(executable, 0o755)
    await writeFile(join(contents, 'Info.plist'), [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      '<key>CFBundleExecutable</key><string>Synthetic</string>',
      '<key>CFBundleIdentifier</key><string>org.creativeloop2rsi.synthetic</string>',
      '<key>CFBundlePackageType</key><string>APPL</string>',
      '</dict></plist>',
      '',
    ].join('\n'))
    await expect(sealMacBundle(bundle)).resolves.toBeUndefined()
    expect((await lstat(join(contents, '_CodeSignature', 'CodeResources'))).isFile()).toBe(true)
    expect(() => execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]))
      .not.toThrow()
  })

  it('rejects a symlinked tree root', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'preview-root-link-'))
    temporary.push(parent)
    await mkdir(join(parent, 'real'))
    await symlink('real', join(parent, 'linked'))
    await expect(inventoryTree(join(parent, 'linked'))).rejects.toThrow('regular directory')
  })

  it('rejects symlinks that escape the bundle', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'preview-escape-'))
    temporary.push(parent)
    const root = join(parent, 'root')
    await mkdir(root)
    await writeFile(join(parent, 'outside'), 'outside')
    await symlink('../outside', join(root, 'escape'))
    await expect(inventoryTree(root)).rejects.toThrow('escapes preview root')
  })

  it('rejects broken symlinks and absolute raw targets even when they point inside', async () => {
    const root = await mkdtemp(join(tmpdir(), 'preview-strict-links-'))
    temporary.push(root)
    await symlink('missing-target', join(root, 'broken'))
    await expect(inventoryTree(root)).rejects.toThrow('broken')
    await (await import('node:fs/promises')).rm(join(root, 'broken'))

    if (process.platform !== 'win32') {
      const inside = join(root, 'inside.txt')
      await writeFile(inside, 'inside')
      await symlink(inside, join(root, 'absolute-inside'))
      await expect(inventoryTree(root)).rejects.toThrow('must be relative')
    }
  })

  it('removes only the validated pnpm workspace self-reference', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'preview-self-link-'))
    temporary.push(parent)
    const deployed = join(parent, 'deployed')
    const packageRoot = join(parent, 'workspace', 'apps', 'desktop')
    const link = join(deployed, 'node_modules', '.pnpm', 'node_modules', '@creative-loop2rsi', 'desktop')
    await mkdir(packageRoot, { recursive: true })
    await mkdir(dirname(link), { recursive: true })
    await symlink(relative(dirname(link), packageRoot), link)

    await expect(removePnpmWorkspaceSelfReference(deployed)).resolves.toBe(true)
    await expect(readFile(link)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(removePnpmWorkspaceSelfReference(deployed)).resolves.toBe(false)
  })

  it('refuses to hide an unexpected target behind the self-reference path', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'preview-bad-self-link-'))
    temporary.push(parent)
    const deployed = join(parent, 'deployed')
    const packageRoot = join(parent, 'unexpected')
    const link = join(deployed, 'node_modules', '.pnpm', 'node_modules', '@creative-loop2rsi', 'desktop')
    await mkdir(packageRoot, { recursive: true })
    await mkdir(dirname(link), { recursive: true })
    await symlink(packageRoot, link)

    await expect(removePnpmWorkspaceSelfReference(deployed)).rejects.toThrow('target is unexpected')
  })

  it('replaces the legacy peer graph with the fresh installed runtime closure', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'preview-runtime-links-'))
    temporary.push(parent)
    const workspace = join(parent, 'workspace')
    const deployed = join(parent, 'deployed')
    const dependencies = {
      '@deepseek-ai/dsh-sdk-client': '0.1.0-rc.6',
      '@deepseek-ai/dsh-sdk-jsonrpc-demo': '0.1.0-rc.6',
    }
    const workspacePackages = {
      '@creative-loop2rsi/controller-bridge': 'packages/controller-bridge',
      '@creative-loop2rsi/model-gateway': 'packages/model-gateway',
      '@creative-loop2rsi/runtime-dsh': 'packages/runtime-dsh',
    }
    const desktop = join(workspace, 'apps', 'desktop')
    const workspaceRuntime = join(workspace, 'packages', 'runtime-dsh')
    await mkdir(desktop, { recursive: true })
    await mkdir(workspaceRuntime, { recursive: true })
    await mkdir(deployed, { recursive: true })
    const runtimeManifest = JSON.stringify({ name: '@creative-loop2rsi/runtime-dsh', dependencies })
    await writeFile(join(workspaceRuntime, 'package.json'), runtimeManifest)
    await writeFile(join(workspaceRuntime, 'profile.txt'), 'trusted-runtime')
    await writeFile(join(desktop, 'package.json'), JSON.stringify({
      name: '@creative-loop2rsi/desktop',
      dependencies: Object.fromEntries(Object.keys(workspacePackages).map(name => [name, 'workspace:*'])),
    }))
    await writeFile(join(deployed, 'package.json'), await readFile(join(desktop, 'package.json')))
    for (const [name, path] of Object.entries(workspacePackages)) {
      const source = join(workspace, path)
      await mkdir(source, { recursive: true })
      if (name !== '@creative-loop2rsi/runtime-dsh') {
        await writeFile(join(source, 'package.json'), JSON.stringify({ name }))
      }
      const desktopLink = join(desktop, 'node_modules', ...name.split('/'))
      await mkdir(dirname(desktopLink), { recursive: true })
      await symlink(relative(dirname(desktopLink), source), desktopLink)
    }

    const legacyStore = join(deployed, 'node_modules', '.pnpm')
    await mkdir(join(legacyStore, 'legacy-peer-context'), { recursive: true })
    await writeFile(join(legacyStore, 'lock.yaml'), 'lockfileVersion: 9\n')

    for (const [dependency, version] of Object.entries(dependencies)) {
      const simpleName = dependency.slice('@deepseek-ai/'.length)
      const workspaceVirtualName = `${dependency.replace('/', '+')}@${version}_workspace-peer-context`
      const workspaceTarget = join(
        workspace, 'node_modules', '.pnpm', workspaceVirtualName,
        'node_modules', '@deepseek-ai', simpleName,
      )
      const packageJson = dependency.endsWith('jsonrpc-demo')
        ? { name: dependency, version, exports: { './bin': './lib/bin.js' } }
        : { name: dependency, version, main: './lib/index.js' }
      await mkdir(join(workspaceTarget, 'lib'), { recursive: true })
      await writeFile(join(workspaceTarget, 'package.json'), JSON.stringify(packageJson))
      await writeFile(join(
        workspaceTarget,
        'lib',
        dependency.endsWith('jsonrpc-demo') ? 'bin.js' : 'index.js',
      ), '')
      const workspaceLink = join(workspaceRuntime, 'node_modules', '@deepseek-ai', simpleName)
      await mkdir(dirname(workspaceLink), { recursive: true })
      await symlink(relative(dirname(workspaceLink), workspaceTarget), workspaceLink)
      const hoistLink = join(
        workspace,
        'node_modules',
        '.pnpm',
        'node_modules',
        '@deepseek-ai',
        simpleName,
      )
      await mkdir(dirname(hoistLink), { recursive: true })
      await symlink(relative(dirname(hoistLink), workspaceTarget), hoistLink)

      if (dependency.endsWith('jsonrpc-demo')) {
        const groupTarget = join(
          workspace,
          'node_modules',
          '.pnpm',
          '@deepseek-ai+cordis-plugin-group@1.0.1_workspace-peer-context',
          'node_modules',
          '@deepseek-ai',
          'cordis-plugin-group',
        )
        await mkdir(groupTarget, { recursive: true })
        await writeFile(join(groupTarget, 'package.json'), JSON.stringify({
          name: '@deepseek-ai/cordis-plugin-group', version: '1.0.1', main: './index.js',
        }))
        await writeFile(join(groupTarget, 'index.js'), '')
        const peerLink = join(
          workspace,
          'node_modules',
          '.pnpm',
          workspaceVirtualName,
          'node_modules',
          '@deepseek-ai',
          'cordis-plugin-group',
        )
        await symlink(relative(dirname(peerLink), groupTarget), peerLink)
      }
    }

    await expect(restoreLegacyWorkspaceRuntimeDependencies(deployed, workspace)).resolves.toBeUndefined()
    await expect(verifyDeployedRuntimeResolution(deployed)).resolves.toBeUndefined()
    for (const dependency of Object.keys(dependencies)) {
      const destination = join(
        deployed,
        'node_modules',
        '@creative-loop2rsi',
        'runtime-dsh',
        'node_modules',
        ...dependency.split('/'),
      )
      await expect((await import('node:fs/promises')).lstat(destination).then(info => info.isSymbolicLink()))
        .resolves.toBe(true)
    }
    const copiedDemo = await (await import('node:fs/promises')).realpath(join(
      deployed,
      'node_modules',
      '@creative-loop2rsi',
      'runtime-dsh',
      'node_modules',
      '@deepseek-ai',
      'dsh-sdk-jsonrpc-demo',
    ))
    await expect((await import('node:fs/promises')).realpath(join(
      dirname(copiedDemo),
      'cordis-plugin-group',
    ))).resolves.toContain('@deepseek-ai+cordis-plugin-group@1.0.1_workspace-peer-context')
    await expect(readFile(join(deployed, 'node_modules', '.pnpm', 'lock.yaml')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await expect((await import('node:fs/promises')).realpath(join(
      deployed,
      'node_modules',
      '.pnpm',
      'node_modules',
      '@deepseek-ai',
      'dsh-sdk-jsonrpc-demo',
    ))).resolves.toContain('@deepseek-ai+dsh-sdk-jsonrpc-demo@0.1.0-rc.6_workspace-peer-context')
  })

  it('binds sidecar bytes and all tracked controller inputs to the source identity', async () => {
    const sidecar = await mkdtemp(join(tmpdir(), 'preview-sidecar-'))
    temporary.push(sidecar)
    const executableName = process.platform === 'win32'
      ? 'creative-rsi-controller.exe'
      : 'creative-rsi-controller'
    const executable = join(sidecar, executableName)
    await writeFile(executable, 'synthetic-sidecar')
    if (process.platform !== 'win32') await chmod(executable, 0o755)
    await writeFile(join(sidecar, 'base_library.zip'), 'base')
    const licenseDirectory = join(sidecar, '_licenses')
    const pythonNotice = join(licenseDirectory, 'CPython-LICENSE.txt')
    const pyinstallerNotice = join(licenseDirectory, 'PyInstaller-COPYING.txt')
    await mkdir(licenseDirectory)
    await writeFile(pythonNotice, 'synthetic CPython license\n')
    await writeFile(pyinstallerNotice, 'synthetic PyInstaller terms\n')
    const tracked = git('ls-files', '-z', '--', 'python', 'skills/creative-loop2rsi')
      .split('\0').filter(Boolean).sort()
    const inputs = Object.fromEntries(await Promise.all(tracked.map(async path => [
      path, sha256(await readFile(join(repositoryRoot, path))),
    ])))
    const source = {
      git_commit: git('rev-parse', 'HEAD').trim(),
      git_tree: git('rev-parse', 'HEAD^{tree}').trim(),
    }
    const evidence = {
      schema_version: '2',
      kind: 'ControllerSidecarBuildManifest',
      platform: process.platform === 'win32'
        ? { system: 'Windows', machine: 'AMD64' }
        : { system: 'Darwin', machine: 'arm64' },
      python: '3.11.13',
      pyinstaller: '6.22.0',
      sidecar_name: 'creative-rsi-controller',
      runtime_components: [
        {
          name: 'CPython',
          version: '3.11.13',
          license: 'PSF-2.0',
          notice: {
            path: '_licenses/CPython-LICENSE.txt',
            bytes: (await readFile(pythonNotice)).length,
            sha256: sha256(await readFile(pythonNotice)),
          },
        },
        {
          name: 'PyInstaller',
          version: '6.22.0',
          license: 'GPL-2.0-or-later WITH Bootloader-exception',
          notice: {
            path: '_licenses/PyInstaller-COPYING.txt',
            bytes: (await readFile(pyinstallerNotice)).length,
            sha256: sha256(await readFile(pyinstallerNotice)),
          },
        },
      ],
      source: {
        ...source,
        inputs,
        builder_sha256: sha256(await readFile(join(repositoryRoot, 'tools/build_controller_sidecar.py'))),
        requirements_sha256: sha256(await readFile(join(repositoryRoot, 'python/requirements-build-hashed.txt'))),
      },
      files: Object.fromEntries((await inventoryTree(sidecar, {
        platform: process.platform === 'win32' ? 'win32' : 'darwin',
      })).map(({ path, ...entry }) => [path, entry])),
    }
    await expect(validateSidecarEvidence(sidecar, evidence, {
      root: repositoryRoot,
      source,
      platform: process.platform === 'win32' ? 'win32' : 'darwin',
      arch: process.platform === 'win32' ? 'x64' : 'arm64',
    })).resolves.toBeUndefined()

    await writeFile(pythonNotice, 'tampered CPython license\n')
    await expect(validateSidecarEvidence(sidecar, evidence, {
      root: repositoryRoot,
      source,
      platform: process.platform === 'win32' ? 'win32' : 'darwin',
      arch: process.platform === 'win32' ? 'x64' : 'arm64',
    })).rejects.toThrow('notice differs from its manifest')
    await writeFile(pythonNotice, 'synthetic CPython license\n')

    await writeFile(executable, 'different-sidecar')
    await expect(validateSidecarEvidence(sidecar, evidence, {
      root: repositoryRoot,
      source,
      platform: process.platform === 'win32' ? 'win32' : 'darwin',
      arch: process.platform === 'win32' ? 'x64' : 'arm64',
    })).rejects.toThrow('bytes or modes differ')

    if (process.platform !== 'win32') {
      await writeFile(executable, 'synthetic-sidecar')
      await chmod(executable, 0o644)
      await expect(validateSidecarEvidence(sidecar, evidence, {
        root: repositoryRoot, source, platform: 'darwin', arch: 'arm64',
      })).rejects.toThrow('bytes or modes differ')
    }
  })
})

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' })
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

async function modeOf(path: string): Promise<string> {
  return ((await lstat(path)).mode & 0o7777).toString(8).padStart(4, '0')
}
