/** Barcode wedge detection, scale frames, the "3*" multiplier and the keyboard map. */
import { describe, expect, it } from 'vitest'
import { createFrameSplitter, parseScaleFrame, weightToQtyMilli } from '../hardware/scale'
import { createWedgeDetector, looksLikeCode } from '../lib/barcode-wedge'
import { HELP_ORDER, POS_ACTIONS, POS_KEYMAP } from '../lib/keymap'
import { parseMultiplier } from '../lib/search'

function typeKeys(
  detector: ReturnType<typeof createWedgeDetector>,
  text: string,
  gapMs: number,
  start = 1000,
) {
  let t = start
  const results = []
  for (const ch of text) {
    results.push(detector.push({ key: ch, time: t }))
    t += gapMs
  }
  results.push(detector.push({ key: 'Enter', time: t }))
  return results.at(-1)
}

describe('barcode wedge', () => {
  it('a fast burst ending in Enter is a scan', () => {
    const d = createWedgeDetector()
    expect(typeKeys(d, '8901234500011', 8)).toEqual({ kind: 'scan', code: '8901234500011' })
  })

  it('human typing is not a scan, and a pause starts a new candidate', () => {
    const d = createWedgeDetector()
    expect(typeKeys(d, '8901', 120)).toEqual({ kind: 'none' })
    // Slow first keys, then a scanner burst: only the burst is the code.
    d.push({ key: 'r', time: 0 })
    d.push({ key: 'i', time: 300 })
    expect(typeKeys(d, '8901234500028', 5, 900)).toEqual({ kind: 'scan', code: '8901234500028' })
  })

  it('short bursts, modifier combos and over-long input are ignored', () => {
    const d = createWedgeDetector({ minLength: 4 })
    expect(typeKeys(d, '12', 5)).toEqual({ kind: 'none' })
    d.push({ key: '1', time: 0 })
    expect(d.push({ key: 'p', time: 5, ctrlKey: true })).toEqual({ kind: 'none' })
    expect(d.buffer()).toBe('')
    expect(typeKeys(createWedgeDetector({ maxLength: 8 }), '1234567890123', 5)).toEqual({
      kind: 'none',
    })
  })

  it('Shift inside a burst (upper-case codes) is ignored', () => {
    const d = createWedgeDetector()
    let t = 0
    for (const ch of 'AB12') {
      d.push({ key: 'Shift', time: t })
      d.push({ key: ch, time: t + 2 })
      t += 6
    }
    expect(d.push({ key: 'Enter', time: t })).toEqual({ kind: 'scan', code: 'AB12' })
  })

  it('looksLikeCode tells codes from product names', () => {
    expect(looksLikeCode('8901234500011')).toBe(true)
    expect(looksLikeCode('ponni rice')).toBe(false)
  })
})

describe('search multiplier', () => {
  it('parses "3*rice", "2.5x" and plain text', () => {
    expect(parseMultiplier('3*rice')).toEqual({ qty_milli: 3000, rest: 'rice' })
    expect(parseMultiplier('2.5x')).toEqual({ qty_milli: 2500, rest: '' })
    expect(parseMultiplier('12 × 8901234500011')).toEqual({
      qty_milli: 12_000,
      rest: '8901234500011',
    })
    expect(parseMultiplier(' toor dal ')).toEqual({ qty_milli: null, rest: 'toor dal' })
    expect(parseMultiplier('0*rice')).toEqual({ qty_milli: null, rest: 'rice' })
  })
})

describe('scale frames', () => {
  const settings = { weight_pattern: null, weight_unit: 'kg' as const, stable_only: true }

  it('reads common frame formats', () => {
    expect(parseScaleFrame('ST,GS,+  1.250kg', settings, 1)).toEqual({
      kg_milli: 1250,
      stable: true,
      raw: 'ST,GS,+  1.250kg',
      at: 1,
    })
    expect(parseScaleFrame('\u0002  0750 g\u0003', settings)?.kg_milli).toBe(750)
    expect(parseScaleFrame('1,5', settings)?.kg_milli).toBe(1500)
  })

  it('drops unstable, overload and negative frames', () => {
    expect(parseScaleFrame('US,GS,+  1.250kg', settings)).toBeNull()
    expect(parseScaleFrame('US,GS,+  1.250kg', { ...settings, stable_only: false })?.stable).toBe(
      false,
    )
    expect(parseScaleFrame('OL', settings)).toBeNull()
    expect(parseScaleFrame('-0.020kg', settings)).toBeNull()
    expect(parseScaleFrame('', settings)).toBeNull()
  })

  it('a configured pattern picks the number', () => {
    const custom = { ...settings, weight_pattern: 'W=(\\d+)', weight_unit: 'g' as const }
    expect(parseScaleFrame('N=7 W=0480 T=0', custom)?.kg_milli).toBe(480)
  })

  it('splits a serial stream into frames', () => {
    const frames: string[] = []
    const splitter = createFrameSplitter((f) => frames.push(f))
    splitter.push('ST,GS, 1.2')
    splitter.push('00kg\r\nST,GS, 0.5')
    splitter.push('00kg\r\n')
    expect(frames).toEqual(['ST,GS, 1.200kg', 'ST,GS, 0.500kg'])
  })

  it('converts a weight to the product unit', () => {
    expect(weightToQtyMilli(1250, 'KG')).toBe(1250)
    expect(weightToQtyMilli(1250, 'G')).toBe(1_250_000)
    expect(weightToQtyMilli(1250, 'PCS')).toBeNull()
  })
})

describe('keyboard map', () => {
  it('binds every action to a distinct key and lists all of them in the help overlay', () => {
    const keys = POS_ACTIONS.map((a) => POS_KEYMAP[a].toLowerCase())
    expect(new Set(keys).size).toBe(keys.length)
    expect([...HELP_ORDER].sort()).toEqual([...POS_ACTIONS].sort())
    expect(POS_KEYMAP).toMatchObject({
      help: 'F1',
      search: 'F2',
      pay: 'F8',
      cash_exact: 'F9',
      upi: 'F10',
      save_print: 'F12',
    })
  })
})
