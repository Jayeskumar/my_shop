/**
 * Line grid of the adjustment editor. Two layouts:
 *  - change list (adjustment / damage / expiry write-off): product (+ batch), current stock,
 *    direction (+ found / − missing; write-offs are always −), quantity, value, reason;
 *  - stock take: product (+ batch), system qty, counted qty, difference (red shortage, green
 *    excess), value, reason. Enter in a counted box jumps to the next line, so a whole shelf
 *    can be counted from the keyboard.
 * Rows become cards below md.
 */
import type { EditableAdjustmentKind } from '@kadai/shared/api/inventory'
import { Minus, Plus, Trash2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { BatchPicker } from '@/components/pickers'
import { IconButton, Money, Qty, QtyInput, Select } from '@/components/ui'
import { cn } from '@/lib/cn'
import {
  type AdjLine,
  type AdjLineErrors,
  isLossOnly,
  lineDelta,
  lineValue,
} from '../lib/adjustment-form'
import { validationText } from '../lib/errors'
import { packUnitFor, reasonLabel, reasonsForKind } from '../lib/labels'
import { focusLater } from '../lib/lines'
import { ProductName } from './ProductName'
import { QtyChange } from './StockBadge'

const CHANGE_COLS = 'xl:grid-cols-[minmax(0,1fr)_6rem_10rem_7.5rem_6.5rem_10rem_2.5rem]'
const TAKE_COLS = 'xl:grid-cols-[minmax(0,1fr)_7rem_8rem_7rem_7rem_10rem_2.5rem]'

export const ADJ_ADDER_ID = 'adjustment-add-product'

export interface AdjustmentLinesProps {
  kind: EditableAdjustmentKind
  lines: readonly AdjLine[]
  errors: AdjLineErrors
  storeId: string | null
  /** Highlighted line (just scanned). */
  flashKey?: string | null
  onChange: (key: string, patch: Partial<AdjLine>) => void
  onRemove: (key: string) => void
}

export function AdjustmentLines({
  kind,
  lines,
  errors,
  storeId,
  flashKey,
  onChange,
  onRemove,
}: AdjustmentLinesProps) {
  const { t } = useTranslation('inventory')
  const take = kind === 'stock_take'
  const cols = take ? TAKE_COLS : CHANGE_COLS
  return (
    <div className="grid grid-cols-1 gap-2">
      <div
        aria-hidden
        className={cn(
          'hidden gap-2 px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground xl:grid',
          cols,
        )}
      >
        <span>{t('lines.product')}</span>
        {take ? (
          <>
            <span className="text-end">{t('lines.system_qty')}</span>
            <span>{t('lines.counted_qty')}</span>
            <span className="text-end">{t('lines.difference')}</span>
          </>
        ) : (
          <>
            <span className="text-end">{t('lines.in_stock')}</span>
            <span>{t('lines.change')}</span>
            <span>{t('lines.qty')}</span>
          </>
        )}
        <span className="text-end">{t('lines.value')}</span>
        <span>{t('lines.reason')}</span>
        <span />
      </div>
      <ul className="grid grid-cols-1 gap-2" aria-label={t('lines.list_label')}>
        {lines.map((l, index) => (
          <LineRow
            key={l.key}
            kind={kind}
            line={l}
            index={index}
            next={lines[index + 1]?.key ?? null}
            errors={errors[l.key] ?? {}}
            storeId={storeId}
            flash={flashKey === l.key}
            cols={cols}
            onChange={(patch) => onChange(l.key, patch)}
            onRemove={() => onRemove(l.key)}
          />
        ))}
      </ul>
    </div>
  )
}

function LineRow({
  kind,
  line: l,
  index,
  next,
  errors,
  storeId,
  flash,
  cols,
  onChange,
  onRemove,
}: {
  kind: EditableAdjustmentKind
  line: AdjLine
  index: number
  next: string | null
  errors: AdjLineErrors[string]
  storeId: string | null
  flash: boolean
  cols: string
  onChange: (patch: Partial<AdjLine>) => void
  onRemove: () => void
}) {
  const { t, i18n } = useTranslation(['inventory', 'common'])
  const take = kind === 'stock_take'
  const delta = lineDelta(kind, l)
  const value = lineValue(kind, l)
  const packUnit = packUnitFor(l.product.unit)
  const n = index + 1
  const errorText = (code: string | undefined) =>
    code
      ? code === 'batch_required'
        ? t('inventory:errors.batch_required')
        : code === 'required'
          ? t('inventory:validation.qty_delta_required')
          : (validationText(code) ?? code)
      : undefined
  const hasError = Object.keys(errors).length > 0
  const reasonOptions = reasonsForKind(kind).map((code) => ({
    value: code,
    label: reasonLabel(code, i18n.language) ?? code,
  }))
  const reasonValue = l.reason && reasonOptions.some((o) => o.value === l.reason) ? l.reason : null

  return (
    <li
      data-line={l.key}
      className={cn(
        'grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg border border-border bg-surface p-3 transition-colors xl:items-center xl:gap-2 xl:px-2 xl:py-1.5',
        cols,
        take && delta !== null && delta < 0 && 'border-danger/40 bg-danger-soft/40',
        take && delta !== null && delta > 0 && 'border-success/40 bg-success-soft/40',
        take && l.counted_milli === null && 'bg-surface-2/60',
        hasError && 'border-danger',
        flash && 'ring-2 ring-primary',
      )}
    >
      <div className="col-span-2 grid min-w-0 grid-cols-1 gap-1.5 xl:col-span-1">
        <div className="flex items-start justify-between gap-2">
          <ProductName name={l.product.name} nameTa={l.product.name_ta} sku={l.product.sku} />
          <IconButton
            icon={<Trash2 />}
            label={t('lines.remove_line', { n })}
            variant="ghost"
            size="sm"
            className="xl:hidden"
            onClick={onRemove}
          />
        </div>
        {l.product.track_batches ? (
          <div className="grid grid-cols-1 gap-1">
            <BatchPicker
              aria-label={t('lines.batch_of', { n })}
              productId={l.product.id}
              storeId={storeId}
              value={l.batch?.id ?? null}
              allowExpired
              withStockOnly={kind === 'damage' || kind === 'expiry_writeoff'}
              size="sm"
              onChange={(_, batch) =>
                onChange(
                  batch
                    ? {
                        batch: {
                          id: batch.id,
                          batch_no: batch.batch_no,
                          expiry_date: batch.expiry_date,
                        },
                        system_milli: batch.qty_milli,
                        product:
                          batch.purchase_price_paise !== null
                            ? { ...l.product, cost_paise: batch.purchase_price_paise }
                            : l.product,
                      }
                    : { batch: null, system_milli: null },
                )
              }
            />
            {errors.batch ? <FieldError>{errorText(errors.batch)}</FieldError> : null}
          </div>
        ) : null}
        {errors.product ? <FieldError>{errorText(errors.product)}</FieldError> : null}
      </div>

      {take ? (
        <>
          <Cell label={t('lines.system_qty')} className="xl:text-end">
            <Qty
              milli={l.system_milli}
              unit={l.product.unit}
              packSize={l.product.pack_size}
              packUnit={packUnit}
              colorize
            />
          </Cell>
          <Cell label={t('lines.counted_qty')}>
            <QtyInput
              id={`adj-count-${l.key}`}
              aria-label={t('lines.counted_of', { n })}
              unit={l.product.unit}
              value={l.counted_milli}
              onChange={(v) => onChange({ counted_milli: v })}
              steppers={false}
              size="md"
              aria-invalid={errors.counted ? true : undefined}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
                  e.preventDefault()
                  focusLater(next ? `adj-count-${next}` : ADJ_ADDER_ID)
                }
              }}
            />
            {errors.counted ? <FieldError>{errorText(errors.counted)}</FieldError> : null}
          </Cell>
          <Cell label={t('lines.difference')} className="xl:text-end">
            {delta === null ? (
              <span className="text-xs text-muted-foreground">
                {l.counted_milli === null ? t('lines.not_counted') : '—'}
              </span>
            ) : delta === 0 ? (
              <span className="text-sm text-muted-foreground">{t('lines.matches')}</span>
            ) : (
              <QtyChange milli={delta} unit={l.product.unit} packSize={l.product.pack_size} />
            )}
          </Cell>
        </>
      ) : (
        <>
          <Cell label={t('lines.in_stock')} className="xl:text-end">
            <Qty
              milli={l.system_milli}
              unit={l.product.unit}
              packSize={l.product.pack_size}
              packUnit={packUnit}
              colorize
              className="text-sm"
            />
          </Cell>
          <Cell label={t('lines.change')}>
            {isLossOnly(kind) ? (
              <span className="inline-flex h-10 items-center gap-1 text-sm font-medium text-danger">
                <Minus className="size-4" aria-hidden />
                {t('lines.reduce')}
              </span>
            ) : (
              <DirectionToggle
                value={l.direction}
                n={n}
                onChange={(direction) => onChange({ direction })}
              />
            )}
          </Cell>
          <Cell label={t('lines.qty')}>
            <QtyInput
              id={`adj-qty-${l.key}`}
              aria-label={t('lines.qty_of', { n })}
              unit={l.product.unit}
              value={l.qty_milli}
              onChange={(v) => onChange({ qty_milli: v })}
              steppers={false}
              aria-invalid={errors.qty ? true : undefined}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
                  e.preventDefault()
                  focusLater(ADJ_ADDER_ID)
                }
              }}
            />
            {errors.qty ? <FieldError>{errorText(errors.qty)}</FieldError> : null}
          </Cell>
        </>
      )}

      <Cell label={t('lines.value')} className="xl:text-end">
        <Money paise={value} colorize className="text-sm" />
      </Cell>
      <Cell label={t('lines.reason')} className="col-span-2 xl:col-span-1">
        <Select
          aria-label={t('lines.reason_of', { n })}
          size="sm"
          value={reasonValue}
          placeholder={t('lines.reason_placeholder')}
          onValueChange={(v) => onChange({ reason: v })}
          options={reasonOptions}
        />
      </Cell>
      <IconButton
        icon={<Trash2 />}
        label={t('lines.remove_line', { n })}
        variant="ghost"
        className="hidden xl:inline-flex"
        onClick={onRemove}
      />
    </li>
  )
}

function DirectionToggle({
  value,
  n,
  onChange,
}: {
  value: 1 | -1
  n: number
  onChange: (v: 1 | -1) => void
}) {
  const { t } = useTranslation('inventory')
  const base =
    'inline-flex h-10 flex-1 items-center justify-center gap-1 px-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring'
  return (
    <div
      role="group"
      aria-label={t('lines.change_of', { n })}
      className="flex min-w-0 overflow-hidden rounded-md border border-input bg-surface shadow-card"
    >
      <button
        type="button"
        aria-pressed={value === 1}
        onClick={() => onChange(1)}
        className={cn(
          base,
          value === 1 ? 'bg-success text-success-foreground' : 'hover:bg-surface-2',
        )}
      >
        <Plus className="size-4" aria-hidden />
        {/* Icon-only on phones (the cell is half a card wide); the text stays for screen readers. */}
        <span className="max-sm:sr-only">{t('lines.add')}</span>
      </button>
      <button
        type="button"
        aria-pressed={value === -1}
        onClick={() => onChange(-1)}
        className={cn(
          base,
          'border-s border-input',
          value === -1 ? 'bg-danger text-danger-foreground' : 'hover:bg-surface-2',
        )}
      >
        <Minus className="size-4" aria-hidden />
        <span className="max-sm:sr-only">{t('lines.reduce')}</span>
      </button>
    </div>
  )
}

function Cell({
  label,
  className,
  children,
}: {
  label: string
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cn('grid gap-1', className)}>
      <span aria-hidden className="text-xs text-muted-foreground xl:hidden">
        {label}
      </span>
      {children}
    </div>
  )
}

function FieldError({ children }: { children: ReactNode }) {
  return <span className="text-xs text-danger">{children}</span>
}
