/**
 * A router link styled as a Button, with its icon (Button's `leftIcon` is not rendered in
 * `asChild` mode). `compact` hides the label on phones (the label stays as the accessible name).
 */
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Button, type ButtonProps } from '@/components/ui'

export interface LinkButtonProps {
  to: string
  icon?: ReactNode
  children: ReactNode
  variant?: ButtonProps['variant']
  size?: ButtonProps['size']
  compact?: boolean
  className?: string
}

export function LinkButton({
  to,
  icon,
  children,
  variant,
  size,
  compact,
  className,
}: LinkButtonProps) {
  return (
    <Button asChild variant={variant} size={size} className={className}>
      <Link to={to} aria-label={compact && typeof children === 'string' ? children : undefined}>
        {icon}
        {compact ? <span className="hidden sm:inline">{children}</span> : children}
      </Link>
    </Button>
  )
}
