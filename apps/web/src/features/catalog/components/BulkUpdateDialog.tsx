/**
 * Bulk update of selected products (POST /products/bulk-update): GST rate, price-slab rule,
 * category, brand, active status and a price change (% / ₹ / set, optional rounding, capped at
 * MRP) with a live preview on the selected rows that are loaded.
 */
import {
  type PriceChange,
  type ProductBulkUpdate,
  type ProductListItem,
  ProductBulkUpdateSchema,
  applyPriceChange,
  catalogRoutes,
} from '@kadai/shared/api/catalog'
import type { GstRateBp } from '@kadai/shared/gst'
import { type FormEvent, type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BrandPicker, type BrandPickerValue, CategoryPicker } from '@/components/pickers'
import {
  Button,
  Checkbox,
  Dialog,
  FormField,
  Money,
  NumberInput,
  MoneyInput,
  RadioGroup,
  notify,
} from '@/components/ui'
import { localizedName } from '@/lib/i18n'
import { useRouteMutation } from '@/lib/query'
import { catalogValidationText, firstIssueText } from '../lib/messages'
import { GstRateSelect, SlabRuleSelect } from './TaxInputs'

type FieldKey = 'gst' | 'slab' | 'category' | 'brand' | 'status' | 'price'
type PriceMode = PriceChange['mode']

export interface BulkUpdateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  ids: readonly string[]
  /** Loaded rows among the selection (price preview). */
  rows: readonly ProductListItem[]
  onDone: () => void
}

const FORM_ID = 'catalog-bulk-update'

export function BulkUpdateDialog({ open, onOpenChange, ids, rows, onDone }: BulkUpdateDialogProps) {
  const { t } = useTranslation(['catalog', 'common'])
  const [enabled, setEnabled] = useState<Set<FieldKey>>(new Set())
  const [gst, setGst] = useState<number | null>(null)
  const [slab, setSlab] = useState<string | null>(null)
  const [categoryId, setCategoryId] = useState<string | null>(null)
  const [brand, setBrand] = useState<BrandPickerValue | null>(null)
  const [active, setActive] = useState<'activate' | 'deactivate'>('activate')
  const [mode, setMode] = useState<PriceMode>('percent')
  const [percentBp, setPercentBp] = useState<number | null>(null)
  const [amount, setAmount] = useState<number | null>(null)
  const [setPrice, setSetPrice] = useState<number | null>(null)
  const [round, setRound] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const mutation = useRouteMutation(catalogRoutes.bulkUpdateProducts, {
    invalidates: [catalogRoutes.listProducts],
    onError: (e) => {
      const text = firstIssueText(e)
      if (text) setError(text)
      else notify.error(e)
    },
  })

  const toggle = (key: FieldKey, on: boolean): void => {
    setEnabled((s) => {
      const next = new Set(s)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })
    setError(null)
  }

  const priceChange = useMemo<PriceChange | null>(() => {
    if (mode === 'percent')
      return percentBp === null ? null : { mode, percent_bp: percentBp, round_to_rupee: round }
    if (mode === 'amount')
      return amount === null ? null : { mode, amount_paise: amount, round_to_rupee: round }
    return setPrice === null ? null : { mode, price_paise: setPrice, round_to_rupee: round }
  }, [mode, percentBp, amount, setPrice, round])

  const body = useMemo<ProductBulkUpdate>(() => {
    const set: ProductBulkUpdate['set'] = {}
    if (enabled.has('gst') && gst !== null) set.gst_rate_bp = gst as GstRateBp
    if (enabled.has('slab')) set.tax_slab_rule_id = slab
    if (enabled.has('category')) set.category_id = categoryId
    if (enabled.has('brand')) set.brand_id = brand?.id ?? null
    if (enabled.has('status')) set.is_active = active === 'activate'
    if (enabled.has('price') && priceChange) set.price_change = priceChange
    return { ids: [...ids], set }
  }, [enabled, gst, slab, categoryId, brand, active, priceChange, ids])

  const preview = useMemo(() => {
    if (!enabled.has('price') || !priceChange) return []
    return rows.slice(0, 5).map((r) => ({
      row: r,
      ...applyPriceChange(r.sale_price_paise, priceChange, r.mrp_paise),
    }))
  }, [enabled, priceChange, rows])

  const submit = (e: FormEvent): void => {
    e.preventDefault()
    const parsed = ProductBulkUpdateSchema.safeParse(body)
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message
      setError(catalogValidationText(msg) ?? t('bulk.pick_change'))
      return
    }
    mutation.mutate(
      { body },
      {
        onSuccess: (res) => {
          const r = res.data
          notify.success(t('bulk.done', { count: r.updated }), {
            description:
              [
                r.unchanged ? t('bulk.unchanged', { count: r.unchanged }) : null,
                r.capped_at_mrp ? t('bulk.capped', { count: r.capped_at_mrp }) : null,
              ]
                .filter(Boolean)
                .join(' · ') || undefined,
          })
          onDone()
          onOpenChange(false)
        },
      },
    )
  }

  const row = (key: FieldKey, label: string, control: ReactNode) => (
    <div
      className="grid grid-cols-1 gap-2 rounded-lg border border-border p-3 data-[on=true]:border-primary data-[on=true]:bg-primary-soft/30"
      data-on={enabled.has(key)}
    >
      <Checkbox
        checked={enabled.has(key)}
        onCheckedChange={(v) => toggle(key, v === true)}
        label={label}
      />
      {enabled.has(key) ? <div className="ps-7">{control}</div> : null}
    </div>
  )

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      dismissible={!mutation.isPending}
      title={t('bulk.title', { count: ids.length })}
      description={t('bulk.description')}
      footer={
        <>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
          >
            {t('common:actions.cancel')}
          </Button>
          <Button
            type="submit"
            form={FORM_ID}
            loading={mutation.isPending}
            disabled={enabled.size === 0}
          >
            {t('bulk.apply', { count: ids.length })}
          </Button>
        </>
      }
    >
      <form id={FORM_ID} onSubmit={submit} className="grid grid-cols-1 gap-3" noValidate>
        {row(
          'gst',
          t('bulk.gst'),
          <GstRateSelect value={gst} onChange={setGst} aria-label={t('bulk.gst')} />,
        )}
        {row('slab', t('bulk.slab'), <SlabRuleSelect value={slab} onChange={setSlab} />)}
        {row(
          'category',
          t('bulk.category'),
          <CategoryPicker
            value={categoryId}
            onChange={(id) => setCategoryId(id)}
            aria-label={t('bulk.category')}
            placeholder={t('bulk.no_category')}
          />,
        )}
        {row(
          'brand',
          t('bulk.brand'),
          <BrandPicker
            value={brand}
            onChange={setBrand}
            aria-label={t('bulk.brand')}
            placeholder={t('bulk.no_brand')}
          />,
        )}
        {row(
          'status',
          t('bulk.status'),
          <RadioGroup
            value={active}
            onValueChange={setActive}
            orientation="horizontal"
            className="flex flex-wrap gap-x-5 gap-y-2"
            options={[
              { value: 'activate', label: t('bulk.activate') },
              { value: 'deactivate', label: t('bulk.deactivate') },
            ]}
          />,
        )}
        {row(
          'price',
          t('bulk.price'),
          <div className="grid grid-cols-1 gap-3">
            <RadioGroup
              value={mode}
              onValueChange={setMode}
              orientation="horizontal"
              className="flex flex-wrap gap-x-5 gap-y-2"
              options={[
                { value: 'percent', label: t('bulk.mode_percent') },
                { value: 'amount', label: t('bulk.mode_amount') },
                { value: 'set', label: t('bulk.mode_set') },
              ]}
            />
            {mode === 'percent' ? (
              <FormField label={t('bulk.percent')} hint={t('bulk.percent_hint')}>
                <NumberInput
                  value={percentBp}
                  onChange={setPercentBp}
                  scale={100}
                  decimals={2}
                  allowNegative
                  suffix="%"
                  min={-9999}
                  max={100000}
                />
              </FormField>
            ) : mode === 'amount' ? (
              <FormField label={t('bulk.amount')} hint={t('bulk.amount_hint')}>
                <MoneyInput value={amount} onChange={setAmount} allowNegative />
              </FormField>
            ) : (
              <FormField label={t('bulk.set_price')}>
                <MoneyInput value={setPrice} onChange={setSetPrice} />
              </FormField>
            )}
            <Checkbox
              checked={round}
              onCheckedChange={(v) => setRound(v === true)}
              label={t('bulk.round')}
            />
            {preview.length ? (
              <div className="rounded-md bg-surface-2 p-3 text-sm">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t('bulk.preview')}
                </p>
                <ul className="grid grid-cols-1 gap-1">
                  {preview.map((p) => (
                    <li key={p.row.id} className="flex items-center justify-between gap-3">
                      <span className="truncate">{localizedName(p.row.name, p.row.name_ta)}</span>
                      <span className="flex shrink-0 items-center gap-2 tabular-nums">
                        <Money
                          paise={p.row.sale_price_paise}
                          className="text-muted-foreground line-through"
                        />
                        <Money paise={p.price_paise} className="font-semibold" />
                        {p.capped ? (
                          <span className="text-xs text-warning-soft-foreground">
                            {t('bulk.mrp_cap')}
                          </span>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>,
        )}
        {error ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {error}
          </p>
        ) : null}
      </form>
    </Dialog>
  )
}
