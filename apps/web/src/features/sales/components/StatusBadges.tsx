/** Status chips of sales documents (invoice, payment, estimate, credit note, doc type). */
import { CloudOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  CreditNoteStatus,
  SalesDocType,
  SalesInvoiceStatus,
  SalesPaymentStatus,
} from '@kadai/shared/enums'
import { Badge } from '@/components/ui'
import {
  type EstimateState,
  docTypeLabel,
  estimateStateTone,
  invoiceStatusTone,
  paymentStatusTone,
} from '../lib/labels'

type Size = 'sm' | 'md'

export function InvoiceStatusBadge({
  status,
  size = 'sm',
}: {
  status: SalesInvoiceStatus
  size?: Size
}) {
  const { t } = useTranslation('sales')
  return (
    <Badge tone={invoiceStatusTone(status)} size={size} dot>
      {t(`invoice_status.${status}`)}
    </Badge>
  )
}

export function PaymentStatusBadge({
  status,
  size = 'sm',
}: {
  status: SalesPaymentStatus
  size?: Size
}) {
  const { t } = useTranslation('sales')
  return (
    <Badge tone={paymentStatusTone(status)} size={size}>
      {t(`payment_status.${status}`)}
    </Badge>
  )
}

export function EstimateStateBadge({ state, size = 'sm' }: { state: EstimateState; size?: Size }) {
  const { t } = useTranslation('sales')
  return (
    <Badge tone={estimateStateTone(state)} size={size} dot>
      {t(`estimate_state.${state}`)}
    </Badge>
  )
}

export function CreditNoteStatusBadge({
  status,
  size = 'sm',
}: {
  status: CreditNoteStatus
  size?: Size
}) {
  const { t } = useTranslation('sales')
  return (
    <Badge tone={status === 'completed' ? 'success' : 'danger'} size={size} dot>
      {t(`credit_note_status.${status}`)}
    </Badge>
  )
}

export function DocTypeBadge({
  docType,
  size = 'sm',
}: {
  docType: SalesDocType | 'credit_note'
  size?: Size
}) {
  const { i18n } = useTranslation('sales')
  return (
    <Badge tone={docType === 'estimate' ? 'accent' : 'neutral'} appearance="outline" size={size}>
      {docTypeLabel(docType, i18n.language)}
    </Badge>
  )
}

export function OfflineBadge({ size = 'sm' }: { size?: Size }) {
  const { t } = useTranslation('sales')
  return (
    <Badge tone="info" size={size} title={t('invoice.offline_hint')}>
      <CloudOff aria-hidden />
      {t('invoice.offline')}
    </Badge>
  )
}
