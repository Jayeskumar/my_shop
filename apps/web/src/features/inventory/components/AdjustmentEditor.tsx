/**
 * Adjustment editor (/inventory/adjustments/new and drafts at /inventory/adjustments/:id):
 * kind (adjustment, stock take, damage, expiry write-off), store, date and notes; lines added by
 * scanning / searching (batch picker for batch-tracked items); stock-take mode with a
 * "system vs counted" grid, loading a whole category to count, scan-to-count (each scan of the
 * same item adds one) and difference highlighting; reason per line and a value-impact summary.
 * Save as draft (POST / PATCH) or post with confirmation (then POST …/post). Opened from other
 * pages with ?kind=&store_id=&batch_ids=&product_ids= (parseInventoryPrefill).
 */
import { catalogRoutes, type ProductListItem } from '@kadai/shared/api/catalog'
import {
  ADJUSTMENT_KIND_LABELS,
  type EditableAdjustmentKind,
  EditableAdjustmentKindSchema,
  type StockAdjustmentDetail,
  inventoryRoutes,
  parseInventoryPrefill,
} from '@kadai/shared/api/inventory'
import { newId } from '@kadai/shared/ids'
import {
  CalendarX2,
  ClipboardCheck,
  FolderDown,
  PackageX,
  Save,
  Send,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react'
import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate } from 'react-router'
import { CategoryPicker, StorePicker } from '@/components/pickers'
import {
  Badge,
  Button,
  Card,
  DatePicker,
  EmptyState,
  FormField,
  Input,
  Kbd,
  Money,
  PageHeader,
  RadioGroup,
  SearchInput,
  notify,
  useConfirm,
} from '@/components/ui'
import { callRoute, isApiError } from '@/lib/api'
import { useCan } from '@/lib/auth'
import { formatMoney } from '@/lib/format'
import { routeQueryKey, useRouteMutation } from '@/lib/query'
import {
  type AdjLine,
  type AdjLineErrors,
  editorIssues,
  estimateSummary,
  isLossOnly,
  lineDelta,
  linesForKind,
  linesPayload,
  uncountedLines,
} from '../lib/adjustment-form'
import { useDefaultStoreId, useToday } from '../lib/access'
import { notifyInventoryError } from '../lib/errors'
import { STOCK_ROUTES } from '../lib/invalidate'
import { INVENTORY_HOTKEY_SCOPE, defaultReasonFor, pickLabel } from '../lib/labels'
import {
  type LineBatch,
  type LineProduct,
  ONE_UNIT_MILLI,
  focusLater,
  fromBatchRow,
  fromDocumentLine,
  fromListItem,
  fromStockRow,
  lineKey,
} from '../lib/lines'
import { useUnsavedGuard } from '../lib/use-unsaved-guard'
import { useHotkeyScope, useHotkeys } from '@/lib/hotkeys'
import { ADJ_ADDER_ID, AdjustmentLines } from './AdjustmentLines'
import { FilterChips } from './FilterChips'
import { ProductAdder } from './ProductAdder'

const KIND_ICONS: Record<EditableAdjustmentKind, ReactElement> = {
  adjustment: <SlidersHorizontal />,
  stock_take: <ClipboardCheck />,
  damage: <PackageX />,
  expiry_writeoff: <CalendarX2 />,
}

/** Lines one "load items" fetches at most (the contract allows 2000 per document). */
const LOAD_LIMIT = 2000
const LOAD_PAGE = 200

function newAdjLine(
  kind: EditableAdjustmentKind,
  product: LineProduct,
  batch: LineBatch | null,
  over: Partial<AdjLine> = {},
): AdjLine {
  return {
    key: lineKey(),
    product,
    batch,
    direction: isLossOnly(kind) ? -1 : 1,
    qty_milli: null,
    counted_milli: null,
    system_milli: null,
    unit_cost_paise: null,
    reason: defaultReasonFor(kind),
    ...over,
  }
}

function linesFromDocument(doc: StockAdjustmentDetail, kind: EditableAdjustmentKind): AdjLine[] {
  return doc.lines.map((l) => {
    const { product, batch } = fromDocumentLine(l)
    return {
      key: l.id,
      product,
      batch,
      direction: l.qty_delta_milli < 0 || isLossOnly(kind) ? -1 : 1,
      qty_milli: kind === 'stock_take' ? null : Math.abs(l.qty_delta_milli) || null,
      counted_milli: l.counted_qty_milli,
      system_milli: l.current_qty_milli,
      unit_cost_paise: null,
      reason: l.reason,
    }
  })
}

type TakeView = 'all' | 'uncounted' | 'diff'

export function AdjustmentEditor({ initial }: { initial?: StockAdjustmentDetail }) {
  const { t, i18n } = useTranslation(['inventory', 'common'])
  const navigate = useNavigate()
  const location = useLocation()
  const confirm = useConfirm()
  const queryClient = useQueryClient()
  const today = useToday()
  const defaultStore = useDefaultStoreId()
  const canCatalog = useCan('catalog.read')
  const prefill = useMemo(
    () => (initial ? null : parseInventoryPrefill(location.search)),
    // The prefill is read once, when the editor opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  const initialKind: EditableAdjustmentKind = initial
    ? (EditableAdjustmentKindSchema.safeParse(initial.kind).data ?? 'adjustment')
    : (prefill?.kind ?? 'adjustment')

  const [kind, setKind] = useState<EditableAdjustmentKind>(initialKind)
  const [storeId, setStoreId] = useState<string | null>(
    initial?.store_id ?? prefill?.store_id ?? defaultStore,
  )
  const [date, setDate] = useState<string | null>(initial?.adjustment_date ?? today)
  const [notes, setNotes] = useState(initial?.notes ?? '')
  const [lines, setLines] = useState<AdjLine[]>(() =>
    initial ? linesFromDocument(initial, initialKind) : [],
  )
  const [errors, setErrors] = useState<AdjLineErrors>({})
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [prefilling, setPrefilling] = useState(false)
  const [flashKey, setFlashKey] = useState<string | null>(null)
  const [view, setView] = useState<TakeView>('all')
  const [filterText, setFilterText] = useState('')
  const [loadCategory, setLoadCategory] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const createKey = useRef(newId())
  const postKey = useRef(newId())
  const { allowLeave } = useUnsavedGuard(dirty && !busy)

  const create = useRouteMutation(inventoryRoutes.createAdjustment, { onError: () => {} })
  const update = useRouteMutation(inventoryRoutes.updateAdjustment, { onError: () => {} })
  const post = useRouteMutation(inventoryRoutes.postAdjustment, {
    invalidates: STOCK_ROUTES,
    onError: () => {},
  })
  const remove = useRouteMutation(inventoryRoutes.deleteAdjustment, {
    invalidates: [inventoryRoutes.listAdjustments],
  })

  // Prefilled lines (?batch_ids= / ?product_ids=), loaded once for a new document.
  const prefillLoaded = useRef(false)
  useEffect(() => {
    if (!prefill || prefillLoaded.current) return
    prefillLoaded.current = true
    if (prefill.batch_ids.length === 0 && prefill.product_ids.length === 0) return
    const store = prefill.store_id ?? defaultStore
    const storeQuery = store ? { store_id: store } : {}
    setPrefilling(true)
    const load = async (): Promise<AdjLine[]> => {
      const out: AdjLine[] = []
      if (prefill.batch_ids.length) {
        const res = await callRoute(inventoryRoutes.listBatches, {
          query: { ids: prefill.batch_ids, limit: 200, ...storeQuery },
        })
        for (const b of res.data) {
          const { product, batch } = fromBatchRow(b)
          out.push(
            newAdjLine(initialKind, product, batch, {
              system_milli: b.qty_milli,
              // Writing off a batch usually means all of it.
              qty_milli: isLossOnly(initialKind) && b.qty_milli > 0 ? b.qty_milli : null,
            }),
          )
        }
      }
      const covered = new Set(out.map((l) => l.product.id))
      const rest = prefill.product_ids.filter((id) => !covered.has(id))
      if (rest.length && canCatalog) {
        const res = await callRoute(catalogRoutes.listProducts, {
          query: { ids: rest, limit: 200, ...storeQuery },
        })
        for (const p of res.data)
          out.push(
            newAdjLine(initialKind, fromListItem(p), null, {
              system_milli: p.track_batches ? null : p.stock_qty_milli,
            }),
          )
      }
      return out
    }
    load()
      .then((out) => {
        setLines((ls) => [...ls, ...out])
        if (out.length) setDirty(true)
      })
      .catch((e: unknown) => notify.error(e))
      .finally(() => setPrefilling(false))
  }, [prefill, defaultStore, initialKind, canCatalog])

  useEffect(() => {
    if (!flashKey) return
    const timer = setTimeout(() => setFlashKey(null), 1200)
    return () => clearTimeout(timer)
  }, [flashKey])

  const touch = (): void => setDirty(true)

  const changeLine = (key: string, patch: Partial<AdjLine>): void => {
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
    const product = fromListItem(p)
    if (!p.track_batches) {
      const existing = lines.find((l) => l.product.id === p.id && !l.batch)
      if (existing) {
        if (kind === 'stock_take') {
          changeLine(existing.key, {
            counted_milli: (existing.counted_milli ?? 0) + ONE_UNIT_MILLI,
          })
          setFlashKey(existing.key)
        } else {
          setFlashKey(existing.key)
          focusLater(`adj-qty-${existing.key}`)
        }
        return
      }
    }
    const line = newAdjLine(kind, product, null, {
      system_milli: p.track_batches ? null : p.stock_qty_milli,
      ...(kind === 'stock_take' && !p.track_batches ? { counted_milli: ONE_UNIT_MILLI } : {}),
    })
    setLines((ls) => [...ls, line])
    setFlashKey(line.key)
    if (kind !== 'stock_take' && !p.track_batches) focusLater(`adj-qty-${line.key}`)
  }

  const loadItems = async (): Promise<void> => {
    if (!storeId) {
      notify.warning(t('lines.store_required'))
      return
    }
    setLoading(true)
    try {
      const existing = new Set(lines.map((l) => `${l.product.id}:${l.batch?.id ?? '-'}`))
      const added: AdjLine[] = []
      for (let offset = 0; offset < LOAD_LIMIT; offset += LOAD_PAGE) {
        const res = await callRoute(inventoryRoutes.listStock, {
          query: {
            store_id: storeId,
            group: 'batch',
            sort: 'name',
            limit: LOAD_PAGE,
            offset,
            ...(loadCategory ? { category_id: loadCategory } : {}),
          },
        })
        for (const row of res.data) {
          const { product, batch } = fromStockRow(row)
          const id = `${product.id}:${batch?.id ?? '-'}`
          if (existing.has(id)) continue
          existing.add(id)
          added.push(newAdjLine('stock_take', product, batch, { system_milli: row.qty_milli }))
        }
        if (res.data.length < LOAD_PAGE || offset + LOAD_PAGE >= res.page.total) break
      }
      const room = LOAD_LIMIT - lines.length
      setLines((ls) => [...ls, ...added.slice(0, Math.max(0, room))])
      if (added.length) touch()
      notify.success(t('stock_take.loaded', { count: Math.min(added.length, room) }))
      if (added.length > room) notify.warning(t('stock_take.too_many', { max: LOAD_LIMIT }))
    } catch (error) {
      notify.error(error)
    } finally {
      setLoading(false)
    }
  }

  const summary = useMemo(() => estimateSummary(kind, lines), [kind, lines])
  const uncounted = useMemo(() => uncountedLines(kind, lines), [kind, lines])
  const differences = useMemo(
    () => lines.filter((l) => (lineDelta(kind, l) ?? 0) !== 0).length,
    [kind, lines],
  )

  const visibleLines = useMemo(() => {
    const q = filterText.trim().toLowerCase()
    return lines.filter((l) => {
      if (kind === 'stock_take' && view === 'uncounted' && l.counted_milli !== null) return false
      if (kind === 'stock_take' && view === 'diff' && (lineDelta(kind, l) ?? 0) === 0) return false
      if (!q) return true
      return [l.product.name, l.product.name_ta, l.product.sku, l.batch?.batch_no]
        .filter(Boolean)
        .some((v) => v!.toLowerCase().includes(q))
    })
  }, [lines, kind, view, filterText])

  const sentLines = (): AdjLine[] =>
    kind === 'stock_take' ? lines.filter((l) => l.counted_milli !== null) : lines

  /** Server VALIDATION_ERROR paths (lines.N.field) back onto the editor lines. */
  const applyServerIssues = (error: unknown): boolean => {
    if (!isApiError(error) || error.code !== 'VALIDATION_ERROR') return false
    const sent = sentLines()
    const next: AdjLineErrors = {}
    for (const issue of error.validationIssues) {
      const [root, index, field] = issue.path.split('.')
      const line = root === 'lines' ? sent[Number(index)] : undefined
      if (!line) continue
      const target =
        field === 'counted_qty_milli'
          ? 'counted'
          : field === 'qty_delta_milli'
            ? 'qty'
            : field === 'batch_id'
              ? 'batch'
              : 'product'
      next[line.key] = {
        ...next[line.key],
        [target]: issue.message as AdjLineErrors[string]['product'],
      }
    }
    setErrors(next)
    return Object.keys(next).length > 0
  }

  const save = async (mode: 'draft' | 'post'): Promise<void> => {
    const issues = editorIssues(kind, lines)
    setErrors(issues)
    if (!storeId) {
      notify.warning(t('lines.store_required'))
      return
    }
    if (Object.keys(issues).length > 0) {
      notify.warning(t('lines.fix_errors'))
      return
    }
    const payload = linesPayload(kind, lines)
    if (mode === 'post' && payload.length === 0) {
      notify.warning(t('adjustments.nothing_to_post'))
      return
    }
    if (mode === 'post') {
      const ok = await confirm({
        title: t('adjustments.confirm_post_title', {
          kind: pickLabel(ADJUSTMENT_KIND_LABELS[kind], i18n.language),
        }),
        description: [
          t('adjustments.confirm_post_lines', { count: payload.length }),
          summary.gain_paise
            ? t('adjustments.confirm_gain', { amount: formatMoney(summary.gain_paise) })
            : '',
          summary.loss_paise
            ? t('adjustments.confirm_loss', { amount: formatMoney(summary.loss_paise) })
            : '',
          uncounted.length ? t('stock_take.uncounted_kept', { count: uncounted.length }) : '',
          t('adjustments.confirm_post_final'),
        ]
          .filter(Boolean)
          .join(' '),
        confirmLabel: t('adjustments.post'),
        tone: summary.loss_paise > 0 ? 'danger' : 'primary',
      })
      if (!ok) return
    } else if (uncounted.length > 0) {
      const ok = await confirm({
        title: t('stock_take.save_uncounted_title', { count: uncounted.length }),
        description: t('stock_take.save_uncounted_description'),
        confirmLabel: t('adjustments.save_draft'),
      })
      if (!ok) return
    }
    setBusy(true)
    try {
      const header = {
        store_id: storeId,
        kind,
        ...(date ? { adjustment_date: date } : {}),
        notes: notes.trim() || null,
        lines: payload,
      }
      let doc: StockAdjustmentDetail
      if (initial) {
        doc = (
          await update.mutateAsync({
            params: { id: initial.id },
            body: { ...header, if_updated_at: initial.updated_at },
          })
        ).data
      } else {
        doc = (await create.mutateAsync({ body: header, idempotencyKey: createKey.current })).data
      }
      if (mode === 'post') {
        doc = (await post.mutateAsync({ params: { id: doc.id }, idempotencyKey: postKey.current }))
          .data
        notify.success(t('adjustments.posted', { number: doc.number ?? '' }))
      } else {
        notify.success(t('adjustments.saved'))
      }
      queryClient.setQueryData(
        routeQueryKey(inventoryRoutes.getAdjustment, { params: { id: doc.id } }),
        { data: doc },
      )
      setDirty(false)
      allowLeave()
      navigate(`/inventory/adjustments/${doc.id}`, { replace: true })
    } catch (error) {
      if (isApiError(error) && error.code === 'STALE_WRITE') {
        notify.warning(t('adjustments.stale'))
      } else {
        applyServerIssues(error)
        notifyInventoryError(error)
      }
      postKey.current = newId()
    } finally {
      setBusy(false)
    }
  }

  const deleteDraft = async (): Promise<void> => {
    if (!initial) return
    const ok = await confirm({
      title: t('adjustments.delete_title'),
      description: t('adjustments.delete_description'),
      confirmLabel: t('common:actions.delete'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await remove.mutateAsync({ params: { id: initial.id } })
      notify.success(t('adjustments.deleted'))
      setDirty(false)
      allowLeave()
      navigate('/inventory/adjustments', { replace: true })
    } catch (error) {
      notifyInventoryError(error)
    }
  }

  const kindOptions = EditableAdjustmentKindSchema.options.map((k) => ({
    value: k,
    label: pickLabel(ADJUSTMENT_KIND_LABELS[k], i18n.language),
    description: t(`adjustments.kind_hint.${k}`),
    icon: KIND_ICONS[k],
  }))

  useHotkeyScope(INVENTORY_HOTKEY_SCOPE)
  useHotkeys(
    {
      'mod+s': () => void save('draft'),
      'mod+enter': () => void save('post'),
    },
    { scope: INVENTORY_HOTKEY_SCOPE, allowInInputs: true, enabled: !busy },
  )

  return (
    <div>
      <PageHeader
        title={initial ? t('adjustments.draft_title') : t('adjustments.new_title')}
        description={t('adjustments.editor_description')}
        backTo="/inventory/adjustments"
        meta={initial ? <Badge tone="neutral">{t('common:status.draft')}</Badge> : undefined}
        actions={
          initial ? (
            <Button variant="ghost" leftIcon={<Trash2 />} onClick={() => void deleteDraft()}>
              {t('adjustments.delete_draft')}
            </Button>
          ) : undefined
        }
      />

      <div className="grid grid-cols-1 gap-4">
        <div className="grid min-w-0 grid-cols-1 gap-4">
          <Card className="grid grid-cols-1 gap-4 p-4">
            <RadioGroup
              aria-label={t('adjustments.kind_label')}
              variant="cards"
              value={kind}
              onValueChange={(k) => {
                touch()
                setKind(k)
                setLines((ls) => linesForKind(k, ls))
                setErrors({})
              }}
              options={kindOptions}
              className="grid-cols-1 sm:grid-cols-2 2xl:grid-cols-4"
            />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
              <FormField label={t('common:fields.store')} required>
                <StorePicker
                  value={storeId}
                  clearable={false}
                  disabled={lines.length > 0}
                  onChange={(id) => {
                    touch()
                    setStoreId(id)
                  }}
                />
              </FormField>
              <FormField label={t('adjustments.date')}>
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
            {lines.length > 0 ? (
              <p className="-mt-2 text-xs text-muted-foreground">{t('adjustments.store_locked')}</p>
            ) : null}
          </Card>

          {kind === 'stock_take' ? (
            <Card className="grid grid-cols-1 gap-3 p-4">
              <div>
                <h2 className="font-semibold">{t('stock_take.load_title')}</h2>
                <p className="text-sm text-muted-foreground">{t('stock_take.load_hint')}</p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                {canCatalog ? (
                  <CategoryPicker
                    aria-label={t('stock.category')}
                    placeholder={t('stock_take.all_categories')}
                    value={loadCategory}
                    onChange={(id) => setLoadCategory(id)}
                    className="sm:max-w-sm"
                  />
                ) : null}
                <Button
                  variant="secondary"
                  leftIcon={<FolderDown />}
                  loading={loading}
                  onClick={() => void loadItems()}
                >
                  {t('stock_take.load')}
                </Button>
              </div>
            </Card>
          ) : null}

          <Card className="grid grid-cols-1 gap-3 p-4">
            <ProductAdder
              id={ADJ_ADDER_ID}
              storeId={storeId}
              onPick={addProduct}
              batchTrackedOnly={kind === 'expiry_writeoff'}
              disabled={!storeId}
            />
            <p className="text-xs text-muted-foreground">
              {kind === 'stock_take' ? t('stock_take.scan_hint') : t('lines.scan_hint')}
            </p>

            {kind === 'stock_take' && lines.length > 0 ? (
              <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                <FilterChips
                  chips={[
                    { key: 'all', label: t('stock_take.view_all'), badge: lines.length },
                    {
                      key: 'uncounted',
                      label: t('stock_take.view_uncounted'),
                      badge: uncounted.length,
                      tone: 'warning',
                    },
                    {
                      key: 'diff',
                      label: t('stock_take.view_diff'),
                      badge: differences,
                      tone: 'danger',
                    },
                  ]}
                  value={view}
                  onChange={setView}
                  label={t('stock_take.view_label')}
                />
                <SearchInput
                  value={filterText}
                  onChange={setFilterText}
                  placeholder={t('stock_take.filter_placeholder')}
                  delay={100}
                  wrapperClassName="md:max-w-xs"
                />
              </div>
            ) : null}

            {kind === 'stock_take' && uncounted.length > 0 ? (
              <div
                role="status"
                className="flex flex-col gap-2 rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning-soft-foreground sm:flex-row sm:items-center sm:justify-between"
              >
                <span>{t('stock_take.uncounted_note', { count: uncounted.length })}</span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    touch()
                    setLines((ls) =>
                      ls.map((l) => (l.counted_milli === null ? { ...l, counted_milli: 0 } : l)),
                    )
                  }}
                >
                  {t('stock_take.mark_zero')}
                </Button>
              </div>
            ) : null}

            {lines.length === 0 ? (
              <EmptyState
                compact
                icon={KIND_ICONS[kind]}
                title={prefilling ? t('common:misc.loading') : t(`adjustments.empty_lines.${kind}`)}
                description={t('adjustments.empty_lines_hint')}
              />
            ) : visibleLines.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t('stock_take.none_in_view')}
              </p>
            ) : (
              <AdjustmentLines
                kind={kind}
                lines={visibleLines}
                errors={errors}
                storeId={storeId}
                flashKey={flashKey}
                onChange={changeLine}
                onRemove={(key) => {
                  touch()
                  setLines((ls) => ls.filter((l) => l.key !== key))
                }}
              />
            )}
          </Card>

          <FormField label={t('common:fields.notes')} optional>
            <Input
              value={notes}
              maxLength={1000}
              placeholder={t('adjustments.notes_placeholder')}
              onChange={(e) => {
                touch()
                setNotes(e.target.value)
              }}
            />
          </FormField>
        </div>

        <aside
          aria-label={t('adjustments.summary_label')}
          className="sticky bottom-[calc(4rem+env(safe-area-inset-bottom))] z-20 -mx-4 border-t border-border bg-surface/95 px-4 py-3 shadow-overlay backdrop-blur sm:mx-0 sm:rounded-xl sm:border md:bottom-3"
        >
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <dl className="grid grid-cols-3 gap-3 text-sm sm:flex sm:gap-6">
              <div>
                <dt className="text-xs text-muted-foreground">{t('adjustments.gain')}</dt>
                <dd className="font-semibold text-success">
                  <Money paise={summary.gain_paise} />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t('adjustments.loss')}</dt>
                <dd className="font-semibold text-danger">
                  <Money paise={summary.loss_paise} />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t('adjustments.net')}</dt>
                <dd className="font-bold">
                  <Money paise={summary.net_paise} colorize />
                </dd>
              </div>
              <p className="hidden max-w-sm self-center text-xs text-muted-foreground xl:block">
                {t('adjustments.estimate_note')}{' '}
                {summary.loss_paise > 0 ? t(`adjustments.account.${summary.loss_account}`) : null}
              </p>
            </dl>
            <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
              <Button
                variant="outline"
                leftIcon={<Save />}
                loading={busy && !post.isPending}
                disabled={busy || (!dirty && Boolean(initial))}
                onClick={() => void save('draft')}
              >
                {t('adjustments.save_draft')}
              </Button>
              <Button
                leftIcon={<Send />}
                loading={post.isPending}
                disabled={busy || lines.length === 0}
                onClick={() => void save('post')}
              >
                {t('adjustments.post')}
                <Kbd
                  aria-hidden
                  combo="mod+enter"
                  className="ms-1 hidden border-primary-foreground/30 bg-primary-foreground/15 text-primary-foreground lg:inline-flex"
                />
              </Button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
