/**
 * Reconciles runtime events that can arrive before works.start resolves.
 * A terminal run must never be re-activated by its late start handle.
 */
export class RunResolutionTracker {
  readonly #terminalRunIds = new Set<string>()

  markTerminal(runId: string): void {
    this.#terminalRunIds.add(runId)
  }

  shouldActivate(runId: string): boolean {
    if (!this.#terminalRunIds.delete(runId)) return true
    return false
  }
}
