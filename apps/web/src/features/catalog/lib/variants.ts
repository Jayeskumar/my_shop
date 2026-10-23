/**
 * Variant matrix editor model (apparel / footwear): axis drafts → POST /products/:id/variants
 * body, and the preview of which combinations are new or already exist.
 */
import {
  MAX_VARIANT_COMBINATIONS,
  VARIANT_PRESETS,
  type VariantGenerate,
  VariantGenerateSchema,
  type VariantPriceOverride,
  type VariantRow,
  variantAxisOrder,
  variantCombinations,
  variantKey,
} from '@kadai/shared/api/catalog'

export interface AxisDraft {
  /** Lower snake axis name: 'size', 'color', 'waist'. */
  name: string
  values: string[]
}

/** Tamil labels of the preset colours (value → Tamil). */
export const COLOR_LABELS_TA: Readonly<Record<string, string>> = Object.fromEntries(
  VARIANT_PRESETS.color.map((c) => [c.value, c.label_ta]),
)

export type SizePresetKey = keyof typeof VARIANT_PRESETS.size

export const SIZE_PRESET_KEYS = Object.keys(VARIANT_PRESETS.size) as SizePresetKey[]

/** Axis name typed by the user → contract axis name ('Waist Size' → 'waist_size'). */
export function normalizeAxisName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, 'a$1')
    .slice(0, 30)
}

/** Default axes for a vertical (settings.catalog.variant_axes first). */
export function defaultAxes(configured: readonly string[], businessType: string): AxisDraft[] {
  const names = configured.length
    ? configured.map(normalizeAxisName).filter(Boolean)
    : businessType === 'footwear' || businessType === 'apparel'
      ? ['size', 'color']
      : ['size']
  return [...new Set(names)].slice(0, 3).map((name) => ({ name, values: [] }))
}

/**
 * Axis drafts of a saved variant parent, prefilled with the values its variants already use (in
 * first-seen order), so values added to one axis combine with every existing value of the others.
 */
export function axesFromVariants(
  axes: readonly string[],
  variants: readonly Pick<VariantRow, 'variant_attributes'>[],
): AxisDraft[] {
  return axes.map((name) => ({
    name,
    values: [
      ...new Set(
        variants.map((v) => v.variant_attributes[name]).filter((x): x is string => Boolean(x)),
      ),
    ],
  }))
}

/** Axes with at least one value, as the contract's `axes` record (display order kept). */
export function axesRecord(axes: readonly AxisDraft[]): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const a of axes) if (a.name && a.values.length) out[a.name] = [...a.values]
  return out
}

export interface PreviewCell {
  attrs: Record<string, string>
  key: string
  exists: boolean
}

/** Every combination of the axes, flagged when the parent already has it. */
export function previewCombinations(
  axes: readonly AxisDraft[],
  existingAxes: readonly string[],
  existing: readonly Pick<VariantRow, 'variant_attributes'>[],
): { order: string[]; cells: PreviewCell[]; newCount: number; tooMany: boolean } {
  const record = axesRecord(axes)
  const order = variantAxisOrder(existingAxes, record).filter((a) => record[a])
  const total = Object.values(record).reduce((n, v) => n * v.length, 1)
  if (Object.keys(record).length === 0) return { order, cells: [], newCount: 0, tooMany: false }
  if (total > MAX_VARIANT_COMBINATIONS) return { order, cells: [], newCount: 0, tooMany: true }
  const have = new Set(existing.map((v) => variantKey(v.variant_attributes, order)))
  const cells = variantCombinations(record, order).map((attrs) => {
    const key = variantKey(attrs, order)
    return { attrs, key, exists: have.has(key) }
  })
  return { order, cells, newCount: cells.filter((c) => !c.exists).length, tooMany: false }
}

/** Per-value sale-price overrides of the first axis ({size: 'XXL'} → ₹ price). */
export function overridesFromPrices(
  axis: string,
  prices: Readonly<Record<string, number | null>>,
): VariantPriceOverride[] {
  return Object.entries(prices)
    .filter((entry): entry is [string, number] => entry[1] !== null)
    .map(([value, price]) => ({ match: { [axis]: value }, sale_price_paise: price }))
}

/** POST /products/:id/variants body (validated by the contract schema). */
export function buildVariantGenerate(input: {
  axes: readonly AxisDraft[]
  priceAxis: string | null
  prices: Readonly<Record<string, number | null>>
  generateBarcodes: boolean
}): { body: VariantGenerate; error: string | null } {
  const axes = axesRecord(input.axes)
  const labels: Record<string, Record<string, string>> = {}
  for (const [axis, values] of Object.entries(axes)) {
    for (const v of values) {
      const ta = COLOR_LABELS_TA[v]
      if (ta && axis === 'color') (labels[axis] ??= {})[v] = ta
    }
  }
  const body: VariantGenerate = {
    axes,
    value_labels_ta: labels,
    price_overrides:
      input.priceAxis && axes[input.priceAxis]
        ? overridesFromPrices(
            input.priceAxis,
            Object.fromEntries(
              Object.entries(input.prices).filter(([v]) => axes[input.priceAxis!]?.includes(v)),
            ),
          )
        : [],
    generate_barcodes: input.generateBarcodes,
  }
  const parsed = VariantGenerateSchema.safeParse(body)
  return { body, error: parsed.success ? null : (parsed.error.issues[0]?.message ?? 'invalid') }
}

export interface VariantDraft {
  axes: AxisDraft[]
  /** Sale price per value of the first axis (null = product price). */
  prices: Record<string, number | null>
  generateBarcodes: boolean
}

export function emptyVariantDraft(axes: AxisDraft[]): VariantDraft {
  return { axes, prices: {}, generateBarcodes: true }
}
