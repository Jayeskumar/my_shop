/**
 * Transfer editor (/inventory/transfers/new and drafts at /inventory/transfers/:id): from store
 * (a store the member works in) → to store (any active store of the business), date, notes and
 * lines (scan / search; batch picker for batch-tracked items, with stock at the source shown).
 * Save as draft or dispatch with confirmation (numbers the transfer and takes the stock out of
 * the source store). Opened with ?from_store_id=&product_ids= (transferPrefillPath).
 */
import { catalogRoutes, type ProductListItem } from '@kadai/shared/api/catalog'
import { identityRoutes } from '@kadai/shared/api/identity'
import {
  type StockTransferDetail,
  type TransferCreate,
  TransferCreateSchema,
  inventoryRoutes,
  parseInventoryPrefill,
  stockValuePaise,
} from '@kadai/shared/api/inventory'
import { newId } from '@kadai/shared/ids'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Ban, Save, Trash2, Truck } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router'
import { BatchPicker, StorePicker } from '@/components/pickers'
import {
  Badge,
  Button,
  Card,
  DatePicker,
  EmptyState,
  FormField,
  IconButton,
  Input,
  Kbd,
  Money,
  PageHeader,
  Qty,
  QtyInput,
  Select,
  notify,
  useConfirm,
} from '@/components/ui'
import { callRoute, isApiError } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatMoney } from '@/lib/format'
import { useMe } from '@/lib/auth'
import { localizedName } from '@/lib/i18n'
import { routeQueryKey, useRouteMutation, useRouteQuery } from '@/lib/query'
import { useDefaultStoreId, useStoreAccess, useToday } from '../lib/access'
import { notifyInventoryError, validationText } from '../lib/errors'
import { STOCK_ROUTES } from '../lib/invalidate'
import { INVENTORY_HOTKEY_SCOPE, packUnitFor } from '../lib/labels'
import {
  type LineBatch,
  type LineProduct,
  focusLater,
  fromDocumentLine,
  fromListItem,
  lineIdentity,
  lineKey,
} from '../lib/lines'
import { useUnsavedGuard } from '../lib/use-unsaved-guard'
import { useHotkeyScope, useHotkeys } from '@/lib/hotkeys'
import { ProductAdder } from './ProductAdder'
import { ProductName } from './ProductName'
import { ReasonDialog } from './ReasonDialog'

interface TransferLineState {
  key: string
  product: LineProduct
  batch: LineBatch | null
  qty_milli: number | null
  /** Stock at the source store (product or batch) when known. */
  available_milli: number | null
}

type LineErrors = Record<string, Partial<Record<'product' | 'batch' | 'qty', string>>>

const ADDER_ID = 'transfer-add-product'
const COLS = 'md:grid-cols-[minmax(0,1fr)_7rem_8rem_7rem_2.5rem]'

export function TransferEditor({ initial }: { initial?: StockTransferDetail }) {
  const { t, i18n } = useTranslation(['inventory', 'common'])
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const today = useToday()
  const defaultStore = useDefaultStoreId()
  const storeAccess = useStoreAccess()
  const prefill = useMemo(
    () => (initial ? null : parseInventoryPrefill(location.search)),
    // Read once when the editor opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  const [fromId, setFromId] = useState<string | null>(
    initial?.from_store_id ??
      (prefill?.from_store_id && storeAccess(prefill.from_store_id)
        ? prefill.from_store_id
        : defaultStore),
  )
  const [toId, setToId] = useState<string | null>(initial?.to_store_id ?? null)
  const [date, setDate] = useState<string | null>(initial?.transfer_date ?? today)
  const [notes, setNotes] = useState(initial?.notes ?? '')
  const [lines, setLines] = useState<TransferLineState[]>(() =>
    (initial?.lines ?? []).map((l) => {
      const { product, batch } = fromDocumentLine(l)
      return {
        key: l.id,
        product,
        batch,
        qty_milli: l.qty_milli,
        available_milli: l.available_qty_milli,
      }
    }),
  )
  const [errors, setErrors] = useState<LineErrors>({})
  const [storeError, setStoreError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)
  const createKey = useRef(newId())
  const dispatchKey = useRef(newId())
  /**
   * The transfer as last saved by this editor: a retry after a failed dispatch (e.g. not enough
   * stock at the source) updates the draft just created instead of creating it again, with the
   * latest updated_at (no IDEMPOTENCY_MISMATCH / STALE_WRITE).
   */
  const saved = useRef<StockTransferDetail | undefined>(initial)
  const { allowLeave } = useUnsavedGuard(dirty && !busy)

  const stores = useRouteQuery(
    identityRoutes.listStores,
    { query: { is_active: true, limit: 200 } },
    { staleTime: 5 * 60_000, meta: { errorToast: false } },
  )
  const me = useMe()
  // Every store of the business (GET /stores); the member's own stores from /me as a fallback.
  const destinations = useMemo(() => {
    const all = new Map<
      string,
      { id: string; code: string; name: string; name_ta: string | null }
    >()
    for (const s of stores.data?.data ?? []) if (s.is_active) all.set(s.id, s)
    for (const s of me?.stores ?? []) if (s.is_active && !all.has(s.id)) all.set(s.id, s)
    return [...all.values()]
      .filter((s) => s.id !== fromId)
      .sort((a, b) => a.code.localeCompare(b.code))
  }, [stores.data, me, fromId])

  const create = useRouteMutation(inventoryRoutes.createTransfer, { onError: () => {} })
  const update = useRouteMutation(inventoryRoutes.updateTransfer, { onError: () => {} })
  const dispatch = useRouteMutation(inventoryRoutes.dispatchTransfer, {
    invalidates: STOCK_ROUTES,
    onError: () => {},
  })
  const cancel = useRouteMutation(inventoryRoutes.cancelTransfer, {
    invalidates: [inventoryRoutes.listTransfers],
    onError: () => {},
  })

  const prefillLoaded = useRef(false)
  useEffect(() => {
    if (!prefill || prefillLoaded.current || !prefill.product_ids.length) return
    prefillLoaded.current = true
    const store = fromId
    callRoute(catalogRoutes.listProducts, {
      query: { ids: prefill.product_ids, limit: 200, ...(store ? { store_id: store } : {}) },
    })
      .then((res) => {
        setLines((ls) => [
          ...ls,
          ...res.data
            .filter((p) => p.track_inventory)
            .map((p) => ({
              key: lineKey(),
              product: fromListItem(p),
              batch: null,
              qty_milli: null,
              available_milli: p.track_batches ? null : p.stock_qty_milli,
            })),
        ])
        if (res.data.length) setDirty(true)
      })
      .catch((e: unknown) => notify.error(e))
  }, [prefill, fromId])

  const touch = (): void => setDirty(true)
  const change = (key: string, patch: Partial<TransferLineState>): void => {
    touch()
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))
    setErrors((e) => {
      if (!e[key]) return e
      const next = { ...e }
      delete next[key]
      return next
    })
  }

  const addProduct = (p: ProductListItem): void => {
    touch()
    if (!p.track_batches) {
      const existing = lines.find((l) => l.product.id === p.id)
      if (existing) {
        focusLater(`tr-qty-${existing.key}`)
        return
      }
    }
    const line: TransferLineState = {
      key: lineKey(),
      product: fromListItem(p),
      batch: null,
      qty_milli: null,
      available_milli: p.track_batches ? null : p.stock_qty_milli,
    }
    setLines((ls) => [...ls, line])
    if (!p.track_batches) focusLater(`tr-qty-${line.key}`)
  }

  const total = lines.reduce(
    (s, l) =>
      s +
      (l.qty_milli ? stockValuePaise(l.product.cost_paise, l.qty_milli, l.product.pack_size) : 0),
    0,
  )

  const validate = (): TransferCreate | null => {
    const next: LineErrors = {}
    const seen = new Set<string>()
    for (const l of lines) {
      const e: LineErrors[string] = {}
      if (l.product.track_batches && !l.batch) e.batch = t('inventory:errors.batch_required')
      if (!l.qty_milli) e.qty = t('inventory:validation.qty_delta_required')
      const id = lineIdentity(l.product.id, l.batch?.id ?? null)
      if (seen.has(id)) e.product = validationText('duplicate_line')
      seen.add(id)
      if (Object.keys(e).length) next[l.key] = e
    }
    setErrors(next)
    setStoreError(null)
    if (!fromId || !toId) {
      setStoreError(t('transfers.stores_required'))
      return null
    }
    const body: TransferCreate = {
      from_store_id: fromId,
      to_store_id: toId,
      ...(date ? { transfer_date: date } : {}),
      notes: notes.trim() || null,
      lines: lines.map((l) => ({
        product_id: l.product.id,
        batch_id: l.batch?.id ?? null,
        qty_milli: l.qty_milli ?? 0,
      })),
    }
    const parsed = TransferCreateSchema.safeParse(body)
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        if (issue.path[0] === 'to_store_id')
          setStoreError(validationText(issue.message) ?? issue.message)
        if (issue.path[0] === 'lines' && typeof issue.path[1] === 'number') {
          const line = lines[issue.path[1]]
          if (line)
            next[line.key] = {
              ...next[line.key],
              product: next[line.key]?.product ?? validationText(issue.message),
            }
        }
        if (issue.path[0] === 'lines' && issue.path.length === 1)
          notify.warning(t('transfers.no_lines'))
      }
      setErrors({ ...next })
    }
    if (Object.keys(next).length > 0) {
      notify.warning(t('lines.fix_errors'))
      return null
    }
    return parsed.success ? body : null
  }

  const save = async (mode: 'draft' | 'dispatch'): Promise<void> => {
    if (lines.length === 0) {
      notify.warning(t('transfers.no_lines'))
      return
    }
    const body = validate()
    if (!body) return
    if (mode === 'dispatch') {
      const known = [...destinations, ...(me?.stores ?? [])]
      const from = known.find((s) => s.id === body.from_store_id)
      const to = known.find((s) => s.id === body.to_store_id)
      const ok = await confirm({
        title: t('transfers.confirm_dispatch_title'),
        description: t('transfers.confirm_dispatch_description', {
          count: body.lines.length,
          from: from ? `${from.code} · ${localizedName(from.name, from.name_ta)}` : '',
          to: to ? `${to.code} · ${localizedName(to.name, to.name_ta)}` : '',
          amount: formatMoney(total),
        }),
        confirmLabel: t('transfers.dispatch'),
      })
      if (!ok) return
    }
    setBusy(true)
    try {
      let doc: StockTransferDetail
      const current = saved.current
      if (current) {
        doc = (
          await update.mutateAsync({
            params: { id: current.id },
            body: { ...body, if_updated_at: current.updated_at },
          })
        ).data
      } else {
        doc = (await create.mutateAsync({ body, idempotencyKey: createKey.current })).data
      }
      saved.current = doc
      if (mode === 'dispatch') {
        doc = (
          await dispatch.mutateAsync({
            params: { id: doc.id },
            idempotencyKey: dispatchKey.current,
          })
        ).data
        notify.success(t('transfers.dispatched', { number: doc.number ?? '' }))
      } else {
        notify.success(t('transfers.saved'))
      }
      queryClient.setQueryData(
        routeQueryKey(inventoryRoutes.getTransfer, { params: { id: doc.id } }),
        {
          data: doc,
        },
      )
      setDirty(false)
      allowLeave()
      navigate(`/inventory/transfers/${doc.id}`, { replace: true })
    } catch (error) {
      if (isApiError(error) && error.code === 'STALE_WRITE') notify.warning(t('transfers.stale'))
      else
        notifyInventoryError(error, {
          unitOf: (id) => lines.find((l) => l.product.id === id)?.product.unit,
        })
      dispatchKey.current = newId()
    } finally {
      setBusy(false)
    }
  }

  useHotkeyScope(INVENTORY_HOTKEY_SCOPE)
  useHotkeys(
    {
      'mod+s': () => void save('draft'),
      'mod+enter': () => void save('dispatch'),
    },
    { scope: INVENTORY_HOTKEY_SCOPE, allowInInputs: true, enabled: !busy },
  )

  return (
    <div>
      <PageHeader
        title={initial ? t('transfers.draft_title') : t('transfers.new_title')}
        description={t('transfers.editor_description')}
        backTo="/inventory/transfers"
        meta={initial ? <Badge tone="neutral">{t('common:status.draft')}</Badge> : undefined}
        actions={
          initial ? (
            <Button variant="ghost" leftIcon={<Ban />} onClick={() => setCancelOpen(true)}>
              {t('transfers.cancel_draft')}
            </Button>
          ) : undefined
        }
      />

      <div className="grid grid-cols-1 gap-4">
        <Card className="grid grid-cols-1 gap-4 p-4">
          <div className="grid items-end gap-3 md:grid-cols-[1fr_auto_1fr_12rem]">
            <FormField label={t('transfers.from_store')} required>
              <StorePicker
                value={fromId}
                clearable={false}
                disabled={lines.length > 0}
                onChange={(id) => {
                  touch()
                  setFromId(id)
                  if (id === toId) setToId(null)
                }}
              />
            </FormField>
            <ArrowRight
              className="mb-2.5 hidden size-5 text-muted-foreground md:block"
              aria-hidden
            />
            <FormField label={t('transfers.to_store')} required error={storeError}>
              <Select
                value={toId}
                placeholder={t('transfers.choose_destination')}
                onValueChange={(id) => {
                  touch()
                  setToId(id)
                  setStoreError(null)
                }}
                options={destinations.map((s) => ({
                  value: s.id,
                  label: `${s.code} · ${i18n.language === 'ta' && s.name_ta ? s.name_ta : s.name}`,
                }))}
              />
            </FormField>
            <FormField label={t('transfers.date')}>
              <DatePicker
                value={date}
                max={today}
                onChange={(d) => {
                  touch()
                  setDate(d)
                }}
              />
            </FormField>
          </div>
          {!stores.isPending && destinations.length === 0 ? (
            <p className="text-sm text-warning">{t('transfers.no_destinations')}</p>
          ) : null}
        </Card>

        <Card className="grid grid-cols-1 gap-3 p-4">
          <ProductAdder id={ADDER_ID} storeId={fromId} onPick={addProduct} disabled={!fromId} />
          {lines.length === 0 ? (
            <EmptyState
              compact
              icon={<Truck />}
              title={t('transfers.empty_lines')}
              description={t('transfers.empty_lines_hint')}
            />
          ) : (
            <div className="grid grid-cols-1 gap-2">
              <div
                aria-hidden
                className={cn(
                  'hidden gap-2 px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground md:grid',
                  COLS,
                )}
              >
                <span>{t('lines.product')}</span>
                <span className="text-end">{t('transfers.available')}</span>
                <span>{t('transfers.qty_to_send')}</span>
                <span className="text-end">{t('lines.value')}</span>
                <span />
              </div>
              <ul className="grid grid-cols-1 gap-2" aria-label={t('lines.list_label')}>
                {lines.map((l, index) => {
                  const e = errors[l.key] ?? {}
                  const over =
                    l.qty_milli !== null &&
                    l.available_milli !== null &&
                    l.qty_milli > l.available_milli
                  const n = index + 1
                  return (
                    <li
                      key={l.key}
                      className={cn(
                        'grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg border border-border bg-surface p-3 md:items-center md:gap-2 md:px-2 md:py-1.5',
                        COLS,
                        Object.keys(e).length > 0 && 'border-danger',
                      )}
                    >
                      <div className="col-span-2 grid min-w-0 grid-cols-1 gap-1.5 md:col-span-1">
                        <div className="flex items-start justify-between gap-2">
                          <ProductName
                            name={l.product.name}
                            nameTa={l.product.name_ta}
                            sku={l.product.sku}
                          />
                          <IconButton
                            icon={<Trash2 />}
                            label={t('lines.remove_line', { n })}
                            variant="ghost"
                            size="sm"
                            className="md:hidden"
                            onClick={() => {
                              touch()
                              setLines((ls) => ls.filter((x) => x.key !== l.key))
                            }}
                          />
                        </div>
                        {l.product.track_batches ? (
                          <BatchPicker
                            aria-label={t('lines.batch_of', { n })}
                            size="sm"
                            productId={l.product.id}
                            storeId={fromId}
                            value={l.batch?.id ?? null}
                            onChange={(_, b) =>
                              change(l.key, {
                                batch: b
                                  ? { id: b.id, batch_no: b.batch_no, expiry_date: b.expiry_date }
                                  : null,
                                available_milli: b ? b.qty_milli : null,
                              })
                            }
                          />
                        ) : null}
                        {e.batch ? <span className="text-xs text-danger">{e.batch}</span> : null}
                        {e.product ? (
                          <span className="text-xs text-danger">{e.product}</span>
                        ) : null}
                      </div>
                      <div className="grid grid-cols-1 gap-1 md:block md:text-end">
                        <span aria-hidden className="text-xs text-muted-foreground md:hidden">
                          {t('transfers.available')}
                        </span>
                        <Qty
                          milli={l.available_milli}
                          unit={l.product.unit}
                          packSize={l.product.pack_size}
                          packUnit={packUnitFor(l.product.unit)}
                          colorize
                          className="text-sm"
                        />
                      </div>
                      <div className="grid grid-cols-1 gap-1">
                        <QtyInput
                          id={`tr-qty-${l.key}`}
                          aria-label={t('lines.qty_of', { n })}
                          unit={l.product.unit}
                          value={l.qty_milli}
                          steppers={false}
                          aria-invalid={e.qty ? true : undefined}
                          onChange={(v) => change(l.key, { qty_milli: v })}
                          onKeyDown={(ev) => {
                            if (ev.key === 'Enter' && !ev.ctrlKey && !ev.metaKey) {
                              ev.preventDefault()
                              focusLater(ADDER_ID)
                            }
                          }}
                        />
                        {e.qty ? <span className="text-xs text-danger">{e.qty}</span> : null}
                        {over ? (
                          <span className="text-xs text-warning">
                            {t('transfers.more_than_stock')}
                          </span>
                        ) : null}
                      </div>
                      <div className="text-end text-sm">
                        <Money
                          paise={
                            l.qty_milli
                              ? stockValuePaise(
                                  l.product.cost_paise,
                                  l.qty_milli,
                                  l.product.pack_size,
                                )
                              : null
                          }
                        />
                      </div>
                      <IconButton
                        icon={<Trash2 />}
                        label={t('lines.remove_line', { n })}
                        variant="ghost"
                        className="hidden md:inline-flex"
                        onClick={() => {
                          touch()
                          setLines((ls) => ls.filter((x) => x.key !== l.key))
                        }}
                      />
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
        </Card>

        <FormField label={t('common:fields.notes')} optional>
          <Input
            value={notes}
            maxLength={1000}
            placeholder={t('transfers.notes_placeholder')}
            onChange={(e) => {
              touch()
              setNotes(e.target.value)
            }}
          />
        </FormField>

        <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-card sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm text-muted-foreground">
            {t('transfers.summary', { count: lines.length })}{' '}
            <Money paise={total} className="font-semibold text-foreground" />
            <span className="block text-xs">{t('transfers.value_note')}</span>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:flex">
            <Button
              variant="outline"
              leftIcon={<Save />}
              loading={busy && !dispatch.isPending}
              disabled={busy}
              onClick={() => void save('draft')}
            >
              {t('transfers.save_draft')}
            </Button>
            <Button
              leftIcon={<Truck />}
              loading={dispatch.isPending}
              disabled={busy || lines.length === 0}
              onClick={() => void save('dispatch')}
            >
              {t('transfers.dispatch')}
              <Kbd
                aria-hidden
                combo="mod+enter"
                className="ms-1 hidden border-primary-foreground/30 bg-primary-foreground/15 text-primary-foreground lg:inline-flex"
              />
            </Button>
          </div>
        </div>
      </div>

      {initial ? (
        <ReasonDialog
          open={cancelOpen}
          onOpenChange={setCancelOpen}
          title={t('transfers.cancel_title')}
          description={t('transfers.cancel_draft_description')}
          confirmLabel={t('transfers.cancel_draft')}
          onConfirm={async (reason) => {
            try {
              await cancel.mutateAsync({ params: { id: initial.id }, body: { reason } })
              notify.success(t('transfers.cancelled'))
              setDirty(false)
              allowLeave()
              navigate('/inventory/transfers', { replace: true })
            } catch (error) {
              notifyInventoryError(error)
              throw error
            }
          }}
        />
      ) : null}
    </div>
  )
}
