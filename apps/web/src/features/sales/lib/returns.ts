/**
 * Live credit-note preview of the return screen — the same maths the server runs
 * (credit-notes service): every line is pro-rated from the original invoice line with
 * prorateReturnLine (the final return of a line takes the exact remainder), totals are rounded
 * per settings.invoice.round_off, and a return that completes the whole invoice takes the
 * round-off that makes Σ credit notes = the invoice total. Settlement choices come from the
 * shared creditNoteSettlementOptions.
 */
import { roundToRupee } from '@kadai/shared/money'
import { sumSafe } from '@kadai/shared/math'
import {
  type ReturnableResponse,
  type ReturnableLine,
  creditNoteSettlementOptions,
  prorateReturnLine,
} from '@kadai/shared/api/sales'
import type { CreditNoteSettlement } from '@kadai/shared/enums'

export interface ReturnLineAmounts {
  invoice_line_id: string
  qty_milli: number
  taxable_paise: number
  cgst_paise: number
  sgst_paise: number
  igst_paise: number
  cess_paise: number
  total_paise: number
}

export interface ReturnPreview {
  lines: ReturnLineAmounts[]
  item_count: number
  taxable_paise: number
  cgst_paise: number
  sgst_paise: number
  igst_paise: number
  cess_paise: number
  tax_paise: number
  round_off_paise: number
  total_paise: number
  /** Every line of the invoice is (now) returned completely. */
  full_return: boolean
}

/** Amounts of returning `qtyMilli` of a returnable line (null for 0 / invalid quantities). */
export function returnLineAmounts(
  line: ReturnableLine,
  qtyMilli: number,
): ReturnLineAmounts | null {
  if (!Number.isSafeInteger(qtyMilli) || qtyMilli <= 0 || qtyMilli > line.returnable_qty_milli) {
    return null
  }
  const amounts = prorateReturnLine(
    {
      taxable_paise: line.taxable_paise,
      cgst_paise: line.cgst_paise,
      sgst_paise: line.sgst_paise,
      igst_paise: line.igst_paise,
      cess_paise: line.cess_paise,
    },
    {
      qty_milli: qtyMilli,
      total_qty_milli: line.qty_milli,
      returned_qty_milli: line.returned_qty_milli,
      credited: line.credited,
    },
  )
  return { invoice_line_id: line.invoice_line_id, qty_milli: qtyMilli, ...amounts }
}

export function previewReturn(
  returnable: ReturnableResponse,
  qtyByLine: Readonly<Record<string, number | null | undefined>>,
  roundOff: 'nearest_rupee' | 'none',
): ReturnPreview {
  const lines: ReturnLineAmounts[] = []
  for (const line of returnable.lines) {
    const amounts = returnLineAmounts(line, qtyByLine[line.invoice_line_id] ?? 0)
    if (amounts) lines.push(amounts)
  }
  const sum = (k: keyof Omit<ReturnLineAmounts, 'invoice_line_id'>): number =>
    sumSafe(lines.map((l) => l[k]))
  const taxable = sum('taxable_paise')
  const cgst = sum('cgst_paise')
  const sgst = sum('sgst_paise')
  const igst = sum('igst_paise')
  const cess = sum('cess_paise')
  const beforeRound = taxable + cgst + sgst + igst + cess
  const fullReturn =
    lines.length > 0 &&
    returnable.lines.every(
      (l) => l.returned_qty_milli + (qtyByLine[l.invoice_line_id] ?? 0) >= l.qty_milli,
    )
  let round = roundOff === 'nearest_rupee' ? roundToRupee(beforeRound).round_off_paise : 0
  if (fullReturn) {
    const exact = returnable.invoice.total_paise - returnable.invoice.returned_paise - beforeRound
    if (exact >= -99 && exact <= 99) round = exact
  }
  const total = Math.max(0, beforeRound + round)
  return {
    lines,
    item_count: lines.length,
    taxable_paise: taxable,
    cgst_paise: cgst,
    sgst_paise: sgst,
    igst_paise: igst,
    cess_paise: cess,
    tax_paise: cgst + sgst + igst + cess,
    round_off_paise: lines.length === 0 ? 0 : total - beforeRound,
    total_paise: lines.length === 0 ? 0 : total,
    full_return: fullReturn,
  }
}

/** Settlements the server accepts for this return (creditNoteSettlementOptions). */
export function settlementOptionsFor(
  returnable: ReturnableResponse,
  totalPaise: number,
): CreditNoteSettlement[] {
  return creditNoteSettlementOptions({
    has_invoice: true,
    has_customer: returnable.invoice.customer_id !== null,
    invoice_due_paise: Math.max(0, returnable.invoice.due_paise),
    refundable_paise: returnable.refundable_paise,
    total_paise: totalPaise,
  })
}

/** Best default settlement: adjust the due first (no cash moves), else a cash refund. */
export function defaultSettlement(
  options: readonly CreditNoteSettlement[],
): CreditNoteSettlement | null {
  for (const s of ['adjust_due', 'cash', 'upi', 'store_credit', 'bank_transfer'] as const) {
    if (options.includes(s)) return s
  }
  return null
}
