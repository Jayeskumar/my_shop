/**
 * Tenant facts the accounting screens need: business "today" (tenant timezone), financial-year
 * start, GST scheme (ITC is only for regular GST businesses) and the store list.
 */
import { useMemo } from 'react'
import { DEFAULT_FY_START_MONTH, DEFAULT_TIMEZONE, fyOf, fyRange, todayIn } from '@kadai/shared/fy'
import type { MeStore } from '@kadai/shared/api/auth'
import { useMe } from '@/lib/auth'
import { type DatePresetKey, presetRange } from '@/lib/date-presets'

export interface TenantInfo {
  today: string
  timezone: string
  fyStartMonth: number
  /** This financial year's first day. */
  fyStart: string
  /** Regular GST registration (ITC allowed). */
  canClaimItc: boolean
  stores: MeStore[]
  multiStore: boolean
  /** Member limited to some stores (trial balance / balance sheet need all stores). */
  storeScoped: boolean
  range: (preset: DatePresetKey) => { from: string; to: string }
}

export function useTenantInfo(): TenantInfo {
  const me = useMe()
  return useMemo(() => {
    const timezone = me?.tenant.timezone ?? DEFAULT_TIMEZONE
    const fyStartMonth = me?.tenant.fy_start_month ?? DEFAULT_FY_START_MONTH
    const today = todayIn(timezone)
    const stores = (me?.stores ?? []).filter((s) => s.is_active)
    return {
      today,
      timezone,
      fyStartMonth,
      fyStart: fyRange(fyOf(today, fyStartMonth), fyStartMonth).from,
      canClaimItc: me?.tenant.gst_scheme === 'regular',
      stores,
      multiStore: stores.length > 1,
      storeScoped: me?.membership.store_ids != null,
      range: (preset) => presetRange(preset, { today, timezone, fyStartMonth }),
    }
  }, [me])
}
