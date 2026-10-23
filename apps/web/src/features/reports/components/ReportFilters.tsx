/**
 * Filter controls of the generic report viewer, rendered from the report's `filters` in the
 * REPORTS catalogue: period (contract presets incl. this FY), store, group-by selects, toggles,
 * "N days", pickers (category, brand, supplier, user, counter, product) and search.
 *
 * Desktop: one wrapping row. Phones: period + "Filters (n)" opening a bottom sheet, so the table
 * keeps the screen.
 */
import type { ReportDef, ReportFilterDef } from '@kadai/shared/api/reports'
import { SlidersHorizontal } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  BrandPicker,
  CategoryPicker,
  ProductPicker,
  RegisterPicker,
  StorePicker,
  SupplierPicker,
  UserPicker,
} from '@/components/pickers'
import {
  Badge,
  Button,
  DatePicker,
  Drawer,
  NumberInput,
  SearchInput,
  Select,
  Switch,
} from '@/components/ui'
import { cn } from '@/lib/cn'
import { useBreakpoint } from '@/lib/use-media-query'
import type { ReportCalendar } from '../lib/calendar'
import { type FilterState, type FilterValue, isRangeValue } from '../lib/filters'
import { pick, useLang } from '../lib/labels'
import { periodOfToday } from '../lib/gst'
import { MonthPicker } from './MonthPicker'
import { ReportDateRange } from './ReportDateRange'

const ALL = '__all'

export interface ReportFiltersProps {
  def: ReportDef
  state: FilterState
  onChange: (key: string, value: FilterValue, name?: string | null) => void
  onReset: () => void
  /** Filters that differ from the defaults (badge on phones; shows "Clear filters"). */
  changedCount: number
  calendar: ReportCalendar
  /** Buttons at the end of the row (export, print, columns). */
  actions?: ReactNode
}

/** Basis-point filters (margin / discount %) are typed as percentages. */
const isBpKey = (key: string): boolean => key.endsWith('_bp')

/** A number box that applies its value once the user pauses typing (no request per keystroke). */
function DebouncedNumber({
  value,
  onCommit,
  filter,
  label,
}: {
  value: number | null
  onCommit: (v: number | null) => void
  filter: ReportFilterDef
  label: string
}) {
  const [draft, setDraft] = useState<number | null>(value)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const commit = useRef(onCommit)
  useEffect(() => {
    commit.current = onCommit
  })
  useEffect(() => setDraft(value), [value])
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )
  const bp = isBpKey(filter.key)
  const inRange = (v: number | null): boolean =>
    v === null ||
    ((filter.min === undefined || v >= filter.min) && (filter.max === undefined || v <= filter.max))
  return (
    <NumberInput
      aria-label={label}
      value={draft}
      decimals={bp ? 2 : 0}
      scale={bp ? 100 : 1}
      min={filter.min}
      max={filter.max}
      allowNegative={(filter.min ?? 0) < 0}
      suffix={bp ? '%' : undefined}
      className="w-28"
      onChange={(v) => {
        setDraft(v)
        if (timer.current) clearTimeout(timer.current)
        if (!inRange(v)) return
        timer.current = setTimeout(() => commit.current(v), 500)
      }}
    />
  )
}

function FilterControl({
  filter,
  def,
  state,
  onChange,
  calendar,
}: {
  filter: ReportFilterDef
  def: ReportDef
  state: FilterState
  onChange: ReportFiltersProps['onChange']
  calendar: ReportCalendar
}) {
  const { t } = useTranslation(['reports', 'common'])
  const lng = useLang()
  const label = pick(filter.label, lng)
  const value = state.values[filter.key] ?? null
  const storeValue = def.filters.find((f) => f.kind === 'store')
    ? (state.values.store_id as string | null)
    : null
  const scopedStore = storeValue && storeValue !== 'all' ? storeValue : null

  switch (filter.kind) {
    case 'date_range':
      return isRangeValue(value) ? (
        <ReportDateRange
          label={label}
          value={value}
          onChange={(v) => onChange(filter.key, v)}
          presets={filter.presets ?? []}
          calendar={calendar}
          className="w-full sm:w-auto sm:min-w-56"
        />
      ) : null
    case 'store':
      return (
        <StorePicker
          aria-label={label}
          allowAll
          clearable={false}
          value={typeof value === 'string' ? value : null}
          onChange={(id) => onChange(filter.key, id)}
          className="sm:w-56"
        />
      )
    case 'select': {
      const hasDefault = typeof filter.default === 'string'
      const options = [
        ...(hasDefault ? [] : [{ value: ALL, label: t('reports:filters.any') }]),
        ...(filter.options ?? []).map((o) => ({ value: o.value, label: pick(o.label, lng) })),
      ]
      return (
        <Select
          aria-label={label}
          value={typeof value === 'string' ? value : ALL}
          onValueChange={(v) => onChange(filter.key, v === ALL ? null : v)}
          options={options}
          className="sm:w-48"
        />
      )
    }
    case 'multi_select': {
      const selected = Array.isArray(value) ? value : []
      return (
        <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
          {(filter.options ?? []).map((o) => {
            const on = selected.includes(o.value)
            return (
              <button
                key={o.value}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  onChange(
                    filter.key,
                    on ? selected.filter((v) => v !== o.value) : [...selected, o.value],
                  )
                }
                className={cn(
                  'h-10 min-w-12 rounded-md border px-3 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring',
                  on
                    ? 'border-primary bg-primary-soft text-primary-soft-foreground'
                    : 'border-input bg-surface hover:bg-surface-2',
                )}
              >
                {pick(o.label, lng)}
              </button>
            )
          })}
        </div>
      )
    }
    case 'boolean':
      return (
        <label className="flex h-10 cursor-pointer items-center gap-2.5 rounded-md border border-input bg-surface px-3 text-sm shadow-card">
          <Switch
            aria-label={label}
            checked={value === true}
            onCheckedChange={(v) => onChange(filter.key, v)}
          />
          <span className="whitespace-nowrap">{label}</span>
        </label>
      )
    case 'number':
    case 'money':
      return (
        <DebouncedNumber
          filter={filter}
          label={label}
          value={typeof value === 'number' ? value : null}
          onCommit={(v) => onChange(filter.key, v)}
        />
      )
    case 'text':
      return (
        <SearchInput
          aria-label={label}
          placeholder={t('reports:filters.search_placeholder')}
          value={typeof value === 'string' ? value : ''}
          onChange={(v) => onChange(filter.key, v || null)}
          wrapperClassName="sm:w-60"
        />
      )
    case 'date':
      return (
        <DatePicker
          aria-label={label}
          value={typeof value === 'string' ? value : null}
          max={calendar.today}
          onChange={(v) => onChange(filter.key, v)}
          className="sm:w-44"
        />
      )
    case 'month':
      return (
        <MonthPicker
          label={label}
          value={typeof value === 'string' ? value : periodOfToday(calendar)}
          max={periodOfToday(calendar)}
          onChange={(v) => onChange(filter.key, v)}
        />
      )
    case 'category':
      return (
        <CategoryPicker
          aria-label={label}
          value={typeof value === 'string' ? value : null}
          onChange={(id, c) => onChange(filter.key, id, c?.name ?? null)}
          className="sm:w-56"
        />
      )
    case 'brand':
      return (
        <BrandPicker
          aria-label={label}
          value={
            typeof value === 'string' ? { id: value, name: state.names[filter.key] ?? '' } : null
          }
          onChange={(b) => onChange(filter.key, b?.id ?? null, b?.name ?? null)}
          className="sm:w-52"
        />
      )
    case 'supplier':
      return (
        <SupplierPicker
          aria-label={label}
          showBalance={false}
          value={
            typeof value === 'string' ? { id: value, name: state.names[filter.key] ?? '' } : null
          }
          onChange={(s) => onChange(filter.key, s?.id ?? null, s?.name ?? null)}
          className="sm:w-56"
        />
      )
    case 'product':
      return (
        <ProductPicker
          aria-label={label}
          value={
            typeof value === 'string' ? { id: value, name: state.names[filter.key] ?? '' } : null
          }
          onChange={(p) => onChange(filter.key, p?.id ?? null, p?.name ?? null)}
          className="sm:w-64"
        />
      )
    case 'user':
      return (
        <UserPicker
          aria-label={label}
          includeDisabled
          storeId={scopedStore}
          value={typeof value === 'string' ? value : null}
          onChange={(id, u) => onChange(filter.key, id, u?.full_name ?? null)}
          className="sm:w-52"
        />
      )
    case 'register':
      return (
        <RegisterPicker
          aria-label={label}
          includeInactive
          storeId={scopedStore}
          value={typeof value === 'string' ? value : null}
          onChange={(id, r) => onChange(filter.key, id, r?.name ?? null)}
          className="sm:w-48"
        />
      )
  }
}

function Labelled({
  label,
  children,
  wide,
}: {
  label: string
  children: ReactNode
  wide?: boolean
}) {
  return (
    <div className={cn('grid min-w-0 gap-1', wide && 'w-full sm:w-auto')}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

export function ReportFilters({
  def,
  state,
  onChange,
  onReset,
  changedCount,
  calendar,
  actions,
}: ReportFiltersProps) {
  const { t } = useTranslation(['reports', 'common'])
  const lng = useLang()
  const desktop = useBreakpoint('md')
  const [sheet, setSheet] = useState(false)
  const range = def.filters.find((f) => f.kind === 'date_range')
  const rest = def.filters.filter((f) => f.kind !== 'date_range')
  const control = (f: ReportFilterDef) => (
    <FilterControl
      key={f.key}
      filter={f}
      def={def}
      state={state}
      onChange={onChange}
      calendar={calendar}
    />
  )
  // Toggles carry their own label; the others get a caption above.
  const labelled = (f: ReportFilterDef) =>
    f.kind === 'boolean' ? (
      <div key={f.key} className="flex items-end">
        {control(f)}
      </div>
    ) : (
      <Labelled key={f.key} label={pick(f.label, lng)} wide={!desktop}>
        {control(f)}
      </Labelled>
    )

  if (desktop) {
    return (
      <section
        aria-label={t('reports:filters.title')}
        className="no-print flex flex-wrap items-end gap-3 pb-4"
      >
        {range ? labelled(range) : null}
        {rest.map(labelled)}
        {changedCount > 0 ? (
          <Button variant="ghost" onClick={onReset} className="self-end">
            {t('common:actions.clear_filters')}
          </Button>
        ) : null}
        {actions ? <div className="ms-auto flex items-end gap-2 self-end">{actions}</div> : null}
      </section>
    )
  }

  return (
    <section aria-label={t('reports:filters.title')} className="no-print grid gap-2 pb-3">
      {range ? control(range) : null}
      <div className="flex items-center gap-2">
        {rest.length ? (
          <Button
            variant="outline"
            leftIcon={<SlidersHorizontal />}
            onClick={() => setSheet(true)}
            className="flex-1"
          >
            {t('common:actions.filters')}
            {changedCount > 0 ? (
              <Badge tone="primary" appearance="solid" size="sm">
                {changedCount}
              </Badge>
            ) : null}
          </Button>
        ) : null}
        {actions}
      </div>
      <Drawer
        open={sheet}
        onOpenChange={setSheet}
        side="bottom"
        title={t('common:actions.filters')}
        footer={
          <div className="flex w-full gap-2">
            {changedCount > 0 ? (
              <Button variant="outline" onClick={onReset} className="flex-1">
                {t('common:actions.clear_filters')}
              </Button>
            ) : null}
            <Button onClick={() => setSheet(false)} className="flex-1" size="lg">
              {t('reports:filters.show_results')}
            </Button>
          </div>
        }
      >
        <div className="grid gap-4">{rest.map(labelled)}</div>
      </Drawer>
    </section>
  )
}
