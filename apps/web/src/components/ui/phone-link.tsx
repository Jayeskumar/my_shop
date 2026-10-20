import { MessageCircle, Phone } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toWhatsAppNumber } from '@kadai/shared/phone'
import { cn } from '@/lib/cn'
import { formatPhone } from '@/lib/format'

export interface PhoneLinkProps {
  /** E.164 (+919876543210). */
  phone: string | null | undefined
  /** Also show a WhatsApp chat link. */
  whatsapp?: boolean
  /** Pre-filled WhatsApp message (e.g. due reminder). */
  message?: string
  showIcon?: boolean
  className?: string
}

export function PhoneLink({ phone, whatsapp, message, showIcon = true, className }: PhoneLinkProps) {
  const { t } = useTranslation()
  if (!phone) return <span className="text-muted-foreground">—</span>
  const wa = whatsapp ? toWhatsAppNumber(phone) : null
  const waUrl = wa ? `https://wa.me/${wa}${message ? `?text=${encodeURIComponent(message)}` : ''}` : null
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <a
        href={`tel:${phone}`}
        className="inline-flex items-center gap-1.5 whitespace-nowrap tabular-nums text-foreground hover:text-primary hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        {showIcon ? <Phone className="size-3.5 text-muted-foreground" aria-hidden /> : null}
        {formatPhone(phone)}
      </a>
      {waUrl ? (
        <a
          href={waUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t('actions.whatsapp')}
          title={t('actions.whatsapp')}
          className="inline-flex size-7 items-center justify-center rounded-full text-success hover:bg-success-soft"
          onClick={(e) => e.stopPropagation()}
        >
          <MessageCircle className="size-4" />
        </a>
      ) : null}
    </span>
  )
}
