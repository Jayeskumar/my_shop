/**
 * Small pure helpers of the home dashboard: greeting by time of day (tenant timezone), the
 * default store scope (remembered per device), margin-point wording and payment-mix colours.
 */
import type { MeResponse } from '@kadai/shared/api/auth'
import type { PaymentMixKey } from '@kadai/shared/api/reports'
import { minutesOfDayIn } from '@kadai/shared/fy'
import { storage } from '@/lib/storage'

export type DayPart = 'morning' | 'afternoon' | 'evening'

/** Morning before 12:00, afternoon until 16:00, evening after (shop hours run late). */
export function dayPart(now: Date, timezone: string): DayPart {
  const minutes = minutesOfDayIn(now, timezone)
  if (minutes < 12 * 60) return 'morning'
  if (minutes < 16 * 60) return 'afternoon'
  return 'evening'
}

/** "Murugan K" → "Murugan". */
export function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? fullName
}

const STORE_KEY = 'dashboard.store'

/**
 * Store the dashboard shows: the remembered choice when it is still accessible, else "all stores"
 * for members who see several stores, else their only store.
 */
export function initialDashboardStore(me: MeResponse | null): string | null {
  const stores = (me?.stores ?? []).filter((s) => s.is_active)
  const saved = storage.get<string | null>(
    STORE_KEY,
    null,
    (v): v is string | null => v === null || typeof v === 'string',
  )
  if (saved === 'all' && stores.length > 1) return 'all'
  if (saved && stores.some((s) => s.id === saved)) return saved
  if (stores.length > 1) return 'all'
  return stores[0]?.id ?? null
}

export function rememberDashboardStore(storeId: string | null): void {
  storage.set(STORE_KEY, storeId)
}

/** Margin change in percentage points: 120 bp → "+1.2". */
export function marginPoints(bp: number): string {
  const sign = bp > 0 ? '+' : bp < 0 ? '−' : ''
  return `${sign}${(Math.abs(bp) / 100).toFixed(1)}`
}

/** Payment-mix slice colours (design tokens; cash / UPI / card in brand hues, dues neutral). */
export const PAYMENT_MIX_COLORS: Readonly<Record<PaymentMixKey, string>> = {
  cash: 'var(--primary)',
  upi: 'var(--accent)',
  card: 'var(--info)',
  credit: 'var(--muted-foreground)',
  other: 'var(--input)',
}
