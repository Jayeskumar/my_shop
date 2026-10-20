import { useTranslation } from 'react-i18next'
import { StatusDot, Tooltip } from '@/components/ui'
import { useOnline } from '@/lib/online'
import { cn } from '@/lib/cn'

/** Online / offline / server-down pill for the top bar. */
export function OnlineIndicator({ className }: { className?: string }) {
  const { t } = useTranslation()
  const status = useOnline()
  const state = !status.browserOnline ? 'offline' : status.serverReachable === false ? 'server_down' : 'online'
  const label =
    state === 'online' ? t('network.online') : state === 'offline' ? t('network.offline') : t('network.server_down')
  const hint = state === 'offline' ? t('network.offline_hint') : state === 'server_down' ? t('network.server_down_hint') : label
  return (
    <Tooltip content={hint}>
      <span
        role="status"
        aria-live="polite"
        tabIndex={0}
        className={cn(
          'inline-flex h-8 items-center rounded-full px-2.5 text-xs font-medium',
          state === 'online' ? 'text-muted-foreground' : state === 'offline' ? 'bg-danger-soft text-danger-soft-foreground' : 'bg-warning-soft text-warning-soft-foreground',
          className,
        )}
      >
        <StatusDot
          tone={state === 'online' ? 'success' : state === 'offline' ? 'danger' : 'warning'}
          pulse={state !== 'online'}
          label={<span className={cn(state === 'online' && 'sr-only sm:not-sr-only')}>{label}</span>}
        />
      </span>
    </Tooltip>
  )
}
