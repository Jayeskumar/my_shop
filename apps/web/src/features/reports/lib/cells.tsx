/**
 * Cell rendering of the generic report viewer from the column formats of the REPORTS catalogue
 * (money, qty, percent, date, days, phone, GSTIN, enum …) — once as React nodes for the screen
 * and once as plain text for printing.
 */
import type { ReportColumnDef } from '@kadai/shared/api/reports'
import { reportCellPath } from '@kadai/shared/api/reports'
import { formatBp } from '@kadai/shared/money'
import { milliToDecimalString } from '@kadai/shared/units'
import i18next from 'i18next'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Money, Qty } from '@/components/ui'
import { cn } from '@/lib/cn'
import {
  formatDate,
  formatDateTime,
  formatMoney,
  formatNumber,
  formatPackQty,
  formatPhone,
  formatQty,
} from '@/lib/format'
import type { Language } from '@/lib/i18n'
import { pick } from './labels'

export type ReportRow = Record<string, unknown>

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

/** Money columns where a negative amount is a loss / shortage worth flagging in red. */
const SIGNED_ALERT_COLUMNS = new Set([
  'difference_paise',
  'gross_profit_paise',
  'margin_bp',
  'net_sales_paise',
  'unreconciled_paise',
])

function daysText(days: number, lng: Language): string {
  return i18next.t('reports:cells.days', { count: days, lng })
}

function qtyText(column: ReportColumnDef, row: ReportRow, milli: number, lng: Language): string {
  const unit = column.unit_field ? str(row[column.unit_field]) : null
  if (!unit) return milliToDecimalString(milli, true)
  const pack = column.pack_size_field ? num(row[column.pack_size_field]) : null
  return pack && pack > 1 && Math.abs(milli) >= pack * 1000
    ? formatPackQty(milli, pack, unit, 'PACK', lng)
    : formatQty(milli, unit, lng)
}

/** Plain text of a cell (print, CSV preview, accessible names). */
export function cellText(
  column: ReportColumnDef,
  row: ReportRow,
  lng: Language,
  value: unknown = row[column.key],
): string {
  if (value === null || value === undefined || value === '') return ''
  switch (column.format) {
    case 'money': {
      const n = num(value)
      return n === null ? String(value) : formatMoney(n)
    }
    case 'qty': {
      const n = num(value)
      return n === null ? String(value) : qtyText(column, row, n, lng)
    }
    case 'int': {
      const n = num(value)
      return n === null ? String(value) : formatNumber(n)
    }
    case 'percent_bp': {
      const n = num(value)
      return n === null ? String(value) : formatBp(n)
    }
    case 'date':
      return typeof value === 'string' ? formatDate(value) : String(value)
    case 'datetime':
      return typeof value === 'string' ? formatDateTime(value) : String(value)
    case 'days': {
      const n = num(value)
      return n === null ? String(value) : daysText(n, lng)
    }
    case 'phone':
      return typeof value === 'string' ? formatPhone(value) : String(value)
    case 'boolean':
      return i18next.t(value ? 'common:actions.yes' : 'common:actions.no', { lng })
    case 'enum': {
      const label = column.enum_labels?.[String(value)]
      return label ? pick(label, lng) : String(value)
    }
    default:
      return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  }
}

/** Screen rendering of a cell (links to the detail page when the column has `link`). */
export function renderCell(
  column: ReportColumnDef,
  row: ReportRow,
  lng: Language,
  options: { linkable?: boolean } = {},
): ReactNode {
  const value = row[column.key]
  if (value === null || value === undefined || value === '') {
    return <span className="text-muted-foreground">—</span>
  }
  let node: ReactNode
  switch (column.format) {
    case 'money': {
      const n = num(value)
      node =
        n === null ? (
          String(value)
        ) : (
          <Money
            paise={n}
            className={cn(n < 0 && SIGNED_ALERT_COLUMNS.has(column.key) && 'text-danger')}
          />
        )
      break
    }
    case 'qty': {
      const n = num(value)
      const unit = column.unit_field ? str(row[column.unit_field]) : null
      const pack = column.pack_size_field ? num(row[column.pack_size_field]) : null
      node =
        n !== null && unit ? (
          <Qty milli={n} unit={unit} packSize={pack ?? undefined} colorize />
        ) : (
          <span className="tabular-nums">{cellText(column, row, lng)}</span>
        )
      break
    }
    case 'percent_bp': {
      const n = num(value)
      node = (
        <span
          className={cn(
            'tabular-nums',
            n !== null && n < 0 && SIGNED_ALERT_COLUMNS.has(column.key) && 'text-danger',
          )}
        >
          {cellText(column, row, lng)}
        </span>
      )
      break
    }
    case 'int':
    case 'days':
      node = <span className="tabular-nums">{cellText(column, row, lng)}</span>
      break
    case 'gstin':
      node = <span className="font-mono text-xs tracking-wide">{String(value)}</span>
      break
    case 'phone':
      node = <span className="whitespace-nowrap tabular-nums">{cellText(column, row, lng)}</span>
      break
    case 'date':
    case 'datetime':
      node = <span className="whitespace-nowrap tabular-nums">{cellText(column, row, lng)}</span>
      break
    default:
      node = cellText(column, row, lng)
  }
  if (options.linkable !== false && column.link) {
    const path = reportCellPath(column, row)
    if (path) {
      return (
        <Link
          to={path}
          className="font-medium text-primary underline-offset-2 hover:underline focus-visible:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {node}
        </Link>
      )
    }
  }
  return node
}

/** Totals-row text of a column (only columns flagged `total` with a value in `totals`). */
export function totalValue(column: ReportColumnDef, totals: ReportRow | null | undefined): unknown {
  if (!column.total || !totals) return undefined
  return totals[column.key]
}
