/**
 * New stock adjustment / stock take / write-off (/inventory/adjustments/new). Accepts the
 * prefill query of adjustmentPrefillPath (?kind=&store_id=&batch_ids=&product_ids=).
 */
import { useLocation } from 'react-router'
import { AdjustmentEditor } from '../components/AdjustmentEditor'

export default function AdjustmentNewPage() {
  // A new prefill link (e.g. another write-off) starts a fresh editor.
  const { search } = useLocation()
  return <AdjustmentEditor key={search} />
}
