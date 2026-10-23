/**
 * Opening stock (POST /stock/opening): a fast grid to enter what is on the shelves when the shop
 * starts using Kadai — scan or search a product, type the quantity and cost (prefilled with the
 * purchase price), and the batch / expiry / MRP for batch-tracked items. Rows can also be pasted
 * from Excel (code, qty, cost, batch, expiry, MRP). Posting adds 'opening' movements and the
 * opening-balance journal; products that already moved in the store need a confirmed `force`.
 */
import { catalogRoutes, type ProductListItem } from '@kadai/shared/api/catalog'
import {
  type OpeningStock,
  OpeningStockSchema,
  inventoryRoutes,
  stockValuePaise,
} from '@kadai/shared/api/inventory'
import { newId } from '@kadai/shared/ids'
import { tryParseQty } from '@kadai/shared/units'
import { ClipboardPaste, PackagePlus, Trash2 } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { StorePicker } from '@/components/pickers'
import {
  Badge,
  Button,
  DatePicker,
  Dialog,
  FormField,
  IconButton,
  Input,
  Money,
  MoneyInput,
  QtyInput,
  notify,
  useConfirm,
} from '@/components/ui'
import { Textarea } from '@/components/ui/textarea'
import { callRoute, isApiError } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatMoney } from '@/lib/format'
import { translate } from '@/lib/i18n'
import { useRouteMutation } from '@/lib/query'
import { useToday } from '../lib/access'
import { errorReason, notifyInventoryError, validationText } from '../lib/errors'
import { STOCK_ROUTES } from '../lib/invalidate'
import { type LineProduct, focusLater, fromListItem, lineKey } from '../lib/lines'
import { type PasteIssue, parseOpeningPaste } from '../lib/opening-paste'
import { ProductAdder } from './ProductAdder'
import { ProductName } from './ProductName'

interface OpeningLine {
  key: string
  product: LineProduct
  qty_milli: number | null
  unit_cost_paise: number | null
  batch_no: string
  expiry_date: string | null
  mrp_paise: number | null
}

type LineField = 'product' | 'qty' | 'cost' | 'batch' | 'expiry'
type LineErrors = Record<string, Partial<Record<LineField, string>>>

function newLine(product: LineProduct, over: Partial<OpeningLine> = {}): OpeningLine {
  return {
    key: lineKey(),
    product,
    qty_milli: null,
    unit_cost_paise: product.cost_paise,
    batch_no: '',
    expiry_date: null,
    mrp_paise: product.track_batches ? product.mrp_paise : null,
    ...over,
  }
}

const ADDER_ID = 'opening-add-product'
const LOOKUP_CONCURRENCY = 4

export interface OpeningStockDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultStoreId: string | null
}

export function OpeningStockDialog({
  open,
  onOpenChange,
  defaultStoreId,
}: OpeningStockDialogProps) {
  const { t } = useTranslation(['inventory', 'common'])
  const confirm = useConfirm()
  const today = useToday()
  const [storeId, setStoreId] = useState<string | null>(defaultStoreId)
  const [date, setDate] = useState<string | null>(today)
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<OpeningLine[]>([])
  const [errors, setErrors] = useState<LineErrors>({})
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [pasteProblems, setPasteProblems] = useState<PasteIssue[]>([])
  const [resolving, setResolving] = useState(false)
  const idempotencyKey = useRef(newId())

  useEffect(() => {
    if (!open) return
    setStoreId(defaultStoreId)
    setDate(today)
  }, [open, defaultStoreId, today])

  const post = useRouteMutation(inventoryRoutes.postOpeningStock, {
    invalidates: STOCK_ROUTES,
    onError: () => {},
  })

  const total = useMemo(
    () =>
      lines.reduce(
        (sum, l) =>
          sum +
          (l.qty_milli && l.unit_cost_paise !== null
            ? stockValuePaise(l.unit_cost_paise, l.qty_milli, l.product.pack_size)
            : 0),
        0,
      ),
    [lines],
  )

  const reset = (): void => {
    setLines([])
    setErrors({})
    setNotes('')
    setPasteText('')
    setPasteProblems([])
    setPasteOpen(false)
    idempotencyKey.current = newId()
  }

  const close = async (): Promise<void> => {
    if (lines.length > 0) {
      const ok = await confirm({
        title: t('common:confirm.discard_title'),
        description: t('common:confirm.discard_description'),
        tone: 'danger',
      })
      if (!ok) return
    }
    reset()
    onOpenChange(false)
  }

  const update = (key: string, patch: Partial<OpeningLine>): void => {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))
    setErrors((e) => {
      if (!e[key]) return e
      const next = { ...e }
      delete next[key]
      return next
    })
  }

  const addProduct = (p: ProductListItem): void => {
    const existing = lines.find((l) => l.product.id === p.id && !p.track_batches)
    if (existing) {
      focusLater(`op-qty-${existing.key}`)
      return
    }
    const line = newLine(fromListItem(p))
    setLines((ls) => [...ls, line])
    focusLater(`op-qty-${line.key}`)
  }

  const readPaste = async (): Promise<void> => {
    const { rows, issues } = parseOpeningPaste(pasteText)
    if (rows.length === 0) {
      setPasteProblems(issues)
      if (issues.length === 0) notify.warning(t('opening.paste_empty'))
      return
    }
    setResolving(true)
    try {
      const problems: PasteIssue[] = [...issues]
      const codes = [...new Set(rows.map((r) => r.code))]
      const idByCode = new Map<string, string>()
      for (let i = 0; i < codes.length; i += LOOKUP_CONCURRENCY) {
        const chunk = codes.slice(i, i + LOOKUP_CONCURRENCY)
        const hits = await Promise.all(
          chunk.map((code) =>
            callRoute(catalogRoutes.lookupProduct, {
              query: { code, ...(storeId ? { store_id: storeId } : {}) },
            }).then(
              (r) => [code, r.data.product.id] as const,
              (e: unknown) => {
                if (isApiError(e) && e.status === 404) return [code, null] as const
                throw e
              },
            ),
          ),
        )
        for (const [code, id] of hits) if (id) idByCode.set(code, id)
      }
      const ids = [...new Set(idByCode.values())]
      const products = new Map<string, ProductListItem>()
      for (let i = 0; i < ids.length; i += 100) {
        const res = await callRoute(catalogRoutes.listProducts, {
          query: { ids: ids.slice(i, i + 100), limit: 100 },
        })
        for (const p of res.data) products.set(p.id, p)
      }
      const added: OpeningLine[] = []
      for (const row of rows) {
        const id = idByCode.get(row.code)
        const product = id ? products.get(id) : undefined
        if (!product) {
          problems.push({ line: row.line, code: 'missing_code', value: row.code })
          continue
        }
        const lp = fromListItem(product)
        const qty = tryParseQty(row.qty, lp.unit)
        if (qty === null || qty <= 0) {
          problems.push({ line: row.line, code: 'missing_qty', value: row.qty })
          continue
        }
        added.push(
          newLine(lp, {
            qty_milli: qty,
            unit_cost_paise: row.cost_paise ?? lp.cost_paise,
            batch_no: lp.track_batches ? (row.batch_no ?? '') : '',
            expiry_date: lp.track_batches ? row.expiry_date : null,
            mrp_paise: lp.track_batches ? (row.mrp_paise ?? lp.mrp_paise) : null,
          }),
        )
      }
      setLines((ls) => [...ls, ...added])
      setPasteProblems(problems.sort((a, b) => a.line - b.line))
      if (added.length > 0) {
        notify.success(t('opening.paste_added', { count: added.length }))
        if (problems.length === 0) {
          setPasteText('')
          setPasteOpen(false)
        }
      }
    } catch (error) {
      notify.error(error)
    } finally {
      setResolving(false)
    }
  }

  const validate = (force: boolean): OpeningStock | null => {
    const next: LineErrors = {}
    const required = translate('errors:validation.required')
    for (const l of lines) {
      const e: Partial<Record<LineField, string>> = {}
      if (!l.qty_milli || l.qty_milli <= 0) e.qty = required
      if (l.unit_cost_paise === null) e.cost = required
      if (l.product.track_batches && !l.batch_no.trim())
        e.batch = t('inventory:errors.batch_required')
      if (Object.keys(e).length) next[l.key] = e
    }
    const body: OpeningStock = {
      store_id: storeId ?? '',
      ...(date ? { date } : {}),
      notes: notes.trim() || null,
      force,
      lines: lines.map((l) => ({
        product_id: l.product.id,
        qty_milli: l.qty_milli ?? 0,
        unit_cost_paise: l.unit_cost_paise ?? 0,
        ...(l.product.track_batches
          ? {
              batch: {
                batch_no: l.batch_no.trim(),
                expiry_date: l.expiry_date,
                mrp_paise: l.mrp_paise,
              },
            }
          : {}),
      })),
    }
    const parsed = OpeningStockSchema.safeParse(body)
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const [root, index, field] = issue.path
        if (root !== 'lines' || typeof index !== 'number') continue
        const line = lines[index]
        if (!line) continue
        const target: LineField =
          field === 'qty_milli'
            ? 'qty'
            : field === 'unit_cost_paise'
              ? 'cost'
              : field === 'batch'
                ? issue.path.includes('expiry_date')
                  ? 'expiry'
                  : 'batch'
                : 'product'
        next[line.key] = {
          ...next[line.key],
          [target]: next[line.key]?.[target] ?? validationText(issue.message) ?? issue.message,
        }
      }
    }
    setErrors(next)
    if (!storeId) {
      notify.warning(t('lines.store_required'))
      return null
    }
    if (Object.keys(next).length > 0) {
      notify.warning(t('lines.fix_errors'))
      return null
    }
    return parsed.success ? body : null
  }

  const submit = async (force = false): Promise<void> => {
    const body = validate(force)
    if (!body) return
    if (!force) {
      const ok = await confirm({
        title: t('opening.confirm_title', { count: lines.length }),
        description: t('opening.confirm_description', { amount: formatMoney(total) }),
        confirmLabel: t('opening.post'),
      })
      if (!ok) return
    }
    try {
      const res = await post.mutateAsync({ body, idempotencyKey: idempotencyKey.current })
      notify.success(
        t('opening.posted', {
          count: lines.length,
          amount: formatMoney(res.data.total_value_paise),
        }),
      )
      reset()
      onOpenChange(false)
    } catch (error) {
      if (errorReason(error) === 'has_movements' && !force) {
        const ids = isApiError(error) ? error.details?.product_ids : undefined
        const moved = Array.isArray(ids)
          ? ids.filter((x): x is string => typeof x === 'string')
          : []
        const names = lines
          .filter((l) => moved.includes(l.product.id))
          .map((l) => l.product.name)
          .slice(0, 5)
          .join(', ')
        const ok = await confirm({
          title: t('opening.has_movements_title', { count: moved.length || 1 }),
          description: t('opening.has_movements_description', { names }),
          confirmLabel: t('opening.post_anyway'),
          tone: 'danger',
        })
        if (ok) {
          idempotencyKey.current = newId()
          await submit(true)
        }
        return
      }
      notifyInventoryError(error)
      idempotencyKey.current = newId()
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) void close()
        else onOpenChange(true)
      }}
      dismissible={lines.length === 0}
      size="xl"
      className="max-w-6xl"
      title={t('opening.title')}
      description={t('opening.description')}
      bodyClassName="grid grid-cols-1 gap-4"
      footer={
        <div className="flex w-full flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm text-muted-foreground" aria-live="polite">
            {t('opening.summary', { count: lines.length })}{' '}
            <Money paise={total} className="font-semibold text-foreground" />
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button variant="outline" onClick={() => void close()}>
              {t('common:actions.cancel')}
            </Button>
            <Button
              leftIcon={<PackagePlus />}
              loading={post.isPending}
              disabled={lines.length === 0}
              onClick={() => void submit(false)}
            >
              {t('opening.post')}
            </Button>
          </div>
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
        <FormField label={t('common:fields.store')} required>
          <StorePicker value={storeId} onChange={(id) => setStoreId(id)} clearable={false} />
        </FormField>
        <FormField label={t('opening.date')}>
          <DatePicker value={date} onChange={setDate} max={today} />
        </FormField>
      </div>

      <div className="grid grid-cols-1 gap-2 rounded-xl border border-border bg-surface-2/50 p-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <ProductAdder id={ADDER_ID} onPick={addProduct} storeId={storeId} className="flex-1" />
          <Button
            variant="ghost"
            leftIcon={<ClipboardPaste />}
            aria-expanded={pasteOpen}
            onClick={() => setPasteOpen((v) => !v)}
          >
            {t('opening.paste_toggle')}
          </Button>
        </div>
        {pasteOpen ? (
          <div className="grid grid-cols-1 gap-2">
            <FormField label={t('opening.paste_label')} hint={t('opening.paste_hint')}>
              <Textarea
                rows={5}
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder={t('opening.paste_placeholder')}
                className="font-mono text-sm"
              />
            </FormField>
            <div className="flex justify-end">
              <Button
                variant="secondary"
                loading={resolving}
                disabled={!pasteText.trim()}
                onClick={() => void readPaste()}
              >
                {t('opening.paste_read')}
              </Button>
            </div>
          </div>
        ) : null}
        {pasteProblems.length > 0 ? (
          <ul
            role="alert"
            className="grid grid-cols-1 gap-1 rounded-lg bg-warning-soft p-2 text-sm text-warning-soft-foreground"
          >
            {pasteProblems.slice(0, 8).map((p, i) => (
              <li key={`${p.line}-${p.code}-${i}`}>
                {t(`opening.paste_issue.${p.code}`, { line: p.line, value: p.value ?? '' })}
              </li>
            ))}
            {pasteProblems.length > 8 ? (
              <li>{t('opening.paste_more', { count: pasteProblems.length - 8 })}</li>
            ) : null}
          </ul>
        ) : null}
      </div>

      {lines.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center">
          <p className="font-medium">{t('opening.empty_title')}</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            {t('opening.empty_hint')}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2">
          <div
            className="hidden gap-2 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground lg:grid lg:grid-cols-[minmax(0,1fr)_7rem_8.5rem_7.5rem_10.5rem_7.5rem_2.5rem]"
            aria-hidden
          >
            <span>{t('lines.product')}</span>
            <span>{t('lines.qty')}</span>
            <span>{t('opening.cost')}</span>
            <span>{t('lines.batch')}</span>
            <span>{t('lines.expiry')}</span>
            <span>{t('opening.mrp')}</span>
            <span />
          </div>
          <ul className="grid grid-cols-1 gap-2">
            {lines.map((l, index) => (
              <OpeningRow
                key={l.key}
                line={l}
                index={index}
                errors={errors[l.key] ?? {}}
                onChange={(patch) => update(l.key, patch)}
                onRemove={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
              />
            ))}
          </ul>
        </div>
      )}

      <FormField label={t('common:fields.notes')} optional>
        <Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />
      </FormField>
    </Dialog>
  )
}

function OpeningRow({
  line: l,
  index,
  errors,
  onChange,
  onRemove,
}: {
  line: OpeningLine
  index: number
  errors: Partial<Record<LineField, string>>
  onChange: (patch: Partial<OpeningLine>) => void
  onRemove: () => void
}) {
  const { t } = useTranslation(['inventory', 'common'])
  const value =
    l.qty_milli && l.unit_cost_paise !== null
      ? stockValuePaise(l.unit_cost_paise, l.qty_milli, l.product.pack_size)
      : null
  const label = (field: string) => `${field} · ${index + 1}`
  return (
    <li
      className={cn(
        'grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg border border-border bg-surface p-3 lg:grid-cols-[minmax(0,1fr)_7rem_8.5rem_7.5rem_10.5rem_7.5rem_2.5rem] lg:items-start lg:gap-2 lg:border-0 lg:bg-transparent lg:p-1',
        Object.keys(errors).length > 0 && 'border-danger lg:bg-danger-soft/30',
      )}
    >
      <div className="col-span-2 flex min-w-0 items-start justify-between gap-2 lg:col-span-1">
        <ProductName
          name={l.product.name}
          nameTa={l.product.name_ta}
          sku={l.product.sku}
          extra={[
            value !== null ? formatMoney(value) : null,
            l.product.pack_size > 1
              ? t('common:units.pack_of', { count: l.product.pack_size })
              : null,
          ]}
          className="pt-1.5"
        />
        <IconButton
          icon={<Trash2 />}
          label={t('lines.remove')}
          variant="ghost"
          size="sm"
          className="lg:hidden"
          onClick={onRemove}
        />
      </div>
      <FieldCell label={t('lines.qty')} error={errors.qty}>
        <QtyInput
          id={`op-qty-${l.key}`}
          aria-label={label(t('lines.qty'))}
          unit={l.product.unit}
          value={l.qty_milli}
          onChange={(qty) => onChange({ qty_milli: qty })}
          steppers={false}
          aria-invalid={errors.qty ? true : undefined}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
              e.preventDefault()
              focusLater(`op-cost-${l.key}`)
            }
          }}
        />
      </FieldCell>
      <FieldCell label={t('opening.cost')} error={errors.cost}>
        <MoneyInput
          id={`op-cost-${l.key}`}
          aria-label={label(t('opening.cost'))}
          value={l.unit_cost_paise}
          onChange={(paise) => onChange({ unit_cost_paise: paise })}
          aria-invalid={errors.cost ? true : undefined}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
              e.preventDefault()
              focusLater(l.product.track_batches ? `op-batch-${l.key}` : ADDER_ID)
            }
          }}
        />
      </FieldCell>
      {l.product.track_batches ? (
        <>
          <FieldCell label={t('lines.batch')} error={errors.batch}>
            <Input
              id={`op-batch-${l.key}`}
              aria-label={label(t('lines.batch'))}
              value={l.batch_no}
              maxLength={40}
              onChange={(e) => onChange({ batch_no: e.target.value.toUpperCase() })}
              aria-invalid={errors.batch ? true : undefined}
            />
          </FieldCell>
          <FieldCell label={t('lines.expiry')} error={errors.expiry}>
            <DatePicker value={l.expiry_date} onChange={(d) => onChange({ expiry_date: d })} />
          </FieldCell>
          <FieldCell label={t('opening.mrp')}>
            <MoneyInput
              aria-label={label(t('opening.mrp'))}
              value={l.mrp_paise}
              onChange={(paise) => onChange({ mrp_paise: paise })}
            />
          </FieldCell>
        </>
      ) : (
        <div className="hidden text-sm text-muted-foreground lg:col-span-3 lg:flex lg:h-10 lg:items-center">
          <Badge tone="neutral" size="sm">
            {t('opening.no_batch')}
          </Badge>
        </div>
      )}
      <IconButton
        icon={<Trash2 />}
        label={t('lines.remove')}
        variant="ghost"
        className="hidden lg:inline-flex"
        onClick={onRemove}
      />
    </li>
  )
}

/** A grid cell: visible label on phones (cards), error text below the control. */
function FieldCell({
  label,
  error,
  children,
}: {
  label: string
  error?: string | undefined
  children: ReactNode
}) {
  return (
    <div className="grid grid-cols-1 gap-1">
      <span aria-hidden className="text-xs text-muted-foreground lg:hidden">
        {label}
      </span>
      {children}
      {error ? <span className="text-xs text-danger">{error}</span> : null}
    </div>
  )
}
