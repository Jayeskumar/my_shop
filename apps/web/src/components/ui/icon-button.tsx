import { cva, type VariantProps } from 'class-variance-authority'
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { buttonVariants } from './variants'
import { Spinner } from './spinner'
import { Tooltip } from './tooltip'

const iconSizes = cva('', {
  variants: {
    size: {
      sm: 'size-8 px-0 [&_svg]:size-4',
      md: 'size-10 px-0 [&_svg]:size-5',
      lg: 'size-12 px-0 [&_svg]:size-5',
      xl: 'size-14 px-0 [&_svg]:size-6',
    },
  },
  defaultVariants: { size: 'md' },
})

export interface IconButtonProps
  extends
    Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>,
    VariantProps<typeof iconSizes> {
  icon: ReactNode
  /** Required accessible name; also shown as tooltip unless `tooltip={false}`. */
  label: string
  variant?: 'primary' | 'accent' | 'secondary' | 'outline' | 'ghost' | 'danger'
  tooltip?: boolean
  loading?: boolean
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    icon,
    label,
    variant = 'ghost',
    size,
    tooltip = true,
    loading,
    className,
    disabled,
    type,
    ...props
  },
  ref,
) {
  const button = (
    <button
      ref={ref}
      type={type ?? 'button'}
      aria-label={label}
      disabled={disabled || loading}
      className={cn(
        buttonVariants({ variant, size: size ?? 'md' }),
        iconSizes({ size }),
        'rounded-md',
        className,
      )}
      {...props}
    >
      {loading ? <Spinner size="sm" label="" /> : icon}
    </button>
  )
  return tooltip ? <Tooltip content={label}>{button}</Tooltip> : button
})
