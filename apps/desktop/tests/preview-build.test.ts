import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import {
  inventoryTree,
  previewOutputPath,
  removePnpmWorkspaceSelfReference,
  validateSidecarEvidence,
} from '../scripts/preview-build-lib.mjs'

const temporary: string[] = []
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(temporary.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe('preview build inventory', () => {
  it('uses a Finder-recognizable macOS app path', () => {
    expect(previewOutputPath('/repo', 'darwin', 'arm64'))
      .toBe('/repo/dist/studio-preview/darwin-arm64/Creative RSI Studio.app')
    expect(previewOutputPath('/repo', 'win32', 'x64'))
      .toBe('/repo/dist/studio-preview/win32-x64/Creative RSI Studio-win32-x64')
  })

  it('hashes regular files and preserves internal symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'preview-inventory-'))
    temporary.push(root)
    await mkdir(join(root, 'real'))
    await writeFile(join(root, 'real', 'file.txt'), 'hello')
    await symlink('real/file.txt', join(root, 'link.txt'))
    const result = await inventoryTree(root)
    expect(result).toEqual([
      { path: 'link.txt', type: 'symlink', target: 'real/file.txt' },
      expect.objectContaining({ path: 'real/file.txt', type: 'file', bytes: 5 }),
    ])
  })

  it('rejects a symlinked tree root', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'preview-root-link-'))
    temporary.push(parent)
    await mkdir(join(parent, 'real'))
    await symlink('real', join(parent, 'linked'))
    await expect(inventoryTree(join(parent, 'linked'))).rejects.toThrow('regular directory')
  })

  it('rejects symlinks that escape the bundle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'preview-escape-'))
    temporary.push(root)
    await symlink('../outside', join(root, 'escape'))
    await expect(inventoryTree(root)).rejects.toThrow('escapes preview root')
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

  it('binds sidecar bytes and all tracked controller inputs to the source identity', async () => {
    const sidecar = await mkdtemp(join(tmpdir(), 'preview-sidecar-'))
    temporary.push(sidecar)
    const executable = join(sidecar, 'Python')
    await writeFile(executable, 'synthetic-sidecar')
    await writeFile(join(sidecar, 'base_library.zip'), 'base')
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
      kind: 'ControllerSidecarBuildManifest',
      platform: { system: 'Darwin', machine: 'arm64' },
      python: '3.11.13',
      pyinstaller: '6.22.0',
      source: {
        ...source,
        inputs,
        builder_sha256: sha256(await readFile(join(repositoryRoot, 'tools/build_controller_sidecar.py'))),
        requirements_sha256: sha256(await readFile(join(repositoryRoot, 'python/requirements-build-hashed.txt'))),
      },
      files: {
        Python: {
          type: 'file', bytes: 17, sha256: sha256(Buffer.from('synthetic-sidecar')),
        },
        'base_library.zip': {
          type: 'file', bytes: 4, sha256: sha256(Buffer.from('base')),
        },
      },
    }
    await expect(validateSidecarEvidence(sidecar, evidence, {
      root: repositoryRoot, source, platform: 'darwin', arch: 'arm64',
    })).resolves.toBeUndefined()

    await writeFile(executable, 'different-sidecar')
    await expect(validateSidecarEvidence(sidecar, evidence, {
      root: repositoryRoot, source, platform: 'darwin', arch: 'arm64',
    })).rejects.toThrow('bytes differ')
  })
})

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' })
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}
