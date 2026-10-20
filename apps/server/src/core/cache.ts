/**
 * Small in-process TTL cache with a size bound and request coalescing, used by the RBAC,
 * session and entitlements caches. Cross-process invalidation is done by NOTIFY kadai_cache
 * (see events.ts); this cache only knows about its own process.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>()
  private readonly inflight = new Map<string, Promise<V>>()
  /** Bumped by clear()/delete() so that a load started before an invalidation is not cached. */
  private generation = 0

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): V | undefined {
    const e = this.entries.get(key)
    if (!e) return undefined
    if (e.expiresAt <= this.now()) {
      this.entries.delete(key)
      return undefined
    }
    return e.value
  }

  set(key: string, value: V): void {
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      // Map iteration order is insertion order: drop the oldest entry.
      const oldest = this.entries.keys().next()
      if (!oldest.done) this.entries.delete(oldest.value)
    }
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs })
  }

  /** Returns the cached value or loads it once (concurrent callers share the same promise). */
  async getOrLoad(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.get(key)
    if (hit !== undefined) return hit
    const pending = this.inflight.get(key)
    if (pending) return pending
    const gen = this.generation
    const p = load()
      .then((value) => {
        if (gen === this.generation) this.set(key, value)
        return value
      })
      .finally(() => this.inflight.delete(key))
    this.inflight.set(key, p)
    return p
  }

  delete(key: string): void {
    this.generation++
    this.entries.delete(key)
    this.inflight.delete(key)
  }

  /** Deletes every key for which `match` returns true. */
  deleteWhere(match: (key: string) => boolean): void {
    this.generation++
    for (const key of [...this.entries.keys()]) if (match(key)) this.entries.delete(key)
    for (const key of [...this.inflight.keys()]) if (match(key)) this.inflight.delete(key)
  }

  clear(): void {
    this.generation++
    this.entries.clear()
    this.inflight.clear()
  }

  get size(): number {
    return this.entries.size
  }
}
