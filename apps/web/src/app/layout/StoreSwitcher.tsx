import { Check, ChevronDown, Lock, MonitorSmartphone, Store } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui'
import {
  selectRegister,
  selectStore,
  useAuth,
  useCurrentRegister,
  useCurrentStore,
} from '@/lib/auth'
import { cn } from '@/lib/cn'
import { getLanguage } from '@/lib/i18n'

/** "Counter A" when the name already says it, else "Counter A · Billing desk". */
function registerLabel(register: { code: string; name: string }, counterWord: string): string {
  return register.name.toUpperCase().includes(register.code.toUpperCase())
    ? register.name
    : `${counterWord} ${register.code} · ${register.name}`
}

/** Current store / counter, switchable unless the session is bound to a trusted device. */
export function StoreSwitcher({ className }: { className?: string }) {
  const { t } = useTranslation('nav')
  const me = useAuth((s) => s.me)
  const store = useCurrentStore()
  const register = useCurrentRegister()
  if (!me) return null
  const ta = getLanguage() === 'ta'
  const storeName = store
    ? ta && store.name_ta
      ? store.name_ta
      : store.name
    : t('shell.select_store')
  const registers = me.registers.filter((r) => r.is_active && r.store_id === store?.id)
  const stores = me.stores.filter((s) => s.is_active)
  const locked = Boolean(me.device)
  const switchable = !locked && (stores.length > 1 || registers.length > 1)

  const label = (
    <span className="flex min-w-0 items-center gap-2">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary-soft-foreground">
        <Store className="size-4" />
      </span>
      <span className="flex min-w-0 flex-col text-start leading-tight">
        <span className="truncate text-sm font-semibold">{storeName}</span>
        <span className="truncate text-xs text-muted-foreground">
          {register ? registerLabel(register, t('shell.counter')) : t('shell.no_counter')}
        </span>
      </span>
      {locked ? <Lock className="size-3.5 shrink-0 text-muted-foreground" aria-hidden /> : null}
    </span>
  )

  if (!switchable) {
    return <div className={cn('flex min-w-0 items-center px-1', className)}>{label}</div>
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'flex min-w-0 max-w-72 items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring',
          className,
        )}
        aria-label={t('shell.select_store')}
      >
        {label}
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        {stores.length > 1 ? (
          <>
            <DropdownMenuLabel>{t('shell.store')}</DropdownMenuLabel>
            {stores.map((s) => (
              <DropdownMenuItem key={s.id} icon={<Store />} onSelect={() => selectStore(s.id)}>
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate">
                    {s.code} · {ta && s.name_ta ? s.name_ta : s.name}
                  </span>
                  {s.id === store?.id ? <Check className="!text-primary" /> : null}
                </span>
              </DropdownMenuItem>
            ))}
          </>
        ) : null}
        {registers.length > 0 ? (
          <>
            {stores.length > 1 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuLabel>{t('shell.select_counter')}</DropdownMenuLabel>
            {registers.map((r) => (
              <DropdownMenuItem
                key={r.id}
                icon={<MonitorSmartphone />}
                onSelect={() => selectRegister(r.id)}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate">
                    {r.code} · {r.name}
                  </span>
                  {r.id === register?.id ? <Check className="!text-primary" /> : null}
                </span>
              </DropdownMenuItem>
            ))}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
