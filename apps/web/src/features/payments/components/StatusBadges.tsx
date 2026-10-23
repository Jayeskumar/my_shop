/** Status chips of intents and payments (colour + text, never colour alone). */
import { useTranslation } from 'react-i18next'
import type { PaymentIntentStatus, PaymentStatus } from '@kadai/shared/enums'
import { Badge } from '@/components/ui'
import { intentStatusTone, paymentStatusTone } from '../lib/labels'

export function IntentStatusBadge({
  status,
  size,
}: {
  status: PaymentIntentStatus
  size?: 'sm' | 'md'
}) {
  const { t } = useTranslation('payments')
  return (
    <Badge tone={intentStatusTone(status)} dot size={size}>
      {t(`intent_status.${status}`)}
    </Badge>
  )
}

export function PaymentStatusBadge({
  status,
  size,
}: {
  status: PaymentStatus
  size?: 'sm' | 'md'
}) {
  const { t } = useTranslation('payments')
  return (
    <Badge tone={paymentStatusTone(status)} dot size={size}>
      {t(`payment_status.${status}`)}
    </Badge>
  )
}
