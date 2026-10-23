/**
 * The sample bill shown in the invoice-settings preview: three everyday grocery lines priced with
 * the shared engine (computeDocument), so tax split, round-off and MRP savings in the preview are
 * exactly what real bills will show for the shop's GST scheme.
 */
import { salesDocumentModeFor } from '@kadai/shared/api/sales'
import type { GstScheme } from '@kadai/shared/enums'
import { computeDocument, type DocumentResult, type LineInput } from '@kadai/shared/pricing'
import type { TenantSettings } from '@kadai/shared/settings'

export interface SampleItem {
  /** Also the name key: settings:receipt.items.<key> (printed in both languages). */
  key: 'rice' | 'oil' | 'paste'
  hsn: string
  qty_milli: number
  unit: 'PCS' | 'KG' | 'L'
  unit_price_paise: number
  mrp_paise: number
  gst_rate_bp: number
}

export const SAMPLE_ITEMS: readonly SampleItem[] = [
  {
    key: 'rice',
    hsn: '1006',
    qty_milli: 1000,
    unit: 'PCS',
    unit_price_paise: 39_900,
    mrp_paise: 42_000,
    gst_rate_bp: 500,
  },
  {
    key: 'oil',
    hsn: '1512',
    qty_milli: 2000,
    unit: 'PCS',
    unit_price_paise: 14_550,
    mrp_paise: 16_000,
    gst_rate_bp: 500,
  },
  {
    key: 'paste',
    hsn: '3306',
    qty_milli: 1000,
    unit: 'PCS',
    unit_price_paise: 9_875,
    mrp_paise: 10_500,
    gst_rate_bp: 1800,
  },
]

export interface SampleBill {
  docType: 'tax_invoice' | 'bill_of_supply'
  result: DocumentResult
}

export function sampleBill(
  scheme: GstScheme,
  invoice: Pick<TenantSettings['invoice'], 'round_off'>,
): SampleBill {
  const mode = salesDocumentModeFor(scheme)
  const lines: LineInput[] = SAMPLE_ITEMS.map((i) => ({
    key: i.key,
    unit_price_paise: i.unit_price_paise,
    qty_milli: i.qty_milli,
    price_includes_tax: true,
    gst_rate_bp: i.gst_rate_bp,
    mrp_paise: i.mrp_paise,
  }))
  return {
    docType: mode.doc_type,
    result: computeDocument({
      lines,
      is_interstate: false,
      tax_mode: mode.tax_mode,
      round_off: invoice.round_off,
    }),
  }
}
