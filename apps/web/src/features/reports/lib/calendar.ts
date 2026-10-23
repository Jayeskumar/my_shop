/**
 * The tenant's business calendar for report screens: "today" in the tenant timezone and the
 * financial-year start month (presets such as "this FY" and quarters follow it).
 */
import type { MeResponse } from '@kadai/shared/api/auth'
import { DEFAULT_FY_START_MONTH, DEFAULT_TIMEZONE, toDateStr } from '@kadai/shared/fy'
import { useMemo } from 'react'
import { useMe } from '@/lib/auth'

export interface ReportCalendar {
  today: string
  timezone: string
  fyStartMonth: number
}

export function calendarOf(me: MeResponse | null, now: Date = new Date()): ReportCalendar {
  const timezone = me?.tenant.timezone ?? DEFAULT_TIMEZONE
  return {
    today: toDateStr(now, timezone),
    timezone,
    fyStartMonth: me?.tenant.fy_start_month ?? DEFAULT_FY_START_MONTH,
  }
}

/** Tenant calendar of the signed-in member (stable for the render; "today" is read once). */
export function useReportCalendar(): ReportCalendar {
  const me = useMe()
  return useMemo(() => calendarOf(me), [me])
}

/**
 * Default store scope of report filters: 'all' for members who see several stores, else their
 * only store (store-scoped cashiers / managers).
 */
export function defaultStoreScope(me: MeResponse | null): string | null {
  const stores = me?.stores.filter((s) => s.is_active) ?? []
  if (stores.length === 1) return stores[0]!.id
  return stores.length > 1 ? 'all' : null
}
