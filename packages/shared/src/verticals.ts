/**
 * Vertical (business type) catalogue: labels, product attribute schemas (`products.attributes`)
 * and onboarding presets (categories, price-slab GST rules, common units).
 *
 * IMPORTANT: GST rates and HSN codes below are *defaults* reflecting the GST 2.0 rate structure
 * (effective 22 Sep 2025) for typical goods in each category. Rates change by notification and
 * depend on the exact product (branded / pre-packed / loose, composition, value). Every business
 * must verify them with its tax advisor; they are editable data, never hard-coded logic.
 */
import { z } from 'zod'
import type { BusinessType } from './enums'
import { DrugScheduleSchema } from './settings'
import type { TaxSlab } from './pricing'

export interface BusinessTypeDef {
  code: BusinessType
  name_en: string
  name_ta: string
  description: string
  description_ta: string
  /** Default UPI merchant category code (`mc`). */
  upi_mcc: string
  /** lucide icon name used by the web app. */
  icon: string
}

export const BUSINESS_TYPES: readonly BusinessTypeDef[] = [
  {
    code: 'general_store',
    name_en: 'General store / Kirana',
    name_ta: 'மளிகைக் கடை',
    description: 'Groceries, loose items by weight, daily needs and credit (khata) customers',
    description_ta:
      'மளிகைப் பொருட்கள், எடைக்கு விற்கும் பொருட்கள், அன்றாடத் தேவைகள், கடன் வாடிக்கையாளர்கள்',
    upi_mcc: '5411',
    icon: 'store',
  },
  {
    code: 'supermarket',
    name_en: 'Supermarket',
    name_ta: 'சூப்பர் மார்க்கெட்',
    description: 'Multi-counter self-service store with weighing scales, offers and loyalty',
    description_ta: 'எடை இயந்திரம், சலுகைகள், விசுவாசப் புள்ளிகளுடன் பல கவுண்டர் கடை',
    upi_mcc: '5411',
    icon: 'shopping-cart',
  },
  {
    code: 'apparel',
    name_en: 'Textiles & readymades',
    name_ta: 'ஜவுளி & ஆயத்த ஆடைகள்',
    description: 'Sarees, dhotis, readymade garments with size/colour variants and fabric by metre',
    description_ta: 'புடவைகள், வேட்டிகள், அளவு/நிற வகைகளுடன் ஆயத்த ஆடைகள், மீட்டர் துணி',
    upi_mcc: '5651',
    icon: 'shirt',
  },
  {
    code: 'pharmacy',
    name_en: 'Pharmacy / Medical store',
    name_ta: 'மருந்தகம்',
    description:
      'Medicines with batch & expiry, strips and loose tablets, prescriptions and Schedule H1 register',
    description_ta:
      'பேட்ச் & காலாவதியுடன் மருந்துகள், அட்டை / தனி மாத்திரைகள், மருத்துவர் சீட்டு, H1 பதிவேடு',
    upi_mcc: '5912',
    icon: 'pill',
  },
  {
    code: 'footwear',
    name_en: 'Footwear',
    name_ta: 'காலணிக் கடை',
    description: 'Shoes and sandals with size variants',
    description_ta: 'அளவு வகைகளுடன் காலணிகள், செருப்புகள்',
    upi_mcc: '5661',
    icon: 'footprints',
  },
  {
    code: 'electronics',
    name_en: 'Electronics & mobiles',
    name_ta: 'மின்னணு & மொபைல் கடை',
    description: 'Mobiles, appliances and accessories with serial numbers and warranty',
    description_ta: 'வரிசை எண் & உத்தரவாதத்துடன் மொபைல்கள், மின் சாதனங்கள், உபகரணங்கள்',
    upi_mcc: '5732',
    icon: 'smartphone',
  },
  {
    code: 'hardware',
    name_en: 'Hardware & paints',
    name_ta: 'ஹார்டுவேர் & பெயிண்ட் கடை',
    description: 'Tools, paints, plumbing, electricals and building materials',
    description_ta: 'கருவிகள், பெயிண்ட், பிளம்பிங், மின் பொருட்கள், கட்டுமானப் பொருட்கள்',
    upi_mcc: '5251',
    icon: 'wrench',
  },
  {
    code: 'bakery_sweets',
    name_en: 'Bakery & sweets',
    name_ta: 'பேக்கரி & இனிப்பகம்',
    description: 'Bread, cakes, sweets and savouries, sold by piece or weight',
    description_ta: 'ரொட்டி, கேக், இனிப்பு, கார வகைகள் — எண்ணிக்கை அல்லது எடைக்கு',
    upi_mcc: '5462',
    icon: 'cake-slice',
  },
  {
    code: 'stationery',
    name_en: 'Stationery & books',
    name_ta: 'எழுதுபொருள் & புத்தகக் கடை',
    description: 'Notebooks, pens, school and office supplies, books and gifts',
    description_ta:
      'நோட்டுகள், பேனாக்கள், பள்ளி & அலுவலகப் பொருட்கள், புத்தகங்கள், பரிசுப் பொருட்கள்',
    upi_mcc: '5943',
    icon: 'pencil',
  },
  {
    code: 'other',
    name_en: 'Other retail',
    name_ta: 'பிற சில்லறை வணிகம்',
    description: 'Any other retail shop',
    description_ta: 'வேறு எந்தச் சில்லறைக் கடையும்',
    upi_mcc: '5399',
    icon: 'building-2',
  },
]

const BUSINESS_TYPE_BY_CODE: ReadonlyMap<BusinessType, BusinessTypeDef> = new Map(
  BUSINESS_TYPES.map((b) => [b.code, b]),
)

export function getBusinessType(code: BusinessType): BusinessTypeDef {
  const def = BUSINESS_TYPE_BY_CODE.get(code)
  if (!def) throw new RangeError(`unknown business type: ${code}`)
  return def
}

export function defaultMccFor(code: BusinessType): string {
  return getBusinessType(code).upi_mcc
}

// ---------------------------------------------------------------------------------------------
// Product attribute schemas (`products.attributes`)
// ---------------------------------------------------------------------------------------------

/** Shops may add their own attributes: JSON primitives only, bounded. */
const CustomAttributeValue = z.union([z.string().max(500), z.number(), z.boolean(), z.null()])
const text = (max = 120) => z.string().trim().max(max)

export const PharmacyAttributesSchema = z
  .object({
    generic_name: text(200).optional(),
    composition: text(500).optional(),
    manufacturer: text(200).optional(),
    marketed_by: text(200).optional(),
    schedule: DrugScheduleSchema.default('OTC'),
    requires_prescription: z.boolean().optional(),
    storage: z.enum(['room', 'cool', 'cold']).optional(),
    dosage_form: z
      .enum([
        'tablet',
        'capsule',
        'syrup',
        'injection',
        'ointment',
        'drops',
        'powder',
        'inhaler',
        'device',
        'other',
      ])
      .optional(),
    strength: text(60).optional(),
  })
  .catchall(CustomAttributeValue)

export const ApparelAttributesSchema = z
  .object({
    fabric: text().optional(),
    gender: z.enum(['men', 'women', 'kids', 'unisex']).optional(),
    fit: text(60).optional(),
    sleeve: text(60).optional(),
    pattern: text(60).optional(),
    season: text(60).optional(),
    occasion: text(60).optional(),
  })
  .catchall(CustomAttributeValue)

export const FootwearAttributesSchema = z
  .object({
    gender: z.enum(['men', 'women', 'kids', 'unisex']).optional(),
    material: text(60).optional(),
    sole: text(60).optional(),
    closure: z.enum(['lace', 'velcro', 'slip_on', 'buckle', 'zip', 'strap']).optional(),
    occasion: text(60).optional(),
    size_system: z.enum(['IND', 'UK', 'US', 'EU']).optional(),
  })
  .catchall(CustomAttributeValue)

export const ElectronicsAttributesSchema = z
  .object({
    model: text().optional(),
    warranty_months: z.int().min(0).max(240).optional(),
    /** Capture a serial / IMEI number for every unit sold. */
    serial_tracked: z.boolean().optional(),
  })
  .catchall(CustomAttributeValue)

export const GroceryAttributesSchema = z
  .object({
    /** FSSAI veg (green dot) / non-veg (brown dot) marking. */
    veg: z.boolean().optional(),
    /** Sold loose (unbranded, weighed at the counter). */
    loose: z.boolean().optional(),
    shelf_life_days: z.int().min(0).max(3650).optional(),
  })
  .catchall(CustomAttributeValue)

export const GenericAttributesSchema = z.object({}).catchall(CustomAttributeValue)

export type PharmacyAttributes = z.infer<typeof PharmacyAttributesSchema>
export type ApparelAttributes = z.infer<typeof ApparelAttributesSchema>
export type FootwearAttributes = z.infer<typeof FootwearAttributesSchema>
export type ElectronicsAttributes = z.infer<typeof ElectronicsAttributesSchema>
export type GroceryAttributes = z.infer<typeof GroceryAttributesSchema>

const ATTRIBUTE_SCHEMAS: Readonly<Record<BusinessType, z.ZodType<Record<string, unknown>>>> = {
  general_store: GroceryAttributesSchema,
  supermarket: GroceryAttributesSchema,
  bakery_sweets: GroceryAttributesSchema,
  apparel: ApparelAttributesSchema,
  pharmacy: PharmacyAttributesSchema,
  footwear: FootwearAttributesSchema,
  electronics: ElectronicsAttributesSchema,
  hardware: GenericAttributesSchema,
  stationery: GenericAttributesSchema,
  other: GenericAttributesSchema,
}

export function attributesSchemaFor(
  businessType: BusinessType,
): z.ZodType<Record<string, unknown>> {
  return ATTRIBUTE_SCHEMAS[businessType]
}

/** Validates (and normalises, e.g. pharmacy schedule default) product attributes for a vertical. */
export function validateAttributes(
  businessType: BusinessType,
  attributes: unknown,
): z.ZodSafeParseResult<Record<string, unknown>> {
  return attributesSchemaFor(businessType).safeParse(attributes ?? {})
}

// ---------------------------------------------------------------------------------------------
// Onboarding presets
// ---------------------------------------------------------------------------------------------

export interface CategoryPreset {
  name: string
  name_ta: string
  hsn_code?: string
  gst_rate_bp?: number
  /** Key of a TaxSlabRulePreset of the same vertical (price-slab GST). */
  tax_slab_rule?: string
  /** Suggested unit for new products in the category. */
  default_unit?: string
  children?: readonly CategoryPreset[]
}

export interface TaxSlabRulePreset {
  key: string
  name: string
  name_ta: string
  description: string
  slabs: readonly TaxSlab[]
}

export interface VerticalPreset {
  categories: readonly CategoryPreset[]
  tax_slab_rules: readonly TaxSlabRulePreset[]
  /** Units commonly used in the vertical (shown first in pickers). */
  suggested_units: readonly string[]
}

const c = (
  name: string,
  name_ta: string,
  opts: Omit<CategoryPreset, 'name' | 'name_ta'> = {},
): CategoryPreset => ({ name, name_ta, ...opts })

/** Readymade garments & made-ups: sale value ≤ ₹2,500 per piece → 5%, above → 18% (GST 2.0). */
const APPAREL_SLAB: TaxSlabRulePreset = {
  key: 'apparel_2500',
  name: 'Garments & made-ups (₹2,500 per piece)',
  name_ta: 'ஆடைகள் (ஒரு துண்டுக்கு ₹2,500)',
  description: 'Up to ₹2,500 per piece: 5% GST; above ₹2,500 per piece: 18% GST',
  slabs: [
    { max_unit_value_paise: 250_000, gst_rate_bp: 500 },
    { max_unit_value_paise: null, gst_rate_bp: 1800 },
  ],
}

/** Footwear: sale value ≤ ₹2,500 per pair → 5%, above → 18% (GST 2.0). */
const FOOTWEAR_SLAB: TaxSlabRulePreset = {
  key: 'footwear_2500',
  name: 'Footwear (₹2,500 per pair)',
  name_ta: 'காலணிகள் (ஒரு ஜோடிக்கு ₹2,500)',
  description: 'Up to ₹2,500 per pair: 5% GST; above ₹2,500 per pair: 18% GST',
  slabs: [
    { max_unit_value_paise: 250_000, gst_rate_bp: 500 },
    { max_unit_value_paise: null, gst_rate_bp: 1800 },
  ],
}

// Packaged & labelled food staples are 5%; loose unbranded staples (rice, pulses, flour) are nil —
// set those products to 0% individually.
const GROCERY_CATEGORIES: readonly CategoryPreset[] = [
  c('Rice', 'அரிசி', {
    hsn_code: '1006',
    gst_rate_bp: 500,
    default_unit: 'KG',
    children: [
      c('Ponni rice', 'பொன்னி அரிசி'),
      c('Idli rice', 'இட்லி அரிசி'),
      c('Raw rice', 'பச்சரிசி'),
      c('Basmati rice', 'பாஸ்மதி அரிசி'),
    ],
  }),
  c('Pulses & dals', 'பருப்பு வகைகள்', {
    hsn_code: '0713',
    gst_rate_bp: 500,
    default_unit: 'KG',
    children: [
      c('Toor dal', 'துவரம் பருப்பு'),
      c('Urad dal', 'உளுத்தம் பருப்பு'),
      c('Chana dal', 'கடலைப் பருப்பு'),
      c('Moong dal', 'பாசிப் பருப்பு'),
    ],
  }),
  c('Edible oils', 'சமையல் எண்ணெய்', {
    hsn_code: '1508',
    gst_rate_bp: 500,
    default_unit: 'L',
    children: [
      c('Groundnut oil', 'கடலை எண்ணெய்', { hsn_code: '1508' }),
      c('Gingelly oil', 'நல்லெண்ணெய்', { hsn_code: '1515' }),
      c('Coconut oil', 'தேங்காய் எண்ணெய்', { hsn_code: '1513' }),
      c('Sunflower oil', 'சூரியகாந்தி எண்ணெய்', { hsn_code: '1512' }),
      c('Palm oil', 'பாமாயில்', { hsn_code: '1511' }),
    ],
  }),
  c('Spices & masala', 'மசாலா பொருட்கள்', {
    hsn_code: '0910',
    gst_rate_bp: 500,
    children: [
      c('Chillies', 'மிளகாய்', { hsn_code: '0904' }),
      c('Turmeric', 'மஞ்சள்', { hsn_code: '0910' }),
      c('Pepper & cumin', 'மிளகு & சீரகம்', { hsn_code: '0904' }),
      c('Masala powders', 'மசாலா பொடிகள்', { hsn_code: '0910' }),
    ],
  }),
  c('Flours & rava', 'மாவு & ரவை', {
    hsn_code: '1101',
    gst_rate_bp: 500,
    default_unit: 'KG',
    children: [
      c('Wheat atta', 'கோதுமை மாவு', { hsn_code: '1101' }),
      c('Rice flour', 'அரிசி மாவு', { hsn_code: '1102' }),
      c('Rava / sooji', 'ரவை', { hsn_code: '1103' }),
      c('Maida', 'மைதா', { hsn_code: '1101' }),
    ],
  }),
  c('Sugar & jaggery', 'சர்க்கரை & வெல்லம்', {
    hsn_code: '1701',
    gst_rate_bp: 500,
    default_unit: 'KG',
  }),
  c('Salt', 'உப்பு', { hsn_code: '2501', gst_rate_bp: 0, default_unit: 'KG' }),
  c('Tea & coffee', 'டீ & காபி', {
    hsn_code: '0902',
    gst_rate_bp: 500,
    children: [
      c('Tea', 'டீ தூள்', { hsn_code: '0902' }),
      c('Coffee', 'காபி தூள்', { hsn_code: '0901' }),
    ],
  }),
  c('Biscuits & snacks', 'பிஸ்கட் & தின்பண்டங்கள்', {
    hsn_code: '1905',
    gst_rate_bp: 500,
    children: [
      c('Biscuits', 'பிஸ்கட்', { hsn_code: '1905' }),
      c('Murukku & mixture', 'முறுக்கு & மிக்சர்', { hsn_code: '2106' }),
      c('Chocolates', 'சாக்லேட்', { hsn_code: '1806' }),
    ],
  }),
  c('Dairy', 'பால் பொருட்கள்', {
    hsn_code: '0405',
    gst_rate_bp: 500,
    children: [
      c('Milk', 'பால்', { hsn_code: '0401', gst_rate_bp: 0, default_unit: 'L' }),
      c('Curd & buttermilk', 'தயிர் & மோர்', { hsn_code: '0403', gst_rate_bp: 500 }),
      c('Ghee & butter', 'நெய் & வெண்ணெய்', { hsn_code: '0405', gst_rate_bp: 500 }),
      c('Paneer', 'பனீர்', { hsn_code: '0406', gst_rate_bp: 0 }),
    ],
  }),
  c('Dry fruits & nuts', 'உலர் பழங்கள் & பருப்புகள்', { hsn_code: '0801', gst_rate_bp: 500 }),
  c('Instant foods', 'உடனடி உணவுகள்', { hsn_code: '1902', gst_rate_bp: 500 }),
  c('Beverages', 'பானங்கள்', {
    hsn_code: '2202',
    gst_rate_bp: 4000,
    children: [
      c('Aerated drinks', 'காற்றடைத்த பானங்கள்', { hsn_code: '2202', gst_rate_bp: 4000 }),
      c('Fruit juices', 'பழச்சாறுகள்', { hsn_code: '2009', gst_rate_bp: 500 }),
      c('Packaged drinking water', 'குடிநீர் பாட்டில்', { hsn_code: '2201', gst_rate_bp: 500 }),
    ],
  }),
  c('Soaps & shampoo', 'சோப்பு & ஷாம்பு', {
    hsn_code: '3401',
    gst_rate_bp: 500,
    children: [
      c('Bath soaps', 'குளியல் சோப்பு', { hsn_code: '3401' }),
      c('Shampoo', 'ஷாம்பு', { hsn_code: '3305' }),
      c('Hair oil', 'தலை எண்ணெய்', { hsn_code: '3305' }),
      c('Toothpaste & brushes', 'பற்பசை & பிரஷ்', { hsn_code: '3306' }),
    ],
  }),
  c('Household cleaning', 'வீட்டு சுத்தம்', {
    hsn_code: '3402',
    gst_rate_bp: 1800,
    children: [
      c('Detergents', 'சலவைத் தூள் & சோப்பு', { hsn_code: '3402' }),
      c('Dishwash', 'பாத்திரம் கழுவும் பொருட்கள்', { hsn_code: '3402' }),
      c('Floor cleaners', 'தரை சுத்திகரிப்பான்', { hsn_code: '3402' }),
    ],
  }),
  c('Pooja items', 'பூஜை பொருட்கள்', {
    hsn_code: '3307',
    gst_rate_bp: 500,
    children: [
      c('Agarbatti', 'ஊதுபத்தி', { hsn_code: '3307', gst_rate_bp: 500 }),
      c('Camphor', 'கற்பூரம்', { hsn_code: '2914', gst_rate_bp: 1800 }),
    ],
  }),
]

const SUPERMARKET_EXTRA: readonly CategoryPreset[] = [
  c('Vegetables', 'காய்கறிகள்', { hsn_code: '0709', gst_rate_bp: 0, default_unit: 'KG' }),
  c('Fruits', 'பழங்கள்', { hsn_code: '0810', gst_rate_bp: 0, default_unit: 'KG' }),
  c('Eggs', 'முட்டைகள்', { hsn_code: '0407', gst_rate_bp: 0 }),
  c('Frozen foods', 'உறைந்த உணவுகள்', { hsn_code: '0710', gst_rate_bp: 500 }),
  c('Bakery', 'பேக்கரி', {
    hsn_code: '1905',
    gst_rate_bp: 500,
    children: [
      c('Bread', 'ரொட்டி', { hsn_code: '1905', gst_rate_bp: 0 }),
      c('Cakes & buns', 'கேக் & பன்', { hsn_code: '1905', gst_rate_bp: 500 }),
    ],
  }),
  c('Personal care', 'தனிநபர் பராமரிப்பு', { hsn_code: '3304', gst_rate_bp: 1800 }),
  c('Baby care', 'குழந்தை பராமரிப்பு', { hsn_code: '9619', gst_rate_bp: 500 }),
  c('Kitchenware & household', 'சமையலறை & வீட்டு உபயோகப் பொருட்கள்', {
    hsn_code: '7323',
    gst_rate_bp: 500,
    children: [
      c('Steel utensils', 'எவர்சில்வர் பாத்திரங்கள்', { hsn_code: '7323', gst_rate_bp: 500 }),
      c('Plastic ware', 'பிளாஸ்டிக் பொருட்கள்', { hsn_code: '3924', gst_rate_bp: 1800 }),
    ],
  }),
]

export const VERTICAL_PRESETS: Readonly<Record<BusinessType, VerticalPreset>> = {
  general_store: {
    categories: GROCERY_CATEGORIES,
    tax_slab_rules: [],
    suggested_units: ['PCS', 'KG', 'G', 'L', 'ML', 'PKT', 'BAG', 'BTL'],
  },
  supermarket: {
    categories: [...GROCERY_CATEGORIES, ...SUPERMARKET_EXTRA],
    tax_slab_rules: [],
    suggested_units: ['PCS', 'KG', 'G', 'L', 'ML', 'PKT', 'BOX', 'DOZ', 'BTL'],
  },
  apparel: {
    categories: [
      // Sarees, dhotis and fabric are woven fabrics (chapters 50–55): 5% irrespective of value.
      c('Sarees', 'புடவைகள்', {
        hsn_code: '5007',
        gst_rate_bp: 500,
        default_unit: 'PCS',
        children: [
          c('Silk sarees', 'பட்டுப் புடவைகள்', { hsn_code: '5007' }),
          c('Cotton sarees', 'காட்டன் புடவைகள்', { hsn_code: '5208' }),
          c('Fancy sarees', 'ஃபேன்சி புடவைகள்', { hsn_code: '5407' }),
        ],
      }),
      c('Dhotis & lungis', 'வேட்டி & லுங்கி', {
        hsn_code: '5208',
        gst_rate_bp: 500,
        default_unit: 'PCS',
        children: [c('Dhotis', 'வேட்டிகள்'), c('Lungis', 'லுங்கிகள்')],
      }),
      c("Men's wear", 'ஆண்கள் ஆடைகள்', {
        hsn_code: '6205',
        tax_slab_rule: 'apparel_2500',
        children: [
          c('Shirts', 'சட்டைகள்', { hsn_code: '6205', tax_slab_rule: 'apparel_2500' }),
          c('Trousers & jeans', 'பேன்ட் & ஜீன்ஸ்', {
            hsn_code: '6203',
            tax_slab_rule: 'apparel_2500',
          }),
          c('T-shirts', 'டி-ஷர்ட்கள்', { hsn_code: '6109', tax_slab_rule: 'apparel_2500' }),
        ],
      }),
      c("Women's wear", 'பெண்கள் ஆடைகள்', {
        hsn_code: '6204',
        tax_slab_rule: 'apparel_2500',
        children: [
          c('Churidar & salwar', 'சுடிதார் & சல்வார்', {
            hsn_code: '6204',
            tax_slab_rule: 'apparel_2500',
          }),
          c('Kurtis & tops', 'குர்திகள் & டாப்ஸ்', {
            hsn_code: '6206',
            tax_slab_rule: 'apparel_2500',
          }),
          c('Nighties', 'நைட்டிகள்', { hsn_code: '6108', tax_slab_rule: 'apparel_2500' }),
          c('Blouses & skirts', 'ரவிக்கை & பாவாடை', {
            hsn_code: '6206',
            tax_slab_rule: 'apparel_2500',
          }),
        ],
      }),
      c("Kids' wear", 'குழந்தைகள் ஆடைகள்', { hsn_code: '6209', tax_slab_rule: 'apparel_2500' }),
      c('Innerwear', 'உள்ளாடைகள்', {
        hsn_code: '6107',
        tax_slab_rule: 'apparel_2500',
        children: [
          c("Men's innerwear", 'ஆண்கள் உள்ளாடைகள்', {
            hsn_code: '6107',
            tax_slab_rule: 'apparel_2500',
          }),
          c("Women's innerwear", 'பெண்கள் உள்ளாடைகள்', {
            hsn_code: '6212',
            tax_slab_rule: 'apparel_2500',
          }),
        ],
      }),
      c('Fabric (by metre)', 'துணி (மீட்டர்)', {
        hsn_code: '5208',
        gst_rate_bp: 500,
        default_unit: 'M',
        children: [
          c('Shirting', 'சட்டைத் துணி', { hsn_code: '5208' }),
          c('Suiting', 'பேன்ட் துணி', { hsn_code: '5515' }),
          c('Blouse material', 'ரவிக்கைத் துணி', { hsn_code: '5208' }),
        ],
      }),
      c('Towels & bedsheets', 'துண்டு & படுக்கை விரிப்புகள்', {
        hsn_code: '6302',
        tax_slab_rule: 'apparel_2500',
      }),
    ],
    tax_slab_rules: [APPAREL_SLAB],
    suggested_units: ['PCS', 'M', 'SET', 'PAIR'],
  },
  pharmacy: {
    categories: [
      c('Medicines', 'மருந்துகள்', {
        hsn_code: '3004',
        gst_rate_bp: 500,
        default_unit: 'TAB',
        children: [
          c('Tablets & capsules', 'மாத்திரைகள் & கேப்சூல்கள்', {
            hsn_code: '3004',
            default_unit: 'TAB',
          }),
          c('Syrups & liquids', 'சிரப் & திரவ மருந்துகள்', {
            hsn_code: '3004',
            default_unit: 'BTL',
          }),
          c('Injections', 'ஊசி மருந்துகள்', { hsn_code: '3004', default_unit: 'VIAL' }),
          c('Ointments & creams', 'களிம்பு & கிரீம்கள்', {
            hsn_code: '3004',
            default_unit: 'TUBE',
          }),
          c('Drops', 'சொட்டு மருந்துகள்', { hsn_code: '3004', default_unit: 'BTL' }),
        ],
      }),
      c('Surgical supplies', 'சர்ஜிகல் பொருட்கள்', {
        hsn_code: '3005',
        gst_rate_bp: 500,
        children: [
          c('Bandages & gauze', 'பேண்டேஜ் & காஸ்', { hsn_code: '3005' }),
          c('Syringes & needles', 'சிரிஞ்ச் & ஊசிகள்', { hsn_code: '9018' }),
          c('Gloves & masks', 'கையுறைகள் & முகக்கவசங்கள்', { hsn_code: '4015' }),
        ],
      }),
      c('OTC & wellness', 'OTC & நலவாழ்வு', {
        hsn_code: '3004',
        gst_rate_bp: 500,
        children: [
          c('Pain relief', 'வலி நிவாரணிகள்', { hsn_code: '3004', gst_rate_bp: 500 }),
          c('Health supplements', 'சத்து & சப்ளிமெண்ட்ஸ்', { hsn_code: '2106', gst_rate_bp: 1800 }),
        ],
      }),
      c('Baby care', 'குழந்தை பராமரிப்பு', {
        hsn_code: '9619',
        gst_rate_bp: 500,
        children: [
          c('Diapers', 'டயப்பர்கள்', { hsn_code: '9619' }),
          c('Baby food', 'குழந்தை உணவு', { hsn_code: '1901' }),
        ],
      }),
      c('Siddha & Ayurveda', 'சித்தா & ஆயுர்வேதம்', { hsn_code: '3004', gst_rate_bp: 500 }),
      c('Medical devices', 'மருத்துவ சாதனங்கள்', {
        hsn_code: '9018',
        gst_rate_bp: 500,
        children: [
          c('BP monitors & glucometers', 'BP & சர்க்கரை அளவீட்டுக் கருவிகள்', { hsn_code: '9018' }),
          c('Thermometers', 'வெப்பமானிகள்', { hsn_code: '9025' }),
        ],
      }),
      c('Personal care & cosmetics', 'தனிநபர் பராமரிப்பு & அழகுப் பொருட்கள்', {
        hsn_code: '3304',
        gst_rate_bp: 1800,
      }),
    ],
    tax_slab_rules: [],
    suggested_units: ['TAB', 'CAP', 'STRIP', 'BTL', 'TUBE', 'VIAL', 'SACHET', 'PCS', 'BOX'],
  },
  footwear: {
    categories: [
      c("Men's footwear", 'ஆண்கள் காலணிகள்', {
        hsn_code: '6403',
        tax_slab_rule: 'footwear_2500',
        default_unit: 'PAIR',
        children: [
          c('Shoes', 'ஷூக்கள்', { hsn_code: '6403', tax_slab_rule: 'footwear_2500' }),
          c('Sandals & chappals', 'செருப்புகள்', {
            hsn_code: '6402',
            tax_slab_rule: 'footwear_2500',
          }),
        ],
      }),
      c("Women's footwear", 'பெண்கள் காலணிகள்', {
        hsn_code: '6402',
        tax_slab_rule: 'footwear_2500',
        default_unit: 'PAIR',
      }),
      c("Kids' footwear", 'குழந்தைகள் காலணிகள்', {
        hsn_code: '6402',
        tax_slab_rule: 'footwear_2500',
        default_unit: 'PAIR',
      }),
      c('Sports shoes', 'விளையாட்டுக் காலணிகள்', {
        hsn_code: '6404',
        tax_slab_rule: 'footwear_2500',
        default_unit: 'PAIR',
      }),
      c('Socks & shoe care', 'காலுறைகள் & ஷூ பராமரிப்பு', {
        children: [
          c('Socks', 'காலுறைகள்', {
            hsn_code: '6115',
            tax_slab_rule: 'apparel_2500',
            default_unit: 'PAIR',
          }),
          c('Polish & accessories', 'பாலிஷ் & உபகரணங்கள்', { hsn_code: '3405', gst_rate_bp: 1800 }),
        ],
      }),
    ],
    tax_slab_rules: [FOOTWEAR_SLAB, APPAREL_SLAB],
    suggested_units: ['PAIR', 'PCS'],
  },
  electronics: {
    categories: [
      c('Mobile phones', 'மொபைல் போன்கள்', { hsn_code: '8517', gst_rate_bp: 1800 }),
      c('Mobile accessories', 'மொபைல் உபகரணங்கள்', {
        hsn_code: '8504',
        gst_rate_bp: 1800,
        children: [
          c('Chargers & cables', 'சார்ஜர் & கேபிள்கள்', { hsn_code: '8504' }),
          c('Earphones & speakers', 'இயர்போன் & ஸ்பீக்கர்கள்', { hsn_code: '8518' }),
          c('Covers & screen guards', 'கவர் & ஸ்கிரீன் கார்டு', { hsn_code: '3926' }),
        ],
      }),
      c('TV & audio', 'டிவி & ஆடியோ', { hsn_code: '8528', gst_rate_bp: 1800 }),
      c('Home appliances', 'வீட்டு மின் சாதனங்கள்', {
        hsn_code: '8516',
        gst_rate_bp: 1800,
        children: [
          c('Mixer grinders', 'மிக்ஸி & கிரைண்டர்', { hsn_code: '8509' }),
          c('Fans', 'மின்விசிறிகள்', { hsn_code: '8414' }),
          c('Iron boxes', 'இஸ்திரிப் பெட்டிகள்', { hsn_code: '8516' }),
        ],
      }),
      c('Lighting & electricals', 'விளக்குகள் & மின் பொருட்கள்', {
        hsn_code: '9405',
        gst_rate_bp: 1800,
      }),
      c('Computer accessories', 'கணினி உபகரணங்கள்', { hsn_code: '8471', gst_rate_bp: 1800 }),
      c('Batteries', 'பேட்டரிகள்', { hsn_code: '8506', gst_rate_bp: 1800 }),
    ],
    tax_slab_rules: [],
    suggested_units: ['PCS', 'SET', 'BOX', 'M'],
  },
  hardware: {
    categories: [
      c('Hand tools', 'கைக்கருவிகள்', { hsn_code: '8205', gst_rate_bp: 1800 }),
      c('Paints', 'பெயிண்ட் & வண்ணங்கள்', {
        hsn_code: '3209',
        gst_rate_bp: 1800,
        default_unit: 'L',
      }),
      c('Plumbing & sanitary', 'பிளம்பிங் & சானிட்டரி', {
        hsn_code: '3917',
        gst_rate_bp: 1800,
        children: [
          c('PVC pipes & fittings', 'PVC குழாய்கள் & இணைப்புகள்', { hsn_code: '3917' }),
          c('Sanitaryware', 'சானிட்டரி பொருட்கள்', { hsn_code: '6910' }),
        ],
      }),
      c('Electricals', 'மின் பொருட்கள்', {
        hsn_code: '8544',
        gst_rate_bp: 1800,
        children: [
          c('Wires & cables', 'மின் கம்பிகள்', { hsn_code: '8544', default_unit: 'M' }),
          c('Switches & sockets', 'சுவிட்சுகள் & சாக்கெட்டுகள்', { hsn_code: '8536' }),
        ],
      }),
      c('Cement', 'சிமெண்ட்', { hsn_code: '2523', gst_rate_bp: 1800, default_unit: 'BAG' }),
      c('Fasteners', 'ஸ்க்ரூ, ஆணி & போல்ட்', {
        hsn_code: '7318',
        gst_rate_bp: 1800,
        children: [
          c('Screws & bolts', 'ஸ்க்ரூ & போல்ட்', { hsn_code: '7318' }),
          c('Nails', 'ஆணிகள்', { hsn_code: '7317', default_unit: 'KG' }),
        ],
      }),
    ],
    tax_slab_rules: [],
    suggested_units: ['PCS', 'KG', 'M', 'L', 'BAG', 'BOX', 'SQFT', 'ROLL', 'BUNDLE'],
  },
  bakery_sweets: {
    categories: [
      c('Bread & buns', 'ரொட்டி & பன்', {
        hsn_code: '1905',
        gst_rate_bp: 500,
        children: [
          c('Bread', 'ரொட்டி', { hsn_code: '1905', gst_rate_bp: 0 }),
          c('Buns & rusk', 'பன் & ரஸ்க்', { hsn_code: '1905', gst_rate_bp: 500 }),
        ],
      }),
      c('Cakes & pastries', 'கேக் & பேஸ்ட்ரி', { hsn_code: '1905', gst_rate_bp: 500 }),
      c('Sweets', 'இனிப்புகள்', { hsn_code: '1704', gst_rate_bp: 500, default_unit: 'KG' }),
      c('Savouries', 'கார வகைகள்', { hsn_code: '2106', gst_rate_bp: 500, default_unit: 'KG' }),
      c('Biscuits & cookies', 'பிஸ்கட் & குக்கீஸ்', { hsn_code: '1905', gst_rate_bp: 500 }),
      c('Ice creams', 'ஐஸ்கிரீம்', { hsn_code: '2105', gst_rate_bp: 500 }),
      c('Cold drinks', 'குளிர் பானங்கள்', { hsn_code: '2202', gst_rate_bp: 4000 }),
    ],
    tax_slab_rules: [],
    suggested_units: ['PCS', 'KG', 'G', 'PKT', 'BOX'],
  },
  stationery: {
    categories: [
      c('Notebooks', 'நோட்டுப் புத்தகங்கள்', { hsn_code: '4820', gst_rate_bp: 0 }),
      c('Pens & pencils', 'பேனா & பென்சில்', {
        children: [
          c('Pens', 'பேனாக்கள்', { hsn_code: '9608', gst_rate_bp: 1800 }),
          c('Pencils, erasers & sharpeners', 'பென்சில், அழிப்பான் & ஷார்ப்னர்', {
            hsn_code: '9609',
            gst_rate_bp: 0,
          }),
        ],
      }),
      c('Office supplies', 'அலுவலகப் பொருட்கள்', { hsn_code: '4802', gst_rate_bp: 1800 }),
      c('Art & craft', 'கலை & கைவினைப் பொருட்கள்', { hsn_code: '3213', gst_rate_bp: 1800 }),
      c('Books', 'புத்தகங்கள்', { hsn_code: '4901', gst_rate_bp: 0 }),
      c('School bags', 'பள்ளிப் பைகள்', { hsn_code: '4202', gst_rate_bp: 1800 }),
      c('Gifts & toys', 'பரிசுப் பொருட்கள் & பொம்மைகள்', { hsn_code: '9503', gst_rate_bp: 500 }),
    ],
    tax_slab_rules: [],
    suggested_units: ['PCS', 'PKT', 'BOX', 'SET', 'DOZ'],
  },
  other: {
    categories: [
      c('General items', 'பொதுப் பொருட்கள்'),
      c('Services', 'சேவைகள்', { hsn_code: '998729', gst_rate_bp: 1800 }),
    ],
    tax_slab_rules: [],
    suggested_units: ['PCS', 'KG', 'L', 'M'],
  },
}

export interface FlatCategoryPreset extends Omit<CategoryPreset, 'children'> {
  /** Name of the parent category (null for top level); names are unique per level. */
  parent_name: string | null
  sort_order: number
}

/** Flattens a preset tree parent-first, for inserting categories in order during onboarding. */
export function flattenCategoryPresets(
  categories: readonly CategoryPreset[],
): FlatCategoryPreset[] {
  const out: FlatCategoryPreset[] = []
  const walk = (list: readonly CategoryPreset[], parent: string | null): void => {
    list.forEach((cat, index) => {
      const { children, ...rest } = cat
      out.push({ ...rest, parent_name: parent, sort_order: (index + 1) * 10 })
      if (children) walk(children, cat.name)
    })
  }
  walk(categories, null)
  return out
}
