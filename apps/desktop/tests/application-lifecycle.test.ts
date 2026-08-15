import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DESKTOP_STARTUP_FAILURE_CODE,
  launchDesktopLifecycle,
  type DesktopLifecycleOptions,
  type QuitEventLike,
} from '../src/main/application-lifecycle.js'

interface LifecycleFixture {
  readonly options: DesktopLifecycleOptions
  readonly bootstrap: ReturnType<typeof vi.fn<() => Promise<void>>>
  readonly shutdown: ReturnType<typeof vi.fn<() => Promise<void>>>
  readonly focus: ReturnType<typeof vi.fn<() => void>>
  readonly quitDuplicate: ReturnType<typeof vi.fn<() => void>>
  readonly exit: ReturnType<typeof vi.fn<(code: number) => void>>
  readonly diagnostic: ReturnType<typeof vi.fn<(code: typeof DESKTOP_STARTUP_FAILURE_CODE) => void>>
  secondInstance(): void
  beforeQuit(event: QuitEventLike): void
}

afterEach(() => {
  vi.useRealTimers()
})

describe('desktop application lifecycle', () => {
  it('quits a duplicate instance without starting application resources', async () => {
    const fixture = createFixture({ lockAcquired: false })
    const handle = launchDesktopLifecycle(fixture.options)

    expect(handle.lockAcquired).toBe(false)
    expect(fixture.quitDuplicate).toHaveBeenCalledOnce()
    expect(fixture.bootstrap).not.toHaveBeenCalled()
    expect(() => fixture.secondInstance()).toThrow('second-instance listener is absent')
    await handle.startup
  })

  it('returns synchronously, then focuses the existing window for a second instance', async () => {
    let releaseBootstrap: (() => void) | undefined
    const bootstrapGate = new Promise<void>(resolve => { releaseBootstrap = resolve })
    const fixture = createFixture({ bootstrap: () => bootstrapGate })

    const handle = launchDesktopLifecycle(fixture.options)

    expect(handle.lockAcquired).toBe(true)
    expect(fixture.bootstrap).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(fixture.bootstrap).toHaveBeenCalledOnce()
    fixture.secondInstance()
    expect(fixture.focus).toHaveBeenCalledOnce()
    releaseBootstrap?.()
    await handle.startup
  })

  it('reports only the fixed diagnostic and cleans resources after bootstrap failure', async () => {
    const fixture = createFixture({
      bootstrap: async () => { throw new Error('provider-secret-and-local-path') },
    })
    const handle = launchDesktopLifecycle(fixture.options)

    await handle.startup
    await handle.requestShutdown(1)

    expect(fixture.diagnostic).toHaveBeenCalledExactlyOnceWith(DESKTOP_STARTUP_FAILURE_CODE)
    expect(fixture.shutdown).toHaveBeenCalledOnce()
    expect(fixture.exit).toHaveBeenCalledExactlyOnceWith(1)
  })

  it('prevents repeated quit events and forces exit after the 15 second bound', async () => {
    vi.useFakeTimers()
    const shutdownNeverFinishes = new Promise<void>(() => undefined)
    const fixture = createFixture({ shutdown: () => shutdownNeverFinishes })
    const handle = launchDesktopLifecycle(fixture.options)
    await handle.startup

    const firstEvent = { preventDefault: vi.fn() }
    const repeatedEvent = { preventDefault: vi.fn() }
    fixture.beforeQuit(firstEvent)
    fixture.beforeQuit(repeatedEvent)
    await Promise.resolve()

    expect(firstEvent.preventDefault).toHaveBeenCalledOnce()
    expect(repeatedEvent.preventDefault).toHaveBeenCalledOnce()
    expect(fixture.shutdown).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(14_999)
    expect(fixture.exit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await handle.requestShutdown()
    expect(fixture.exit).toHaveBeenCalledExactlyOnceWith(0)

    const exitEvent = { preventDefault: vi.fn() }
    fixture.beforeQuit(exitEvent)
    expect(exitEvent.preventDefault).not.toHaveBeenCalled()
  })

  it('exits immediately after a completed cleanup and suppresses late focus', async () => {
    const fixture = createFixture()
    const handle = launchDesktopLifecycle(fixture.options)
    await handle.startup

    await handle.requestShutdown()
    fixture.secondInstance()

    expect(fixture.shutdown).toHaveBeenCalledOnce()
    expect(fixture.exit).toHaveBeenCalledExactlyOnceWith(0)
    expect(fixture.focus).not.toHaveBeenCalled()
  })

  it('fails closed with the fixed diagnostic when lock acquisition throws', async () => {
    const fixture = createFixture({ lockError: true })
    const handle = launchDesktopLifecycle(fixture.options)

    expect(handle.lockAcquired).toBe(false)
    expect(fixture.diagnostic).toHaveBeenCalledExactlyOnceWith(DESKTOP_STARTUP_FAILURE_CODE)
    expect(fixture.exit).toHaveBeenCalledExactlyOnceWith(1)
    expect(fixture.bootstrap).not.toHaveBeenCalled()
    await handle.startup
  })
})

function createFixture(overrides: {
  readonly lockAcquired?: boolean
  readonly lockError?: boolean
  readonly bootstrap?: () => Promise<void>
  readonly shutdown?: () => Promise<void>
} = {}): LifecycleFixture {
  let secondInstanceListener: (() => void) | undefined
  let beforeQuitListener: ((event: QuitEventLike) => void) | undefined
  const bootstrap = vi.fn(overrides.bootstrap ?? (async () => undefined))
  const shutdown = vi.fn(overrides.shutdown ?? (async () => undefined))
  const focus = vi.fn<() => void>()
  const quitDuplicate = vi.fn<() => void>()
  const exit = vi.fn<(code: number) => void>()
  const diagnostic = vi.fn<(code: typeof DESKTOP_STARTUP_FAILURE_CODE) => void>()
  return {
    bootstrap,
    shutdown,
    focus,
    quitDuplicate,
    exit,
    diagnostic,
    options: {
      acquireSingleInstanceLock: () => {
        if (overrides.lockError === true) throw new Error('raw-lock-error')
        return overrides.lockAcquired ?? true
      },
      registerSecondInstance: listener => { secondInstanceListener = listener },
      registerBeforeQuit: listener => { beforeQuitListener = listener },
      quitDuplicateInstance: quitDuplicate,
      exit,
      bootstrap,
      shutdown,
      focusExistingWindow: focus,
      reportDiagnostic: diagnostic,
      shutdownTimeoutMs: 15_000,
    },
    secondInstance: () => {
      if (secondInstanceListener === undefined) throw new Error('second-instance listener is absent')
      secondInstanceListener()
    },
    beforeQuit: event => {
      if (beforeQuitListener === undefined) throw new Error('before-quit listener is absent')
      beforeQuitListener(event)
    },
  }
}
