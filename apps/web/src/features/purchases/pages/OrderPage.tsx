/**
 * Purchase order (/purchases/orders/:id): the order detail with its actions; "Edit" on a draft
 * switches to the editor in place (same URL).
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router'
import { useCan } from '@/lib/auth'
import { useOrder } from '../api'
import { OrderDetail } from '../components/OrderDetail'
import { OrderEditor } from '../components/OrderEditor'
import { DetailError, DetailSkeleton } from '../components/PageState'

export default function OrderPage() {
  const { t } = useTranslation('purchases')
  const { id } = useParams<{ id: string }>()
  const canWrite = useCan('purchases.write')
  const query = useOrder(id)
  const [editing, setEditing] = useState(false)
  const order = query.data?.data

  if (query.isLoading) return <DetailSkeleton />
  if (!order) {
    return (
      <DetailError
        error={query.error}
        backTo="/purchases/orders"
        backLabel={t('orders.back_to_list')}
        onRetry={() => void query.refetch()}
      />
    )
  }
  if (editing && canWrite && order.status === 'draft') {
    return <OrderEditor order={order} onDone={() => setEditing(false)} />
  }
  return <OrderDetail order={order} onEdit={() => setEditing(true)} />
}
