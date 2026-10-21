/** Status chips of purchase orders, bills (+ payment status) and debit notes. */
import type {
  DebitNoteStatus,
  PurchaseBillStatus,
  PurchaseOrderStatus,
  PurchasePaymentStatus,
} from '@kadai/shared'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui'
import {
  billStatusTone,
  debitNoteStatusTone,
  orderStatusTone,
  paymentStatusTone,
} from '../lib/labels'

type Size = 'sm' | 'md'

export function OrderStatusBadge({
  status,
  size = 'sm',
}: {
  status: PurchaseOrderStatus
  size?: Size
}) {
  const { t } = useTranslation('purchases')
  return (
    <Badge tone={orderStatusTone(status)} size={size} dot>
      {t(`status.order.${status}`)}
    </Badge>
  )
}

export function BillStatusBadge({
  status,
  size = 'sm',
}: {
  status: PurchaseBillStatus
  size?: Size
}) {
  const { t } = useTranslation('purchases')
  return (
    <Badge tone={billStatusTone(status)} size={size} dot>
      {t(`status.bill.${status}`)}
    </Badge>
  )
}

export function PaymentStatusBadge({
  status,
  overdue = false,
  size = 'sm',
}: {
  status: PurchasePaymentStatus
  overdue?: boolean
  size?: Size
}) {
  const { t } = useTranslation('purchases')
  return (
    <Badge tone={paymentStatusTone(status, overdue)} size={size}>
      {overdue && status !== 'paid' ? t('status.payment.overdue') : t(`status.payment.${status}`)}
    </Badge>
  )
}

export function DebitNoteStatusBadge({
  status,
  size = 'sm',
}: {
  status: DebitNoteStatus
  size?: Size
}) {
  const { t } = useTranslation('purchases')
  return (
    <Badge tone={debitNoteStatusTone(status)} size={size} dot>
      {t(`status.debit_note.${status}`)}
    </Badge>
  )
}
