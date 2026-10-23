/**
 * Tax inputs shared by the product form, category editor and bulk update: GST rate select,
 * HSN search (GET /hsn/search with suggested rates) and the price-slab rule select.
 */
import { type HsnEntry, type TaxSlabRule, catalogRoutes } from '@kadai/shared/api/catalog'
import { isValidHsn } from '@kadai/shared/gst'
import { formatBp } from '@kadai/shared/money'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge, Combobox, Select } from '@/components/ui'
import { callRoute } from '@/lib/api'
import { useRouteQuery } from '@/lib/query'
import { gstRateOptions, slabSummary } from '../lib/format'

const NONE = '__none'

export interface GstRateSelectProps {
  value: number | null
  onChange: (bp: number | null) => void
  id?: string
  disabled?: boolean
  placeholder?: string
  className?: string
  'aria-label'?: string
  /** Offer an empty choice (category defaults: "not set"). */
  noneLabel?: string
}

export function GstRateSelect({ value, onChange, noneLabel, ...props }: GstRateSelectProps) {
  const options = useMemo(
    () => [...(noneLabel ? [{ value: NONE, label: noneLabel }] : []), ...gstRateOptions()],
    [noneLabel],
  )
  return (
    <Select
      {...props}
      value={value === null ? (noneLabel ? NONE : null) : String(value)}
      onValueChange={(v) => onChange(v === NONE ? null : Number(v))}
      options={options}
    />
  )
}

/** Stable value object for the HSN combobox (a typed code may be outside the directory). */
interface HsnOption {
  code: string
  description: string
  gst_rate_bp: number | null
  group: string | null
  slab_rule_hint: string | null
}

export interface HsnComboboxProps {
  value: string
  onChange: (code: string, entry: HsnEntry | null) => void
  id?: string
  disabled?: boolean
}

export function HsnCombobox({ value, onChange, id, disabled }: HsnComboboxProps) {
  const { t } = useTranslation('catalog')
  const selected: HsnOption | null = value
    ? { code: value, description: '', gst_rate_bp: null, group: null, slab_rule_hint: null }
    : null
  const load = async (q: string, signal: AbortSignal): Promise<HsnOption[]> => {
    const res = await callRoute(catalogRoutes.searchHsn, { query: { q, limit: 20 }, signal })
    return res.data
  }
  return (
    <Combobox<HsnOption>
      id={id}
      disabled={disabled}
      value={selected}
      onChange={(o) => onChange(o?.code ?? '', o && o.description ? o : null)}
      loadOptions={load}
      minQueryLength={2}
      getOptionValue={(o) => o.code}
      getOptionLabel={(o) => `${o.code} ${o.description}`}
      renderValue={(o) => o.code}
      renderOption={(o) => (
        <span className="flex w-full min-w-0 items-start justify-between gap-3">
          <span className="min-w-0">
            <span className="font-mono font-semibold">{o.code}</span>
            <span className="block truncate text-xs text-muted-foreground">{o.description}</span>
          </span>
          {o.gst_rate_bp !== null ? (
            <Badge tone="primary" size="sm">
              {formatBp(o.gst_rate_bp)}
            </Badge>
          ) : o.slab_rule_hint ? (
            <Badge tone="accent" size="sm">
              {t('tax.by_price')}
            </Badge>
          ) : null}
        </span>
      )}
      placeholder={t('tax.hsn_placeholder')}
      searchPlaceholder={t('tax.hsn_search')}
      emptyText={t('tax.hsn_empty')}
      onCreate={(q) => {
        const code = q.replace(/\s/g, '')
        if (isValidHsn(code)) onChange(code, null)
      }}
      createLabel={(q) => t('tax.hsn_use_code', { code: q.replace(/\s/g, '') })}
    />
  )
}

export interface SlabRuleSelectProps {
  value: string | null
  onChange: (id: string | null) => void
  id?: string
  disabled?: boolean
  /** Show the explanation of the chosen rule below the select. */
  explain?: boolean
}

/** Active price-slab rules (GET /tax-slab-rules) with "None". */
export function SlabRuleSelect({
  value,
  onChange,
  id,
  disabled,
  explain = true,
}: SlabRuleSelectProps) {
  const { t } = useTranslation('catalog')
  const rules = useRouteQuery(
    catalogRoutes.listTaxSlabRules,
    { query: { limit: 200 } },
    { staleTime: 5 * 60_000 },
  )
  const list = useMemo(() => (rules.data?.data ?? []) as TaxSlabRule[], [rules.data])
  const options = useMemo(
    () => [
      { value: NONE, label: t('tax.no_slab_rule') },
      ...list
        .filter((r) => r.is_active || r.id === value)
        .map((r) => ({ value: r.id, label: r.name })),
    ],
    [list, t, value],
  )
  const chosen = list.find((r) => r.id === value) ?? null
  return (
    <div className="grid grid-cols-1 gap-1.5">
      <Select
        id={id}
        disabled={disabled || rules.isPending}
        value={value ?? NONE}
        onValueChange={(v) => onChange(v === NONE ? null : v)}
        options={options}
      />
      {explain && chosen ? (
        <p className="rounded-md bg-accent-soft px-3 py-2 text-xs text-accent-soft-foreground">
          {slabSummary(chosen.slabs, {
            upTo: (a) => t('tax_rules.up_to', { amount: a }),
            above: (a) => t('tax_rules.above', { amount: a }),
          })}
        </p>
      ) : null}
    </div>
  )
}
