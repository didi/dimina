/**
 * Pure bookkeeping for service Worker FIFO barriers. Worker failure makes an ACK impossible, so
 * every waiter must be released and future barriers must become no-ops to let teardown continue.
 */
export class DMPWorkerFlushBarrier {
  private available: boolean = true
  private pending: Map<number, () => void> = new Map()

  register(requestId: number, resolve: () => void): boolean {
    if (!this.available) {
      return false
    }
    this.pending.set(requestId, resolve)
    return true
  }

  complete(requestId: number): void {
    const resolve = this.pending.get(requestId)
    if (!resolve) {
      return
    }
    this.pending.delete(requestId)
    resolve()
  }

  markUnavailable(): void {
    if (!this.available && this.pending.size === 0) {
      return
    }
    this.available = false
    const pendingResolvers = Array.from(this.pending.values())
    this.pending.clear()
    pendingResolvers.forEach((resolve: () => void) => resolve())
  }

  pendingCount(): number {
    return this.pending.size
  }
}
