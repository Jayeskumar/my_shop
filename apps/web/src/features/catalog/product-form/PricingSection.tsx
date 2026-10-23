/**
 * Prices per pack: MRP, selling, wholesale, purchase (excl. GST), minimum price and maximum
 * discount, with the live margin / markup and the customer's saving against MRP.
 */
import {
  type TaxSlabRule,
  catalogRoutes,
  mrpSavings,
  productMargin,
  slabRateForPrice,
} from '@kadai/shared/api/catalog'
import type { TaxSlab } from '@kadai/shared/pricing'
import { formatBp } from '@kadai/shared/money'
import { TrendingUp } from 'lucide-react'
import type { ReactNode } from 'react'
import { Controller } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Checkbox, MoneyInput, NumberInput, Switch } from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatMoney } from '@/lib/format'
import { useRouteQuery } from '@/lib/query'
import { Field } from '../components/Field'
import { Section } from '../components/FormChrome'
import { unitSymbol } from '../lib/format'
import { useProductForm, useProductFormEnv } from './env'

type MoneyField =
  | 'mrp_paise'
  | 'sale_price_paise'
  | 'wholesale_price_paise'
  | 'purchase_price_paise'
  | 'min_sale_price_paise'

export function PricingSection({ icon }: { icon: ReactNode }) {
  const { t } = useTranslation('catalog')
  const env = useProductFormEnv()
  const { control, watch, formState } = useProductForm()
  const [
    pack_size,
    unit,
    tax_slab_rule_id,
    sale_price_paise,
    price_includes_tax,
    cess_rate_bp,
    gst_rate_bp,
    purchase_price_paise,
    mrp_paise,
  ] = watch([
    'pack_size',
    'unit',
    'tax_slab_rule_id',
    'sale_price_paise',
    'price_includes_tax',
    'cess_rate_bp',
    'gst_rate_bp',
    'purchase_price_paise',
    'mrp_paise',
  ])
  const v = {
    pack_size,
    unit,
    tax_slab_rule_id,
    sale_price_paise,
    price_includes_tax,
    cess_rate_bp,
    gst_rate_bp,
    purchase_price_paise,
    mrp_paise,
  }
  const packLabel =
    v.pack_size && v.pack_size > 1
      ? t('pricing.per_pack', { count: v.pack_size, unit: unitSymbol(v.unit) })
      : null

  const rules = useRouteQuery(
    catalogRoutes.listTaxSlabRules,
    { query: { limit: 200 } },
    { staleTime: 5 * 60_000, enabled: Boolean(v.tax_slab_rule_id) },
  )
  const rule = (rules.data?.data ?? []).find((r: TaxSlabRule) => r.id === v.tax_slab_rule_id)
  const effectiveGst =
    rule && v.sale_price_paise !== null
      ? slabRateForPrice(
          rule.slabs as TaxSlab[],
          Math.round(v.sale_price_paise / Math.max(1, v.pack_size ?? 1)),
          {
            price_includes_tax: v.price_includes_tax,
            cess_rate_bp: v.cess_rate_bp ?? 0,
          },
        ).gst_rate_bp
      : v.gst_rate_bp

  const margin =
    v.sale_price_paise !== null && v.purchase_price_paise !== null && effectiveGst !== null
      ? productMargin({
          sale_price_paise: v.sale_price_paise,
          purchase_price_paise: v.purchase_price_paise,
          price_includes_tax: v.price_includes_tax,
          gst_rate_bp: effectiveGst,
          cess_rate_bp: v.cess_rate_bp ?? 0,
        })
      : null
  const savings = v.sale_price_paise !== null ? mrpSavings(v.mrp_paise, v.sale_price_paise) : null
  const mrpError = formState.errors.sale_price_paise?.message === 'mrp_below_sale_price'

  const money = (
    name: MoneyField,
    label: string,
    opts: { required?: boolean; hint?: string } = {},
  ) => (
    <Field
      name={name}
      label={label}
      required={opts.required}
      optional={!opts.required}
      hint={opts.hint}
    >
      <Controller
        control={control}
        name={name}
        render={({ field }) => (
          <MoneyInput
            value={field.value}
            onChange={field.onChange}
            onBlur={field.onBlur}
            disabled={env.readOnly}
            size={name === 'sale_price_paise' ? 'lg' : 'md'}
            className={name === 'sale_price_paise' ? 'font-semibold' : undefined}
          />
        )}
      />
    </Field>
  )

  return (
    <Section
      id="pricing"
      icon={icon}
      title={t('form.sections.pricing')}
      description={packLabel ?? t('form.sections.pricing_hint')}
    >
      <div className="grid grid-cols-1 gap-4">
        <Controller
          control={control}
          name="price_includes_tax"
          render={({ field }) => (
            <Switch
              checked={field.value}
              onCheckedChange={field.onChange}
              disabled={env.readOnly}
              label={t('pricing.includes_tax')}
              description={
                field.value ? t('pricing.includes_tax_on') : t('pricing.includes_tax_off')
              }
            />
          )}
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {money('sale_price_paise', t('fields.sale_price'), { required: true })}
          {money('mrp_paise', t('fields.mrp'), { hint: t('pricing.mrp_hint') })}
          {money('purchase_price_paise', t('fields.purchase_price'), {
            hint: t('pricing.purchase_hint'),
          })}
          {money('wholesale_price_paise', t('fields.wholesale_price'))}
          {money('min_sale_price_paise', t('fields.min_price'), {
            hint: t('pricing.min_price_hint'),
          })}
          <Field
            name="max_discount_bp"
            label={t('fields.max_discount')}
            optional
            hint={t('pricing.max_discount_hint')}
          >
            <Controller
              control={control}
              name="max_discount_bp"
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
                  disabled={env.readOnly}
                />
              )}
            />
          </Field>
        </div>
        {mrpError && !env.readOnly ? (
          <Controller
            control={control}
            name="allow_mrp_below_sale"
            render={({ field }) => (
              <Checkbox
                checked={field.value}
                onCheckedChange={(c) => field.onChange(c === true)}
                label={t('pricing.allow_above_mrp')}
                description={t('pricing.allow_above_mrp_hint')}
              />
            )}
          />
        ) : null}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" aria-live="polite">
          <Fact
            label={t('pricing.margin')}
            tone={margin && margin.margin_paise < 0 ? 'danger' : 'success'}
            value={
              margin && margin.margin_bp !== null
                ? `${formatBp(margin.margin_bp)} · ${formatMoney(margin.margin_paise)}`
                : '—'
            }
            hint={
              margin
                ? t('pricing.margin_hint', { amount: formatMoney(margin.sale_excl_tax_paise) })
                : t('pricing.margin_empty')
            }
          />
          <Fact
            label={t('pricing.markup')}
            tone={margin && margin.margin_paise < 0 ? 'danger' : 'neutral'}
            value={margin && margin.markup_bp !== null ? formatBp(margin.markup_bp) : '—'}
            hint={t('pricing.markup_hint')}
          />
          <Fact
            label={t('pricing.savings')}
            tone="accent"
            value={
              savings && savings.savings_paise > 0
                ? `${formatMoney(savings.savings_paise)} (${formatBp(savings.savings_bp)})`
                : '—'
            }
            hint={t('pricing.savings_hint')}
          />
        </div>
        {rule && effectiveGst !== null ? (
          <p className="text-xs text-muted-foreground">
            {t('pricing.slab_rate', { rate: formatBp(effectiveGst), rule: rule.name })}
          </p>
        ) : null}
      </div>
    </Section>
  )
}

function Fact({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: string
  hint?: string
  tone: 'success' | 'danger' | 'neutral' | 'accent'
}) {
  return (
    <div
      className={cn(
        'flex min-w-0 items-center justify-between gap-3 rounded-lg border px-3 py-2 sm:block sm:p-3',
        tone === 'success' && 'border-success/30 bg-success-soft text-success-soft-foreground',
        tone === 'danger' && 'border-danger/30 bg-danger-soft text-danger-soft-foreground',
        tone === 'accent' && 'border-accent/30 bg-accent-soft text-accent-soft-foreground',
        tone === 'neutral' && 'border-border bg-surface-2',
      )}
    >
      <p className="flex min-w-0 items-center gap-1.5 text-xs font-medium uppercase tracking-wide opacity-80">
        {tone === 'success' ? <TrendingUp className="size-3.5" aria-hidden /> : null}
        {label}
      </p>
      <p className="shrink-0 text-end text-base font-semibold tabular-nums sm:mt-1 sm:text-start sm:text-lg">
        {value}
      </p>
      {hint ? <p className="mt-0.5 hidden text-xs opacity-80 sm:block">{hint}</p> : null}
    </div>
  )
}
