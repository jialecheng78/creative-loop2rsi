export const DESKTOP_STARTUP_FAILURE_CODE = 'DESKTOP_STARTUP_FAILED'
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000

export interface QuitEventLike {
  preventDefault(): void
}

export interface DesktopLifecycleOptions {
  readonly acquireSingleInstanceLock: () => boolean
  readonly registerSecondInstance: (listener: () => void) => void
  readonly registerBeforeQuit: (listener: (event: QuitEventLike) => void) => void
  readonly quitDuplicateInstance: () => void
  readonly exit: (code: number) => void
  readonly bootstrap: () => Promise<void>
  readonly shutdown: () => Promise<void>
  readonly focusExistingWindow: () => void
  readonly reportDiagnostic: (code: typeof DESKTOP_STARTUP_FAILURE_CODE) => void
  readonly shutdownTimeoutMs?: number
}

export interface DesktopLifecycleHandle {
  readonly lockAcquired: boolean
  readonly startup: Promise<void>
  requestShutdown(code?: number): Promise<void>
}

/**
 * Start Electron without returning the bootstrap Promise to the ESM loader.
 * Electron's default app awaits the entrypoint import before emitting `ready`,
 * so the caller must invoke this function without a top-level await.
 */
export function launchDesktopLifecycle(options: DesktopLifecycleOptions): DesktopLifecycleHandle {
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
  if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs <= 0) {
    throw new TypeError('shutdownTimeoutMs must be a positive safe integer')
  }

  let lockAcquired: boolean
  try {
    lockAcquired = options.acquireSingleInstanceLock()
  } catch {
    reportStartupFailure(options)
    options.exit(1)
    return inactiveHandle(false)
  }
  if (!lockAcquired) {
    options.quitDuplicateInstance()
    return inactiveHandle(false)
  }

  let exitAllowed = false
  let exitCode = 0
  let shutdownRequested = false
  let shutdownTask: Promise<void> | undefined
  let startupTask: Promise<void>

  const requestShutdown = (code = 0): Promise<void> => {
    exitCode = Math.max(exitCode, code)
    shutdownRequested = true
    shutdownTask ??= (async () => {
      const orderlyShutdown = (async () => {
        await startupTask
        await options.shutdown()
      })()
      await completionWithin(orderlyShutdown, shutdownTimeoutMs)
      exitAllowed = true
      options.exit(exitCode)
    })()
    return shutdownTask
  }

  try {
    options.registerSecondInstance(() => {
      if (shutdownRequested) return
      try {
        options.focusExistingWindow()
      } catch {
        // A window can be destroyed between the state check and focus call.
      }
    })
    options.registerBeforeQuit(event => {
      if (exitAllowed) return
      event.preventDefault()
      void requestShutdown(0)
    })
  } catch {
    reportStartupFailure(options)
    options.exit(1)
    return inactiveHandle(true)
  }

  // Do not await this task from the module entrypoint. Scheduling bootstrap in
  // a microtask lets Electron finish importing the ESM main module first.
  startupTask = Promise.resolve()
    .then(async () => {
      if (shutdownRequested) return
      await options.bootstrap()
    })
    .catch(() => {
      reportStartupFailure(options)
      void requestShutdown(1)
    })

  return {
    lockAcquired: true,
    startup: startupTask,
    requestShutdown,
  }
}

function inactiveHandle(lockAcquired: boolean): DesktopLifecycleHandle {
  return {
    lockAcquired,
    startup: Promise.resolve(),
    requestShutdown: () => Promise.resolve(),
  }
}

function reportStartupFailure(options: DesktopLifecycleOptions): void {
  try {
    options.reportDiagnostic(DESKTOP_STARTUP_FAILURE_CODE)
  } catch {
    // Diagnostics must never replace the fixed public failure boundary.
  }
}

function completionWithin(task: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise(resolve => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    void task.then(finish, finish)
  })
}
