/**
 * Form chrome shared by the catalog editors: the sticky save bar (Ctrl+S hint), form section
 * cards and the unsaved-changes guard (router navigation + tab close).
 */
import { type ReactNode, type RefObject, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useBlocker } from 'react-router'
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  IconButton,
  Kbd,
} from '@/components/ui'
import { RotateCcw } from 'lucide-react'
import { cn } from '@/lib/cn'

export interface SaveBarProps {
  dirty: boolean
  saving: boolean
  onDiscard?: () => void
  /** id of the <form> the Save button submits. */
  formId: string
  saveLabel?: ReactNode
  disabled?: boolean
  /** Extra content on the left (e.g. "Saved 2 minutes ago"). */
  status?: ReactNode
  /** Extra buttons before Save (e.g. "Save & add another"). */
  extra?: ReactNode
  onSaveClick?: () => void
}

export function SaveBar({
  dirty,
  saving,
  onDiscard,
  formId,
  saveLabel,
  disabled,
  status,
  extra,
  onSaveClick,
}: SaveBarProps) {
  const { t } = useTranslation(['catalog', 'common'])
  return (
    <div
      className={cn(
        'sticky bottom-0 z-20 -mx-4 mt-6 border-t border-border bg-surface/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8',
        // Phones: a floating bar above the bottom navigation and its billing button.
        'max-md:bottom-[5.75rem] max-md:mx-0 max-md:rounded-xl max-md:border max-md:px-3 max-md:py-2 max-md:shadow-raised',
      )}
    >
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
        <div className="hidden min-w-0 text-sm text-muted-foreground sm:block" aria-live="polite">
          {dirty ? (
            <span className="flex items-center gap-2 font-medium text-warning-soft-foreground">
              <span className="size-2 rounded-full bg-warning" aria-hidden />
              {t('form.unsaved')}
            </span>
          ) : (
            status
          )}
        </div>
        <div className="flex w-full items-center gap-2 sm:w-auto sm:shrink-0">
          {dirty && onDiscard ? (
            <>
              <Button
                variant="ghost"
                onClick={onDiscard}
                disabled={saving}
                className="hidden sm:inline-flex"
              >
                {t('form.discard')}
              </Button>
              <IconButton
                icon={<RotateCcw />}
                label={t('form.discard')}
                variant="ghost"
                onClick={onDiscard}
                disabled={saving}
                className="sm:hidden"
              />
            </>
          ) : null}
          {extra}
          <Button
            type="submit"
            form={formId}
            onClick={onSaveClick}
            size="lg"
            loading={saving}
            disabled={disabled}
            className="max-sm:flex-1"
            rightIcon={
              <Kbd
                combo="mod+s"
                className="hidden border-primary-foreground/30 bg-primary-hover/40 text-primary-foreground sm:inline-flex"
              />
            }
          >
            {dirty ? (
              <span className="me-1 size-2 rounded-full bg-warning sm:hidden" aria-hidden />
            ) : null}
            {saveLabel ?? t('common:actions.save')}
          </Button>
        </div>
      </div>
    </div>
  )
}

export interface SectionProps {
  id?: string
  title: ReactNode
  description?: ReactNode
  icon?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}

/** A titled form section card (anchor target of the section nav). */
export function Section({
  id,
  title,
  description,
  icon,
  actions,
  children,
  className,
}: SectionProps) {
  return (
    <Card id={id} className={cn('scroll-mt-24', className)}>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="flex min-w-0 items-start gap-3">
          {icon ? (
            <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary-soft-foreground [&_svg]:size-4">
              {icon}
            </span>
          ) : null}
          <div className="grid grid-cols-1 min-w-0 gap-1">
            <CardTitle>{title}</CardTitle>
            {description ? <CardDescription>{description}</CardDescription> : null}
          </div>
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

/**
 * Blocks in-app navigation (confirm dialog) and tab close / reload (browser prompt) while
 * `when` is true. `allowRef.current = true` lets the next navigation through (e.g. right after
 * a save, before the re-render that clears `when`).
 */
export function UnsavedChangesGuard({
  when,
  allowRef,
}: {
  when: boolean
  allowRef?: RefObject<boolean>
}) {
  const { t } = useTranslation('common')
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      when &&
      !allowRef?.current &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search),
  )
  const proceeding = useRef(false)
  useEffect(() => {
    if (blocker.state !== 'blocked') proceeding.current = false
  }, [blocker.state])
  useEffect(() => {
    if (!when || allowRef?.current) return
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [when, allowRef])
  return (
    <ConfirmDialog
      open={blocker.state === 'blocked'}
      onOpenChange={(open) => {
        if (!open && !proceeding.current && blocker.state === 'blocked') blocker.reset()
      }}
      title={t('confirm.discard_title')}
      description={t('confirm.discard_description')}
      tone="danger"
      confirmLabel={t('actions.continue')}
      onConfirm={() => {
        if (blocker.state !== 'blocked') return
        proceeding.current = true
        blocker.proceed()
      }}
    />
  )
}
