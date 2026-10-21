/** Small helpers shared by the platform module's services. */
import {
  type BillingCycle,
  DEFAULT_TIMEZONE,
  addDays,
  addMonths,
  startOfDayInstant,
  toDateStr,
} from '@kadai/shared'

/** Our billing calendar (invoice dates, periods): India Standard Time. */
export const BILLING_TZ = DEFAULT_TIMEZONE

export type Clock = () => Date

export const systemClock: Clock = () => new Date()

/** ISO string of a Date (response schemas output strings). */
export function iso(d: Date): string
export function iso(d: Date | null): string | null
export function iso(d: Date | null): string | null {
  return d === null ? null : d.toISOString()
}

/**
 * `start` plus calendar months in IST, keeping the time of day (31 Jan + 1 month → 28/29 Feb).
 */
export function addMonthsInstant(start: Date, months: number): Date {
  if (months === 0) return new Date(start.getTime())
  const day = toDateStr(start, BILLING_TZ)
  const target = addMonths(day, months)
  const shift = startOfDayInstant(target, BILLING_TZ).getTime() - startOfDayInstant(day, BILLING_TZ).getTime()
  return new Date(start.getTime() + shift)
}

/** Inclusive service period dates of `months` starting at `start` ('2026-10-20' → '2027-10-19'). */
export function periodDates(start: Date, months: number): { start: string; end: string } {
  const from = toDateStr(start, BILLING_TZ)
  return { start: from, end: addDays(addMonths(from, months), -1) }
}

/** Last service day (inclusive) of a period ending at the instant `end`. */
export function periodEndDate(end: Date): string {
  return toDateStr(new Date(end.getTime() - 1), BILLING_TZ)
}

const CLOUD_PRODUCT_RE = /^cloud_([a-z][a-z0-9_]*)_(monthly|yearly)$/

/** 'cloud_growth_yearly' → {plan_code: 'growth', cycle: 'yearly'}; null for other codes. */
export function parseCloudPlanProductCode(
  code: string,
): { plan_code: string; cycle: BillingCycle } | null {
  const m = CLOUD_PRODUCT_RE.exec(code)
  return m ? { plan_code: m[1]!, cycle: m[2] as BillingCycle } : null
}

/** Unix seconds (Razorpay) → Date; null for missing / non-positive values. */
export function fromUnix(v: unknown): Date | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? new Date(v * 1000) : null
}

export function maxDate(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b
}
