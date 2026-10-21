/**
 * Channel glyph (WhatsApp / SMS / email) in a tinted tile, with the channel name for screen
 * readers (or visible next to it with `showLabel`).
 */
import { Mail, MessageCircle, MessageSquareText } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { NotificationChannel } from '@kadai/shared/enums'
import { cn } from '@/lib/cn'
import { channelLabel } from '../lib/labels'

const ICONS = {
  whatsapp: MessageCircle,
  sms: MessageSquareText,
  email: Mail,
} as const

const TILE: Readonly<Record<NotificationChannel, string>> = {
  whatsapp: 'bg-success-soft text-success-soft-foreground',
  sms: 'bg-info-soft text-info-soft-foreground',
  email: 'bg-accent-soft text-accent-soft-foreground',
}

export function ChannelIcon({
  channel,
  size = 'md',
  showLabel = false,
  className,
}: {
  channel: NotificationChannel
  size?: 'sm' | 'md' | 'lg'
  showLabel?: boolean
  className?: string
}) {
  const { i18n } = useTranslation()
  const Icon = ICONS[channel]
  const label = channelLabel(channel, i18n.language)
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-2', className)}>
      <span
        className={cn(
          'flex shrink-0 items-center justify-center rounded-lg',
          TILE[channel],
          size === 'sm' && 'size-7 [&_svg]:size-3.5',
          size === 'md' && 'size-9 [&_svg]:size-4.5',
          size === 'lg' && 'size-11 [&_svg]:size-5',
        )}
        aria-hidden={showLabel}
        title={showLabel ? undefined : label}
      >
        <Icon />
      </span>
      {showLabel ? (
        <span className="truncate text-sm font-medium">{label}</span>
      ) : (
        <span className="sr-only">{label}</span>
      )}
    </span>
  )
}
