/**
 * Keyboard line grid of the purchase-bill entry screen, built like desktop billing software:
 *
 *  - Enter moves to the next cell (Shift+Enter back); after the last cell of the last row the
 *    product search gets focus, so the next scan / search adds the next row.
 *  - ↑ / ↓ move to the same column of the previous / next row; Ctrl+Delete removes the row.
 *  - Batch and expiry ("MM/YY" quick entry) are required for batch-tracked items and disabled
 *    for the others. Pack-priced products (pharmacy strips) are entered in packs.
 *  - Taxable / tax / amount come from the live purchaseBillTotals(); the new selling price shows
 *    its margin over the landed cost; warnings (cost above last, MRP changed, near expiry…) are
 *    flagged on the row.
 *
 * Below the lg breakpoint every line is a card with the same cells (same keyboard order).
 */
import { GST_RATES_BP } from '@kadai/shared/gst'
import type { PurchaseWarning } from '@kadai/shared/api/purchases'
import { AlertTriangle, PackageCheck, Trash2 } from 'lucide-react'
import { type KeyboardEvent, type ReactNode, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Badge,
  IconButton,
  Input,
  Money,
  MoneyInput,
  NumberInput,
  Qty,
  Tooltip,
  fieldVariants,
} from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatBp, formatMoney } from '@/lib/format'
import { getLanguage, localizedName } from '@/lib/i18n'
import { isDecimalUnit } from '@kadai/shared/units'
import {
  type BillComputation,
  type BillContext,
  type BillErrors,
  type BillLineDraft,
  type LineField,
  fromPackMilli,
  lineMarginBp,
  lineWarnings,
  toPackMilli,
} from '../lib/bill-form'
import { normalizeExpiryTyping, parseExpiryText } from '../lib/expiry'
import { packUnitFor, unitLabel } from '../lib/labels'
import { validationText } from '../lib/errors'
import { formatMargin, isSevereWarning, marginTone, warningText } from '../lib/warnings'
import { GRID_COLUMNS, cellId, columnEnabled } from '../lib/grid'

export interface BillLineGridProps {
  lines: BillLineDraft[]
  calc: BillComputation
  ctx: BillContext
  errors: BillErrors['lines']
  /** Show batch / expiry columns (feature on, or any batch-tracked line). */
  showBatch: boolean
  layout: 'table' | 'cards'
  /** Product search id: Enter after the last cell goes there. */
  adderId: string
  disabled?: boolean
  onChange: (key: string, patch: Partial<BillLineDraft>) => void
  onRemove: (key: string) => void
}

export function BillLineGrid({
  lines,
  calc,
  ctx,
  errors,
  showBatch,
  layout,
  adderId,
  disabled,
  onChange,
  onRemove,
}: BillLineGridProps) {
  const { t } = useTranslation('purchases')
  const order = useMemo(
    () =>
      lines.flatMap((l) =>
        GRID_COLUMNS.filter((c) => columnEnabled(l, c, showBatch)).map((c) => ({
          key: l.key,
          col: c,
          id: cellId(l.key, c),
        })),
      ),
    [lines, showBatch],
  )

  const focus = (id: string): void => {
    const el = document.getElementById(id)
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) {
      el.focus()
      if (el instanceof HTMLInputElement) el.select()
    } else el?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const target = event.target as HTMLElement
    const cell = target.dataset.cell
    if (!cell || event.nativeEvent.isComposing) return
    const at = order.findIndex((c) => c.id === cell)
    if (at < 0) return
    const here = order[at]!
    if (event.key === 'Enter') {
      event.preventDefault()
      if (event.shiftKey) {
        const prev = order[at - 1]
        if (prev) focus(prev.id)
        return
      }
      const next = order[at + 1]
      if (next) focus(next.id)
      else focus(adderId)
      return
    }
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && target.tagName !== 'SELECT') {
      if (event.defaultPrevented) return
      const rowIndex = lines.findIndex((l) => l.key === here.key)
      const step = event.key === 'ArrowDown' ? 1 : -1
      for (let r = rowIndex + step; r >= 0 && r < lines.length; r += step) {
        const line = lines[r]!
        if (columnEnabled(line, here.col, showBatch)) {
          event.preventDefault()
          focus(cellId(line.key, here.col))
          return
        }
      }
      if (step === 1) {
        event.preventDefault()
        focus(adderId)
      }
      return
    }
    if (event.key === 'Delete' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      const neighbour = order.find((c, i) => i > at && c.key !== here.key)
      onRemove(here.key)
      if (neighbour) window.setTimeout(() => focus(neighbour.id), 0)
      else window.setTimeout(() => focus(adderId), 0)
    }
  }

  if (lines.length === 0) return null

  if (layout === 'cards') {
    return (
      <ol
        className="grid grid-cols-[minmax(0,1fr)] gap-3"
        onKeyDown={onKeyDown}
        aria-label={t('lines.title')}
      >
        {lines.map((line, i) => (
          <LineCard
            key={line.key}
            index={i}
            line={line}
            calc={calc}
            ctx={ctx}
            errors={errors[line.key] ?? {}}
            showBatch={showBatch}
            disabled={disabled}
            onChange={onChange}
            onRemove={onRemove}
          />
        ))}
      </ol>
    )
  }

  return (
    <div className="scrollbar-thin relative min-w-0 overflow-x-auto rounded-xl border border-border bg-surface">
      <table
        className={cn(
          'w-full table-fixed border-collapse text-sm',
          showBatch ? 'min-w-[1300px]' : 'min-w-[1100px]',
        )}
        onKeyDown={onKeyDown}
      >
        <caption className="sr-only">{t('lines.title')}</caption>
        <colgroup>
          {/* Fixed layout: the item column takes the rest; numbers keep readable widths. */}
          <col />
          {showBatch ? (
            <>
              <col className="w-[5.5rem]" />
              <col className="w-[5rem]" />
            </>
          ) : null}
          {/* MRP and rate fit ₹1,23,456.00 (rice bags, textiles); amounts fit lakhs. */}
          <col className="w-[6rem]" />
          <col className="w-[4.5rem]" />
          <col className="w-[3.75rem]" />
          <col className="w-[6rem]" />
          <col className="w-[3.75rem]" />
          <col className="w-[5rem]" />
          <col className="w-[6.25rem]" />
          <col className="w-[5rem]" />
          <col className="w-[6.5rem]" />
          <col className="w-[6rem]" />
          <col className="w-9" />
        </colgroup>
        <thead className="bg-surface-2 text-xs text-muted-foreground">
          <tr>
            <Th>{t('lines.item')}</Th>
            {showBatch ? (
              <>
                <Th>{t('lines.batch')}</Th>
                <Th>{t('lines.expiry')}</Th>
              </>
            ) : null}
            <Th align="end">{t('lines.mrp')}</Th>
            <Th align="end">{t('lines.qty')}</Th>
            <Th align="end">{t('lines.free')}</Th>
            <Th align="end">{t('lines.rate')}</Th>
            <Th align="end">{t('lines.disc')}</Th>
            <Th align="end">{t('lines.gst')}</Th>
            <Th align="end">{t('lines.taxable')}</Th>
            <Th align="end">{t('lines.tax')}</Th>
            <Th align="end">{t('lines.amount')}</Th>
            <Th align="end">{t('lines.sale_price')}</Th>
            <Th>
              <span className="sr-only">{t('lines.remove')}</span>
            </Th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, i) => (
            <LineRow
              key={line.key}
              index={i}
              line={line}
              calc={calc}
              ctx={ctx}
              errors={errors[line.key] ?? {}}
              showBatch={showBatch}
              disabled={disabled}
              onChange={onChange}
              onRemove={onRemove}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Th({ children, align }: { children: ReactNode; align?: 'end' }) {
  return (
    <th
      scope="col"
      className={cn(
        'whitespace-nowrap border-b border-border px-1.5 py-2 font-semibold first:sticky first:start-0 first:z-10 first:border-e first:bg-surface-2 first:ps-3 last:pe-3',
        align === 'end' ? 'text-end' : 'text-start',
      )}
    >
      {children}
    </th>
  )
}

interface LineProps {
  index: number
  line: BillLineDraft
  calc: BillComputation
  ctx: BillContext
  errors: Partial<Record<LineField, string>>
  showBatch: boolean
  disabled?: boolean
  onChange: (key: string, patch: Partial<BillLineDraft>) => void
  onRemove: (key: string) => void
}

/** Cell inputs shared by the table row and the mobile card. */
function useCells({ index, line, calc, ctx, errors, showBatch, disabled, onChange }: LineProps) {
  const { t } = useTranslation('purchases')
  const p = line.product
  const set = (patch: Partial<BillLineDraft>): void => onChange(line.key, patch)
  const packed = p.pack_size > 1
  const packWord = packed ? unitLabel(packUnitFor(p.unit)) : null
  const qtyDecimals = packed ? 3 : isDecimalUnit(p.unit) ? 3 : 0
  const result = calc.byKey.get(line.key)
  const warnings = lineWarnings(line, index, calc, ctx)
  const margin = lineMarginBp(line, calc)
  const expiryState = parseExpiryText(line.expiry_text)
  const label = (col: string): string => t('lines.cell_label', { col, n: index + 1 })
  const errorOf = (field: LineField): string | undefined => validationText(errors[field])
  const invalid = (field: LineField): { 'aria-invalid'?: true } =>
    errors[field] ? { 'aria-invalid': true } : {}
  const batchEnabled = showBatch && p.track_batches

  const batch = batchEnabled ? (
    <Input
      id={cellId(line.key, 'batch_no')}
      data-cell={cellId(line.key, 'batch_no')}
      size="sm"
      value={line.batch_no}
      maxLength={40}
      autoComplete="off"
      disabled={disabled}
      aria-label={label(t('lines.batch'))}
      placeholder={t('lines.batch_placeholder')}
      className="px-1.5 font-mono uppercase"
      onChange={(e) => set({ batch_no: e.target.value.toUpperCase() })}
      onFocus={(e) => e.currentTarget.select()}
      {...invalid('batch_no')}
    />
  ) : (
    <span className="block px-1 text-muted-foreground" aria-label={t('lines.no_batch')}>
      —
    </span>
  )

  const expiry = batchEnabled ? (
    <Input
      id={cellId(line.key, 'expiry')}
      data-cell={cellId(line.key, 'expiry')}
      size="sm"
      value={line.expiry_text}
      inputMode="numeric"
      autoComplete="off"
      disabled={disabled}
      aria-label={label(t('lines.expiry'))}
      placeholder={t('lines.expiry_placeholder')}
      className="px-1.5 tabular-nums"
      onChange={(e) => set({ expiry_text: normalizeExpiryTyping(e.target.value) })}
      onFocus={(e) => e.currentTarget.select()}
      {...(errors.expiry || expiryState.kind === 'invalid'
        ? { 'aria-invalid': true as const }
        : {})}
    />
  ) : (
    <span className="block px-1 text-muted-foreground">—</span>
  )

  const mrp = (
    <MoneyInput
      id={cellId(line.key, 'mrp')}
      data-cell={cellId(line.key, 'mrp')}
      size="sm"
      showSymbol={false}
      className="px-1.5"
      value={line.mrp_paise}
      disabled={disabled}
      aria-label={label(t('lines.mrp'))}
      onChange={(v) => set({ mrp_paise: v })}
      {...invalid('mrp')}
    />
  )

  const qty = (
    <NumberInput
      id={cellId(line.key, 'qty')}
      data-cell={cellId(line.key, 'qty')}
      size="sm"
      decimals={qtyDecimals}
      scale={1000}
      value={packed ? toPackMilli(line.qty_milli, p.pack_size) : line.qty_milli}
      disabled={disabled}
      aria-label={label(t('lines.qty'))}
      className="px-1.5 text-end"
      onFocus={(e) => e.currentTarget.select()}
      onChange={(v) => set({ qty_milli: packed ? fromPackMilli(v, p.pack_size) : v })}
      {...invalid('qty')}
    />
  )

  const free = (
    <NumberInput
      id={cellId(line.key, 'free')}
      data-cell={cellId(line.key, 'free')}
      size="sm"
      decimals={qtyDecimals}
      scale={1000}
      value={packed ? toPackMilli(line.free_qty_milli, p.pack_size) : line.free_qty_milli}
      disabled={disabled}
      aria-label={label(t('lines.free'))}
      className="px-1.5 text-end"
      onFocus={(e) => e.currentTarget.select()}
      onChange={(v) => set({ free_qty_milli: packed ? fromPackMilli(v, p.pack_size) : v })}
      {...invalid('free')}
    />
  )

  const rate = (
    <MoneyInput
      id={cellId(line.key, 'unit_cost')}
      data-cell={cellId(line.key, 'unit_cost')}
      size="sm"
      showSymbol={false}
      className="px-1.5"
      value={line.unit_cost_paise}
      disabled={disabled}
      aria-label={label(t('lines.rate'))}
      onChange={(v) => set({ unit_cost_paise: v })}
      {...invalid('unit_cost')}
    />
  )

  const discount = (
    <NumberInput
      id={cellId(line.key, 'discount')}
      data-cell={cellId(line.key, 'discount')}
      size="sm"
      decimals={2}
      scale={100}
      max={10_000}
      value={line.discount_bp}
      disabled={disabled}
      aria-label={label(t('lines.disc'))}
      className="px-1.5 text-end"
      onFocus={(e) => e.currentTarget.select()}
      onChange={(v) => set({ discount_bp: v })}
      {...invalid('discount')}
    />
  )

  const gst = (
    <select
      id={cellId(line.key, 'gst')}
      data-cell={cellId(line.key, 'gst')}
      value={line.gst_rate_bp}
      disabled={disabled}
      aria-label={label(t('lines.gst'))}
      className={cn(fieldVariants({ size: 'sm' }), 'px-1 text-end tabular-nums')}
      onChange={(e) => set({ gst_rate_bp: Number(e.target.value) })}
    >
      {GST_RATES_BP.map((r) => (
        <option key={r} value={r}>
          {formatBp(r)}
        </option>
      ))}
    </select>
  )

  const sale = (
    <MoneyInput
      id={cellId(line.key, 'sale_price')}
      data-cell={cellId(line.key, 'sale_price')}
      size="sm"
      showSymbol={false}
      className="px-1.5"
      value={line.sale_price_paise}
      placeholder={formatMoney(p.sale_price_paise, { symbol: false })}
      disabled={disabled}
      aria-label={label(t('lines.sale_price'))}
      onChange={(v) => set({ sale_price_paise: v })}
      {...invalid('sale_price')}
    />
  )

  const marginBadge =
    margin === null ? null : (
      <Tooltip
        content={
          line.sale_price_paise === null
            ? t('lines.margin_current_hint')
            : t('lines.margin_new_hint')
        }
      >
        <span
          className={cn(
            'mt-0.5 inline-block text-[11px] font-medium tabular-nums',
            marginTone(margin) === 'danger' && 'text-danger',
            marginTone(margin) === 'warning' && 'text-warning',
            marginTone(margin) === 'success' && 'text-success',
            line.sale_price_paise === null && 'opacity-80',
          )}
        >
          {t('lines.margin', { value: formatMargin(margin) })}
        </span>
      </Tooltip>
    )

  const name = localizedName(p.name, p.name_ta)
  const other = getLanguage() === 'ta' ? p.name : p.name_ta
  const product = (
    <div className="min-w-0">
      <div className="flex min-w-0 items-start gap-1.5">
        <span className="shrink-0 tabular-nums text-muted-foreground">{index + 1}.</span>
        <span className="min-w-0 font-medium leading-snug [overflow-wrap:anywhere]">{name}</span>
        {line.purchase_order_line_id ? (
          <Tooltip content={t('lines.from_order')}>
            <PackageCheck
              className="mt-0.5 size-4 shrink-0 text-info"
              aria-label={t('lines.from_order')}
            />
          </Tooltip>
        ) : null}
        <WarningIcon warnings={warnings} />
      </div>
      <div className="truncate ps-5 text-xs text-muted-foreground">
        {[
          other && other !== name ? other : null,
          p.sku,
          packed
            ? t('lines.pack_of', { count: p.pack_size, unit: unitLabel(p.unit), pack: packWord })
            : null,
        ]
          .filter(Boolean)
          .join(' · ')}
        {p.stock_qty_milli !== null ? (
          <>
            {' · '}
            {t('lines.stock')}{' '}
            <Qty
              milli={p.stock_qty_milli}
              unit={p.unit}
              packSize={p.pack_size}
              packUnit={packUnitFor(p.unit)}
            />
          </>
        ) : null}
      </div>
    </div>
  )

  const amounts = <Money paise={result?.taxable_paise ?? null} />
  const tax = <Money paise={result?.tax_paise ?? null} className="text-muted-foreground" />
  const amount = <Money paise={result?.total_paise ?? null} className="font-semibold" />
  const total = (
    <div className="text-end">
      {amount}
      {result ? (
        <div className="text-[11px] text-muted-foreground tabular-nums">
          {t('lines.tax_amount', { amount: formatMoney(result.tax_paise) })}
        </div>
      ) : null}
    </div>
  )

  return {
    batch,
    expiry,
    mrp,
    qty,
    free,
    rate,
    discount,
    gst,
    sale,
    marginBadge,
    product,
    amounts,
    tax,
    amount,
    total,
    errorOf,
    warnings,
    packWord,
  }
}

function WarningIcon({ warnings }: { warnings: PurchaseWarning[] }) {
  const { t } = useTranslation('purchases')
  if (warnings.length === 0) return null
  const severe = warnings.some(isSevereWarning)
  return (
    <Tooltip
      content={
        <ul className="grid gap-1">
          {warnings.map((w) => (
            <li key={w.code}>{warningText(w)}</li>
          ))}
        </ul>
      }
    >
      <span
        role="img"
        tabIndex={0}
        aria-label={t('lines.warnings_count', { count: warnings.length })}
        className={cn(
          'mt-0.5 inline-flex shrink-0 rounded focus-visible:outline-2 focus-visible:outline-ring',
          severe ? 'text-danger' : 'text-warning',
        )}
      >
        <AlertTriangle className="size-4" />
      </span>
    </Tooltip>
  )
}

function CellError({ text }: { text: string | undefined }) {
  if (!text) return null
  return (
    <div role="alert" className="mt-0.5 text-[11px] font-medium leading-tight text-danger">
      {text}
    </div>
  )
}

function LineRow(props: LineProps) {
  const { t } = useTranslation('purchases')
  const { line, showBatch, disabled, onRemove, index } = props
  const c = useCells(props)
  const td =
    'border-b border-border/70 px-1.5 py-1.5 align-top first:sticky first:start-0 first:z-10 first:border-e first:bg-surface first:ps-3 last:pe-3'
  const hasError = Object.keys(props.errors).length > 0
  return (
    <tr className={cn('group', hasError && 'bg-danger-soft/30')}>
      <td className={td}>{c.product}</td>
      {showBatch ? (
        <>
          <td className={td}>
            {c.batch}
            <CellError text={c.errorOf('batch_no')} />
          </td>
          <td className={td}>
            {c.expiry}
            <CellError text={c.errorOf('expiry')} />
          </td>
        </>
      ) : null}
      <td className={td}>{c.mrp}</td>
      <td className={td}>
        {c.qty}
        {c.packWord ? (
          <div className="mt-0.5 text-end text-[11px] text-muted-foreground">{c.packWord}</div>
        ) : null}
        <CellError text={c.errorOf('qty')} />
      </td>
      <td className={td}>{c.free}</td>
      <td className={td}>
        {c.rate}
        <CellError text={c.errorOf('unit_cost')} />
      </td>
      <td className={td}>
        {c.discount}
        <CellError text={c.errorOf('discount')} />
      </td>
      <td className={td}>{c.gst}</td>
      <td className={cn(td, 'pt-3 text-end')}>{c.amounts}</td>
      <td className={cn(td, 'pt-3 text-end')}>{c.tax}</td>
      <td className={cn(td, 'pt-3 text-end')}>{c.amount}</td>
      <td className={cn(td, 'text-end')}>
        {c.sale}
        {c.marginBadge}
      </td>
      <td className={cn(td, 'text-end')}>
        <IconButton
          icon={<Trash2 />}
          label={t('lines.remove_line', { n: index + 1 })}
          variant="ghost"
          size="sm"
          disabled={disabled}
          tabIndex={-1}
          className="text-muted-foreground hover:text-danger"
          onClick={() => onRemove(line.key)}
        />
      </td>
    </tr>
  )
}

function Field({ label, children, error }: { label: string; children: ReactNode; error?: string }) {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      <CellError text={error} />
    </div>
  )
}

function LineCard(props: LineProps) {
  const { t } = useTranslation('purchases')
  const { line, showBatch, disabled, onRemove, index } = props
  const c = useCells(props)
  const batchEnabled = showBatch && line.product.track_batches
  const hasError = Object.keys(props.errors).length > 0
  return (
    <li
      className={cn(
        'min-w-0 rounded-xl border bg-surface p-3 shadow-card',
        hasError ? 'border-danger/60' : 'border-border',
      )}
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        {c.product}
        <IconButton
          icon={<Trash2 />}
          label={t('lines.remove_line', { n: index + 1 })}
          variant="ghost"
          size="sm"
          disabled={disabled}
          className="-me-1 -mt-1 text-muted-foreground hover:text-danger"
          onClick={() => onRemove(line.key)}
        />
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2.5 sm:grid-cols-3">
        {batchEnabled ? (
          <>
            <Field label={t('lines.batch')} error={c.errorOf('batch_no')}>
              {c.batch}
            </Field>
            <Field label={t('lines.expiry')} error={c.errorOf('expiry')}>
              {c.expiry}
            </Field>
          </>
        ) : null}
        <Field
          label={c.packWord ? t('lines.qty_in', { unit: c.packWord }) : t('lines.qty')}
          error={c.errorOf('qty')}
        >
          {c.qty}
        </Field>
        <Field label={t('lines.free')}>{c.free}</Field>
        <Field label={t('lines.rate')} error={c.errorOf('unit_cost')}>
          {c.rate}
        </Field>
        <Field label={t('lines.disc')} error={c.errorOf('discount')}>
          {c.discount}
        </Field>
        <Field label={t('lines.gst')}>{c.gst}</Field>
        <Field label={t('lines.mrp')}>{c.mrp}</Field>
        <Field label={t('lines.sale_price')}>
          {c.sale}
          {c.marginBadge}
        </Field>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-2 text-sm">
        <span className="text-muted-foreground">
          {t('lines.taxable')}: {c.amounts}
        </span>
        <div className="flex items-center gap-2">
          {c.warnings.length > 0 ? (
            <Badge tone={c.warnings.some(isSevereWarning) ? 'danger' : 'warning'} size="sm">
              {t('lines.warnings_count', { count: c.warnings.length })}
            </Badge>
          ) : null}
          {c.total}
        </div>
      </div>
    </li>
  )
}
