// A first-in, first-out queue with a hard size. When it is full a new item is dropped and counted,
// so a flood can never grow memory without bound. The crew gate's audit rows wait here for their
// batched write.
export class BoundedQueue<T> {
  private items: T[] = []
  /** Items refused because the queue was full, since the process started. */
  dropped = 0

  constructor(private readonly max: number) {}

  push(item: T): boolean {
    if (this.items.length >= this.max) {
      this.dropped++
      return false
    }
    this.items.push(item)
    return true
  }

  /** Takes everything queued so far, oldest first, and leaves the queue empty. */
  drain(): T[] {
    const taken = this.items
    this.items = []
    return taken
  }

  get length(): number {
    return this.items.length
  }
}
