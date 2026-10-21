/** Search box helpers. */

const MULTIPLIER_RE = /^(\d{1,4}(?:\.\d{1,3})?)\s*[*xX×]\s*(.*)$/

/** Quantity prefix typed before a scan / search: "3*rice" → { qty: 3000, rest: 'rice' }; "2.5x" → { qty: 2500, rest: '' }. */
export function parseMultiplier(text: string): { qty_milli: number | null; rest: string } {
  const m = MULTIPLIER_RE.exec(text.trim())
  if (!m) return { qty_milli: null, rest: text.trim() }
  const qty = Math.round(Number(m[1]) * 1000)
  return { qty_milli: qty > 0 ? qty : null, rest: (m[2] ?? '').trim() }
}
