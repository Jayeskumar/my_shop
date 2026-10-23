/**
 * Rows pasted from Excel / Google Sheets (tab separated) or a CSV into the opening stock grid.
 * Columns: code (barcode or SKU), qty, cost per pack, batch no, expiry, MRP — either in that
 * order or named in a header row ("barcode", "qty", "cost", "batch", "expiry", "mrp", also in
 * Tamil). Quantities are parsed later, once the product (and so its unit) is known.
 * Expiry accepts dd-mm-yyyy, yyyy-mm-dd and the MM/YY printed on medicine strips (end of month).
 */
import { parseCsv } from '@kadai/shared/api/identity'
import { expiryFromMonthYear } from '@kadai/shared/api/purchases'
import { isDateStr, parseDisplayDate } from '@kadai/shared/fy'
import { tryParseRupees } from '@kadai/shared/money'

export type PasteColumn = 'code' | 'qty' | 'cost' | 'batch_no' | 'expiry' | 'mrp'

const POSITIONAL: readonly PasteColumn[] = ['code', 'qty', 'cost', 'batch_no', 'expiry', 'mrp']

const HEADER_ALIASES: Readonly<Record<PasteColumn, readonly string[]>> = {
  code: ['code', 'barcode', 'sku', 'item code', 'product code', 'குறியீடு', 'பார்கோடு'],
  qty: ['qty', 'quantity', 'stock', 'opening', 'opening stock', 'அளவு', 'இருப்பு'],
  cost: ['cost', 'rate', 'purchase price', 'purchase rate', 'cost price', 'அடக்க விலை', 'விலை'],
  batch_no: ['batch', 'batch no', 'batch number', 'பேட்ச்'],
  expiry: ['expiry', 'exp', 'expiry date', 'காலாவதி'],
  mrp: ['mrp', 'm.r.p', 'எம்ஆர்பி'],
}

export interface PastedRow {
  /** 1-based line number in the pasted text. */
  line: number
  code: string
  qty: string
  cost_paise: number | null
  batch_no: string | null
  expiry_date: string | null
  mrp_paise: number | null
}

export type PasteIssueCode = 'missing_code' | 'missing_qty' | 'bad_cost' | 'bad_expiry' | 'bad_mrp'

export interface PasteIssue {
  line: number
  code: PasteIssueCode
  value?: string
}

/** Business date from a pasted expiry cell, or null when it cannot be read. */
export function parseExpiryText(text: string): string | null {
  const v = text.trim()
  if (!v) return null
  if (isDateStr(v)) return v
  return parseDisplayDate(v) ?? expiryFromMonthYear(v)
}

function normalizeHeader(cell: string): string {
  return cell
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, ' ')
    .replace(/[:*]/g, '')
}

function headerColumns(cells: readonly string[]): (PasteColumn | null)[] | null {
  const mapped = cells.map((cell) => {
    const h = normalizeHeader(cell)
    const hit = (Object.entries(HEADER_ALIASES) as [PasteColumn, readonly string[]][]).find(
      ([, aliases]) => aliases.includes(h),
    )
    return hit ? hit[0] : null
  })
  return mapped.includes('code') && mapped.includes('qty') ? mapped : null
}

export function parseOpeningPaste(text: string): { rows: PastedRow[]; issues: PasteIssue[] } {
  const records = parseCsv(text)
  const rows: PastedRow[] = []
  const issues: PasteIssue[] = []
  if (records.length === 0) return { rows, issues }
  const header = headerColumns(records[0] ?? [])
  const columns: readonly (PasteColumn | null)[] = header ?? POSITIONAL
  const start = header ? 1 : 0
  records.slice(start).forEach((cells, i) => {
    const line = i + start + 1
    const cell = (col: PasteColumn): string => {
      const at = columns.indexOf(col)
      return at >= 0 ? (cells[at] ?? '').trim() : ''
    }
    if (cells.every((c) => c.trim() === '')) return
    const code = cell('code')
    const qty = cell('qty')
    if (!code) {
      issues.push({ line, code: 'missing_code' })
      return
    }
    if (!qty) {
      issues.push({ line, code: 'missing_qty', value: code })
      return
    }
    const costText = cell('cost')
    const cost = costText ? tryParseRupees(costText) : null
    if (costText && cost === null) issues.push({ line, code: 'bad_cost', value: costText })
    const expiryText = cell('expiry')
    const expiry = expiryText ? parseExpiryText(expiryText) : null
    if (expiryText && expiry === null) issues.push({ line, code: 'bad_expiry', value: expiryText })
    const mrpText = cell('mrp')
    const mrp = mrpText ? tryParseRupees(mrpText) : null
    if (mrpText && mrp === null) issues.push({ line, code: 'bad_mrp', value: mrpText })
    rows.push({
      line,
      code,
      qty,
      cost_paise: cost,
      batch_no: cell('batch_no') || null,
      expiry_date: expiry,
      mrp_paise: mrp,
    })
  })
  return { rows, issues }
}
