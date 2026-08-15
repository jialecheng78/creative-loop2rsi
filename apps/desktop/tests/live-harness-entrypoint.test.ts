import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const source = readFileSync(
  new URL('../scripts/live-flash-acceptance.mjs', import.meta.url),
  'utf8',
)

describe('live Flash acceptance Electron entrypoint', () => {
  it('lets the ESM entrypoint finish before waiting for Electron ready', () => {
    expect(source).toContain('void runElectronPhase().catch')
    expect(source).not.toMatch(/else\s*\{\s*await runElectronPhase\(\)/u)
    expect(source).toContain('publicError(error, outerTracker)')
    expect(source).toContain('process.stdout.write(`${report}\\n`, () => process.exit(1))')
  })

  it('finishes a no-key and no-network preflight before opening the key file', () => {
    const preflight = source.indexOf("runPhase(electronBinary, 'preflight'")
    const keyOpen = source.indexOf("open(keyFile, 'r')")

    expect(preflight).toBeGreaterThan(0)
    expect(keyOpen).toBeGreaterThan(preflight)
    expect(source).toContain("throw new Error('network access is forbidden during Electron preflight')")
    expect(source).toContain('key_file_opened: false')
  })

  it('validates temporary paths and evidence filenames without POSIX-only separators', () => {
    expect(source).toContain('isAcceptanceTemporaryDirectory(stateDirectory)')
    expect(source).toContain('basename(path) === name')
    expect(source).not.toContain("resolve(tmpdir()) + '/creative-rsi-flash-live-'")
  })
})
