export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<T>) => void
    reject: (error: Error) => void
  }> = []
  private ended = false
  private failure: Error | undefined

  push(value: T): void {
    if (this.ended) return
    const waiter = this.waiters.shift()
    if (waiter === undefined) this.values.push(value)
    else waiter.resolve({ value, done: false })
  }

  close(): void {
    if (this.ended) return
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true })
  }

  fail(error: Error): void {
    if (this.ended) return
    this.failure = error
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        const value = this.values.shift()
        if (value !== undefined) return { value, done: false }
        if (this.failure !== undefined) throw this.failure
        if (this.ended) return { value: undefined, done: true }
        return await new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject })
        })
      },
    }
  }
}
