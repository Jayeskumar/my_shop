/**
 * Promotion editor (side panel): kind → kind-specific rules with targeting pickers (products /
 * categories / brands via the shared pickers), schedule (date range + days of week), stores,
 * priority & stacking, and a live Tamil / English explanation with a worked example computed by
 * the shared promotions engine.
 */
import {
  PROMOTION_KIND_LABELS,
  type PromotionResponse,
  catalogRoutes,
} from '@kadai/shared/api/catalog'
import { DEFAULT_TIMEZONE } from '@kadai/shared/fy'
import type { PromotionKind } from '@kadai/shared/promotions'
import { BadgePercent, Gift, Package, Receipt, ShoppingBag, Tags, Trash2 } from 'lucide-react'
import { type FormEvent, type ReactNode, useMemo, useState } from 'react'
import {
  Controller,
  FormProvider,
  useFieldArray,
  useForm,
  useFormContext,
  useWatch,
} from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { ProductPicker, StorePicker } from '@/components/pickers'
import {
  Button,
  DatePicker,
  Drawer,
  IconButton,
  Input,
  MoneyInput,
  NumberInput,
  QtyInput,
  RadioGroup,
  Skeleton,
  Switch,
  notify,
  useConfirm,
} from '@/components/ui'
import { useMe } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { formatMoney } from '@/lib/format'
import { useRouteMutation, useRouteQuery } from '@/lib/query'
import { useBreakpoint } from '@/lib/use-media-query'
import { bilingual } from '../lib/format'
import { catalogReasonText } from '../lib/messages'
import {
  BILL_KINDS,
  ITEM_KINDS,
  type PromotionFormValues,
  defaultPromotionValues,
  promotionExample,
  promotionResolver,
  toPromotionCreate,
  toPromotionUpdate,
  valuesFromPromotion,
} from '../lib/promotion-form'
import { dayShort, promotionText } from '../lib/promotion-text'
import { Field } from './Field'
import { useProductNames } from '../lib/use-product-names'
import { BrandMultiPicker, CategoryMultiPicker, ProductMultiPicker } from './MultiPickers'

const KIND_ICONS: Record<PromotionKind, ReactNode> = {
  item_percent: <BadgePercent />,
  item_flat: <Tags />,
  buy_x_get_y: <Gift />,
  bill_percent: <Receipt />,
  bill_flat: <Receipt />,
  combo_price: <ShoppingBag />,
}

const FORM_ID = 'catalog-promotion-form'

export interface PromotionEditorProps {
  promotionId: string | null
  readOnly: boolean
  onClose: () => void
}

export function PromotionEditor({ promotionId, readOnly, onClose }: PromotionEditorProps) {
  const { t } = useTranslation(['catalog', 'common'])
  const query = useRouteQuery(
    catalogRoutes.getPromotion,
    { params: { id: promotionId ?? '' } },
    { enabled: Boolean(promotionId) },
  )
  const promotion = promotionId ? (query.data?.data ?? null) : null
  const loading = Boolean(promotionId) && query.isPending
  return (
    <Drawer
      open
      onOpenChange={(open) => !open && onClose()}
      title={promotion ? t('promotions.edit_title') : t('promotions.new_title')}
      description={t('promotions.editor_hint')}
      className="w-[min(42rem,100vw)]"
    >
      {loading ? (
        <div className="grid grid-cols-1 gap-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : (
        <EditorForm promotion={promotion} readOnly={readOnly} onClose={onClose} />
      )}
    </Drawer>
  )
}

function EditorForm({
  promotion,
  readOnly,
  onClose,
}: {
  promotion: PromotionResponse | null
  readOnly: boolean
  onClose: () => void
}) {
  const { t } = useTranslation(['catalog', 'common'])
  const me = useMe()
  const confirm = useConfirm()
  const tz = me?.tenant.timezone ?? DEFAULT_TIMEZONE
  const multiStore = (me?.stores.filter((s) => s.is_active).length ?? 0) > 1
  const roomy = useBreakpoint('sm')
  const form = useForm<PromotionFormValues>({
    defaultValues: promotion ? valuesFromPromotion(promotion, tz) : defaultPromotionValues(),
    resolver: promotionResolver(tz),
    mode: 'onTouched',
  })
  const values = useWatch({ control: form.control }) as PromotionFormValues
  const kind = values.kind
  const [saving, setSaving] = useState(false)
  const create = useRouteMutation(catalogRoutes.createPromotion, {
    invalidates: [catalogRoutes.listPromotions],
    meta: { errorToast: false },
  })
  const update = useRouteMutation(catalogRoutes.updatePromotion, {
    invalidates: [catalogRoutes.listPromotions, catalogRoutes.getPromotion],
    meta: { errorToast: false },
  })
  const del = useRouteMutation(catalogRoutes.deletePromotion, {
    invalidates: [catalogRoutes.listPromotions],
  })

  const save = async (v: PromotionFormValues): Promise<void> => {
    setSaving(true)
    try {
      if (promotion) {
        await update.mutateAsync({
          params: { id: promotion.id },
          body: toPromotionUpdate(v, promotion, tz),
        })
        notify.success(t('promotions.saved', { name: v.name }))
      } else {
        await create.mutateAsync({ body: toPromotionCreate(v, tz) })
        notify.success(t('promotions.created', { name: v.name }))
      }
      form.reset(v)
      onClose()
    } catch (error) {
      notify.error(catalogReasonText(error) ?? error)
    } finally {
      setSaving(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!promotion) return
    const ok = await confirm({
      title: t('promotions.delete_title', { name: promotion.name }),
      description: t('promotions.delete_description'),
      tone: 'danger',
      confirmLabel: t('common:actions.delete'),
    })
    if (!ok) return
    del.mutate(
      { params: { id: promotion.id } },
      {
        onSuccess: (res) => {
          notify.success(
            res.data.result === 'deleted'
              ? t('promotions.deleted', { name: promotion.name })
              : t('promotions.switched_off', { name: promotion.name }),
          )
          onClose()
        },
      },
    )
  }

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault()
    if (readOnly) return
    void form.handleSubmit(save, () => notify.error(t('form.fix_errors')))(e)
  }

  const example = useMemo(() => promotionExample(values), [values])
  const summary = useMemo(() => {
    try {
      return promotionText({ kind, rules: toPromotionCreate(values, tz).rules })
    } catch {
      return null
    }
  }, [values, kind, tz])
  const isItem = ITEM_KINDS.includes(kind)
  const isBill = BILL_KINDS.includes(kind)

  return (
    <FormProvider {...form}>
      <form id={FORM_ID} onSubmit={onSubmit} className="grid grid-cols-1 gap-5 pb-2" noValidate>
        <fieldset disabled={readOnly} className="contents">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field name="name" label={t('promotions.name')} required>
              <Input
                {...form.register('name')}
                autoFocus={!promotion}
                maxLength={120}
                placeholder={t('promotions.name_placeholder')}
              />
            </Field>
            <Field name="name_ta" label={t('fields.name_ta')} optional>
              <Input
                {...form.register('name_ta')}
                lang="ta"
                maxLength={120}
                placeholder={t('promotions.name_ta_placeholder')}
              />
            </Field>
          </div>

          <Field name="kind" label={t('promotions.kind')}>
            <Controller
              control={form.control}
              name="kind"
              render={({ field }) => (
                <RadioGroup
                  value={field.value}
                  onValueChange={field.onChange}
                  variant="cards"
                  disabled={readOnly}
                  className="grid-cols-2 sm:grid-cols-3"
                  options={(Object.keys(PROMOTION_KIND_LABELS) as PromotionKind[]).map((k) => ({
                    value: k,
                    label: bilingual(PROMOTION_KIND_LABELS[k]),
                    // Phones: no icon, so long Tamil words fit two cards per row.
                    icon: roomy ? KIND_ICONS[k] : undefined,
                  }))}
                />
              )}
            />
          </Field>

          <section
            className="grid grid-cols-1 gap-4 rounded-lg border border-border p-4"
            aria-label={t('promotions.rules')}
          >
            {kind === 'item_percent' || kind === 'bill_percent' ? (
              <Field name="percent_bp" label={t('promotions.percent')} required>
                <Controller
                  control={form.control}
                  name="percent_bp"
                  render={({ field }) => (
                    <NumberInput
                      value={field.value}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                      scale={100}
                      decimals={2}
                      min={0}
                      max={10_000}
                      suffix="%"
                      size="lg"
                    />
                  )}
                />
              </Field>
            ) : null}
            {kind === 'item_flat' || kind === 'bill_flat' ? (
              <Field
                name="flat_paise"
                label={
                  kind === 'item_flat' ? t('promotions.flat_per_unit') : t('promotions.flat_bill')
                }
                required
              >
                <Controller
                  control={form.control}
                  name="flat_paise"
                  render={({ field }) => (
                    <MoneyInput
                      value={field.value}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                      size="lg"
                    />
                  )}
                />
              </Field>
            ) : null}
            {kind === 'buy_x_get_y' ? <BuyXGetYFields /> : null}
            {kind === 'combo_price' ? <ComboFields /> : null}
            {kind === 'item_percent' || kind === 'item_flat' ? (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field name="min_qty_milli" label={t('promotions.min_qty')} optional>
                  <Controller
                    control={form.control}
                    name="min_qty_milli"
                    render={({ field }) => (
                      <QtyInput
                        value={field.value}
                        onChange={field.onChange}
                        unit="PCS"
                        showUnit={false}
                        min={1000}
                        steppers={false}
                      />
                    )}
                  />
                </Field>
                <Field name="max_discount_paise" label={t('promotions.max_discount_line')} optional>
                  <Controller
                    control={form.control}
                    name="max_discount_paise"
                    render={({ field }) => (
                      <MoneyInput value={field.value} onChange={field.onChange} />
                    )}
                  />
                </Field>
              </div>
            ) : null}
            {isBill ? (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field name="min_bill_paise" label={t('promotions.min_bill')} optional>
                  <Controller
                    control={form.control}
                    name="min_bill_paise"
                    render={({ field }) => (
                      <MoneyInput value={field.value} onChange={field.onChange} />
                    )}
                  />
                </Field>
                {kind === 'bill_percent' ? (
                  <Field
                    name="max_discount_paise"
                    label={t('promotions.max_discount_bill')}
                    optional
                  >
                    <Controller
                      control={form.control}
                      name="max_discount_paise"
                      render={({ field }) => (
                        <MoneyInput value={field.value} onChange={field.onChange} />
                      )}
                    />
                  </Field>
                ) : null}
              </div>
            ) : null}
          </section>

          {isItem ? <TargetingFields /> : null}

          <section
            className="grid grid-cols-1 gap-4 rounded-lg border border-border p-4"
            aria-label={t('promotions.schedule')}
          >
            <p className="text-sm font-semibold">{t('promotions.schedule')}</p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field
                name="start_date"
                label={t('promotions.start_date')}
                optional
                hint={t('promotions.start_hint')}
              >
                <Controller
                  control={form.control}
                  name="start_date"
                  render={({ field }) => (
                    <DatePicker value={field.value} onChange={field.onChange} />
                  )}
                />
              </Field>
              <Field
                name="end_date"
                label={t('promotions.end_date')}
                optional
                hint={t('promotions.end_hint')}
              >
                <Controller
                  control={form.control}
                  name="end_date"
                  render={({ field }) => (
                    <DatePicker
                      value={field.value}
                      onChange={field.onChange}
                      min={values.start_date ?? undefined}
                    />
                  )}
                />
              </Field>
            </div>
            <Field
              name="days_of_week"
              label={t('promotions.days')}
              optional
              hint={t('promotions.days_hint')}
            >
              <Controller
                control={form.control}
                name="days_of_week"
                render={({ field }) => (
                  <div className="flex flex-wrap gap-1.5" role="group">
                    {[1, 2, 3, 4, 5, 6, 0].map((d) => {
                      const on = field.value.includes(d)
                      return (
                        <button
                          key={d}
                          type="button"
                          aria-pressed={on}
                          disabled={readOnly}
                          onClick={() =>
                            field.onChange(
                              on ? field.value.filter((x) => x !== d) : [...field.value, d].sort(),
                            )
                          }
                          className={cn(
                            'h-10 min-w-12 rounded-full border px-3 text-sm font-medium transition-colors',
                            on
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'border-border hover:bg-surface-2',
                          )}
                        >
                          {dayShort(d)}
                        </button>
                      )
                    })}
                  </div>
                )}
              />
            </Field>
            {multiStore ? <StoreScopeFields /> : null}
          </section>

          <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              name="priority"
              label={t('promotions.priority')}
              optional
              hint={t('promotions.priority_hint')}
            >
              <Controller
                control={form.control}
                name="priority"
                render={({ field }) => (
                  <NumberInput
                    value={field.value}
                    onChange={field.onChange}
                    min={-1000}
                    max={1000}
                    allowNegative
                  />
                )}
              />
            </Field>
            <div className="grid grid-cols-1 content-start gap-3 rounded-lg bg-surface-2 p-3">
              <Controller
                control={form.control}
                name="stackable"
                render={({ field }) => (
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                    label={t('promotions.stackable')}
                    description={t('promotions.stackable_hint')}
                  />
                )}
              />
              <Controller
                control={form.control}
                name="is_active"
                render={({ field }) => (
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                    label={t('promotions.switched_on')}
                  />
                )}
              />
            </div>
          </section>
        </fieldset>

        <section
          className="grid grid-cols-1 gap-1.5 rounded-lg border border-accent/40 bg-accent-soft p-4 text-accent-soft-foreground"
          aria-live="polite"
          aria-label={t('promotions.explanation')}
        >
          <p className="text-xs font-semibold uppercase tracking-wide opacity-80">
            {t('promotions.explanation')}
          </p>
          <p className="text-base font-semibold">{summary ?? t('promotions.fill_rules')}</p>
          {example ? (
            <p className="text-sm">
              {example.kind === 'bill'
                ? t('promotions.example_bill', {
                    bill: formatMoney(example.gross_paise, { decimals: 'auto' }),
                    off: formatMoney(example.discount_paise, { decimals: 'auto' }),
                    pays: formatMoney(example.pays_paise, { decimals: 'auto' }),
                  })
                : t('promotions.example_items', {
                    count: example.units,
                    price: formatMoney(example.unit_price_paise, { decimals: 'auto' }),
                    gross: formatMoney(example.gross_paise, { decimals: 'auto' }),
                    off: formatMoney(example.discount_paise, { decimals: 'auto' }),
                    pays: formatMoney(example.pays_paise, { decimals: 'auto' }),
                  })}
            </p>
          ) : null}
        </section>

        {!readOnly ? (
          <div className="sticky -bottom-4 z-10 -mx-5 -mb-4 flex flex-col-reverse gap-2 border-t border-border bg-surface px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              {promotion ? (
                <Button
                  variant="ghost"
                  leftIcon={<Trash2 />}
                  className="text-danger"
                  onClick={() => void remove()}
                >
                  {t('common:actions.delete')}
                </Button>
              ) : null}
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button variant="outline" onClick={onClose} disabled={saving}>
                {t('common:actions.cancel')}
              </Button>
              <Button type="submit" loading={saving}>
                {promotion ? t('common:actions.save_changes') : t('promotions.create')}
              </Button>
            </div>
          </div>
        ) : null}
      </form>
    </FormProvider>
  )
}

function TargetingFields() {
  const { t } = useTranslation('catalog')
  const { control, watch } = useFormTyped()
  const all = watch('all_items')
  return (
    <section
      className="grid grid-cols-1 gap-4 rounded-lg border border-border p-4"
      aria-label={t('promotions.targeting')}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">{t('promotions.targeting')}</p>
          <p className="text-xs text-muted-foreground">{t('promotions.targeting_hint')}</p>
        </div>
      </div>
      <Field name="all_items">
        <Controller
          control={control}
          name="all_items"
          render={({ field }) => (
            <Switch
              checked={field.value}
              onCheckedChange={field.onChange}
              label={t('promotions.all_items')}
            />
          )}
        />
      </Field>
      {!all ? (
        <div className="grid grid-cols-1 gap-4">
          <Field name="product_ids" label={t('promotions.products')} optional>
            <Controller
              control={control}
              name="product_ids"
              render={({ field }) => (
                <ProductMultiPicker value={field.value} onChange={field.onChange} />
              )}
            />
          </Field>
          <Field name="category_ids" label={t('promotions.categories')} optional>
            <Controller
              control={control}
              name="category_ids"
              render={({ field }) => (
                <CategoryMultiPicker value={field.value} onChange={field.onChange} />
              )}
            />
          </Field>
          <Field name="brand_ids" label={t('promotions.brands')} optional>
            <Controller
              control={control}
              name="brand_ids"
              render={({ field }) => (
                <BrandMultiPicker value={field.value} onChange={field.onChange} />
              )}
            />
          </Field>
        </div>
      ) : null}
      <Field name="exclude_product_ids" label={t('promotions.exclude')} optional>
        <Controller
          control={control}
          name="exclude_product_ids"
          render={({ field }) => (
            <ProductMultiPicker
              value={field.value}
              onChange={field.onChange}
              placeholder={t('promotions.exclude_placeholder')}
            />
          )}
        />
      </Field>
    </section>
  )
}

function BuyXGetYFields() {
  const { t } = useTranslation('catalog')
  const { control, watch } = useFormTyped()
  const free = watch('get_free')
  const different = watch('reward_different')
  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="grid grid-cols-2 gap-4">
        <Field name="buy_qty" label={t('promotions.buy_qty')} required>
          <Controller
            control={control}
            name="buy_qty"
            render={({ field }) => (
              <NumberInput
                value={field.value}
                onChange={field.onChange}
                min={1}
                max={1000}
                size="lg"
              />
            )}
          />
        </Field>
        <Field name="get_qty" label={t('promotions.get_qty')} required>
          <Controller
            control={control}
            name="get_qty"
            render={({ field }) => (
              <NumberInput
                value={field.value}
                onChange={field.onChange}
                min={1}
                max={1000}
                size="lg"
              />
            )}
          />
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:items-end">
        <Controller
          control={control}
          name="get_free"
          render={({ field }) => (
            <RadioGroup
              value={field.value ? 'free' : 'discount'}
              onValueChange={(v) => field.onChange(v === 'free')}
              orientation="horizontal"
              className="flex flex-wrap gap-x-5 gap-y-2"
              options={[
                { value: 'free', label: t('promotions.get_free') },
                { value: 'discount', label: t('promotions.get_discount') },
              ]}
            />
          )}
        />
        {!free ? (
          <Field name="get_discount_bp" label={t('promotions.get_discount_bp')}>
            <Controller
              control={control}
              name="get_discount_bp"
              render={({ field }) => (
                <NumberInput
                  value={field.value}
                  onChange={field.onChange}
                  scale={100}
                  decimals={2}
                  min={0}
                  max={10_000}
                  suffix="%"
                />
              )}
            />
          </Field>
        ) : null}
      </div>
      <Field
        name="max_applications"
        label={t('promotions.max_applications')}
        optional
        hint={t('promotions.max_applications_hint')}
      >
        <Controller
          control={control}
          name="max_applications"
          render={({ field }) => (
            <NumberInput value={field.value} onChange={field.onChange} min={1} max={1000} />
          )}
        />
      </Field>
      <Controller
        control={control}
        name="reward_different"
        render={({ field }) => (
          <Switch
            checked={field.value}
            onCheckedChange={field.onChange}
            label={t('promotions.reward_different')}
            description={t('promotions.reward_different_hint')}
          />
        )}
      />
      {different ? (
        <div className="grid grid-cols-1 gap-4 rounded-md bg-surface-2 p-3">
          <Field name="reward_product_ids" label={t('promotions.reward_products')} optional>
            <Controller
              control={control}
              name="reward_product_ids"
              render={({ field }) => (
                <ProductMultiPicker value={field.value} onChange={field.onChange} />
              )}
            />
          </Field>
          <Field name="reward_category_ids" label={t('promotions.reward_categories')} optional>
            <Controller
              control={control}
              name="reward_category_ids"
              render={({ field }) => (
                <CategoryMultiPicker value={field.value} onChange={field.onChange} />
              )}
            />
          </Field>
          <Field name="reward_brand_ids" label={t('promotions.reward_brands')} optional>
            <Controller
              control={control}
              name="reward_brand_ids"
              render={({ field }) => (
                <BrandMultiPicker value={field.value} onChange={field.onChange} />
              )}
            />
          </Field>
        </div>
      ) : null}
    </div>
  )
}

function ComboFields() {
  const { t } = useTranslation(['catalog', 'common'])
  const { control } = useFormTyped()
  const items = useFieldArray({ control, name: 'combo_items' })
  const { names } = useProductNames(items.fields.map((f) => f.product_id))
  return (
    <div className="grid grid-cols-1 gap-4">
      <Field
        name="combo_items"
        label={t('promotions.combo_items')}
        hint={t('promotions.combo_items_hint')}
      >
        <div className="grid grid-cols-1 gap-2">
          {items.fields.map((f, i) => (
            <div
              key={f.id}
              className="flex items-center gap-2 rounded-md border border-border px-3 py-2"
            >
              <Package className="size-4 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-sm">
                {names.get(f.product_id) ?? '…'}
              </span>
              <Controller
                control={control}
                name={`combo_items.${i}.qty_milli`}
                render={({ field }) => (
                  <QtyInput
                    value={field.value}
                    onChange={field.onChange}
                    unit="PCS"
                    min={1000}
                    className="w-28"
                    aria-label={t('promotions.combo_qty')}
                  />
                )}
              />
              <IconButton
                icon={<Trash2 />}
                label={t('common:actions.remove')}
                variant="ghost"
                size="sm"
                onClick={() => items.remove(i)}
              />
            </div>
          ))}
          <ProductPicker
            value={null}
            placeholder={t('promotions.combo_add')}
            onChange={(p) => {
              if (p && !items.fields.some((f) => f.product_id === p.id))
                items.append({ product_id: p.id, qty_milli: 1000 })
            }}
          />
        </div>
      </Field>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field name="combo_price_paise" label={t('promotions.combo_price')} required>
          <Controller
            control={control}
            name="combo_price_paise"
            render={({ field }) => (
              <MoneyInput value={field.value} onChange={field.onChange} size="lg" />
            )}
          />
        </Field>
        <Field name="max_applications" label={t('promotions.max_applications')} optional>
          <Controller
            control={control}
            name="max_applications"
            render={({ field }) => (
              <NumberInput value={field.value} onChange={field.onChange} min={1} max={1000} />
            )}
          />
        </Field>
      </div>
    </div>
  )
}

function StoreScopeFields() {
  const { t } = useTranslation(['catalog', 'common'])
  const me = useMe()
  const { control, watch } = useFormTyped()
  const all = watch('all_stores')
  return (
    <div className="grid grid-cols-1 gap-3">
      <Controller
        control={control}
        name="all_stores"
        render={({ field }) => (
          <Switch
            checked={field.value}
            onCheckedChange={field.onChange}
            label={t('promotions.all_stores')}
          />
        )}
      />
      {!all ? (
        <Field name="store_ids" label={t('promotions.stores')}>
          <Controller
            control={control}
            name="store_ids"
            render={({ field }) => (
              <div className="grid grid-cols-1 gap-2">
                <StorePicker
                  value={null}
                  excludeIds={field.value}
                  placeholder={t('promotions.add_store')}
                  onChange={(id) => {
                    if (id && id !== 'all' && !field.value.includes(id))
                      field.onChange([...field.value, id])
                  }}
                />
                <div className="flex flex-wrap gap-1.5">
                  {field.value.map((id) => {
                    const s = me?.stores.find((x) => x.id === id)
                    return (
                      <span
                        key={id}
                        className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 py-1 pe-1 ps-3 text-sm"
                      >
                        {s ? `${s.code} · ${s.name}` : id.slice(0, 8)}
                        <IconButton
                          icon={<Trash2 />}
                          label={t('common:actions.remove')}
                          variant="ghost"
                          size="sm"
                          onClick={() => field.onChange(field.value.filter((x) => x !== id))}
                        />
                      </span>
                    )
                  })}
                </div>
              </div>
            )}
          />
        </Field>
      ) : null}
    </div>
  )
}

function useFormTyped() {
  return useFormContext<PromotionFormValues>()
}
