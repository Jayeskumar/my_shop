import * as RadioGroupPrimitive from '@radix-ui/react-radio-group'
import {
  Building2,
  CakeSlice,
  CheckCircle2,
  Footprints,
  PencilLine,
  Pill,
  Shirt,
  ShoppingCart,
  Smartphone,
  Store,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { BusinessType } from '@kadai/shared/enums'
import { BUSINESS_TYPES } from '@kadai/shared/verticals'
import { cn } from '@/lib/cn'

/** lucide icon per `BusinessTypeDef.icon` name from the shared vertical catalogue. */
const ICONS: Record<string, LucideIcon> = {
  store: Store,
  'shopping-cart': ShoppingCart,
  shirt: Shirt,
  pill: Pill,
  footprints: Footprints,
  smartphone: Smartphone,
  wrench: Wrench,
  'cake-slice': CakeSlice,
  pencil: PencilLine,
  'building-2': Building2,
}

const TINTS = [
  'bg-primary-soft text-primary-soft-foreground',
  'bg-accent-soft text-accent-soft-foreground',
  'bg-info-soft text-info-soft-foreground',
  'bg-success-soft text-success-soft-foreground',
]

export interface BusinessTypePickerProps {
  value: BusinessType | undefined
  onChange: (value: BusinessType) => void
  invalid?: boolean
  'aria-labelledby'?: string
}

/** Shop type cards: Tamil name first, English below, short description. */
export function BusinessTypePicker({ value, onChange, invalid, ...aria }: BusinessTypePickerProps) {
  const { i18n } = useTranslation()
  const ta = i18n.language !== 'en'
  return (
    <RadioGroupPrimitive.Root
      value={value ?? ''}
      onValueChange={(v) => onChange(v as BusinessType)}
      className={cn(
        'grid grid-cols-1 gap-3 min-[420px]:grid-cols-2',
        invalid && 'rounded-xl ring-2 ring-danger/40 ring-offset-4 ring-offset-background',
      )}
      {...aria}
    >
      {BUSINESS_TYPES.map((b, i) => {
        const Icon = ICONS[b.icon] ?? Store
        const selected = value === b.code
        return (
          <RadioGroupPrimitive.Item
            key={b.code}
            value={b.code}
            className={cn(
              'group relative flex items-start gap-3 rounded-xl border bg-surface p-3.5 text-start shadow-card transition-all',
              'hover:border-primary/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
              selected ? 'border-primary bg-primary-soft/50 ring-1 ring-primary' : 'border-border',
            )}
          >
            <span
              className={cn(
                'flex size-11 shrink-0 items-center justify-center rounded-xl',
                TINTS[i % TINTS.length],
              )}
            >
              <Icon className="size-6" aria-hidden />
            </span>
            <span className="flex min-w-0 flex-col gap-0.5 pe-5">
              <span
                lang="ta"
                className="font-tamil text-[15px] font-semibold leading-snug text-foreground"
              >
                {b.name_ta}
              </span>
              <span lang="en" className="text-xs font-medium text-muted-foreground">
                {b.name_en}
              </span>
              <span className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                {ta ? b.description_ta : b.description}
              </span>
            </span>
            <RadioGroupPrimitive.Indicator className="absolute end-3 top-3 text-primary">
              <CheckCircle2 className="size-5" />
            </RadioGroupPrimitive.Indicator>
          </RadioGroupPrimitive.Item>
        )
      })}
    </RadioGroupPrimitive.Root>
  )
}
