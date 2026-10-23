/** Vertical attribute fields of the product form (keys of @kadai/shared/verticals schemas). */
import type { BusinessType } from '@kadai/shared/enums'

export type AttrField =
  | { key: string; kind: 'text'; max: number; wide?: boolean }
  | { key: string; kind: 'enum'; options: readonly string[] }
  | { key: string; kind: 'bool' }
  | { key: string; kind: 'int'; min: number; max: number; suffix?: 'months' | 'days' }
  | { key: string; kind: 'veg' }
  | { key: 'schedule'; kind: 'schedule' }

const GENDER = ['men', 'women', 'kids', 'unisex'] as const

const GROCERY: readonly AttrField[] = [
  { key: 'veg', kind: 'veg' },
  { key: 'loose', kind: 'bool' },
  { key: 'shelf_life_days', kind: 'int', min: 0, max: 3650, suffix: 'days' },
]

export const ATTRIBUTE_FIELDS: Readonly<Record<BusinessType, readonly AttrField[]>> = {
  pharmacy: [
    { key: 'generic_name', kind: 'text', max: 200 },
    { key: 'composition', kind: 'text', max: 500, wide: true },
    { key: 'manufacturer', kind: 'text', max: 200 },
    { key: 'marketed_by', kind: 'text', max: 200 },
    { key: 'strength', kind: 'text', max: 60 },
    {
      key: 'dosage_form',
      kind: 'enum',
      options: [
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
      ],
    },
    { key: 'storage', kind: 'enum', options: ['room', 'cool', 'cold'] },
    { key: 'schedule', kind: 'schedule' },
    { key: 'requires_prescription', kind: 'bool' },
  ],
  apparel: [
    { key: 'fabric', kind: 'text', max: 120 },
    { key: 'gender', kind: 'enum', options: GENDER },
    { key: 'fit', kind: 'text', max: 60 },
    { key: 'sleeve', kind: 'text', max: 60 },
    { key: 'pattern', kind: 'text', max: 60 },
    { key: 'occasion', kind: 'text', max: 60 },
    { key: 'season', kind: 'text', max: 60 },
  ],
  footwear: [
    { key: 'gender', kind: 'enum', options: GENDER },
    { key: 'material', kind: 'text', max: 60 },
    { key: 'sole', kind: 'text', max: 60 },
    {
      key: 'closure',
      kind: 'enum',
      options: ['lace', 'velcro', 'slip_on', 'buckle', 'zip', 'strap'],
    },
    { key: 'occasion', kind: 'text', max: 60 },
    { key: 'size_system', kind: 'enum', options: ['IND', 'UK', 'US', 'EU'] },
  ],
  electronics: [
    { key: 'model', kind: 'text', max: 120 },
    { key: 'warranty_months', kind: 'int', min: 0, max: 240, suffix: 'months' },
    { key: 'serial_tracked', kind: 'bool' },
  ],
  general_store: GROCERY,
  supermarket: GROCERY,
  bakery_sweets: GROCERY,
  hardware: [],
  stationery: [],
  other: [],
}
