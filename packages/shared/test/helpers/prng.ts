/** Deterministic PRNG (mulberry32) so property tests are reproducible from a seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface Rng {
  next(): number
  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number
  pick<T>(items: readonly T[]): T
  bool(pTrue?: number): boolean
}

export function createRng(seed: number): Rng {
  const next = mulberry32(seed)
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => {
      const item = items[Math.floor(next() * items.length)]
      if (item === undefined) throw new Error('pick from empty list')
      return item
    },
    bool: (pTrue = 0.5) => next() < pTrue,
  }
}
