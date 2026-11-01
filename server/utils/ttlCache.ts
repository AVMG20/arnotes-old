// A single value kept for a short time. The crew gate keeps the window row here for at most
// two seconds, and clears it on every open, close and expiry, so a flood of calls does not read
// the database each time.
export const MAX_TTL_MS = 2_000

export class TtlCache<T> {
  private value: T | undefined
  private storedAt = 0
  private readonly ttl: number

  constructor(ttlMs = MAX_TTL_MS) {
    // Never longer than the limit, whatever the caller asks for.
    this.ttl = Math.min(ttlMs, MAX_TTL_MS)
  }

  get(now: number): T | undefined {
    if (this.value === undefined) return undefined
    if (now - this.storedAt >= this.ttl) {
      this.clear()
      return undefined
    }
    return this.value
  }

  set(value: T, now: number): void {
    this.value = value
    this.storedAt = now
  }

  clear(): void {
    this.value = undefined
    this.storedAt = 0
  }
}

// Returns the cached value when it is fresh, otherwise loads it and keeps it. A clear() makes the
// next call load again at once.
export async function readThrough<T>(cache: TtlCache<T>, now: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(now)
  if (hit !== undefined) return hit
  const value = await load()
  cache.set(value, now)
  return value
}
