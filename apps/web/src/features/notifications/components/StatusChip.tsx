/**
 * Delivery status chip (queued / sending / sent / delivered / read / failed / not sent). Failed
 * and cancelled messages carry the reason in a tooltip (and for screen readers), from the
 * NotificationErrorCode at the start of `error`.
 */
import { AlertTriangle, Check, CheckCheck, Clock, Loader2, Send, Ban } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { NotificationStatus } from '@kadai/shared/enums'
import { Badge, Tooltip } from '@/components/ui'
import { errorInfo, STATUS_TONE, statusLabel } from '../lib/labels'

const ICONS = {
  queued: Clock,
  sending: Loader2,
  sent: Send,
  delivered: Check,
  read: CheckCheck,
  failed: AlertTriangle,
  cancelled: Ban,
} as const

export function StatusChip({
  status,
  error,
  size = 'md',
}: {
  status: NotificationStatus
  error?: string | null
  size?: 'sm' | 'md'
}) {
  const { t, i18n } = useTranslation('notifications')
  const Icon = ICONS[status]
  const info =
    status === 'failed' || status === 'cancelled' ? errorInfo(error, i18n.language) : null
  const chip = (
    <Badge
      tone={STATUS_TONE[status]}
      size={size}
      icon={<Icon className={status === 'sending' ? 'animate-spin' : undefined} aria-hidden />}
      tabIndex={info ? 0 : undefined}
      className={
        info ? 'cursor-help focus-visible:outline-2 focus-visible:outline-ring' : undefined
      }
      data-status={status}
    >
      {statusLabel(status, i18n.language)}
      {info ? <span className="sr-only">: {info.reason}</span> : null}
    </Badge>
  )
  return (
    <Tooltip
      content={
        info ? (
          <span className="grid max-w-64 gap-0.5">
            <span className="font-medium">{info.reason}</span>
            {info.detail ? <span className="opacity-80">{info.detail}</span> : null}
          </span>
        ) : (
          t(`status_hint.${status}`)
        )
      }
    >
      {chip}
    </Tooltip>
  )
}
