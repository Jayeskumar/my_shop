import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { cn } from '@/lib/cn'

export const TooltipProvider = TooltipPrimitive.Provider
export const TooltipRoot = TooltipPrimitive.Root
export const TooltipTrigger = TooltipPrimitive.Trigger

export function TooltipContent({
  className,
  sideOffset = 6,
  ...props
}: ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          'z-50 max-w-xs rounded-md bg-foreground px-2.5 py-1.5 text-xs font-medium text-background shadow-raised',
          'data-[state=delayed-open]:animate-fade-in data-[state=closed]:animate-fade-out',
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  )
}

export interface TooltipProps {
  content: ReactNode
  children: ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  /** Disable without changing the tree (e.g. when a sidebar label is already visible). */
  disabled?: boolean
  delayDuration?: number
}

/** `<Tooltip content="Print (Ctrl+P)"><IconButton … /></Tooltip>` */
export function Tooltip({
  content,
  children,
  side = 'top',
  align,
  disabled,
  delayDuration,
}: TooltipProps) {
  if (disabled || content === null || content === undefined || content === '')
    return <>{children}</>
  return (
    <TooltipPrimitive.Root delayDuration={delayDuration}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipContent side={side} align={align}>
        {content}
      </TooltipContent>
    </TooltipPrimitive.Root>
  )
}
