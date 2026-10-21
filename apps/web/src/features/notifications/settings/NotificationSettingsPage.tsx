/**
 * Notification settings (/settings/notifications, settings.manage + plan feature notifications):
 *  1. Sending services — status card per channel from GET /notification-templates `providers`;
 *  2. Automatic messages — settings.notifications toggles saved through PATCH /settings;
 *  3. Message texts — the template editor (code × channel × language) with live preview, the
 *     DLT note for SMS and "back to standard".
 * One request loads all three (the catalogue carries providers and settings).
 */
import { History } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Button, EmptyState, PageHeader, Skeleton } from '@/components/ui'
import { useAuth, useCan } from '@/lib/auth'
import { describeError } from '@/lib/errors'
import { useTemplateCatalog } from '../api'
import { AutomationCard } from './AutomationCard'
import { ProviderCards } from './ProviderCards'
import { TemplatesCard } from './TemplatesCard'

export default function NotificationSettingsPage() {
  const { t } = useTranslation(['notifications', 'common', 'nav'])
  const catalog = useTemplateCatalog()
  const canManage = useCan('settings.manage')
  const allStores = useAuth((s) => s.me?.membership.store_ids === null)
  const data = catalog.data?.data

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6 pb-8">
      <PageHeader
        title={t('nav:titles.settings_notifications')}
        description={t('settings.description')}
        backTo="/settings"
        className="pb-0"
        actions={
          <Button asChild variant="outline" leftIcon={<History />}>
            <Link to="/notifications">{t('settings.outbox_link')}</Link>
          </Button>
        }
      />

      {catalog.isPending ? (
        <div className="grid gap-6" aria-busy="true" aria-label={t('common:misc.loading')}>
          <div className="grid gap-3 md:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-44 rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-80 rounded-xl" />
          <Skeleton className="h-96 rounded-xl" />
        </div>
      ) : !data ? (
        <EmptyState
          title={t('settings.load_error')}
          description={describeError(catalog.error).title}
          action={
            <Button variant="outline" onClick={() => void catalog.refetch()}>
              {t('common:actions.retry')}
            </Button>
          }
        />
      ) : (
        <>
          <ProviderCards providers={data.providers} />
          <AutomationCard
            settings={data.settings}
            providers={data.providers}
            canEdit={canManage && allStores}
            storeScoped={canManage && !allStores}
          />
          <TemplatesCard catalog={data} />
        </>
      )}
    </div>
  )
}
