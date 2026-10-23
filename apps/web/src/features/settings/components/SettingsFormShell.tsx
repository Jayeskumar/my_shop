/**
 * Page frame for the tenant-settings forms: header, loading skeleton, load error with retry,
 * the read-only notice for store-scoped members, the sticky save bar and the unsaved-changes
 * guard. `aside` renders next to the form on wide screens (e.g. the receipt preview).
 */
import { Eye, Settings2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { FormProvider } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Button, EmptyState, Skeleton } from '@/components/ui'
import { cn } from '@/lib/cn'
import type { SettingsSection } from '@kadai/shared/settings'
import type { SettingsFormApi } from '../lib/use-settings-form'
import { settingsErrorDisplay } from '../lib/messages'
import { SaveBar, UnsavedChangesGuard } from './SaveBar'
import { ReadOnlyNotice } from './SettingsCard'
import { SettingsPageHeader } from './SettingsPageHeader'

const ASIDE_ID = 'settings-aside'

export function SettingsFormSkeleton({ cards = 2 }: { cards?: number }) {
  return (
    <div className="flex flex-col gap-4" aria-busy>
      {Array.from({ length: cards }, (_, i) => (
        <div key={i} className="rounded-xl border border-border bg-surface p-5">
          <Skeleton className="mb-4 h-5 w-48" />
          <div className="flex flex-col gap-3">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
            <Skeleton className="h-10 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  )
}

export function SettingsFormShell<K extends SettingsSection>({
  title,
  description,
  api,
  children,
  aside,
  asideLabel,
  notice,
}: {
  title: string
  description?: string
  api: SettingsFormApi<K>
  children: ReactNode
  aside?: ReactNode
  /** Button text that scrolls to the aside where it sits below the form (narrow screens). */
  asideLabel?: string
  notice?: ReactNode
}) {
  const { t } = useTranslation(['settings', 'common'])
  if (api.error && !api.loaded) {
    const display = settingsErrorDisplay(api.error)
    return (
      <div>
        <SettingsPageHeader title={title} />
        <EmptyState
          icon={<Settings2 />}
          title={display.title}
          description={display.description}
          action={
            <Button variant="outline" onClick={api.refetch}>
              {t('common:actions.retry')}
            </Button>
          }
        />
      </div>
    )
  }
  return (
    <div className={cn(aside ? 'max-w-4xl 2xl:max-w-6xl' : 'max-w-4xl')}>
      <SettingsPageHeader
        title={title}
        description={description}
        actions={
          aside && asideLabel && api.loaded ? (
            <Button
              variant="outline"
              size="sm"
              leftIcon={<Eye />}
              className="2xl:hidden"
              onClick={() =>
                document.getElementById(ASIDE_ID)?.scrollIntoView({ behavior: 'smooth' })
              }
            >
              {asideLabel}
            </Button>
          ) : null
        }
      />
      {api.storeScoped ? (
        <ReadOnlyNotice>{t('common.store_scoped_readonly')}</ReadOnlyNotice>
      ) : null}
      {notice}
      {!api.loaded ? (
        <SettingsFormSkeleton />
      ) : (
        <FormProvider {...api.form}>
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault()
              api.save()
            }}
            aria-label={title}
            className={cn(
              aside && '2xl:grid 2xl:grid-cols-[minmax(0,1fr)_22rem] 2xl:items-start 2xl:gap-6',
            )}
          >
            <fieldset disabled={!api.canEdit} className="flex min-w-0 flex-col gap-5">
              {children}
            </fieldset>
            {aside ? (
              <div id={ASIDE_ID} className="mt-5 scroll-mt-20 2xl:sticky 2xl:top-20 2xl:mt-0">
                {aside}
              </div>
            ) : null}
            {api.canEdit ? (
              <SaveBar
                dirty={api.dirty}
                saving={api.saving}
                onSave={api.save}
                onDiscard={api.discard}
                className={cn(aside && '2xl:col-span-2')}
              />
            ) : null}
          </form>
        </FormProvider>
      )}
      <UnsavedChangesGuard dirty={api.dirty && !api.saving} />
    </div>
  )
}
