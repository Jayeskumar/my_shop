/**
 * Icon of a payment method (lists, receipts, POS tender buttons). Decorative by default; pass
 * `label` to make it announce the method name.
 */
import {
  Banknote,
  CircleEllipsis,
  CreditCard,
  FileText,
  Gift,
  Landmark,
  type LucideIcon,
  Smartphone,
  Wallet,
} from 'lucide-react'
import type { PaymentMethod } from '@kadai/shared/enums'
import { cn } from '@/lib/cn'

const ICONS: Readonly<Record<PaymentMethod, LucideIcon>> = {
  cash: Banknote,
  upi: Smartphone,
  card: CreditCard,
  bank_transfer: Landmark,
  cheque: FileText,
  wallet: Wallet,
  store_credit: Gift,
  other: CircleEllipsis,
}

const TONES: Readonly<Record<PaymentMethod, string>> = {
  cash: 'text-success',
  upi: 'text-primary',
  card: 'text-info',
  bank_transfer: 'text-info',
  cheque: 'text-muted-foreground',
  wallet: 'text-accent',
  store_credit: 'text-accent',
  other: 'text-muted-foreground',
}

export interface PaymentMethodIconProps {
  method: PaymentMethod
  className?: string
  /** Colour the icon by method (default true). */
  tinted?: boolean
  /** Accessible name; omit for a decorative icon next to a visible label. */
  label?: string
}

export function PaymentMethodIcon({
  method,
  className,
  tinted = true,
  label,
}: PaymentMethodIconProps) {
  const Icon = ICONS[method]
  return (
    <Icon
      className={cn('size-4 shrink-0', tinted && TONES[method], className)}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
    />
  )
}
