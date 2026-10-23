/**
 * The billing counter (/pos): full screen, tuned for 1366×768 counters with keyboard + scanner
 * and for touch; on phones the cart stacks above a bottom action bar. Works offline from the
 * cached catalogue (ARCHITECTURE.md §12).
 */
import { AlertTriangle, CloudOff, LayoutGrid, Store, Timer } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, EmptyState, Kbd, Skeleton } from '@/components/ui'
import { useMe } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { activeHotkeyScope, useHotkeyScope, useHotkeys } from '@/lib/hotkeys'
import { useBreakpoint } from '@/lib/use-media-query'
import { ActionBar, MobileActionBar } from '../components/ActionBar'
import { BrowsePanel } from '../components/BrowsePanel'
import { CartCards, CartTable } from '../components/CartView'
import { CustomerPanel } from '../components/CustomerPanel'
import { PosTopBar } from '../components/PosTopBar'
import { ProductSearch } from '../components/ProductSearch'
import { LastSaleCard, TotalsPanel } from '../components/TotalsPanel'
import { PosDialogs } from '../dialogs/PosDialogs'
import { useShiftStatus } from '../hooks/use-shift-status'
import { useBarcodeWedge } from '../hooks/use-barcode-wedge'
import { POS_KEYMAP } from '../lib/keymap'
import { PosProvider } from '../state/pos-controller'
import { usePos } from '../state/pos-context'
import { usePosActions } from '../state/use-pos-actions'

const GUARDED_KEY = /^F([1-9]|10|12)$/

function useCounterHotkeys(): void {
  const { run } = usePosActions()
  const pos = usePos()
  useHotkeyScope('pos')
  useHotkeys(
    {
      [POS_KEYMAP.help]: () => run('help'),
      [POS_KEYMAP.search]: () => run('search'),
      [POS_KEYMAP.customer]: () => run('customer'),
      [POS_KEYMAP.hold]: () => run('hold'),
      [POS_KEYMAP.recall]: () => run('recall'),
      [POS_KEYMAP.bill_discount]: () => run('bill_discount'),
      [POS_KEYMAP.qty]: () => run('qty'),
      [POS_KEYMAP.pay]: () => run('pay'),
      [POS_KEYMAP.cash_exact]: () => run('cash_exact'),
      [POS_KEYMAP.upi]: () => run('upi'),
      [POS_KEYMAP.save_print]: () => run('save_print'),
    },
    { scope: 'pos' },
  )
  // Work from the search box too (it has focus most of the time).
  useHotkeys(
    {
      [POS_KEYMAP.clear]: () => {
        if (pos.lastSale && pos.cart.lines.length === 0) pos.dismissLastSale()
        else run('clear')
      },
      [POS_KEYMAP.reprint]: () => run('reprint'),
    },
    { scope: 'pos', allowInInputs: true },
  )
  useHotkeys(
    {
      [POS_KEYMAP.remove_line]: () => run('remove_line'),
      [POS_KEYMAP.next_line]: () => run('next_line'),
      [POS_KEYMAP.previous_line]: () => run('previous_line'),
    },
    { scope: 'pos' },
  )
  // While a dialog is open, POS keys must not reach the browser (F5 reload, Ctrl+P print…). The
  // guard must run after every other shortcut handler (they skip default-prevented events), so a
  // capture listener queues a one-shot bubble listener — the last one window runs for this event.
  useEffect(() => {
    const late = (e: KeyboardEvent): void => {
      if (activeHotkeyScope() === 'pos') return
      if (GUARDED_KEY.test(e.key) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p'))
        e.preventDefault()
    }
    const early = (): void => {
      window.removeEventListener('keydown', late)
      window.addEventListener('keydown', late, { once: true })
    }
    window.addEventListener('keydown', early, { capture: true })
    return () => {
      window.removeEventListener('keydown', early, { capture: true })
      window.removeEventListener('keydown', late)
    }
  }, [])
}

function Banners() {
  const { t } = useTranslation('pos')
  const pos = usePos()
  const shift = useShiftStatus()
  return (
    <>
      {!pos.online ? (
        <div
          className="flex items-center gap-2 bg-warning-soft px-3 py-1.5 text-sm text-warning-soft-foreground"
          role="status"
        >
          <CloudOff className="size-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            {pos.scope?.registerId ? t('banner.offline') : t('banner.offline_no_counter')}
          </span>
          {pos.outbox.unsynced > 0 ? (
            <button
              type="button"
              className="font-semibold underline"
              onClick={() => pos.openDialog({ name: 'sync' })}
            >
              {t('banner.pending', { count: pos.outbox.unsynced })}
            </button>
          ) : null}
        </div>
      ) : null}
      {shift.enabled && !shift.loading && !shift.shift ? (
        <div className="flex items-center gap-2 bg-info-soft px-3 py-1.5 text-sm text-info-soft-foreground">
          <Timer className="size-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            {shift.required ? t('banner.shift_required') : t('banner.no_shift')}
          </span>
          <Button size="sm" variant="outline" onClick={() => pos.openDialog({ name: 'shift' })}>
            {t('banner.open_shift')}
          </Button>
        </div>
      ) : null}
      {pos.catalogError && pos.context && pos.online ? (
        <div className="flex items-center gap-2 bg-surface-2 px-3 py-1 text-xs text-muted-foreground">
          <AlertTriangle className="size-3.5" aria-hidden />
          {t('banner.catalog_stale', {
            time: new Date(pos.context.synced_at).toLocaleTimeString(),
          })}
          <button type="button" className="underline" onClick={() => void pos.refreshCatalog()}>
            {t('banner.retry')}
          </button>
        </div>
      ) : null}
    </>
  )
}

function LoadingScreen() {
  return (
    <div className="grid min-h-0 flex-1 gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_24rem]">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-14 rounded-lg" />
        <Skeleton className="h-28 rounded-lg" />
        <Skeleton className="min-h-60 flex-1 rounded-lg" />
      </div>
      <div className="hidden flex-col gap-3 lg:flex">
        <Skeleton className="h-12 rounded-lg" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    </div>
  )
}

function PosScreen() {
  const { t } = useTranslation('pos')
  const pos = usePos()
  const me = useMe()
  const desktop = useBreakpoint('lg')
  const [browse, setBrowse] = useState(desktop)
  const shift = useShiftStatus()
  const shiftPrompted = useRef(false)
  useCounterHotkeys()
  useBarcodeWedge((code) => void pos.addByCode(code), {
    enabled: Boolean(pos.context),
    scope: 'pos',
  })

  // A counter that needs an open shift asks for it once on arrival.
  useEffect(() => {
    if (
      shift.required &&
      !shift.loading &&
      !shift.shift &&
      !shiftPrompted.current &&
      pos.dialog === null
    ) {
      shiftPrompted.current = true
      pos.openDialog({ name: 'shift' })
    }
  }, [shift.required, shift.loading, shift.shift, pos])

  // Focus the search box when the screen is ready.
  useEffect(() => {
    if (pos.context && desktop) pos.focusSearch()
    // once per catalogue readiness
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(pos.context), desktop])

  if (!pos.scope) {
    return (
      <div className="flex h-dvh flex-col">
        <EmptyState
          icon={<Store />}
          title={t('screen.no_store')}
          description={t('screen.no_store_hint')}
        />
      </div>
    )
  }

  const body = !pos.context ? (
    pos.catalogStatus === 'error' ? (
      <div className="flex flex-1 items-center justify-center p-6">
        <EmptyState
          icon={<CloudOff />}
          title={t('screen.catalog_failed')}
          description={
            pos.online ? t('screen.catalog_failed_hint') : t('screen.catalog_offline_hint')
          }
          action={
            <Button
              onClick={() => void pos.refreshCatalog({ full: true })}
              loading={pos.catalogSyncing}
            >
              {t('banner.retry')}
            </Button>
          }
        />
      </div>
    ) : (
      <LoadingScreen />
    )
  ) : desktop ? (
    <main className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_23rem] gap-3 p-3 xl:grid-cols-[minmax(0,1fr)_27rem]">
      <div className="flex min-h-0 flex-col gap-2">
        <div className="flex items-center gap-2">
          <ProductSearch className="flex-1" />
          <Button
            variant={browse ? 'secondary' : 'outline'}
            size="lg"
            leftIcon={<LayoutGrid />}
            aria-pressed={browse}
            onClick={() => setBrowse((b) => !b)}
          >
            {t('browse.toggle')}
          </Button>
        </div>
        {browse ? (
          <BrowsePanel className="max-h-[13rem] shrink-0 rounded-xl border border-border bg-surface-2/40 p-2" />
        ) : null}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-card">
          <CartTable className="flex-1" />
        </div>
      </div>
      <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto">
        <CustomerPanel />
        <TotalsPanel />
        <LastSaleCard />
        <p className="mt-auto text-center text-xs text-muted-foreground">
          {t('screen.cashier', { name: me?.user.full_name ?? '' })} · <Kbd combo="F1" />{' '}
          {t('actions.help')}
        </p>
      </aside>
    </main>
  ) : (
    <main className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 pb-6">
      <ProductSearch />
      <CustomerPanel />
      <LastSaleCard />
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-muted-foreground">
          {t('cart.title', { count: pos.cart.lines.length })}
        </h2>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={<LayoutGrid />}
          aria-pressed={browse}
          onClick={() => setBrowse((b) => !b)}
        >
          {t('browse.toggle')}
        </Button>
      </div>
      {browse ? <BrowsePanel className="max-h-72" /> : null}
      <CartCards />
      {pos.cart.lines.length > 0 ? <TotalsPanel /> : null}
    </main>
  )

  return (
    <div className={cn('flex h-dvh flex-col bg-background')}>
      <PosTopBar />
      <Banners />
      {body}
      {pos.context ? desktop ? <ActionBar /> : <MobileActionBar /> : null}
      <PosDialogs />
    </div>
  )
}

export default function PosPage() {
  return (
    <PosProvider>
      <PosScreen />
    </PosProvider>
  )
}
