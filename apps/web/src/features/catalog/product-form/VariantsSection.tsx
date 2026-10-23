/**
 * Sizes & colours (feature variants): axis chips editor with presets (S–XXL, waist 28–44,
 * footwear 6–11, common colours with Tamil names) → preview matrix → generate the missing
 * combinations (POST /products/:id/variants, idempotent), and the variants table with per-variant
 * price / MRP / active editing and barcode generation.
 */
import {
  VARIANT_PRESETS,
  type VariantRow,
  catalogRoutes,
  variantLabel,
} from '@kadai/shared/api/catalog'
import { Check, Plus, Sparkles, Trash2 } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Badge, Button, IconButton, Input, MoneyInput, Qty, Switch, notify } from '@/components/ui'
import { callRoute } from '@/lib/api'
import { cn } from '@/lib/cn'
import { getLanguage, localizedName } from '@/lib/i18n'
import { invalidateRoutes, useRouteMutation } from '@/lib/query'
import { useQueryClient } from '@tanstack/react-query'
import { ChipsInput } from '../components/ChipsInput'
import { Section } from '../components/FormChrome'
import { catalogReasonText, catalogValidationText, firstIssueText } from '../lib/messages'
import {
  COLOR_LABELS_TA,
  type VariantDraft,
  axesFromVariants,
  emptyVariantDraft,
  SIZE_PRESET_KEYS,
  buildVariantGenerate,
  normalizeAxisName,
  previewCombinations,
} from '../lib/variants'
import { useProductFormEnv } from './env'

const axisTitle = (t: (k: string) => string, name: string): string =>
  name === 'size' || name === 'color' ? t(`variants.axis_${name}`) : name.replace(/_/g, ' ')

/** Axis editor + preview + price overrides (shared by new and saved products). */
export function VariantMatrixEditor({
  draft,
  onChange,
  existingAxes,
  existing,
  disabled,
}: {
  draft: VariantDraft
  onChange: (next: VariantDraft) => void
  existingAxes: readonly string[]
  existing: readonly Pick<VariantRow, 'variant_attributes'>[]
  disabled?: boolean
}) {
  const { t } = useTranslation('catalog')
  const [newAxis, setNewAxis] = useState('')
  const tt = (k: string): string => t(k as 'variants.axis_size')
  const preview = useMemo(
    () => previewCombinations(draft.axes, existingAxes, existing),
    [draft.axes, existingAxes, existing],
  )
  const setAxis = (i: number, values: string[]): void =>
    onChange({ ...draft, axes: draft.axes.map((a, j) => (j === i ? { ...a, values } : a)) })
  const addValues = (i: number, values: readonly string[]): void => {
    const axis = draft.axes[i]
    if (!axis) return
    const have = new Set(axis.values.map((v) => v.toLowerCase()))
    setAxis(i, [...axis.values, ...values.filter((v) => !have.has(v.toLowerCase()))])
  }
  const toggleValue = (i: number, value: string): void => {
    const axis = draft.axes[i]
    if (!axis) return
    setAxis(
      i,
      axis.values.includes(value)
        ? axis.values.filter((v) => v !== value)
        : [...axis.values, value],
    )
  }
  const firstAxis = preview.order[0] ?? draft.axes[0]?.name
  const firstValues = draft.axes.find((a) => a.name === firstAxis)?.values ?? []
  const lng = getLanguage()

  return (
    <div className="grid grid-cols-1 gap-5">
      {draft.axes.map((axis, i) => {
        const locked = existingAxes.includes(axis.name)
        return (
          <div
            key={axis.name}
            className="grid grid-cols-1 gap-2 rounded-lg border border-border p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <p className="font-semibold capitalize">{axisTitle(tt, axis.name)}</p>
              {!locked && !disabled ? (
                <IconButton
                  icon={<Trash2 />}
                  label={t('variants.remove_axis', { axis: axisTitle(tt, axis.name) })}
                  variant="ghost"
                  size="sm"
                  onClick={() => onChange({ ...draft, axes: draft.axes.filter((_, j) => j !== i) })}
                />
              ) : null}
            </div>
            <ChipsInput
              value={axis.values}
              onChange={(v) => setAxis(i, v)}
              max={60}
              maxLength={30}
              disabled={disabled}
              aria-label={t('variants.values_of', { axis: axisTitle(tt, axis.name) })}
              placeholder={t('variants.values_placeholder')}
              renderChip={(v) =>
                axis.name === 'color' && COLOR_LABELS_TA[v] && lng === 'ta'
                  ? `${COLOR_LABELS_TA[v]} (${v})`
                  : v
              }
            />
            {!disabled && axis.name === 'size' ? (
              <div className="flex flex-wrap gap-1.5">
                {SIZE_PRESET_KEYS.map((key) => (
                  <Button
                    key={key}
                    size="sm"
                    variant="outline"
                    leftIcon={<Plus />}
                    onClick={() => addValues(i, VARIANT_PRESETS.size[key])}
                  >
                    {t(`variants.preset_${key}`)}
                  </Button>
                ))}
              </div>
            ) : null}
            {!disabled && axis.name === 'color' ? (
              <div
                className="flex flex-wrap gap-1.5"
                role="group"
                aria-label={t('variants.common_colours')}
              >
                {VARIANT_PRESETS.color.map((c) => {
                  const on = axis.values.includes(c.value)
                  return (
                    <button
                      key={c.value}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleValue(i, c.value)}
                      className={cn(
                        'inline-flex h-9 items-center gap-1 rounded-full border px-3 text-sm transition-colors',
                        on
                          ? 'border-primary bg-primary-soft text-primary-soft-foreground'
                          : 'border-border hover:bg-surface-2',
                      )}
                    >
                      {on ? <Check className="size-3.5" aria-hidden /> : null}
                      {lng === 'ta' ? c.label_ta : c.value}
                    </button>
                  )
                })}
              </div>
            ) : null}
          </div>
        )
      })}

      {!disabled && draft.axes.length < 3 ? (
        <div className="flex flex-wrap items-end gap-2">
          {!draft.axes.some((a) => a.name === 'size') ? (
            <Button
              variant="outline"
              size="sm"
              leftIcon={<Plus />}
              onClick={() =>
                onChange({ ...draft, axes: [...draft.axes, { name: 'size', values: [] }] })
              }
            >
              {t('variants.axis_size')}
            </Button>
          ) : null}
          {!draft.axes.some((a) => a.name === 'color') ? (
            <Button
              variant="outline"
              size="sm"
              leftIcon={<Plus />}
              onClick={() =>
                onChange({ ...draft, axes: [...draft.axes, { name: 'color', values: [] }] })
              }
            >
              {t('variants.axis_color')}
            </Button>
          ) : null}
          <div className="flex items-center gap-2">
            <Input
              size="sm"
              value={newAxis}
              onChange={(e) => setNewAxis(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.preventDefault()
              }}
              placeholder={t('variants.custom_axis')}
              aria-label={t('variants.custom_axis')}
              className="w-40"
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={
                !normalizeAxisName(newAxis) ||
                draft.axes.some((a) => a.name === normalizeAxisName(newAxis))
              }
              onClick={() => {
                onChange({
                  ...draft,
                  axes: [...draft.axes, { name: normalizeAxisName(newAxis), values: [] }],
                })
                setNewAxis('')
              }}
            >
              {t('variants.add_axis')}
            </Button>
          </div>
        </div>
      ) : null}

      <VariantPreview preview={preview} lng={lng} />

      {firstAxis && firstValues.length && preview.newCount > 0 ? (
        <div className="grid grid-cols-1 gap-2">
          <p className="text-sm font-medium">
            {t('variants.prices_title', { axis: axisTitle(tt, firstAxis) })}
          </p>
          <p className="text-xs text-muted-foreground">{t('variants.prices_hint')}</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
            {firstValues.map((value) => (
              <label key={value} className="grid grid-cols-1 gap-1 text-xs font-medium">
                {value}
                <MoneyInput
                  size="sm"
                  value={draft.prices[value] ?? null}
                  disabled={disabled}
                  onChange={(p) => onChange({ ...draft, prices: { ...draft.prices, [value]: p } })}
                />
              </label>
            ))}
          </div>
        </div>
      ) : null}

      <Switch
        checked={draft.generateBarcodes}
        onCheckedChange={(v) => onChange({ ...draft, generateBarcodes: v })}
        disabled={disabled}
        label={t('variants.generate_barcodes')}
        description={t('variants.generate_barcodes_hint')}
      />
    </div>
  )
}

function VariantPreview({
  preview,
  lng,
}: {
  preview: ReturnType<typeof previewCombinations>
  lng: 'ta' | 'en'
}) {
  const { t } = useTranslation('catalog')
  if (preview.tooMany)
    return (
      <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-soft-foreground">
        {t('validation.variant_combinations_limit')}
      </p>
    )
  if (!preview.cells.length)
    return (
      <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">
        {t('variants.preview_empty')}
      </p>
    )
  const [rowsAxis, colsAxis] = preview.order
  const label = (v: string, axis: string | undefined) =>
    axis === 'color' && lng === 'ta' && COLOR_LABELS_TA[v] ? COLOR_LABELS_TA[v] : v
  const summary = (
    <p className="text-sm">
      <span className="font-semibold">
        {t('variants.will_create', { count: preview.newCount })}
      </span>
      {preview.cells.length - preview.newCount > 0 ? (
        <span className="text-muted-foreground">
          {' '}
          · {t('variants.already_exist', { count: preview.cells.length - preview.newCount })}
        </span>
      ) : null}
    </p>
  )
  if (preview.order.length === 2 && rowsAxis && colsAxis) {
    const rowValues = [...new Set(preview.cells.map((c) => c.attrs[rowsAxis]!))]
    const colValues = [...new Set(preview.cells.map((c) => c.attrs[colsAxis]!))]
    const byKey = new Map(
      preview.cells.map((c) => [`${c.attrs[rowsAxis]}|${c.attrs[colsAxis]}`, c]),
    )
    return (
      <div className="grid grid-cols-1 gap-2">
        {summary}
        <div className="max-w-full overflow-x-auto rounded-lg border border-border">
          <table className="min-w-full text-sm" aria-label={t('variants.preview')}>
            <thead className="bg-surface-2">
              <tr>
                <th className="px-2 py-1.5" />
                {colValues.map((c) => (
                  <th
                    key={c}
                    scope="col"
                    className="whitespace-nowrap px-2 py-1.5 text-start text-xs font-semibold"
                  >
                    {label(c, colsAxis)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rowValues.map((r) => (
                <tr key={r} className="border-t border-border">
                  <th
                    scope="row"
                    className="whitespace-nowrap px-2 py-1.5 text-start text-xs font-semibold"
                  >
                    {label(r, rowsAxis)}
                  </th>
                  {colValues.map((c) => {
                    const cell = byKey.get(`${r}|${c}`)
                    return (
                      <td key={c} className="px-2 py-1.5">
                        {cell?.exists ? (
                          <Badge tone="neutral" size="sm">
                            {t('variants.exists')}
                          </Badge>
                        ) : (
                          <Badge tone="success" size="sm" icon={<Plus />}>
                            {t('variants.new')}
                          </Badge>
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    )
  }
  return (
    <div className="grid grid-cols-1 gap-2">
      {summary}
      <div className="flex flex-wrap gap-1.5">
        {preview.cells.map((c) => (
          <Badge key={c.key} tone={c.exists ? 'neutral' : 'success'} size="md">
            {variantLabel(c.attrs, preview.order, {
              color: lng === 'ta' ? { ...COLOR_LABELS_TA } : {},
            })}
          </Badge>
        ))}
      </div>
    </div>
  )
}

/** Saved product: generate more combinations + the variants table. */
export function VariantsSection({ icon }: { icon: ReactNode }) {
  const { t } = useTranslation('catalog')
  const env = useProductFormEnv()
  const product = env.product!
  const queryClient = useQueryClient()
  const existingAxes = product.variant_axes
  const [draft, setDraft] = useState<VariantDraft>(() =>
    emptyVariantDraft(
      existingAxes.length
        ? axesFromVariants(existingAxes, product.variants)
        : [
            { name: 'size', values: [] },
            ...(env.businessType === 'footwear' ? [] : [{ name: 'color', values: [] }]),
          ],
    ),
  )
  const generate = useRouteMutation(catalogRoutes.generateVariants, {
    invalidates: [catalogRoutes.getProduct, catalogRoutes.listProducts],
    onError: (error) => notify.error(catalogReasonText(error) ?? firstIssueText(error) ?? error),
  })
  const run = (): void => {
    const firstAxis = draft.axes.find((a) => a.values.length)?.name ?? null
    const { body, error } = buildVariantGenerate({
      axes: draft.axes,
      priceAxis: firstAxis,
      prices: draft.prices,
      generateBarcodes: draft.generateBarcodes,
    })
    if (error) {
      notify.error(catalogValidationText(error) ?? t('variants.check_values'))
      return
    }
    generate.mutate(
      { params: { id: product.id }, body },
      {
        onSuccess: (res) => {
          notify.success(t('variants.generated', { count: res.data.created.length }), {
            description: res.data.skipped.length
              ? t('variants.skipped', { count: res.data.skipped.length })
              : undefined,
          })
          setDraft(
            emptyVariantDraft(
              axesFromVariants(res.data.parent.variant_axes, res.data.parent.variants),
            ),
          )
          void invalidateRoutes(queryClient, [catalogRoutes.getProduct])
        },
      },
    )
  }
  const newCount = previewCombinations(draft.axes, existingAxes, product.variants).newCount
  const canGenerate = newCount > 0

  return (
    <Section
      id="variants"
      icon={icon}
      title={t('form.sections.variants')}
      description={t('form.sections.variants_hint')}
    >
      <div className="grid grid-cols-1 gap-6">
        {product.variants.length ? (
          <VariantsTable variants={product.variants} axes={existingAxes} />
        ) : null}
        {!env.readOnly ? (
          <div className="grid grid-cols-1 gap-4">
            <div>
              <p className="text-sm font-semibold">
                {product.variants.length ? t('variants.add_more') : t('variants.create_title')}
              </p>
              {product.variants.length ? (
                <p className="text-xs text-muted-foreground">{t('variants.add_more_hint')}</p>
              ) : null}
              {product.kind === 'standard' && product.barcodes.length ? (
                // The server removes them: a product with sizes / colours is not sold itself.
                <p className="mt-1 text-xs text-warning-soft-foreground">
                  {t('variants.parent_barcodes_note', {
                    codes: product.barcodes.map((b) => b.barcode).join(', '),
                  })}
                </p>
              ) : null}
            </div>
            <VariantMatrixEditor
              draft={draft}
              onChange={setDraft}
              existingAxes={existingAxes}
              existing={product.variants}
            />
            <div>
              <Button
                leftIcon={<Sparkles />}
                onClick={run}
                loading={generate.isPending}
                disabled={!canGenerate}
              >
                {newCount > 0
                  ? t('variants.generate', { count: newCount })
                  : t('variants.generate_none')}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </Section>
  )
}

interface RowEdit {
  sale_price_paise?: number | null
  mrp_paise?: number | null
  is_active?: boolean
}

function VariantsTable({
  variants,
  axes,
}: {
  variants: readonly VariantRow[]
  axes: readonly string[]
}) {
  const { t } = useTranslation('catalog')
  const env = useProductFormEnv()
  const queryClient = useQueryClient()
  const [edits, setEdits] = useState<Record<string, RowEdit>>({})
  const [saving, setSaving] = useState(false)
  const [generating, setGenerating] = useState<string | null>(null)
  const lng = getLanguage()
  const changed = Object.entries(edits).filter(([, e]) => Object.keys(e).length > 0)

  const edit = (id: string, patch: RowEdit): void =>
    setEdits((m) => ({ ...m, [id]: { ...m[id], ...patch } }))

  const save = async (): Promise<void> => {
    setSaving(true)
    let ok = 0
    try {
      for (const [id, e] of changed) {
        const v = variants.find((x) => x.id === id)
        if (!v) continue
        if (e.sale_price_paise === null) continue
        await callRoute(catalogRoutes.updateProduct, {
          params: { id },
          body: {
            ...(e.sale_price_paise !== undefined ? { sale_price_paise: e.sale_price_paise } : {}),
            ...(e.mrp_paise !== undefined ? { mrp_paise: e.mrp_paise } : {}),
            ...(e.is_active !== undefined ? { is_active: e.is_active } : {}),
          },
        })
        ok += 1
      }
      setEdits({})
      notify.success(t('variants.saved', { count: ok }))
    } catch (error) {
      notify.error(catalogReasonText(error) ?? firstIssueText(error) ?? error)
    } finally {
      setSaving(false)
      await invalidateRoutes(queryClient, [catalogRoutes.getProduct, catalogRoutes.listProducts])
    }
  }

  const generateBarcode = async (id: string): Promise<void> => {
    setGenerating(id)
    try {
      const res = await callRoute(catalogRoutes.addBarcode, {
        params: { id },
        body: { generate: true },
      })
      notify.success(t('barcodes.generated', { code: res.data.barcode }))
      await invalidateRoutes(queryClient, [catalogRoutes.getProduct])
    } catch (error) {
      notify.error(error)
    } finally {
      setGenerating(null)
    }
  }

  const labelOf = (v: VariantRow) =>
    variantLabel(v.variant_attributes, axes.length ? axes : Object.keys(v.variant_attributes), {
      color: lng === 'ta' ? { ...COLOR_LABELS_TA } : {},
    })

  return (
    <div className="grid grid-cols-1 gap-3">
      <ul className="grid grid-cols-1 gap-2 md:hidden" aria-label={t('variants.table')}>
        {variants.map((v) => {
          const e = edits[v.id] ?? {}
          return (
            <li key={v.id} className="grid grid-cols-1 gap-2 rounded-lg border border-border p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <Link to={`/catalog/products/${v.id}`} className="font-semibold hover:underline">
                    {labelOf(v)}
                  </Link>
                  <p className="flex flex-wrap gap-x-2 font-mono text-xs text-muted-foreground">
                    <span>{v.sku ?? '—'}</span>
                    {v.primary_barcode ? <span>{v.primary_barcode}</span> : null}
                  </p>
                </div>
                <Switch
                  checked={e.is_active ?? v.is_active}
                  onCheckedChange={(on) => edit(v.id, { is_active: on })}
                  disabled={env.readOnly}
                  aria-label={t('variants.active_of', { variant: labelOf(v) })}
                />
              </div>
              <div className="grid grid-cols-2 items-end gap-2">
                <label className="grid gap-1 text-xs font-medium">
                  {t('fields.sale_price')}
                  <MoneyInput
                    size="sm"
                    value={
                      e.sale_price_paise !== undefined ? e.sale_price_paise : v.sale_price_paise
                    }
                    onChange={(p) => edit(v.id, { sale_price_paise: p })}
                    disabled={env.readOnly}
                  />
                </label>
                <label className="grid gap-1 text-xs font-medium">
                  {t('fields.mrp')}
                  <MoneyInput
                    size="sm"
                    value={e.mrp_paise !== undefined ? e.mrp_paise : v.mrp_paise}
                    onChange={(p) => edit(v.id, { mrp_paise: p })}
                    disabled={env.readOnly}
                  />
                </label>
              </div>
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="text-muted-foreground">
                  {t('products.col_stock')}:{' '}
                  {v.stock_qty_milli === null ? (
                    '—'
                  ) : (
                    <Qty milli={v.stock_qty_milli} unit={env.product?.unit ?? 'PCS'} />
                  )}
                </span>
                {!v.primary_barcode && !env.readOnly ? (
                  <Button
                    size="sm"
                    variant="link"
                    loading={generating === v.id}
                    onClick={() => void generateBarcode(v.id)}
                  >
                    {t('variants.make_barcode')}
                  </Button>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>
      <div className="hidden overflow-x-auto rounded-lg border border-border md:block">
        <table className="w-full min-w-[40rem] text-sm" aria-label={t('variants.table')}>
          <thead className="bg-surface-2 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-start">{t('variants.col_variant')}</th>
              <th className="px-3 py-2 text-start">{t('variants.col_code')}</th>
              <th className="w-36 px-3 py-2 text-end">{t('fields.sale_price')}</th>
              <th className="w-36 px-3 py-2 text-end">{t('fields.mrp')}</th>
              <th className="px-3 py-2 text-end">{t('products.col_stock')}</th>
              <th className="px-3 py-2 text-center">{t('variants.col_active')}</th>
            </tr>
          </thead>
          <tbody>
            {variants.map((v) => {
              const e = edits[v.id] ?? {}
              return (
                <tr key={v.id} className="border-t border-border">
                  <td className="px-3 py-2">
                    <Link to={`/catalog/products/${v.id}`} className="font-medium hover:underline">
                      {labelOf(v)}
                    </Link>
                    <span className="block truncate text-xs text-muted-foreground">
                      {localizedName(v.name, v.name_ta)}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">
                    <span className="block">{v.sku ?? '—'}</span>
                    {v.primary_barcode ? (
                      <span className="block text-muted-foreground">{v.primary_barcode}</span>
                    ) : !env.readOnly ? (
                      <Button
                        size="sm"
                        variant="link"
                        loading={generating === v.id}
                        onClick={() => void generateBarcode(v.id)}
                      >
                        {t('variants.make_barcode')}
                      </Button>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    <MoneyInput
                      size="sm"
                      aria-label={t('variants.price_of', { variant: labelOf(v) })}
                      value={
                        e.sale_price_paise !== undefined ? e.sale_price_paise : v.sale_price_paise
                      }
                      onChange={(p) => edit(v.id, { sale_price_paise: p })}
                      disabled={env.readOnly}
                      className="text-end"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <MoneyInput
                      size="sm"
                      aria-label={t('variants.mrp_of', { variant: labelOf(v) })}
                      value={e.mrp_paise !== undefined ? e.mrp_paise : v.mrp_paise}
                      onChange={(p) => edit(v.id, { mrp_paise: p })}
                      disabled={env.readOnly}
                      className="text-end"
                    />
                  </td>
                  <td className="px-3 py-2 text-end tabular-nums">
                    {v.stock_qty_milli === null ? (
                      '—'
                    ) : (
                      <Qty milli={v.stock_qty_milli} unit={env.product?.unit ?? 'PCS'} />
                    )}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <Switch
                      checked={e.is_active ?? v.is_active}
                      onCheckedChange={(on) => edit(v.id, { is_active: on })}
                      disabled={env.readOnly}
                      aria-label={t('variants.active_of', { variant: labelOf(v) })}
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {changed.length && !env.readOnly ? (
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={() => setEdits({})} disabled={saving}>
            {t('form.discard')}
          </Button>
          <Button onClick={() => void save()} loading={saving}>
            {t('variants.save_changes', { count: changed.length })}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
