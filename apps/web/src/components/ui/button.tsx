import { Slot } from '@radix-ui/react-slot'
import type { VariantProps } from 'class-variance-authority'
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Spinner } from './spinner'
import { buttonVariants } from './variants'

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /** Render the child element (e.g. a router <Link>) with button styles. */
  asChild?: boolean
  /** Shows a spinner and disables the button (keeps its width). */
  loading?: boolean
  leftIcon?: ReactNode
  rightIcon?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant,
    size,
    fullWidth,
    asChild = false,
    loading = false,
    disabled,
    leftIcon,
    rightIcon,
    children,
    type,
    ...props
  },
  ref,
) {
  const classes = cn(buttonVariants({ variant, size, fullWidth }), className)
  if (asChild) {
    return (
      <Slot
        ref={ref}
        className={classes}
        aria-disabled={disabled || loading || undefined}
        {...props}
      >
        {children}
      </Slot>
    )
  }
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <Spinner size={size === 'xl' || size === 'lg' ? 'md' : 'sm'} label="" />
      ) : (
        leftIcon
      )}
      {children}
      {!loading && rightIcon}
    </button>
  )
})
