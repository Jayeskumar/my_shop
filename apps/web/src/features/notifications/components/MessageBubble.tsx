/**
 * How a message looks on the customer's side: a WhatsApp-style chat bubble, an SMS bubble or an
 * email card with its subject. Used by the outbox drawer, the template editor's live preview
 * and the reminder dialog.
 */
import type { ReactNode } from 'react'
import type { Locale, NotificationChannel } from '@kadai/shared/enums'
import { cn } from '@/lib/cn'

/** Splits text into plain parts and links so URLs wrap and read as links. */
function withLinks(text: string): ReactNode[] {
  // A URL ends before trailing sentence punctuation ("…/pay/KD7Q2M9X4B1Z." keeps the dot as text).
  return text.split(/(https?:\/\/[^\s]*[^\s.,;:!?)'"])/g).map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <span key={i} className="break-all text-primary underline underline-offset-2">
        {part}
      </span>
    ) : (
      <span key={i}>{part}</span>
    ),
  )
}

export function MessageBubble({
  channel,
  body,
  subject,
  locale,
  footer,
  className,
  testId,
}: {
  channel: NotificationChannel
  body: string
  subject?: string | null
  locale?: Locale
  /** Small line under the bubble (length, SMS parts …). */
  footer?: ReactNode
  className?: string
  testId?: string
}) {
  if (channel === 'email') {
    return (
      <div className={cn('grid gap-1.5', className)}>
        <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-card">
          {subject ? (
            <div
              lang={locale}
              className="border-b border-border bg-surface-2 px-4 py-2.5 text-sm font-semibold"
            >
              {subject}
            </div>
          ) : null}
          <p
            lang={locale}
            data-testid={testId}
            className="whitespace-pre-wrap break-words px-4 py-3 text-sm leading-relaxed"
          >
            {withLinks(body)}
          </p>
        </div>
        {footer ? <div className="text-xs text-muted-foreground">{footer}</div> : null}
      </div>
    )
  }
  const whatsapp = channel === 'whatsapp'
  return (
    <div className={cn('grid gap-1.5', className)}>
      <div className={cn('rounded-xl p-3', whatsapp ? 'bg-success-soft/60' : 'bg-surface-2')}>
        <p
          lang={locale}
          data-testid={testId}
          className={cn(
            'max-w-[34rem] whitespace-pre-wrap break-words rounded-lg rounded-tl-none p-3 text-sm leading-relaxed shadow-card',
            whatsapp ? 'bg-surface' : 'bg-surface text-foreground',
          )}
        >
          {withLinks(body)}
        </p>
      </div>
      {footer ? <div className="text-xs text-muted-foreground">{footer}</div> : null}
    </div>
  )
}
