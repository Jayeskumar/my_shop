/**
 * Purchase bill (/purchases/bills/:id): a draft opens in the bill entry screen (users who may
 * edit); posted / cancelled bills show the GRN detail with payments, returns and actions.
 */
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router'
import { useCan } from '@/lib/auth'
import { useBill } from '../api'
import { BillDetail } from '../components/BillDetail'
import { BillEditor } from '../components/BillEditor'
import { DetailError, DetailSkeleton } from '../components/PageState'

export default function BillPage() {
  const { t } = useTranslation('purchases')
  const { id } = useParams<{ id: string }>()
  const canWrite = useCan('purchases.write')
  const query = useBill(id)
  const bill = query.data?.data

  if (query.isLoading) return <DetailSkeleton />
  if (!bill) {
    return (
      <DetailError
        error={query.error}
        backTo="/purchases/bills"
        backLabel={t('bills.back_to_list')}
        onRetry={() => void query.refetch()}
      />
    )
  }
  if (bill.status === 'draft' && canWrite) return <BillEditor key={bill.id} bill={bill} />
  return <BillDetail bill={bill} />
}
