/**
 * Shape conversions between other contracts and the POS cart: catalog scan results, customers
 * (bootstrap cache, parties search, quick add) and recalled held bills.
 */
import type { SellableProduct } from '@kadai/shared/api/catalog'
import type { Customer, CustomerListItem } from '@kadai/shared/api/parties'
import type { SalesInvoiceDetail } from '@kadai/shared/api/sales'
import type { CartCustomer } from './cart'
import type { PosCustomerRow, PosProduct } from './types'

/** GET /products/lookup row → POS product (fields the lookup does not carry get defaults). */
export function sellableToPosProduct(p: SellableProduct): PosProduct {
  return {
    id: p.id,
    parent_id: p.parent_id,
    kind: p.kind,
    sku: p.sku,
    name: p.name,
    name_ta: p.name_ta,
    aliases: [],
    category_id: p.category_id,
    brand_id: p.brand_id,
    unit: p.unit,
    pack_size: p.pack_size,
    allow_loose: p.allow_loose,
    decimal_qty: p.decimal_qty,
    hsn_code: p.hsn_code,
    gst_rate_bp: p.gst_rate_bp,
    cess_rate_bp: p.cess_rate_bp,
    tax_slab_rule_id: p.tax_slab_rule_id,
    price_includes_tax: p.price_includes_tax,
    mrp_paise: p.mrp_paise,
    // The lookup's price already includes the store price; no separate store_prices row.
    sale_price_paise: p.sale_price_paise,
    wholesale_price_paise: p.wholesale_price_paise,
    min_sale_price_paise: p.min_sale_price_paise,
    max_discount_bp: p.max_discount_bp,
    track_inventory: p.track_inventory,
    track_batches: p.track_batches,
    is_weighed: p.is_weighed,
    scale_plu: null,
    variant_attributes: p.variant_attributes,
    variant_axes: [],
    attributes: p.attributes,
    stock_qty_milli: p.stock_qty_milli,
    reorder_level_milli: null,
    is_active: p.is_active,
    updated_at: new Date().toISOString(),
  }
}

export function customerFromRow(c: PosCustomerRow | CustomerListItem | Customer): CartCustomer {
  return {
    id: c.id,
    name: c.name,
    name_ta: c.name_ta,
    phone: c.phone,
    gstin: c.gstin,
    state_code: c.state_code,
    price_tier: c.price_tier,
    balance_paise: c.balance_paise,
    credit_limit_paise: c.credit_limit_paise,
    loyalty_points: c.loyalty_points,
  }
}

/** Phone digits for matching ('+919876543210' → '9876543210'). */
export function phoneDigits(phone: string | null | undefined): string {
  return (phone ?? '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '')
}

/** Local customer search over the bootstrap's recent customers (name, Tamil name, phone). */
export function searchCachedCustomers(
  rows: readonly PosCustomerRow[],
  query: string,
  limit = 8,
): PosCustomerRow[] {
  const q = query.trim().toLocaleLowerCase('en-IN')
  if (!q) return rows.slice(0, limit)
  const digits = q.replace(/\D/g, '')
  return rows
    .filter((c) => {
      if (digits.length >= 3 && phoneDigits(c.phone).includes(digits)) return true
      return (
        c.name.toLocaleLowerCase('en-IN').includes(q) || (c.name_ta ?? '').includes(query.trim())
      )
    })
    .slice(0, limit)
}

/** One cart line rebuilt from stored invoice lines (FEFO split parts merged back). */
export interface RecalledLine {
  key: string
  product_id: string
  qty_milli: number
  unit_price_paise: number | null
  discount_bp: number
  discount_paise: number
  batch_id: string | null
  serial_numbers: string[]
  scanned_code: string | null
  note: string | null
}

/** Lines of a held bill as the cashier entered them (manual prices / batches kept). */
export function recalledLines(detail: Pick<SalesInvoiceDetail, 'lines'>): RecalledLine[] {
  const out = new Map<string, RecalledLine>()
  for (const l of detail.lines) {
    if (!l.product_id) continue
    const key = l.meta.source_key ?? l.id
    const existing = out.get(key)
    if (existing) {
      existing.qty_milli += l.qty_milli
      existing.discount_paise += l.meta.manual_discount_paise ?? 0
      existing.serial_numbers.push(...l.serial_numbers)
      if (l.meta.batch_auto) existing.batch_id = null
      continue
    }
    out.set(key, {
      key,
      product_id: l.product_id,
      qty_milli: l.qty_milli,
      unit_price_paise: l.meta.price_source === 'manual' ? l.unit_price_paise : null,
      discount_bp: l.discount_bp,
      discount_paise: l.meta.manual_discount_paise ?? 0,
      batch_id: l.meta.batch_auto ? null : l.batch_id,
      serial_numbers: [...l.serial_numbers],
      scanned_code: l.meta.scanned_code ?? null,
      note: l.meta.note ?? null,
    })
  }
  return [...out.values()]
}
