/** 404 / 403 / upgrade / route-error pages. */
import { Compass, Lock, ServerCrash, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link, isRouteErrorResponse, useRouteError } from 'react-router'
import type { Feature } from '@kadai/shared/features'
import { FEATURE_LABELS } from '@kadai/shared/features'
import { Button, EmptyState, ErrorFallback } from '@/components/ui'
import { getLanguage } from '@/lib/i18n'
import { useAuth } from '@/lib/auth'

function HomeButton() {
  const { t } = useTranslation()
  return (
    <Button asChild>
      <Link to="/">{t('actions.go_home')}</Link>
    </Button>
  )
}

export function NotFoundPage() {
  const { t } = useTranslation('errors')
  return (
    <EmptyState
      icon={<Compass />}
      title={t('pages.not_found_title')}
      description={t('pages.not_found_description')}
      action={<HomeButton />}
      className="min-h-[60vh]"
    />
  )
}

export function ForbiddenPage() {
  const { t } = useTranslation('errors')
  return (
    <EmptyState
      icon={<Lock />}
      title={t('pages.forbidden_title')}
      description={t('pages.forbidden_description')}
      action={<HomeButton />}
      className="min-h-[60vh]"
    />
  )
}

export function ModeUnavailablePage() {
  const { t } = useTranslation('errors')
  return (
    <EmptyState
      icon={<Compass />}
      title={t('pages.mode_title')}
      description={t('pages.mode_description')}
      action={<HomeButton />}
      className="min-h-[60vh]"
    />
  )
}

export function UpgradePage({ feature }: { feature: Feature }) {
  const { t } = useTranslation(['errors', 'nav'])
  const mode = useAuth((s) => s.me?.mode ?? s.deployment.mode)
  const canManageBilling = useAuth((s) => s.permissions.has('billing.manage'))
  const label = FEATURE_LABELS[feature][getLanguage()]
  return (
    <EmptyState
      icon={<Sparkles />}
      title={t('pages.upgrade_title')}
      description={t('pages.upgrade_description', { feature: label })}
      action={
        <>
          {mode === 'cloud' && canManageBilling ? (
            <Button asChild variant="accent">
              <Link to="/settings/billing">{t('pages.upgrade_cta')}</Link>
            </Button>
          ) : null}
          <HomeButton />
        </>
      }
      className="min-h-[60vh]"
    />
  )
}

/** errorElement of the root route: unexpected render/loader errors and thrown responses. */
export function RouteErrorPage() {
  const error = useRouteError()
  const { t } = useTranslation(['errors', 'common'])
  if (isRouteErrorResponse(error) && error.status === 404) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background p-6">
        <NotFoundPage />
      </div>
    )
  }
  // A chunk that fails to load after a deploy usually means the app was updated: reload once.
  const message = error instanceof Error ? error.message : ''
  const staleChunk =
    /dynamically imported module|Importing a module script failed|Failed to fetch/i.test(message)
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-6">
      {staleChunk ? (
        <EmptyState
          icon={<ServerCrash />}
          title={t('pages.crash_title')}
          description={t('client.NETWORK_ERROR')}
          action={
            <Button onClick={() => window.location.reload()}>{t('common:actions.reload')}</Button>
          }
        />
      ) : (
        <ErrorFallback error={error} />
      )}
    </div>
  )
}
