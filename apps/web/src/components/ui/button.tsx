import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Spinner } from './spinner'

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
        primary: 'bg-primary text-primary-foreground shadow-card hover:bg-primary-hover active:bg-primary-hover',
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

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
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
      <Slot ref={ref} className={classes} aria-disabled={disabled || loading || undefined} {...props}>
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
      {loading ? <Spinner size={size === 'xl' || size === 'lg' ? 'md' : 'sm'} label="" /> : leftIcon}
      {children}
      {!loading && rightIcon}
    </button>
  )
})
