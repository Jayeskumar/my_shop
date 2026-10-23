/**
 * Loading skeleton and error / not-found states of the purchases detail pages (same layout as
 * the loaded page, so nothing jumps when data arrives).
 */
import { FileQuestion } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Button, EmptyState, RetryButton, Skeleton } from '@/components/ui'
import { isApiError } from '@/lib/api'
import { describeError } from '@/lib/errors'

export function DetailSkeleton() {
  const { t } = useTranslation('common')
  return (
    <div aria-busy="true" aria-label={t('misc.loading')} className="grid gap-4">
      <div className="grid gap-2 pb-2">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-8 w-72 max-w-full" />
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
      </div>
      <Skeleton className="h-64" />
    </div>
  )
}

export function DetailError({
  error,
  backTo,
  backLabel,
  onRetry,
}: {
  error: unknown
  backTo: string
  backLabel: string
  onRetry: () => void
}) {
  const { t } = useTranslation('purchases')
  const notFound = isApiError(error) && error.status === 404
  const display = describeError(error)
  return (
    <div className="rounded-xl border border-dashed border-border bg-surface">
      <EmptyState
        icon={<FileQuestion />}
        title={notFound ? t('detail.not_found') : display.title}
        description={notFound ? t('detail.not_found_hint') : display.description}
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="outline" asChild>
              <Link to={backTo}>{backLabel}</Link>
            </Button>
            {notFound ? null : <RetryButton onRetry={onRetry} />}
          </div>
        }
      />
    </div>
  )
}
