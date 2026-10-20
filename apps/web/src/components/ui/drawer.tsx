/**
 * Side sheet (Radix Dialog). `side`: 'right' (default; detail panels, filters), 'left' (mobile
 * navigation) or 'bottom' (phone action sheets).
 */
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { cva } from 'class-variance-authority'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { useHotkeyScope } from '@/lib/hotkeys'
import { DialogOverlay } from './dialog'

const sheetVariants = cva(
  'fixed z-50 flex flex-col bg-surface text-foreground shadow-overlay outline-none',
  {
    variants: {
      side: {
        right:
          'inset-y-0 end-0 h-full w-[min(28rem,100vw)] border-s border-border data-[state=open]:animate-slide-in-right data-[state=closed]:animate-slide-out-right',
        left:
          'inset-y-0 start-0 h-full w-[min(20rem,88vw)] border-e border-border data-[state=open]:animate-slide-in-left data-[state=closed]:animate-slide-out-left',
        bottom:
          'inset-x-0 bottom-0 max-h-[85dvh] rounded-t-2xl border-t border-border pb-safe data-[state=open]:animate-slide-in-bottom data-[state=closed]:animate-slide-out-bottom',
      },
    },
    defaultVariants: { side: 'right' },
  },
)

export interface DrawerProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  side?: 'right' | 'left' | 'bottom'
  title: ReactNode
  description?: ReactNode
  /** Visually hide the header (e.g. navigation drawer with its own branding). */
  hideHeader?: boolean
  trigger?: ReactNode
  footer?: ReactNode
  children?: ReactNode
  className?: string
  bodyClassName?: string
}

function DrawerScope() {
  useHotkeyScope('dialog')
  return null
}

export function Drawer({
  open,
  onOpenChange,
  side = 'right',
  title,
  description,
  hideHeader,
  trigger,
  footer,
  children,
  className,
  bodyClassName,
}: DrawerProps) {
  const { t } = useTranslation()
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger> : null}
      <DialogPrimitive.Portal>
        <DialogOverlay />
        <DialogPrimitive.Content
          className={cn(sheetVariants({ side }), className)}
          {...(description ? {} : { 'aria-describedby': undefined })}
        >
          <DrawerScope />
          {side === 'bottom' ? (
            <div className="mx-auto mt-2 h-1.5 w-10 shrink-0 rounded-full bg-surface-3" aria-hidden />
          ) : null}
          <div
            className={cn(
              'flex items-start justify-between gap-3 border-b border-border px-5 py-4',
              hideHeader && 'sr-only',
            )}
          >
            <div className="grid gap-1">
              <DialogPrimitive.Title className="text-lg font-semibold leading-snug">{title}</DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="text-sm text-muted-foreground">
                  {description}
                </DialogPrimitive.Description>
              ) : null}
            </div>
            <DialogPrimitive.Close
              className="-me-2 -mt-1 inline-flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              aria-label={t('a11y.close')}
            >
              <X className="size-5" />
            </DialogPrimitive.Close>
          </div>
          <div className={cn('min-h-0 flex-1 overflow-y-auto px-5 py-4', bodyClassName)}>{children}</div>
          {footer ? (
            <div className="flex flex-col-reverse gap-2 border-t border-border px-5 py-4 sm:flex-row sm:justify-end">
              {footer}
            </div>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
