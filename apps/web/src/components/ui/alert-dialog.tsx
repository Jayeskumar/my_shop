/**
 * AlertDialog primitives (Radix) and ConfirmDialog for destructive / irreversible actions.
 *
 *   <ConfirmDialog open={open} onOpenChange={setOpen} tone="danger"
 *     title={t('confirm.delete_title', { name })} description={t('confirm.delete_description')}
 *     confirmLabel={t('actions.delete')} onConfirm={() => remove.mutateAsync(id)} />
 *
 * Imperative form (needs <ConfirmProvider> — mounted by the app providers):
 *   const confirm = useConfirm()
 *   if (await confirm({ title: '…', tone: 'danger' })) { … }
 */
import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog'
import { AlertTriangle, Info } from 'lucide-react'
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ElementRef,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { useHotkeyScope } from '@/lib/hotkeys'
import { Button } from './button'

export const AlertDialogRoot = AlertDialogPrimitive.Root
export const AlertDialogTrigger = AlertDialogPrimitive.Trigger
export const AlertDialogAction = AlertDialogPrimitive.Action
export const AlertDialogCancel = AlertDialogPrimitive.Cancel
export const AlertDialogTitle = AlertDialogPrimitive.Title
export const AlertDialogDescription = AlertDialogPrimitive.Description

function Scope() {
  useHotkeyScope('dialog')
  return null
}

export const AlertDialogContent = forwardRef<
  ElementRef<typeof AlertDialogPrimitive.Content>,
  ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Content>
>(function AlertDialogContent({ className, children, ...props }, ref) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay backdrop-blur-[2px] data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out" />
      <AlertDialogPrimitive.Content
        ref={ref}
        className={cn(
          'fixed left-1/2 top-1/2 z-50 grid w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl border border-border bg-surface p-5 text-foreground shadow-overlay',
          'data-[state=open]:animate-zoom-in data-[state=closed]:animate-zoom-out',
          className,
        )}
        {...props}
      >
        <Scope />
        {children}
      </AlertDialogPrimitive.Content>
    </AlertDialogPrimitive.Portal>
  )
})

export interface ConfirmOptions {
  title: ReactNode
  description?: ReactNode
  confirmLabel?: ReactNode
  cancelLabel?: ReactNode
  tone?: 'danger' | 'primary'
}

export interface ConfirmDialogProps extends ConfirmOptions {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** May return a promise: the dialog shows a spinner and closes when it resolves. */
  onConfirm: () => void | Promise<unknown>
  /** Extra content between the description and the buttons (e.g. a reason field). */
  children?: ReactNode
  confirmDisabled?: boolean
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  tone = 'primary',
  onConfirm,
  children,
  confirmDisabled,
}: ConfirmDialogProps) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const handleConfirm = async (event: ReactMouseEvent): Promise<void> => {
    event.preventDefault()
    try {
      setBusy(true)
      await onConfirm()
      onOpenChange(false)
    } catch {
      // the caller reports the error (toast); keep the dialog open to retry
    } finally {
      setBusy(false)
    }
  }
  const Icon = tone === 'danger' ? AlertTriangle : Info
  return (
    <AlertDialogPrimitive.Root open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <AlertDialogContent>
        <div className="flex gap-4">
          <span
            className={cn(
              'flex size-10 shrink-0 items-center justify-center rounded-full',
              tone === 'danger' ? 'bg-danger-soft text-danger' : 'bg-primary-soft text-primary',
            )}
          >
            <Icon className="size-5" />
          </span>
          <div className="grid gap-1.5">
            <AlertDialogPrimitive.Title className="text-lg font-semibold leading-snug">{title}</AlertDialogPrimitive.Title>
            {description ? (
              <AlertDialogPrimitive.Description className="text-sm text-muted-foreground">
                {description}
              </AlertDialogPrimitive.Description>
            ) : (
              <AlertDialogPrimitive.Description className="sr-only">{title}</AlertDialogPrimitive.Description>
            )}
          </div>
        </div>
        {children}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <AlertDialogPrimitive.Cancel asChild>
            <Button variant="outline" disabled={busy}>
              {cancelLabel ?? t('actions.cancel')}
            </Button>
          </AlertDialogPrimitive.Cancel>
          <AlertDialogPrimitive.Action asChild>
            <Button
              variant={tone === 'danger' ? 'danger' : 'primary'}
              loading={busy}
              disabled={confirmDisabled}
              onClick={(e) => void handleConfirm(e)}
            >
              {confirmLabel ?? t('actions.confirm')}
            </Button>
          </AlertDialogPrimitive.Action>
        </div>
      </AlertDialogContent>
    </AlertDialogPrimitive.Root>
  )
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>
const ConfirmContext = createContext<ConfirmFn | null>(null)

/** Mount once near the root; provides `useConfirm()`. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null)
  const resolver = useRef<((ok: boolean) => void) | null>(null)

  const confirm = useCallback<ConfirmFn>((opts) => {
    resolver.current?.(false)
    setOptions(opts)
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve
    })
  }, [])

  const settle = (ok: boolean): void => {
    resolver.current?.(ok)
    resolver.current = null
    setOptions(null)
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {options ? (
        <ConfirmDialog
          {...options}
          open
          onOpenChange={(open) => {
            if (!open) settle(false)
          }}
          onConfirm={() => settle(true)}
        />
      ) : null}
    </ConfirmContext.Provider>
  )
}

export function useConfirm(): ConfirmFn {
  const fn = useContext(ConfirmContext)
  if (!fn) throw new Error('useConfirm must be used inside <ConfirmProvider>')
  return fn
}
