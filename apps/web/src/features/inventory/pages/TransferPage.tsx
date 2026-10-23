/**
 * One stock transfer (/inventory/transfers/:id): drafts open in the editor (when the member can
 * work at the source store), everything else in the detail view with its timeline.
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
import { TransferDetailView } from '../components/TransferDetailView'
import { TransferEditor } from '../components/TransferEditor'
import { useTransferActionAllowed } from '../lib/access'

export default function TransferPage() {
  const { t } = useTranslation(['inventory', 'common'])
  const { id = '' } = useParams()
  const allowed = useTransferActionAllowed()
  const valid = isUuid(id)
  const query = useRouteQuery(
    inventoryRoutes.getTransfer,
    { params: { id } },
    { enabled: valid, meta: { errorToast: false } },
  )
  const doc = query.data?.data
  if (!valid || (query.error && isApiError(query.error) && query.error.status === 404))
    return (
      <EmptyState
        icon={<FileQuestion />}
        title={t('transfers.not_found')}
        action={
          <Button asChild variant="outline">
            <Link to="/inventory/transfers">{t('transfers.back_to_list')}</Link>
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
  if (doc.status === 'draft' && allowed('update', doc))
    return <TransferEditor key={`${doc.id}:${doc.updated_at}`} initial={doc} />
  return <TransferDetailView doc={doc} />
}
