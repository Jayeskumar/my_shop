/**
 * One stock adjustment (/inventory/adjustments/:id): drafts open in the editor, posted and
 * cancelled ones show the detail view with their movements.
 */
import { inventoryRoutes } from '@kadai/shared/api/inventory'
import { isUuid } from '@kadai/shared/ids'
import { FileQuestion } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router'
import { Button, EmptyState, RetryButton, Skeleton } from '@/components/ui'
import { isApiError } from '@/lib/api'
import { describeError } from '@/lib/errors'
import { useRouteQuery } from '@/lib/query'
import { AdjustmentDetailView } from '../components/AdjustmentDetailView'
import { AdjustmentEditor } from '../components/AdjustmentEditor'

export default function AdjustmentPage() {
  const { t } = useTranslation(['inventory', 'common'])
  const { id = '' } = useParams()
  const valid = isUuid(id)
  const query = useRouteQuery(
    inventoryRoutes.getAdjustment,
    { params: { id } },
    { enabled: valid, meta: { errorToast: false } },
  )
  const doc = query.data?.data
  if (!valid || (query.error && isApiError(query.error) && query.error.status === 404))
    return (
      <EmptyState
        icon={<FileQuestion />}
        title={t('adjustments.not_found')}
        action={
          <Button asChild variant="outline">
            <Link to="/inventory/adjustments">{t('adjustments.back_to_list')}</Link>
          </Button>
        }
      />
    )
  if (query.error)
    return (
      <EmptyState
        title={describeError(query.error).title}
        action={<RetryButton onRetry={() => void query.refetch()} />}
      />
    )
  if (!doc)
    return (
      <div className="grid grid-cols-1 gap-4" aria-busy>
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  if (doc.status === 'draft' && doc.kind !== 'opening')
    return <AdjustmentEditor key={`${doc.id}:${doc.updated_at}`} initial={doc} />
  return <AdjustmentDetailView doc={doc} />
}
