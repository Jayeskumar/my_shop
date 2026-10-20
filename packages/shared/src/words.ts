/**
 * Amount in words for invoices (ARCHITECTURE.md §9.3), Indian numbering system
 * (thousand, lakh, crore), English and Tamil.
 *
 *   amountInWords(12345650, 'en') → "Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Fifty Paise Only"
 *   amountInWords(12345650, 'ta') → "ரூபாய் ஒரு லட்சத்து இருபத்து மூன்றாயிரத்து நானூற்று ஐம்பத்து ஆறு மற்றும் ஐம்பது பைசா மட்டும்"
 *
 * Tamil uses combining forms when a larger unit is followed by more digits
 * (இருபது → இருபத்து, நூறு → நூற்று, ஆயிரம் → ஆயிரத்து, லட்சம் → லட்சத்து, கோடி → கோடியே),
 * fuses the thousands multiplier with ஆயிரம் (இரண்டாயிரம், இருபத்து ஓராயிரம்) and uses the
 * adjective forms ஒரு / பதினொரு before லட்சம் and கோடி.
 */

export type WordsLocale = 'en' | 'ta'

/** Largest supported number: 99,99,99,99,999 (9,999 crore …). */
export const MAX_WORDS_NUMBER = 99_999_999_999

const CRORE = 10_000_000
const LAKH = 100_000

// ---------------------------------------------------------------------------------------------
// English
// ---------------------------------------------------------------------------------------------

const EN_ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
]
const EN_TENS = [
  '',
  '',
  'Twenty',
  'Thirty',
  'Forty',
  'Fifty',
  'Sixty',
  'Seventy',
  'Eighty',
  'Ninety',
]

function en99(n: number): string {
  if (n < 20) return EN_ONES[n]!
  const t = Math.floor(n / 10)
  const u = n % 10
  return u === 0 ? EN_TENS[t]! : `${EN_TENS[t]!} ${EN_ONES[u]!}`
}

function en999(n: number): string {
  const h = Math.floor(n / 100)
  const r = n % 100
  if (h === 0) return en99(r)
  return r === 0 ? `${EN_ONES[h]!} Hundred` : `${EN_ONES[h]!} Hundred ${en99(r)}`
}

function enIndian(n: number): string {
  const parts: string[] = []
  const crore = Math.floor(n / CRORE)
  const lakh = Math.floor((n % CRORE) / LAKH)
  const thousand = Math.floor((n % LAKH) / 1000)
  const rest = n % 1000
  if (crore) parts.push(`${enIndian(crore)} Crore`)
  if (lakh) parts.push(`${en99(lakh)} Lakh`)
  if (thousand) parts.push(`${en99(thousand)} Thousand`)
  if (rest) parts.push(en999(rest))
  return parts.join(' ')
}

// ---------------------------------------------------------------------------------------------
// Tamil
// ---------------------------------------------------------------------------------------------

const TA_UNITS = [
  '',
  'ஒன்று',
  'இரண்டு',
  'மூன்று',
  'நான்கு',
  'ஐந்து',
  'ஆறு',
  'ஏழு',
  'எட்டு',
  'ஒன்பது',
]
const TA_TEENS = [
  'பத்து',
  'பதினொன்று',
  'பன்னிரண்டு',
  'பதிமூன்று',
  'பதினான்கு',
  'பதினைந்து',
  'பதினாறு',
  'பதினேழு',
  'பதினெட்டு',
  'பத்தொன்பது',
]
const TA_TENS = [
  '',
  '',
  'இருபது',
  'முப்பது',
  'நாற்பது',
  'ஐம்பது',
  'அறுபது',
  'எழுபது',
  'எண்பது',
  'தொண்ணூறு',
]
const TA_TENS_COMBINING = [
  '',
  '',
  'இருபத்து',
  'முப்பத்து',
  'நாற்பத்து',
  'ஐம்பத்து',
  'அறுபத்து',
  'எழுபத்து',
  'எண்பத்து',
  'தொண்ணூற்று',
]
const TA_HUNDREDS = [
  '',
  'நூறு',
  'இருநூறு',
  'முந்நூறு',
  'நானூறு',
  'ஐநூறு',
  'அறுநூறு',
  'எழுநூறு',
  'எண்ணூறு',
  'தொள்ளாயிரம்',
]
const TA_HUNDREDS_COMBINING = [
  '',
  'நூற்று',
  'இருநூற்று',
  'முந்நூற்று',
  'நானூற்று',
  'ஐநூற்று',
  'அறுநூற்று',
  'எழுநூற்று',
  'எண்ணூற்று',
  'தொள்ளாயிரத்து',
]

const TA_ONE = 'ஒன்று'
const TA_ELEVEN = 'பதினொன்று'
const VOWEL_SIGN_U = 'ு' // ு — every final number word below 100 ends with it

function ta99(n: number): string {
  if (n < 10) return TA_UNITS[n]!
  if (n < 20) return TA_TEENS[n - 10]!
  const t = Math.floor(n / 10)
  const u = n % 10
  return u === 0 ? TA_TENS[t]! : `${TA_TENS_COMBINING[t]!} ${TA_UNITS[u]!}`
}

function ta999(n: number): string {
  const h = Math.floor(n / 100)
  const r = n % 100
  if (h === 0) return ta99(r)
  return r === 0 ? TA_HUNDREDS[h]! : `${TA_HUNDREDS_COMBINING[h]!} ${ta99(r)}`
}

/** Adjective form before லட்சம் / கோடி: …ஒன்று → …ஒரு, …பதினொன்று → …பதினொரு. */
function taAdjective(words: string): string {
  if (words.endsWith(TA_ELEVEN)) return `${words.slice(0, -TA_ELEVEN.length)}பதினொரு`
  if (words.endsWith(TA_ONE)) return `${words.slice(0, -TA_ONE.length)}ஒரு`
  return words
}

/** m × 1000 for m in 1..99, fused with ஆயிரம் (sandhi): 2 → இரண்டாயிரம், 21 → இருபத்து ஓராயிரம். */
function taThousands(m: number, combining: boolean): string {
  if (m === 1) return combining ? 'ஆயிரத்து' : 'ஆயிரம்'
  // "ா" + "யிரம்": the multiplier's final vowel u (ு) becomes ā (ா) — இரண்டு + ஆயிரம் = இரண்டாயிரம்.
  const suffix = combining ? 'ாயிரத்து' : 'ாயிரம்'
  const words = ta99(m)
  if (words.endsWith(TA_ELEVEN)) return `${words.slice(0, -TA_ELEVEN.length)}பதினோர${suffix}`
  if (words.endsWith(TA_ONE)) return `${words.slice(0, -TA_ONE.length)}ஓர${suffix}`
  if (words.endsWith(VOWEL_SIGN_U)) return `${words.slice(0, -1)}${suffix}`
  // Not reachable for 2..99 (all end in ு); kept as a safe fallback.
  return `${words} ${combining ? 'ஆயிரத்து' : 'ஆயிரம்'}`
}

function taIndian(n: number): string {
  const crore = Math.floor(n / CRORE)
  const belowCrore = n % CRORE
  const lakh = Math.floor(belowCrore / LAKH)
  const belowLakh = belowCrore % LAKH
  const thousand = Math.floor(belowLakh / 1000)
  const rest = belowLakh % 1000
  const parts: string[] = []
  if (crore) parts.push(`${taAdjective(taIndian(crore))} ${belowCrore > 0 ? 'கோடியே' : 'கோடி'}`)
  if (lakh) parts.push(`${taAdjective(ta99(lakh))} ${belowLakh > 0 ? 'லட்சத்து' : 'லட்சம்'}`)
  if (thousand) parts.push(taThousands(thousand, rest > 0))
  if (rest) parts.push(ta999(rest))
  return parts.join(' ')
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

function assertWordsNumber(n: number, name: string): void {
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX_WORDS_NUMBER) {
    throw new RangeError(
      `${name} must be an integer between 0 and ${MAX_WORDS_NUMBER}, got ${String(n)}`,
    )
  }
}

/** Integer in words (Indian system): 123456 → "One Lakh Twenty Three Thousand Four Hundred Fifty Six". */
export function numberToWords(n: number, locale: WordsLocale = 'en'): string {
  assertWordsNumber(n, 'n')
  if (n === 0) return locale === 'ta' ? 'பூஜ்ஜியம்' : 'Zero'
  return locale === 'ta' ? taIndian(n) : enIndian(n)
}

/**
 * Invoice amount in words. Zero → "Rupees Zero Only" / "ரூபாய் பூஜ்ஜியம் மட்டும்";
 * paise only → "Fifty Paise Only" / "ஐம்பது பைசா மட்டும்".
 * @throws RangeError for negative, fractional or too large amounts.
 */
export function amountInWords(paise: number, locale: WordsLocale = 'en'): string {
  if (!Number.isSafeInteger(paise) || paise < 0)
    throw new RangeError('paise must be a non-negative integer')
  const p = paise % 100
  const rupees = (paise - p) / 100
  assertWordsNumber(rupees, 'rupees')
  if (locale === 'ta') {
    if (rupees === 0 && p > 0) return `${numberToWords(p, 'ta')} பைசா மட்டும்`
    const paisePart = p > 0 ? ` மற்றும் ${numberToWords(p, 'ta')} பைசா` : ''
    return `ரூபாய் ${numberToWords(rupees, 'ta')}${paisePart} மட்டும்`
  }
  if (rupees === 0 && p > 0) return `${numberToWords(p)} Paise Only`
  const paisePart = p > 0 ? ` and ${numberToWords(p)} Paise` : ''
  return `Rupees ${numberToWords(rupees)}${paisePart} Only`
}
