/**
 * Business dates, financial years and GST periods.
 *
 * Business dates are 'YYYY-MM-DD' strings in the tenant timezone (default Asia/Kolkata);
 * instants are JS Dates / ISO timestamps. Financial year labels look like '2026-27'
 * (April 2026 → March 2027 by default, `tenants.fy_start_month`), short form '2627'.
 * Date arithmetic is done on UTC calendar days, so it is independent of the host timezone.
 */

export const DEFAULT_TIMEZONE = 'Asia/Kolkata'
export const DEFAULT_FY_START_MONTH = 4

export interface DateRange {
  from: string
  to: string
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const PERIOD_RE = /^(\d{4})-(\d{2})$/
const FY_RE = /^(\d{4})-(\d{2})$/
const MS_PER_DAY = 86_400_000

const pad2 = (n: number): string => String(n).padStart(2, '0')
const pad4 = (n: number): string => String(n).padStart(4, '0')

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** Strict 'YYYY-MM-DD' with a real calendar day (leap years included). */
export function isDateStr(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const m = DATE_RE.exec(value)
  if (!m) return false
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo)
}

function parseDate(dateStr: string): { y: number; m: number; d: number } {
  if (!isDateStr(dateStr)) throw new RangeError(`invalid date: ${JSON.stringify(dateStr)}`)
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number]
  return { y, m, d }
}

function utcDays(dateStr: string): number {
  const { y, m, d } = parseDate(dateStr)
  return Date.UTC(y, m - 1, d) / MS_PER_DAY
}

function fromUtcMs(ms: number): string {
  const dt = new Date(ms)
  return `${pad4(dt.getUTCFullYear())}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`
}

// ---------------------------------------------------------------------------------------------
// Timezone conversion (Intl based; works in Node 22 and browsers)
// ---------------------------------------------------------------------------------------------

const zoneFormatters = new Map<string, Intl.DateTimeFormat>()
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  weekday: number
}

function zonedParts(date: Date, timeZone: string): ZonedParts {
  if (Number.isNaN(date.getTime())) throw new RangeError('invalid Date')
  let fmt = zoneFormatters.get(timeZone)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    })
    zoneFormatters.set(timeZone, fmt)
  }
  const out: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {}
  for (const part of fmt.formatToParts(date)) out[part.type] = part.value
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: WEEKDAYS[out.weekday ?? ''] ?? 0,
  }
}

/** Calendar date of an instant in a timezone: toDateStr(new Date('2026-10-19T20:00:00Z')) → '2026-10-20'. */
export function toDateStr(date: Date, timeZone: string = DEFAULT_TIMEZONE): string {
  const p = zonedParts(date, timeZone)
  return `${pad4(p.year)}-${pad2(p.month)}-${pad2(p.day)}`
}

/** Today's business date in the timezone. */
export function todayIn(timeZone: string = DEFAULT_TIMEZONE): string {
  return toDateStr(new Date(), timeZone)
}

/** Day of week (0 = Sunday … 6 = Saturday) of an instant in a timezone. */
export function dayOfWeekIn(date: Date, timeZone: string = DEFAULT_TIMEZONE): number {
  return zonedParts(date, timeZone).weekday
}

/** Minutes since local midnight of an instant in a timezone (e.g. happy-hour checks). */
export function minutesOfDayIn(date: Date, timeZone: string = DEFAULT_TIMEZONE): number {
  const p = zonedParts(date, timeZone)
  return p.hour * 60 + p.minute
}

/** UTC offset (minutes, east positive) of a timezone at an instant: Asia/Kolkata → 330. */
export function timezoneOffsetMinutes(date: Date, timeZone: string = DEFAULT_TIMEZONE): number {
  const p = zonedParts(date, timeZone)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60_000)
}

/** Instant at which a business date starts (local midnight) in a timezone. */
export function startOfDayInstant(dateStr: string, timeZone: string = DEFAULT_TIMEZONE): Date {
  const { y, m, d } = parseDate(dateStr)
  const localMidnightAsUtc = Date.UTC(y, m - 1, d)
  // Two passes handle zones whose offset differs between the guess and the result (DST).
  let instant = localMidnightAsUtc - timezoneOffsetMinutes(new Date(localMidnightAsUtc), timeZone) * 60_000
  instant = localMidnightAsUtc - timezoneOffsetMinutes(new Date(instant), timeZone) * 60_000
  return new Date(instant)
}

/**
 * Half-open instant range [start, end) covering business dates from..to inclusive, for
 * timestamptz filters: `created_at >= start AND created_at < end`.
 */
export function instantRangeForDates(from: string, to: string, timeZone: string = DEFAULT_TIMEZONE): { start: Date; end: Date } {
  return { start: startOfDayInstant(from, timeZone), end: startOfDayInstant(addDays(to, 1), timeZone) }
}

// ---------------------------------------------------------------------------------------------
// Date arithmetic & display
// ---------------------------------------------------------------------------------------------

export function addDays(dateStr: string, days: number): string {
  if (!Number.isSafeInteger(days)) throw new RangeError('days must be an integer')
  return fromUtcMs((utcDays(dateStr) + days) * MS_PER_DAY)
}

/** Whole days from `from` to `to` (positive when `to` is later): diffDays('2026-10-01', '2026-10-31') = 30. */
export function diffDays(from: string, to: string): number {
  return utcDays(to) - utcDays(from)
}

/** Adds calendar months, clamping the day: addMonths('2026-01-31', 1) → '2026-02-28'. */
export function addMonths(dateStr: string, months: number): string {
  if (!Number.isSafeInteger(months)) throw new RangeError('months must be an integer')
  const { y, m, d } = parseDate(dateStr)
  const index = y * 12 + (m - 1) + months
  const ny = Math.floor(index / 12)
  const nm = index - ny * 12 + 1
  return `${pad4(ny)}-${pad2(nm)}-${pad2(Math.min(d, daysInMonth(ny, nm)))}`
}

/** Day of week of a business date (0 = Sunday). */
export function dayOfWeek(dateStr: string): number {
  return new Date(utcDays(dateStr) * MS_PER_DAY).getUTCDay()
}

export function compareDates(a: string, b: string): number {
  return utcDays(a) - utcDays(b)
}

/** UI format dd-MM-yyyy: '2026-10-20' → '20-10-2026'. */
export function formatDateDisplay(dateStr: string): string {
  const { y, m, d } = parseDate(dateStr)
  return `${pad2(d)}-${pad2(m)}-${pad4(y)}`
}

/** Parses dd-MM-yyyy / dd/MM/yyyy / dd.MM.yyyy (Indian order) into 'YYYY-MM-DD', or null. */
export function parseDisplayDate(input: string): string | null {
  const m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(input.trim())
  if (!m) return null
  const candidate = `${m[3]}-${pad2(Number(m[2]))}-${pad2(Number(m[1]))}`
  return isDateStr(candidate) ? candidate : null
}

// ---------------------------------------------------------------------------------------------
// Financial years
// ---------------------------------------------------------------------------------------------

function assertStartMonth(startMonth: number): void {
  if (!Number.isInteger(startMonth) || startMonth < 1 || startMonth > 12) {
    throw new RangeError('fy start month must be 1..12')
  }
}

function fyLabel(startYear: number, startMonth: number): string {
  // A January-start FY ends in the same calendar year ('2026-26').
  const endYear = startMonth === 1 ? startYear : startYear + 1
  return `${pad4(startYear)}-${pad2(endYear % 100)}`
}

/** Financial year label of a date: fyOf('2026-10-20') → '2026-27'; fyOf('2027-03-31') → '2026-27'. */
export function fyOf(dateStr: string, startMonth: number = DEFAULT_FY_START_MONTH): string {
  assertStartMonth(startMonth)
  const { y, m } = parseDate(dateStr)
  return fyLabel(m >= startMonth ? y : y - 1, startMonth)
}

/** True for a well-formed FY label ('2026-27'). */
export function isFy(value: unknown, startMonth: number = DEFAULT_FY_START_MONTH): value is string {
  if (typeof value !== 'string') return false
  const m = FY_RE.exec(value)
  if (!m) return false
  return fyLabel(Number(m[1]), startMonth) === value
}

function fyStartYear(fy: string, startMonth: number): number {
  if (!isFy(fy, startMonth)) throw new RangeError(`invalid financial year: ${JSON.stringify(fy)}`)
  return Number(fy.slice(0, 4))
}

/** Short FY used in document numbers: '2026-27' → '2627'. */
export function fyShort(fy: string): string {
  const m = FY_RE.exec(fy)
  if (!m) throw new RangeError(`invalid financial year: ${JSON.stringify(fy)}`)
  return `${m[1]!.slice(2)}${m[2]}`
}

/** First and last date of a financial year: '2026-27' → { from: '2026-04-01', to: '2027-03-31' }. */
export function fyRange(fy: string, startMonth: number = DEFAULT_FY_START_MONTH): DateRange {
  assertStartMonth(startMonth)
  const y = fyStartYear(fy, startMonth)
  const from = `${pad4(y)}-${pad2(startMonth)}-01`
  return { from, to: addDays(addMonths(from, 12), -1) }
}

/** The 12 GST periods ('YYYY-MM') of a financial year in order. */
export function periodsOfFy(fy: string, startMonth: number = DEFAULT_FY_START_MONTH): string[] {
  const { from } = fyRange(fy, startMonth)
  return Array.from({ length: 12 }, (_, i) => periodOf(addMonths(from, i)))
}

// ---------------------------------------------------------------------------------------------
// Periods (months) and GST filing periods
// ---------------------------------------------------------------------------------------------

export function isPeriod(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const m = PERIOD_RE.exec(value)
  return !!m && Number(m[2]) >= 1 && Number(m[2]) <= 12
}

function parsePeriod(period: string): { y: number; m: number } {
  if (!isPeriod(period)) throw new RangeError(`invalid period: ${JSON.stringify(period)}`)
  return { y: Number(period.slice(0, 4)), m: Number(period.slice(5, 7)) }
}

/** Month of a date: '2026-10-20' → '2026-10' (usage counters, GST returns). */
export function periodOf(dateStr: string): string {
  parseDate(dateStr)
  return dateStr.slice(0, 7)
}

/** First and last date of a month: '2026-02' → { from: '2026-02-01', to: '2026-02-28' }. */
export function periodRange(period: string): DateRange {
  const { y, m } = parsePeriod(period)
  return { from: `${pad4(y)}-${pad2(m)}-01`, to: `${pad4(y)}-${pad2(m)}-${pad2(daysInMonth(y, m))}` }
}

export function addPeriods(period: string, months: number): string {
  const { y, m } = parsePeriod(period)
  return periodOf(addMonths(`${pad4(y)}-${pad2(m)}-01`, months))
}

export const nextPeriod = (period: string): string => addPeriods(period, 1)
export const previousPeriod = (period: string): string => addPeriods(period, -1)

/** GST portal return period 'MMYYYY': '2026-10' → '102026'. */
export function periodToFp(period: string): string {
  const { y, m } = parsePeriod(period)
  return `${pad2(m)}${pad4(y)}`
}

/** Inverse of {@link periodToFp}: '102026' → '2026-10'. */
export function fpToPeriod(fp: string): string {
  const m = /^(\d{2})(\d{4})$/.exec(fp)
  if (!m) throw new RangeError(`invalid GST return period: ${JSON.stringify(fp)}`)
  const period = `${m[2]}-${m[1]}`
  if (!isPeriod(period)) throw new RangeError(`invalid GST return period: ${JSON.stringify(fp)}`)
  return period
}

/** Quarter-end period for quarterly (QRMP) filers: '2026-05' → '2026-06'. */
export function quarterEndPeriod(period: string): string {
  const { y, m } = parsePeriod(period)
  return `${pad4(y)}-${pad2(Math.ceil(m / 3) * 3)}`
}
