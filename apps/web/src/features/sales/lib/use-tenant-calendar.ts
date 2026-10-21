/** Business calendar of the signed-in tenant: timezone, FY start and "today" (YYYY-MM-DD). */
import { DEFAULT_FY_START_MONTH, DEFAULT_TIMEZONE, todayIn } from '@kadai/shared/fy'
import { useMemo } from 'react'
import { useMe } from '@/lib/auth'
import type { PresetContext } from '@/lib/date-presets'

export function useTenantCalendar(): { today: string; ctx: PresetContext; timezone: string } {
  const me = useMe()
  const timezone = me?.tenant.timezone ?? DEFAULT_TIMEZONE
  const fyStartMonth = me?.tenant.fy_start_month ?? DEFAULT_FY_START_MONTH
  const today = todayIn(timezone)
  return useMemo(
    () => ({ today, timezone, ctx: { timezone, fyStartMonth } }),
    [today, timezone, fyStartMonth],
  )
}
