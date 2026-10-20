import { cva, type VariantProps } from 'class-variance-authority'
import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'

export type Tone = 'neutral' | 'primary' | 'accent' | 'success' | 'warning' | 'danger' | 'info'

export const badgeVariants = cva(
  'inline-flex items-center gap-1 whitespace-nowrap rounded-full border font-medium leading-none [&_svg]:size-3.5',
  {
    variants: {
      tone: {
        neutral: '',
        primary: '',
        accent: '',
        success: '',
        warning: '',
        danger: '',
        info: '',
      },
      appearance: { soft: '', solid: '', outline: 'bg-transparent' },
      size: { sm: 'px-2 py-0.5 text-[11px]', md: 'px-2.5 py-1 text-xs', lg: 'px-3 py-1.5 text-sm' },
    },
    compoundVariants: [
      { appearance: 'soft', tone: 'neutral', className: 'border-transparent bg-surface-2 text-foreground' },
      { appearance: 'soft', tone: 'primary', className: 'border-transparent bg-primary-soft text-primary-soft-foreground' },
      { appearance: 'soft', tone: 'accent', className: 'border-transparent bg-accent-soft text-accent-soft-foreground' },
      { appearance: 'soft', tone: 'success', className: 'border-transparent bg-success-soft text-success-soft-foreground' },
      { appearance: 'soft', tone: 'warning', className: 'border-transparent bg-warning-soft text-warning-soft-foreground' },
      { appearance: 'soft', tone: 'danger', className: 'border-transparent bg-danger-soft text-danger-soft-foreground' },
      { appearance: 'soft', tone: 'info', className: 'border-transparent bg-info-soft text-info-soft-foreground' },
      { appearance: 'solid', tone: 'neutral', className: 'border-transparent bg-foreground text-background' },
      { appearance: 'solid', tone: 'primary', className: 'border-transparent bg-primary text-primary-foreground' },
      { appearance: 'solid', tone: 'accent', className: 'border-transparent bg-accent text-accent-foreground' },
      { appearance: 'solid', tone: 'success', className: 'border-transparent bg-success text-success-foreground' },
      { appearance: 'solid', tone: 'warning', className: 'border-transparent bg-warning text-warning-foreground' },
      { appearance: 'solid', tone: 'danger', className: 'border-transparent bg-danger text-danger-foreground' },
      { appearance: 'solid', tone: 'info', className: 'border-transparent bg-info text-info-foreground' },
      { appearance: 'outline', tone: 'neutral', className: 'border-input text-foreground' },
      { appearance: 'outline', tone: 'primary', className: 'border-primary/50 text-primary' },
      { appearance: 'outline', tone: 'accent', className: 'border-accent/60 text-accent-soft-foreground' },
      { appearance: 'outline', tone: 'success', className: 'border-success/50 text-success' },
      { appearance: 'outline', tone: 'warning', className: 'border-warning/50 text-warning' },
      { appearance: 'outline', tone: 'danger', className: 'border-danger/50 text-danger' },
      { appearance: 'outline', tone: 'info', className: 'border-info/50 text-info' },
    ],
    defaultVariants: { tone: 'neutral', appearance: 'soft', size: 'md' },
  },
)

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {
  icon?: ReactNode
  /** Shows a coloured dot before the text. */
  dot?: boolean
}

const dotColor: Record<Tone, string> = {
  neutral: 'bg-muted-foreground',
  primary: 'bg-primary',
  accent: 'bg-accent',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
}

export function Badge({ className, tone, appearance, size, icon, dot, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ tone, appearance, size }), className)} {...props}>
      {dot ? <span className={cn('size-1.5 rounded-full', dotColor[tone ?? 'neutral'])} aria-hidden /> : null}
      {icon}
      {children}
    </span>
  )
}

/**
 * Colour for document / record statuses used across modules (sales, purchases, payments,
 * inventory, notifications, subscriptions). Unknown statuses are neutral.
 */
export function statusTone(status: string): Tone {
  switch (status) {
    case 'completed':
    case 'paid':
    case 'posted':
    case 'received':
    case 'delivered':
    case 'read':
    case 'active':
    case 'sent':
    case 'synced':
      return 'success'
    case 'partial':
    case 'partially_received':
    case 'held':
    case 'past_due':
    case 'trialing':
    case 'pending':
    case 'syncing':
    case 'queued':
    case 'sending':
      return 'warning'
    case 'cancelled':
    case 'failed':
    case 'unpaid':
    case 'suspended':
      return 'danger'
    case 'created':
    case 'dispatched':
    case 'open':
    case 'converted':
    case 'refunded':
      return 'info'
    case 'draft':
    case 'expired':
    case 'closed':
    case 'inactive':
    default:
      return 'neutral'
  }
}
