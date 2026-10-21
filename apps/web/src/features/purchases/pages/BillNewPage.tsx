/**
 * New purchase bill (/purchases/bills/new[?supplier_id=]): the bill entry screen. Saving creates
 * the draft and moves to /purchases/bills/:id, where the same editor continues.
 */
import { isUuid } from '@kadai/shared/ids'
import { useSearchParams } from 'react-router'
import { BillEditor } from '../components/BillEditor'

export default function BillNewPage() {
  const [params] = useSearchParams()
  const supplierId = params.get('supplier_id')
  return <BillEditor initialSupplierId={supplierId && isUuid(supplierId) ? supplierId : null} />
}
