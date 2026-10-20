/** Small text helpers. */

let segmenter: Intl.Segmenter | undefined

/**
 * Up to two initials, grapheme-aware so Tamil names keep their vowel signs:
 * "Murugan K" → "MK", "முருகன் கண்ணன்" → "முக".
 */
export function initialsOf(name: string): string {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  const words = name.trim().split(/\s+/u).filter(Boolean)
  const first = (w: string): string => {
    const it = segmenter!.segment(w)[Symbol.iterator]().next()
    return it.done ? '' : it.value.segment
  }
  const picks = words.length > 1 ? [words[0]!, words[words.length - 1]!] : words.slice(0, 1)
  return picks.map(first).join('').toLocaleUpperCase('en-IN')
}
