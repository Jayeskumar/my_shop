/**
 * Modal dialog (Radix). Simple form:
 *
 *   <Dialog open={open} onOpenChange={setOpen} title="Change password" description="…"
 *           footer={<Button>Save</Button>} size="md">…</Dialog>
 *
 * Page hotkeys are suspended while open (hotkey scope 'dialog'). Primitives are exported for
 * custom layouts (DialogRoot, DialogTrigger, DialogContent, DialogHeader, DialogFooter, …).
 */
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { cva, type VariantProps } from 'class-variance-authority'
import { X } from 'lucide-react'
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type HTMLAttributes, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { useHotkeyScope } from '@/lib/hotkeys'

export const DialogRoot = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close
export const DialogPortal = DialogPrimitive.Portal

export const DialogOverlay = forwardRef<
  ElementRef<typeof DialogPrimitive.Overlay>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(function DialogOverlay({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Overlay
      ref={ref}
      className={cn(
        'fixed inset-0 z-50 bg-overlay backdrop-blur-[2px] data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out',
        className,
      )}
      {...props}
    />
  )
})

const contentVariants = cva(
  [
    'fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col',
    'rounded-xl border border-border bg-surface text-foreground shadow-overlay outline-none',
    'data-[state=open]:animate-zoom-in data-[state=closed]:animate-zoom-out',
  ],
  {
    variants: {
      size: {
        sm: 'max-w-sm',
        md: 'max-w-lg',
        lg: 'max-w-2xl',
        xl: 'max-w-4xl',
        full: 'h-[calc(100dvh-2rem)] max-w-[calc(100vw-2rem)]',
      },
    },
    defaultVariants: { size: 'md' },
  },
)

export interface DialogContentProps
  extends ComponentPropsWithoutRef<typeof DialogPrimitive.Content>,
    VariantProps<typeof contentVariants> {
  hideClose?: boolean
}

function DialogHotkeyScope() {
  useHotkeyScope('dialog')
  return null
}

export const DialogContent = forwardRef<ElementRef<typeof DialogPrimitive.Content>, DialogContentProps>(
  function DialogContent({ className, children, size, hideClose, ...props }, ref) {
    const { t } = useTranslation()
    return (
      <DialogPrimitive.Portal>
        <DialogOverlay />
        <DialogPrimitive.Content ref={ref} className={cn(contentVariants({ size }), className)} {...props}>
          <DialogHotkeyScope />
          {children}
          {!hideClose ? (
            <DialogPrimitive.Close
              className="absolute end-3 top-3 inline-flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              aria-label={t('a11y.close')}
            >
              <X className="size-5" />
            </DialogPrimitive.Close>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    )
  },
)

export function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1.5 px-5 pb-2 pt-5 pe-14', className)} {...props} />
}

export function DialogBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('min-h-0 flex-1 overflow-y-auto px-5 py-3', className)} {...props} />
}

export function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex flex-col-reverse gap-2 border-t border-border px-5 py-4 sm:flex-row sm:justify-end',
        className,
      )}
      {...props}
    />
  )
}

export const DialogTitle = forwardRef<
  ElementRef<typeof DialogPrimitive.Title>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(function DialogTitle({ className, ...props }, ref) {
  return <DialogPrimitive.Title ref={ref} className={cn('text-lg font-semibold leading-snug', className)} {...props} />
})

export const DialogDescription = forwardRef<
  ElementRef<typeof DialogPrimitive.Description>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(function DialogDescription({ className, ...props }, ref) {
  return <DialogPrimitive.Description ref={ref} className={cn('text-sm text-muted-foreground', className)} {...props} />
})

export interface DialogProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  /** Element that opens the dialog (uncontrolled use). */
  trigger?: ReactNode
  footer?: ReactNode
  size?: DialogContentProps['size']
  children?: ReactNode
  className?: string
  bodyClassName?: string
  /** Prevent closing by outside click (forms with unsaved input). */
  dismissible?: boolean
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  trigger,
  footer,
  size,
  children,
  className,
  bodyClassName,
  dismissible = true,
}: DialogProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger> : null}
      <DialogContent
        size={size}
        className={className}
        onInteractOutside={dismissible ? undefined : (e) => e.preventDefault()}
        {...(description ? {} : { 'aria-describedby': undefined })}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {children ? <DialogBody className={bodyClassName}>{children}</DialogBody> : null}
        {footer ? <DialogFooter>{footer}</DialogFooter> : null}
      </DialogContent>
    </DialogPrimitive.Root>
  )
}
