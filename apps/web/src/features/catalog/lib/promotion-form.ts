/**
 * Promotion editor model: form values ↔ POST/PATCH /promotions bodies (kind + rules), contract
 * validation mapped onto the form fields, and a worked example computed with the shared
 * promotions engine (the same maths the POS applies).
 */
import {
  type PromotionCreate,
  PromotionCreateSchema,
  type PromotionResponse,
  type PromotionUpdate,
} from '@kadai/shared/api/catalog'
import { DEFAULT_TIMEZONE, addDays, startOfDayInstant, toDateStr } from '@kadai/shared/fy'
import {
  type PromotionKind,
  type PromotionLike,
  PROMOTION_RULE_SCHEMAS,
  applyPromotions,
} from '@kadai/shared/promotions'
import { type FieldErrors, type FieldValues, type Resolver, set } from 'react-hook-form'
import { validationToken } from '@/lib/validation'

export const ITEM_KINDS: readonly PromotionKind[] = ['item_percent', 'item_flat', 'buy_x_get_y']
export const BILL_KINDS: readonly PromotionKind[] = ['bill_percent', 'bill_flat']

export interface ComboItemDraft {
  product_id: string
  qty_milli: number | null
}

export interface PromotionFormValues {
  name: string
  name_ta: string
  kind: PromotionKind
  // targeting (item kinds)
  all_items: boolean
  product_ids: string[]
  category_ids: string[]
  brand_ids: string[]
  exclude_product_ids: string[]
  // amounts
  percent_bp: number | null
  flat_paise: number | null
  min_qty_milli: number | null
  max_discount_paise: number | null
  min_bill_paise: number | null
  // buy x get y
  buy_qty: number | null
  get_qty: number | null
  get_free: boolean
  get_discount_bp: number | null
  reward_different: boolean
  reward_product_ids: string[]
  reward_category_ids: string[]
  reward_brand_ids: string[]
  max_applications: number | null
  // combo
  combo_items: ComboItemDraft[]
  combo_price_paise: number | null
  // schedule & scope
  start_date: string | null
  /** Inclusive last day (sent as the exclusive instant of the next midnight). */
  end_date: string | null
  /** Empty = every day. */
  days_of_week: number[]
  all_stores: boolean
  store_ids: string[]
  priority: number | null
  stackable: boolean
  is_active: boolean
}

export function defaultPromotionValues(kind: PromotionKind = 'item_percent'): PromotionFormValues {
  return {
    name: '',
    name_ta: '',
    kind,
    all_items: false,
    product_ids: [],
    category_ids: [],
    brand_ids: [],
    exclude_product_ids: [],
    percent_bp: null,
    flat_paise: null,
    min_qty_milli: null,
    max_discount_paise: null,
    min_bill_paise: null,
    buy_qty: 2,
    get_qty: 1,
    get_free: true,
    get_discount_bp: 5000,
    reward_different: false,
    reward_product_ids: [],
    reward_category_ids: [],
    reward_brand_ids: [],
    max_applications: null,
    combo_items: [],
    combo_price_paise: null,
    start_date: null,
    end_date: null,
    days_of_week: [],
    all_stores: true,
    store_ids: [],
    priority: 0,
    stackable: false,
    is_active: true,
  }
}

const num = (r: Record<string, unknown>, k: string): number | null =>
  typeof r[k] === 'number' ? (r[k] as number) : null
const ids = (r: Record<string, unknown>, k: string): string[] =>
  Array.isArray(r[k]) ? (r[k] as unknown[]).filter((x): x is string => typeof x === 'string') : []

/** Form values of a stored promotion (dates in the tenant timezone). */
export function valuesFromPromotion(
  p: PromotionResponse,
  timeZone: string = DEFAULT_TIMEZONE,
): PromotionFormValues {
  const r = p.rules as Record<string, unknown>
  const base = defaultPromotionValues(p.kind)
  const getDiscount = num(r, 'get_discount_bp') ?? 10_000
  const reward = {
    product_ids: ids(r, 'get_product_ids'),
    category_ids: ids(r, 'get_category_ids'),
    brand_ids: ids(r, 'get_brand_ids'),
  }
  const items = Array.isArray(r.items)
    ? (r.items as { product_id: string; qty_milli: number }[])
    : []
  return {
    ...base,
    name: p.name,
    name_ta: p.name_ta ?? '',
    kind: p.kind,
    all_items: r.all_items === true,
    product_ids: ids(r, 'product_ids'),
    category_ids: ids(r, 'category_ids'),
    brand_ids: ids(r, 'brand_ids'),
    exclude_product_ids: ids(r, 'exclude_product_ids'),
    percent_bp: num(r, 'percent_bp'),
    flat_paise: num(r, 'flat_paise'),
    min_qty_milli: num(r, 'min_qty_milli'),
    max_discount_paise: num(r, 'max_discount_paise'),
    min_bill_paise: num(r, 'min_bill_paise'),
    buy_qty: num(r, 'buy_qty') ?? base.buy_qty,
    get_qty: num(r, 'get_qty') ?? base.get_qty,
    get_free: getDiscount >= 10_000,
    get_discount_bp: getDiscount >= 10_000 ? base.get_discount_bp : getDiscount,
    reward_different:
      reward.product_ids.length + reward.category_ids.length + reward.brand_ids.length > 0,
    reward_product_ids: reward.product_ids,
    reward_category_ids: reward.category_ids,
    reward_brand_ids: reward.brand_ids,
    max_applications: num(r, 'max_applications'),
    combo_items: items.map((i) => ({ product_id: i.product_id, qty_milli: i.qty_milli })),
    combo_price_paise: num(r, 'combo_price_paise'),
    start_date: p.starts_at ? toDateStr(new Date(p.starts_at), timeZone) : null,
    end_date: p.ends_at ? toDateStr(new Date(Date.parse(p.ends_at) - 1), timeZone) : null,
    days_of_week: p.days_of_week ? [...p.days_of_week].sort() : [],
    all_stores: p.store_ids === null,
    store_ids: p.store_ids ?? [],
    priority: p.priority,
    stackable: p.stackable,
    is_active: p.is_active,
  }
}

const opt = <K extends string>(key: K, value: number | null): Partial<Record<K, number>> =>
  value === null ? {} : ({ [key]: value } as Record<K, number>)

/** Kind-specific `rules` JSON of the form values. */
export function rulesOf(v: PromotionFormValues): Record<string, unknown> {
  const targeting = {
    all_items: v.all_items,
    product_ids: v.all_items ? [] : v.product_ids,
    category_ids: v.all_items ? [] : v.category_ids,
    brand_ids: v.all_items ? [] : v.brand_ids,
    exclude_product_ids: v.exclude_product_ids,
  }
  switch (v.kind) {
    case 'item_percent':
      return {
        ...targeting,
        percent_bp: v.percent_bp ?? 0,
        ...opt('min_qty_milli', v.min_qty_milli),
        ...opt('max_discount_paise', v.max_discount_paise),
      }
    case 'item_flat':
      return {
        ...targeting,
        flat_paise: v.flat_paise ?? 0,
        ...opt('min_qty_milli', v.min_qty_milli),
        ...opt('max_discount_paise', v.max_discount_paise),
      }
    case 'buy_x_get_y':
      return {
        ...targeting,
        buy_qty: v.buy_qty ?? 0,
        get_qty: v.get_qty ?? 0,
        get_discount_bp: v.get_free ? 10_000 : (v.get_discount_bp ?? 0),
        get_product_ids: v.reward_different ? v.reward_product_ids : [],
        get_category_ids: v.reward_different ? v.reward_category_ids : [],
        get_brand_ids: v.reward_different ? v.reward_brand_ids : [],
        ...opt('max_applications', v.max_applications),
      }
    case 'bill_percent':
      return {
        percent_bp: v.percent_bp ?? 0,
        ...opt('min_bill_paise', v.min_bill_paise),
        ...opt('max_discount_paise', v.max_discount_paise),
      }
    case 'bill_flat':
      return { flat_paise: v.flat_paise ?? 0, ...opt('min_bill_paise', v.min_bill_paise) }
    case 'combo_price':
      return {
        items: v.combo_items.map((i) => ({
          product_id: i.product_id,
          qty_milli: i.qty_milli ?? 0,
        })),
        combo_price_paise: v.combo_price_paise ?? 0,
        ...opt('max_applications', v.max_applications),
      }
  }
}

function baseFields(v: PromotionFormValues, timeZone: string) {
  return {
    name: v.name.trim(),
    name_ta: v.name_ta.trim() === '' ? null : v.name_ta.trim(),
    store_ids: v.all_stores ? null : v.store_ids,
    starts_at: v.start_date ? startOfDayInstant(v.start_date, timeZone).toISOString() : null,
    ends_at: v.end_date ? startOfDayInstant(addDays(v.end_date, 1), timeZone).toISOString() : null,
    days_of_week:
      v.days_of_week.length === 0 || v.days_of_week.length === 7 ? null : v.days_of_week,
    priority: v.priority ?? 0,
    stackable: v.stackable,
    is_active: v.is_active,
  }
}

/** POST /promotions body. */
export function toPromotionCreate(
  v: PromotionFormValues,
  timeZone: string = DEFAULT_TIMEZONE,
): PromotionCreate {
  return { ...baseFields(v, timeZone), kind: v.kind, rules: rulesOf(v) } as PromotionCreate
}

/** PATCH /promotions/:id body: every field, kind + rules together, with the stale-write guard. */
export function toPromotionUpdate(
  v: PromotionFormValues,
  original: PromotionResponse,
  timeZone: string = DEFAULT_TIMEZONE,
): PromotionUpdate {
  return {
    ...baseFields(v, timeZone),
    kind: v.kind,
    rules: rulesOf(v),
    if_updated_at: original.updated_at,
  }
}

const RULE_FIELD: Record<string, keyof PromotionFormValues> = {
  items: 'combo_items',
  get_product_ids: 'reward_product_ids',
  get_category_ids: 'reward_category_ids',
  get_brand_ids: 'reward_brand_ids',
  get_discount_bp: 'get_discount_bp',
}

const SHARED_MESSAGES: Record<string, string> = {
  'select products, categories or brands (or all items)': 'promotion_target',
  'each product may appear only once in a combo': 'combo_duplicate',
}

function issueField(path: readonly PropertyKey[]): string {
  const [head, second, ...rest] = path.map(String)
  if (head === 'rules') {
    if (second === undefined) return 'all_items'
    const field = RULE_FIELD[second] ?? second
    return [field, ...rest].join('.')
  }
  if (head === 'ends_at') return 'end_date'
  if (head === 'starts_at') return 'start_date'
  return [head ?? 'name', second, ...rest].filter((x) => x !== undefined).join('.')
}

/** Contract issues of the form values, keyed for react-hook-form. */
export function promotionFormIssues(
  v: PromotionFormValues,
  timeZone: string = DEFAULT_TIMEZONE,
): { path: string; message: string }[] {
  const out: { path: string; message: string }[] = []
  const required = validationToken('required')
  if ((v.kind === 'item_percent' || v.kind === 'bill_percent') && v.percent_bp === null)
    out.push({ path: 'percent_bp', message: required })
  if ((v.kind === 'item_flat' || v.kind === 'bill_flat') && v.flat_paise === null)
    out.push({ path: 'flat_paise', message: required })
  if (v.kind === 'buy_x_get_y') {
    if (v.buy_qty === null) out.push({ path: 'buy_qty', message: required })
    if (v.get_qty === null) out.push({ path: 'get_qty', message: required })
  }
  if (v.kind === 'combo_price' && v.combo_price_paise === null)
    out.push({ path: 'combo_price_paise', message: required })
  if (!v.all_stores && v.store_ids.length === 0)
    out.push({ path: 'store_ids', message: validationToken('select') })
  if (v.start_date && v.end_date && v.end_date < v.start_date)
    out.push({ path: 'end_date', message: 'promotion_dates' })
  const parsed = PromotionCreateSchema.safeParse(toPromotionCreate(v, timeZone))
  if (!parsed.success)
    for (const issue of parsed.error.issues)
      out.push({
        path: issueField(issue.path),
        message: SHARED_MESSAGES[issue.message] ?? issue.message,
      })
  return out
}

export function promotionResolver(timeZone: string): Resolver<PromotionFormValues> {
  return (values) => {
    const issues = promotionFormIssues(values, timeZone)
    if (issues.length === 0) return { values, errors: {} }
    const errors: FieldErrors<PromotionFormValues> = {}
    const seen = new Set<string>()
    for (const issue of issues) {
      if (seen.has(issue.path)) continue
      seen.add(issue.path)
      set(errors, issue.path, { type: 'validate', message: issue.message })
    }
    return { values: {}, errors: errors as FieldErrors<FieldValues> }
  }
}

export interface PromotionExample {
  kind: 'items' | 'bill'
  /** Units in the example cart (item kinds). */
  units: number
  unit_price_paise: number
  gross_paise: number
  discount_paise: number
  pays_paise: number
}

const SAMPLE_PRICE = 10_000
const SAMPLE_BILL = 100_000

/**
 * Worked example with the shared engine: item kinds on ₹100 items (enough units to qualify),
 * bill kinds on a ₹1,000 bill (or the minimum bill). null when the rules are incomplete.
 */
export function promotionExample(v: PromotionFormValues): PromotionExample | null {
  if (v.kind === 'combo_price') return null
  const rules = PROMOTION_RULE_SCHEMAS[v.kind].safeParse(rulesOf(v))
  if (!rules.success) return null
  const promo = {
    id: '00000000-0000-7000-8000-000000000001',
    name: 'example',
    kind: v.kind,
    rules: rules.data,
    store_ids: null,
    starts_at: null,
    ends_at: null,
    days_of_week: null,
    priority: 0,
    stackable: false,
    is_active: true,
  } as PromotionLike
  const bill = BILL_KINDS.includes(v.kind)
  const minUnits = v.min_qty_milli ? Math.ceil(v.min_qty_milli / 1000) : 1
  const units = bill
    ? 1
    : v.kind === 'buy_x_get_y'
      ? (v.buy_qty ?? 1) + (v.get_qty ?? 1)
      : Math.max(2, minUnits)
  const price = bill ? Math.max(SAMPLE_BILL, v.min_bill_paise ?? 0) : SAMPLE_PRICE
  const line = {
    key: 'l1',
    product_id: v.product_ids[0] ?? '00000000-0000-7000-8000-0000000000a1',
    category_id: v.category_ids[0] ?? null,
    brand_id: v.brand_ids[0] ?? null,
    unit_price_paise: price,
    qty_milli: units * 1000,
  }
  const result = applyPromotions([line], [promo], { store_id: 'example', now: new Date() })
  const discount = (result.line_discounts.l1?.discount_paise ?? 0) + result.bill_discount_paise
  const gross = price * units
  return {
    kind: bill ? 'bill' : 'items',
    units,
    unit_price_paise: price,
    gross_paise: gross,
    discount_paise: discount,
    pays_paise: gross - discount,
  }
}
