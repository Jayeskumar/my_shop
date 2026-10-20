/**
 * Style variants (cva) and status tones shared by UI kit components. Kept apart from the
 * component files so React Fast Refresh can hot-swap components.
 */
import { cva, type VariantProps } from 'class-variance-authority'

export const buttonVariants = cva(
  [
    'inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium select-none',
    'transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
    'disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        primary:
          'bg-primary text-primary-foreground shadow-card hover:bg-primary-hover active:bg-primary-hover',
        accent: 'bg-accent text-accent-foreground shadow-card hover:bg-accent-hover',
        secondary: 'bg-surface-2 text-foreground hover:bg-surface-3',
        outline: 'border border-input bg-surface text-foreground shadow-card hover:bg-surface-2',
        ghost: 'text-foreground hover:bg-surface-2',
        danger: 'bg-danger text-danger-foreground shadow-card hover:bg-danger-hover',
        success: 'bg-success text-success-foreground shadow-card hover:opacity-90',
        link: 'h-auto px-0 text-primary underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-8 rounded-md px-3 text-sm [&_svg]:size-4',
        md: 'h-10 rounded-md px-4 text-sm [&_svg]:size-4',
        lg: 'h-12 rounded-lg px-5 text-base [&_svg]:size-5',
        /** POS counter: large touch targets. */
        xl: 'h-14 rounded-lg px-6 text-lg font-semibold [&_svg]:size-6',
      },
      fullWidth: { true: 'w-full' },
    },
    compoundVariants: [{ variant: 'link', className: 'h-auto px-0' }],
    defaultVariants: { variant: 'primary', size: 'md' },
  },
)

/** Shared look of text-like controls (Input, Textarea, Select trigger, DatePicker…). */
export const fieldVariants = cva(
  [
    'w-full min-w-0 rounded-md border border-input bg-surface text-foreground shadow-card',
    'placeholder:text-muted-foreground/70 transition-[color,box-shadow,border-color]',
    'focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25',
    'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:opacity-70',
    'aria-[invalid=true]:border-danger aria-[invalid=true]:focus-visible:ring-danger/25',
    'read-only:bg-surface-2',
  ],
  {
    variants: {
      size: {
        // 16px text on phones avoids iOS zoom-on-focus; 14px from sm up.
        sm: 'h-8 px-2.5 text-sm',
        md: 'h-10 px-3 text-base sm:text-sm',
        lg: 'h-12 px-3.5 text-base',
        xl: 'h-14 px-4 text-lg font-medium',
      },
    },
    defaultVariants: { size: 'md' },
  },
)

export type FieldSize = NonNullable<VariantProps<typeof fieldVariants>['size']>

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
      {
        appearance: 'soft',
        tone: 'neutral',
        className: 'border-transparent bg-surface-2 text-foreground',
      },
      {
        appearance: 'soft',
        tone: 'primary',
        className: 'border-transparent bg-primary-soft text-primary-soft-foreground',
      },
      {
        appearance: 'soft',
        tone: 'accent',
        className: 'border-transparent bg-accent-soft text-accent-soft-foreground',
      },
      {
        appearance: 'soft',
        tone: 'success',
        className: 'border-transparent bg-success-soft text-success-soft-foreground',
      },
      {
        appearance: 'soft',
        tone: 'warning',
        className: 'border-transparent bg-warning-soft text-warning-soft-foreground',
      },
      {
        appearance: 'soft',
        tone: 'danger',
        className: 'border-transparent bg-danger-soft text-danger-soft-foreground',
      },
      {
        appearance: 'soft',
        tone: 'info',
        className: 'border-transparent bg-info-soft text-info-soft-foreground',
      },
      {
        appearance: 'solid',
        tone: 'neutral',
        className: 'border-transparent bg-foreground text-background',
      },
      {
        appearance: 'solid',
        tone: 'primary',
        className: 'border-transparent bg-primary text-primary-foreground',
      },
      {
        appearance: 'solid',
        tone: 'accent',
        className: 'border-transparent bg-accent text-accent-foreground',
      },
      {
        appearance: 'solid',
        tone: 'success',
        className: 'border-transparent bg-success text-success-foreground',
      },
      {
        appearance: 'solid',
        tone: 'warning',
        className: 'border-transparent bg-warning text-warning-foreground',
      },
      {
        appearance: 'solid',
        tone: 'danger',
        className: 'border-transparent bg-danger text-danger-foreground',
      },
      {
        appearance: 'solid',
        tone: 'info',
        className: 'border-transparent bg-info text-info-foreground',
      },
      { appearance: 'outline', tone: 'neutral', className: 'border-input text-foreground' },
      { appearance: 'outline', tone: 'primary', className: 'border-primary/50 text-primary' },
      {
        appearance: 'outline',
        tone: 'accent',
        className: 'border-accent/60 text-accent-soft-foreground',
      },
      { appearance: 'outline', tone: 'success', className: 'border-success/50 text-success' },
      { appearance: 'outline', tone: 'warning', className: 'border-warning/50 text-warning' },
      { appearance: 'outline', tone: 'danger', className: 'border-danger/50 text-danger' },
      { appearance: 'outline', tone: 'info', className: 'border-info/50 text-info' },
    ],
    defaultVariants: { tone: 'neutral', appearance: 'soft', size: 'md' },
  },
)

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
