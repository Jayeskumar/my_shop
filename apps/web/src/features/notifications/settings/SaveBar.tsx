/**
 * Sticky "unsaved changes" bar of the automatic-messages form (Discard / Save, Ctrl+S) and the
 * leave-page guard: in-app navigation or closing the tab with unsaved changes asks first.
 * Same look and keys as the other settings screens.
 */
import { Save, Undo2 } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useBlocker } from 'react-router'
import { Button, ConfirmDialog, Kbd } from '@/components/ui'
import { useHotkeys } from '@/lib/hotkeys'

export function SaveBar({
  dirty,
  saving,
  onSave,
  onDiscard,
  disabled,
}: {
  dirty: boolean
  saving: boolean
  onSave: () => void
  onDiscard: () => void
  disabled?: boolean
}) {
  const { t } = useTranslation(['notifications', 'common'])
  useHotkeys(
    {
      'ctrl+s': () => {
        if (dirty && !saving && !disabled) onSave()
      },
    },
    { allowInInputs: true, preventDefault: true },
  )
  if (!dirty && !saving) return null
  return (
    <div className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-20 md:bottom-4">
      <div
        role="region"
        aria-label={t('settings.save_bar.label')}
        className="flex flex-wrap items-center gap-3 rounded-xl border border-primary/30 bg-surface px-4 py-3 shadow-overlay"
      >
        <p className="min-w-0 flex-1 text-sm font-medium">{t('settings.save_bar.unsaved')}</p>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            leftIcon={<Undo2 />}
            onClick={onDiscard}
            disabled={saving}
          >
            {t('settings.save_bar.discard')}
          </Button>
          <Button
            type="button"
            leftIcon={<Save />}
            onClick={onSave}
            loading={saving}
            disabled={disabled}
          >
            {t('common:actions.save_changes')}
            <Kbd
              combo="ctrl+s"
              className="ms-1 hidden border-primary-foreground/30 bg-primary-foreground/15 text-primary-foreground lg:inline-flex"
            />
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Asks before leaving the page (route change or tab close) while `dirty`. */
export function UnsavedChangesGuard({ dirty }: { dirty: boolean }) {
  const { t } = useTranslation('common')
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && currentLocation.pathname !== nextLocation.pathname,
  )
  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])
  return (
    <ConfirmDialog
      open={blocker.state === 'blocked'}
      onOpenChange={(open) => {
        if (!open && blocker.state === 'blocked') blocker.reset()
      }}
      title={t('confirm.discard_title')}
      description={t('confirm.discard_description')}
      confirmLabel={t('actions.continue')}
      tone="danger"
      onConfirm={() => {
        if (blocker.state === 'blocked') blocker.proceed()
      }}
    />
  )
}
