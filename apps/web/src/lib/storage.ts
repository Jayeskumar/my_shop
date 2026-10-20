/**
 * Safe localStorage wrapper. Keys are namespaced with `kadai.`, values are JSON. Every access is
 * guarded: in private mode / disabled storage / quota errors the values live in memory for the
 * session instead of throwing.
 */

const PREFIX = 'kadai.'
const memory = new Map<string, string>()

function backend(): Storage | null {
  try {
    const ls = globalThis.localStorage
    if (!ls) return null
    return ls
  } catch {
    return null
  }
}

function readRaw(key: string): string | null {
  const full = PREFIX + key
  try {
    const ls = backend()
    if (ls) return ls.getItem(full)
  } catch {
    // fall through to memory
  }
  return memory.get(full) ?? null
}

function writeRaw(key: string, value: string | null): void {
  const full = PREFIX + key
  if (value === null) memory.delete(full)
  else memory.set(full, value)
  try {
    const ls = backend()
    if (!ls) return
    if (value === null) ls.removeItem(full)
    else ls.setItem(full, value)
  } catch {
    // quota exceeded / disabled: the in-memory copy keeps the app working this session
  }
}

export const storage = {
  /**
   * Reads a JSON value. Returns `fallback` when missing, unparsable, or rejected by `validate`
   * (always validate data that affects behaviour: storage may hold values from an old version).
   */
  get<T>(key: string, fallback: T, validate?: (value: unknown) => value is T): T {
    const raw = readRaw(key)
    if (raw === null) return fallback
    try {
      const parsed: unknown = JSON.parse(raw)
      if (validate && !validate(parsed)) return fallback
      return parsed as T
    } catch {
      return fallback
    }
  },

  set(key: string, value: unknown): void {
    writeRaw(key, value === undefined ? null : JSON.stringify(value))
  },

  remove(key: string): void {
    writeRaw(key, null)
  },

  /** Keys (without prefix) currently stored, optionally filtered by a prefix. */
  keys(prefix = ''): string[] {
    const out = new Set<string>()
    try {
      const ls = backend()
      if (ls) {
        for (let i = 0; i < ls.length; i++) {
          const k = ls.key(i)
          if (k?.startsWith(PREFIX + prefix)) out.add(k.slice(PREFIX.length))
        }
      }
    } catch {
      // ignore
    }
    for (const k of memory.keys())
      if (k.startsWith(PREFIX + prefix)) out.add(k.slice(PREFIX.length))
    return [...out]
  },

  /** Calls `listener` when another tab changes `key`. Returns an unsubscribe function. */
  subscribe(key: string, listener: (value: unknown) => void): () => void {
    if (typeof window === 'undefined') return () => {}
    const full = PREFIX + key
    const onStorage = (event: StorageEvent): void => {
      if (event.key !== full) return
      try {
        listener(event.newValue === null ? null : (JSON.parse(event.newValue) as unknown))
      } catch {
        listener(null)
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  },

  /** Test helper: forget the in-memory fallback copies. */
  _resetMemory(): void {
    memory.clear()
  },
}

export const isString = (v: unknown): v is string => typeof v === 'string'
export const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean'
export const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
