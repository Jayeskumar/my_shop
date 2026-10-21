/**
 * Texts of the bill-entry warnings (PurchaseWarning from purchaseLineWarnings / the server's
 * `warnings`): purchases:warnings.<code> with the params formatted for display.
 */
import type { PurchaseWarning } from '@kadai/shared/api/purchases'
import { formatBp, formatDate, formatMoney } from '@/lib/format'
import { translate } from '@/lib/i18n'

function num(params: PurchaseWarning['params'], key: string): number | null {
  const v = params[key]
  return typeof v === 'number' ? v : null
}

function str(params: PurchaseWarning['params'], key: string): string | null {
  const v = params[key]
  return typeof v === 'string' ? v : null
}

const money = (v: number | null): string => (v === null ? '—' : formatMoney(v))

/** Localized one-line text of a warning. */
export function warningText(w: PurchaseWarning): string {
  const p = w.params
  switch (w.code) {
    case 'cost_above_last':
      return translate('purchases:warnings.cost_above_last', {
        amount: money(num(p, 'last_cost_paise')),
      })
    case 'mrp_changed':
      return translate('purchases:warnings.mrp_changed', {
        amount: money(num(p, 'previous_mrp_paise')),
      })
    case 'near_expiry':
      return translate('purchases:warnings.near_expiry', {
        date: formatDate(str(p, 'expiry_date')),
        count: num(p, 'days') ?? 0,
      })
    case 'expired':
      return translate('purchases:warnings.expired', { date: formatDate(str(p, 'expiry_date')) })
    case 'sale_price_below_cost':
      return translate('purchases:warnings.sale_price_below_cost')
    case 'sale_price_above_mrp':
      return translate('purchases:warnings.sale_price_above_mrp', {
        amount: money(num(p, 'mrp_paise')),
      })
    case 'gst_rate_differs': {
      const rate = num(p, 'product_gst_rate_bp')
      return translate('purchases:warnings.gst_rate_differs', {
        rate: rate === null ? '—' : formatBp(rate),
      })
    }
    case 'interstate_mismatch':
      return translate('purchases:warnings.interstate_mismatch')
    case 'received_more_than_ordered':
      return translate('purchases:warnings.received_more_than_ordered')
  }
}

/** Blocking-looking warnings (shown in red): expired stock, selling below cost. */
export function isSevereWarning(w: PurchaseWarning): boolean {
  return w.code === 'expired' || w.code === 'sale_price_below_cost'
}

/** Margin badge tone: below cost red, thin margin (< 5%) amber, else green. */
export function marginTone(bp: number | null): 'danger' | 'warning' | 'success' | 'neutral' {
  if (bp === null) return 'neutral'
  if (bp < 0) return 'danger'
  if (bp < 500) return 'warning'
  return 'success'
}

export function formatMargin(bp: number): string {
  return `${bp < 0 ? '−' : ''}${formatBp(Math.abs(bp))}`
}
