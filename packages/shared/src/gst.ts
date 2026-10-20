/**
 * GST reference data and validators: rates, state codes (place of supply), GSTIN / PAN / HSN.
 * Rates are integer basis points (18% = 1800). The pricing maths lives in pricing.ts.
 */

/**
 * GST rates allowed on products (bp). GST 2.0 (Sept 2025) structure — 5% / 18% / 40% plus
 * special rates (0.1%, 0.25%, 1%, 1.5%, 3%, 6%, 7.5%) and legacy 12% / 28% still used for some
 * goods and for documents dated before the change.
 */
export const GST_RATES_BP = [0, 10, 25, 100, 150, 300, 500, 600, 750, 1200, 1800, 2800, 4000] as const
export type GstRateBp = (typeof GST_RATES_BP)[number]

const GST_RATE_SET: ReadonlySet<number> = new Set(GST_RATES_BP)

export function isValidGstRate(bp: unknown): bp is GstRateBp {
  return typeof bp === 'number' && GST_RATE_SET.has(bp)
}

export type StateKind = 'state' | 'union_territory' | 'other'

export interface IndianState {
  /** Two-digit GST state code ('33' = Tamil Nadu). */
  code: string
  /** Alpha code used by the GST portal / e-invoice ('TN'). */
  alpha: string
  name_en: string
  name_ta: string
  kind: StateKind
  /** UT without legislature: UTGST is levied instead of SGST. */
  utgst: boolean
  /** Code kept only to read old GSTINs/documents (e.g. 25 Daman & Diu before the 2020 merger). */
  legacy?: boolean
}

const s = (
  code: string,
  alpha: string,
  name_en: string,
  name_ta: string,
  kind: StateKind = 'state',
  utgst = false,
  legacy = false,
): IndianState => ({ code, alpha, name_en, name_ta, kind, utgst, ...(legacy ? { legacy } : {}) })

/** GST state / UT codes (place of supply), ordered by code. */
export const INDIAN_STATES: readonly IndianState[] = [
  s('01', 'JK', 'Jammu and Kashmir', 'ஜம்மு காஷ்மீர்', 'union_territory'),
  s('02', 'HP', 'Himachal Pradesh', 'இமாச்சலப் பிரதேசம்'),
  s('03', 'PB', 'Punjab', 'பஞ்சாப்'),
  s('04', 'CH', 'Chandigarh', 'சண்டிகர்', 'union_territory', true),
  s('05', 'UK', 'Uttarakhand', 'உத்தராகண்ட்'),
  s('06', 'HR', 'Haryana', 'அரியானா'),
  s('07', 'DL', 'Delhi', 'டெல்லி', 'union_territory'),
  s('08', 'RJ', 'Rajasthan', 'ராஜஸ்தான்'),
  s('09', 'UP', 'Uttar Pradesh', 'உத்தரப் பிரதேசம்'),
  s('10', 'BR', 'Bihar', 'பீகார்'),
  s('11', 'SK', 'Sikkim', 'சிக்கிம்'),
  s('12', 'AR', 'Arunachal Pradesh', 'அருணாச்சலப் பிரதேசம்'),
  s('13', 'NL', 'Nagaland', 'நாகாலாந்து'),
  s('14', 'MN', 'Manipur', 'மணிப்பூர்'),
  s('15', 'MZ', 'Mizoram', 'மிசோரம்'),
  s('16', 'TR', 'Tripura', 'திரிபுரா'),
  s('17', 'ML', 'Meghalaya', 'மேகாலயா'),
  s('18', 'AS', 'Assam', 'அசாம்'),
  s('19', 'WB', 'West Bengal', 'மேற்கு வங்காளம்'),
  s('20', 'JH', 'Jharkhand', 'ஜார்கண்ட்'),
  s('21', 'OD', 'Odisha', 'ஒடிசா'),
  s('22', 'CG', 'Chhattisgarh', 'சத்தீஸ்கர்'),
  s('23', 'MP', 'Madhya Pradesh', 'மத்தியப் பிரதேசம்'),
  s('24', 'GJ', 'Gujarat', 'குஜராத்'),
  s('25', 'DD', 'Daman and Diu (before 2020)', 'டாமன் டையூ (2020-க்கு முன்)', 'union_territory', true, true),
  s('26', 'DN', 'Dadra and Nagar Haveli and Daman and Diu', 'தாத்ரா நகர் ஹவேலி மற்றும் டாமன் டையூ', 'union_territory', true),
  s('27', 'MH', 'Maharashtra', 'மகாராஷ்டிரா'),
  s('28', 'AP', 'Andhra Pradesh (before 2018)', 'ஆந்திரப் பிரதேசம் (2018-க்கு முன்)', 'state', false, true),
  s('29', 'KA', 'Karnataka', 'கர்நாடகா'),
  s('30', 'GA', 'Goa', 'கோவா'),
  s('31', 'LD', 'Lakshadweep', 'இலட்சத்தீவுகள்', 'union_territory', true),
  s('32', 'KL', 'Kerala', 'கேரளா'),
  s('33', 'TN', 'Tamil Nadu', 'தமிழ்நாடு'),
  s('34', 'PY', 'Puducherry', 'புதுச்சேரி', 'union_territory'),
  s('35', 'AN', 'Andaman and Nicobar Islands', 'அந்தமான் நிக்கோபார் தீவுகள்', 'union_territory', true),
  s('36', 'TS', 'Telangana', 'தெலங்கானா'),
  s('37', 'AD', 'Andhra Pradesh', 'ஆந்திரப் பிரதேசம்'),
  s('38', 'LA', 'Ladakh', 'லடாக்', 'union_territory', true),
  s('97', 'OT', 'Other Territory', 'பிற பிரதேசம்', 'other'),
  s('99', 'CJ', 'Centre Jurisdiction', 'மத்திய அதிகார வரம்பு', 'other'),
]

/** All state codes, including legacy codes (valid in GSTINs and old documents). */
export const STATE_CODES = INDIAN_STATES.map((st) => st.code) as [string, ...string[]]

/** Codes offered when choosing a place of supply / store state (no legacy codes). */
export const ACTIVE_STATE_CODES = INDIAN_STATES.filter((st) => !st.legacy).map((st) => st.code)

export const TAMIL_NADU_STATE_CODE = '33'

const STATE_BY_CODE: ReadonlyMap<string, IndianState> = new Map(INDIAN_STATES.map((st) => [st.code, st]))

export function getState(code: string): IndianState | undefined {
  return STATE_BY_CODE.get(code)
}

export function isValidStateCode(code: unknown): code is string {
  return typeof code === 'string' && STATE_BY_CODE.has(code)
}

/** 'UTGST' for union territories without legislature, otherwise 'SGST' (invoice labels). */
export function stateTaxLabel(stateCode: string): 'SGST' | 'UTGST' {
  return getState(stateCode)?.utgst ? 'UTGST' : 'SGST'
}

// ---------------------------------------------------------------------------------------------
// GSTIN
// ---------------------------------------------------------------------------------------------

const GSTIN_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
/** 2-digit state, 10 alphanumerics (PAN or special id), entity number 1-9/A-Z, 2 alphanumerics. */
const GSTIN_STRUCTURE_RE = /^[0-9]{2}[0-9A-Z]{10}[1-9A-Z][0-9A-Z]{2}$/
/** Regular taxpayer: PAN-based with 'Z' as the 14th character. */
const GSTIN_REGULAR_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/

/**
 * GSTIN check character for the first 14 characters (base-36 Luhn mod N):
 * factor alternates 1, 2 from the left; p = value × factor; sum += ⌊p / 36⌋ + p mod 36;
 * check = (36 − sum mod 36) mod 36.
 * @throws RangeError when `first14` is not 14 characters of [0-9A-Z].
 */
export function gstinCheckChar(first14: string): string {
  const value = first14.toUpperCase()
  if (!/^[0-9A-Z]{14}$/.test(value)) throw new RangeError('GSTIN body must be 14 characters [0-9A-Z]')
  let sum = 0
  for (let i = 0; i < 14; i++) {
    const v = GSTIN_CHARSET.indexOf(value.charAt(i))
    const p = v * (i % 2 === 1 ? 2 : 1)
    sum += Math.floor(p / 36) + (p % 36)
  }
  return GSTIN_CHARSET.charAt((36 - (sum % 36)) % 36)
}

/** Normalises user input: trims and upper-cases ("  33aapfu0939f1zv " → "33AAPFU0939F1ZV"). */
export function normalizeGstin(input: string): string {
  return input.trim().toUpperCase()
}

/**
 * Validates a GSTIN (expects normalised upper case): structure, known state code and checksum.
 * Special registrations (TDS/TCS, UN bodies, OIDAR) pass when their checksum is valid.
 */
export function isValidGstin(gstin: unknown): gstin is string {
  if (typeof gstin !== 'string' || !GSTIN_STRUCTURE_RE.test(gstin)) return false
  if (!isValidStateCode(gstin.slice(0, 2))) return false
  return gstinCheckChar(gstin.slice(0, 14)) === gstin.charAt(14)
}

/** True for a valid regular (PAN-based) taxpayer GSTIN. */
export function isRegularGstin(gstin: string): boolean {
  return isValidGstin(gstin) && GSTIN_REGULAR_RE.test(gstin)
}

/** State code of a GSTIN ('33AAPFU0939F1ZV' → '33'), or null if invalid. */
export function stateCodeFromGstin(gstin: string): string | null {
  return isValidGstin(gstin) ? gstin.slice(0, 2) : null
}

/** PAN embedded in a regular GSTIN (characters 3–12), or null. */
export function panFromGstin(gstin: string): string | null {
  if (!isValidGstin(gstin)) return null
  const pan = gstin.slice(2, 12)
  return isValidPan(pan) ? pan : null
}

/** Builds a valid GSTIN from state code + PAN + entity number (tests, fixtures, data repair). */
export function makeGstin(stateCode: string, pan: string, entity = '1'): string {
  const body = `${stateCode}${pan}${entity}Z`
  return body + gstinCheckChar(body)
}

/**
 * PAN: AAAAA9999A where the 4th character is the holder type
 * (P individual, C company, H HUF, F firm/LLP, A AOP, T trust, B BOI, L local authority,
 * J artificial juridical person, G government, K krish, E LLP).
 */
const PAN_RE = /^[A-Z]{3}[ABCEFGHJKLPT][A-Z][0-9]{4}[A-Z]$/

export function isValidPan(pan: unknown): pan is string {
  return typeof pan === 'string' && PAN_RE.test(pan)
}

// ---------------------------------------------------------------------------------------------
// HSN / SAC and inter-state supply
// ---------------------------------------------------------------------------------------------

/** HSN (goods) or SAC (services, 6 digits starting 99): 4, 6 or 8 digits. */
export function isValidHsn(code: unknown): code is string {
  return typeof code === 'string' && /^(?:[0-9]{4}|[0-9]{6}|[0-9]{8})$/.test(code)
}

/**
 * Inter-state supply when the place of supply differs from the supplier (store) state.
 * (Supplies to SEZ units are inter-state even within a state: pass is_interstate explicitly.)
 */
export function isInterstate(storeStateCode: string, placeOfSupply: string): boolean {
  return storeStateCode !== placeOfSupply
}

/** Splits intra-state GST into the two halves: sgst = ⌊gst / 2⌋, cgst = gst − sgst. */
export function splitGst(gstPaise: number): { cgst_paise: number; sgst_paise: number } {
  if (!Number.isSafeInteger(gstPaise)) throw new RangeError('gstPaise must be a safe integer')
  const sgst = Math.floor(gstPaise / 2)
  return { cgst_paise: gstPaise - sgst, sgst_paise: sgst }
}

/** Half of a GST rate for CGST/SGST labels: 1800 → 900 (9%). */
export function halfRateBp(gstRateBp: number): number {
  return gstRateBp / 2
}
