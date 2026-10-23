/**
 * Keyboard-wedge barcode scanner detection. A scanner "types" the code as a burst of keystrokes
 * (a few ms apart) followed by Enter; people type far slower. The detector watches keydown
 * events and reports a scan when at least `minLength` printable characters arrived with every
 * gap ≤ `maxGapMs`, terminated by Enter (or Tab, for scanners configured that way).
 *
 * It never steals typing from text fields: callers decide what to do with the result (the POS
 * search box treats a burst as a code lookup, the page-level listener only listens while focus
 * is not in an input).
 */

export interface WedgeOptions {
  /** Shortest code accepted as a scan (default 4). */
  minLength?: number
  /** Largest gap between two scanner keystrokes in ms (default 35). */
  maxGapMs?: number
  /** Longest code (default 64, the API limit). */
  maxLength?: number
}

export interface WedgeKey {
  key: string
  /** event.timeStamp / performance.now() in ms. */
  time: number
  ctrlKey?: boolean
  altKey?: boolean
  metaKey?: boolean
}

export type WedgeResult =
  /** Not part of a scan. */
  | { kind: 'none' }
  /** A printable key was buffered (may be part of a scan). */
  | { kind: 'buffered' }
  /** Enter ended a burst: the scanned code. */
  | { kind: 'scan'; code: string }

export interface WedgeDetector {
  push: (key: WedgeKey) => WedgeResult
  reset: () => void
  /** Whether the keys typed so far look like a scanner burst. */
  isBurst: () => boolean
  /** Characters buffered so far. */
  buffer: () => string
}

export function createWedgeDetector(options: WedgeOptions = {}): WedgeDetector {
  const minLength = options.minLength ?? 4
  const maxGap = options.maxGapMs ?? 35
  const maxLength = options.maxLength ?? 64
  let chars: string[] = []
  let lastTime = -Infinity
  let burst = true

  const reset = (): void => {
    chars = []
    lastTime = -Infinity
    burst = true
  }

  return {
    reset,
    isBurst: () => burst && chars.length >= minLength,
    buffer: () => chars.join(''),
    push(k) {
      if (k.ctrlKey || k.altKey || k.metaKey) {
        reset()
        return { kind: 'none' }
      }
      const gap = k.time - lastTime
      if (k.key === 'Enter' || k.key === 'Tab') {
        const code = chars.join('')
        const isScan = burst && chars.length >= minLength && gap <= maxGap * 4
        reset()
        return isScan ? { kind: 'scan', code } : { kind: 'none' }
      }
      if (k.key.length !== 1) {
        // Shift and other modifiers come with scanner bursts on some layouts: ignore them.
        if (k.key === 'Shift') return { kind: 'none' }
        reset()
        return { kind: 'none' }
      }
      if (chars.length > 0 && gap > maxGap) {
        // A slow key starts a new candidate burst (the first character may follow a pause).
        chars = []
        burst = true
      }
      if (chars.length >= maxLength) {
        burst = false
      }
      chars.push(k.key)
      lastTime = k.time
      return { kind: 'buffered' }
    },
  }
}

/** A typed query that is clearly a code (digits / no spaces, 6+ chars): try the exact lookup. */
export function looksLikeCode(text: string): boolean {
  const s = text.trim()
  return /^[0-9]{6,}$/.test(s) || (/^\S{4,}$/.test(s) && /\d/.test(s) && !/\s/.test(s))
}
