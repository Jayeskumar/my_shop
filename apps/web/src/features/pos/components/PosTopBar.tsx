/**
 * Counter header: shop and counter (register choice when the browser is not a trusted device),
 * cashier with PIN switch (trusted devices), shift status, connectivity + offline bills, the
 * customer display, language, help and exit.
 */
import {
  CircleHelp,
  CloudUpload,
  LogOut,
  MonitorSmartphone,
  RefreshCcw,
  Timer,
  UserRoundCog,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Badge, Button, IconButton, Select, Tooltip } from '@/components/ui'
import { BrandMark } from '@/app/layout/BrandMark'
import { LanguageToggle } from '@/app/layout/LanguageToggle'
import { OnlineIndicator } from '@/app/layout/OnlineIndicator'
import { getDeviceCredentials, selectRegister, useMe } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { formatTime } from '@/lib/format'
import { localizedName } from '@/lib/i18n'
import { useShiftStatus } from '../hooks/use-shift-status'
import { usePos } from '../state/pos-context'
import { usePosActions } from '../state/use-pos-actions'

export function PosTopBar({ className }: { className?: string }) {
  const { t } = useTranslation('pos')
  const pos = usePos()
  const me = useMe()
  const { run } = usePosActions()
  const shift = useShiftStatus()
  const device = getDeviceCredentials()
  const context = pos.context
  const storeName = context ? localizedName(context.store.name, context.store.name_ta) : ''
  const registers = (me?.registers ?? []).filter(
    (r) => r.is_active && r.store_id === pos.scope?.storeId,
  )
  const canPickRegister = !me?.device && registers.length > 1
  const pending = pos.outbox.unsynced

  return (
    <header
      className={cn(
        'flex items-center gap-2 border-b border-border bg-surface px-3 py-2',
        className,
      )}
    >
      <Link
        to="/"
        className="shrink-0 rounded-md focus-visible:outline-2 focus-visible:outline-ring"
        aria-label={t('top.home')}
      >
        <BrandMark size="sm" withName={false} />
      </Link>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold leading-tight">
          {context ? localizedName(context.tenant.name, context.tenant.name_ta) : me?.tenant.name}
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="truncate">{storeName}</span>
          {canPickRegister ? (
            <Select
              size="sm"
              value={pos.scope?.registerId ?? ''}
              onValueChange={(v) => selectRegister(v)}
              options={registers.map((r) => ({ value: r.id, label: `${r.code} · ${r.name}` }))}
              aria-label={t('top.counter')}
              className="h-6 w-auto min-w-28 text-xs"
            />
          ) : context?.register ? (
            <span className="whitespace-nowrap">
              · {t('top.counter_code', { code: context.register.code })}
            </span>
          ) : (
            <Badge size="sm" tone="warning">
              {t('top.no_counter')}
            </Badge>
          )}
        </div>
      </div>

      {shift.enabled ? (
        <Button
          variant={shift.shift ? 'ghost' : 'outline'}
          size="sm"
          leftIcon={<Timer />}
          onClick={() => pos.openDialog({ name: 'shift' })}
          className={cn(
            'hidden md:inline-flex',
            !shift.shift && 'border-warning text-warning-soft-foreground',
          )}
        >
          {shift.shift
            ? t('top.shift_since', { time: formatTime(shift.shift.opened_at) })
            : t('top.open_shift')}
        </Button>
      ) : null}

      <div className="flex items-center gap-1">
        {pos.catalogSyncing ? (
          <Tooltip content={t('top.catalog_syncing')}>
            <RefreshCcw
              className="size-4 animate-spin text-muted-foreground"
              aria-label={t('top.catalog_syncing')}
            />
          </Tooltip>
        ) : null}
        <OnlineIndicator />
        {pending > 0 || pos.outbox.failed > 0 ? (
          <Button
            variant={pos.outbox.failed ? 'danger' : 'outline'}
            size="sm"
            leftIcon={<CloudUpload />}
            onClick={() => pos.openDialog({ name: 'sync' })}
            aria-label={t('top.pending_bills', { count: pending })}
          >
            {pending}
          </Button>
        ) : null}
      </div>

      <div className="hidden items-center gap-1 sm:flex">
        <span className="hidden max-w-36 truncate text-sm font-medium lg:inline">
          {me?.user.full_name}
        </span>
        {device ? (
          <IconButton
            icon={<UserRoundCog />}
            label={t('top.switch_cashier')}
            onClick={() => pos.openDialog({ name: 'pin' })}
          />
        ) : null}
        {pos.display.enabled ? (
          <IconButton
            icon={<MonitorSmartphone />}
            label={t('top.customer_display')}
            onClick={() => run('display')}
          />
        ) : null}
        <LanguageToggle className="hidden md:inline-flex" />
        <IconButton icon={<CircleHelp />} label={t('top.help')} onClick={() => run('help')} />
      </div>
      <Tooltip content={t('top.exit')}>
        <Button asChild variant="ghost" size="md" className="px-2.5">
          <Link to="/" aria-label={t('top.exit')}>
            <LogOut />
          </Link>
        </Button>
      </Tooltip>
    </header>
  )
}
