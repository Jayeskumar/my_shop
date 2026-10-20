import type { VariantProps } from 'class-variance-authority'
import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { badgeVariants, type Tone } from './variants'



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

