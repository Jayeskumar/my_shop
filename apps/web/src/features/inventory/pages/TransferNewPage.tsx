/**
 * New stock transfer (/inventory/transfers/new); accepts transferPrefillPath's
 * ?from_store_id=&product_ids=.
 */
import { useLocation } from 'react-router'
import { TransferEditor } from '../components/TransferEditor'

export default function TransferNewPage() {
  const { search } = useLocation()
  return <TransferEditor key={search} />
}
