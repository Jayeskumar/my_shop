/**
 * Counter action bar with the F-key of every action (desktop), and the phone bottom bar: the
 * grand total, a big Pay button and the other actions in a menu.
 */
import {
  Banknote,
  ClipboardList,
  CreditCard,
  Eraser,
  FileText,
  History,
  Loader2,
  MoreHorizontal,
  Pause,
  Percent,
  Printer,
  QrCode,
  Undo2,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Kbd,
} from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatMoney } from '@/lib/format'
import { POS_KEYMAP, type PosAction } from '../lib/keymap'
import { usePos } from '../state/pos-context'
import { type PosActionId, usePosActions } from '../state/use-pos-actions'

type Tone = 'neutral' | 'quiet' | 'outline' | 'success' | 'primary'

interface ActionDef {
  id: PosActionId
  icon: ReactNode
  tone: Tone
}

const SECONDARY: ActionDef[] = [
  { id: 'hold', icon: <Pause />, tone: 'neutral' },
  { id: 'recall', icon: <History />, tone: 'neutral' },
  { id: 'bill_discount', icon: <Percent />, tone: 'neutral' },
  { id: 'estimate', icon: <FileText />, tone: 'neutral' },
  { id: 'return', icon: <Undo2 />, tone: 'neutral' },
  { id: 'clear', icon: <Eraser />, tone: 'quiet' },
]

const PRIMARY: ActionDef[] = [
  { id: 'upi', icon: <QrCode />, tone: 'outline' },
  { id: 'cash_exact', icon: <Banknote />, tone: 'success' },
  { id: 'pay', icon: <CreditCard />, tone: 'primary' },
]

const TONE: Record<Tone, string> = {
  neutral: 'border-border bg-surface text-foreground hover:bg-surface-2',
  quiet: 'border-transparent bg-surface-2 text-muted-foreground hover:text-foreground',
  outline: 'border-primary/40 bg-surface text-primary hover:bg-primary-soft/50',
  success: 'border-transparent bg-success text-success-foreground hover:bg-success/90',
  primary: 'border-transparent bg-primary text-primary-foreground hover:bg-primary/90',
}

const SOLID: ReadonlySet<Tone> = new Set(['success', 'primary'])

function keyOf(id: PosActionId): string | null {
  return id in POS_KEYMAP ? POS_KEYMAP[id as PosAction] : null
}

/**
 * Counter function keys in one row: icon and F-key over the label (two lines on the small keys —
 * Tamil labels are long); the three payment keys are wider and coloured.
 */
function KeyTile({ action, wide }: { action: ActionDef; wide: boolean }) {
  const { t } = useTranslation('pos')
  const { run, enabled } = usePosActions()
  const pos = usePos()
  const key = keyOf(action.id)
  const busy = action.id === 'cash_exact' && pos.busy === 'checkout'
  const kbd = key ? (
    <Kbd
      combo={key}
      className={cn(
        'shrink-0',
        SOLID.has(action.tone) && 'border-white/30 bg-white/15 text-current shadow-none',
      )}
    />
  ) : null
  return (
    <button
      type="button"
      disabled={!enabled(action.id) || busy}
      aria-busy={busy || undefined}
      aria-keyshortcuts={key ?? undefined}
      title={t(`actions.${action.id}`)}
      onClick={() => run(action.id)}
      className={cn(
        'flex h-16 min-w-0 flex-col justify-center gap-0.5 rounded-lg border px-2.5 py-1 text-start font-semibold shadow-card transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-45',
        wide ? 'text-base leading-snug' : 'text-[13px] leading-[1.2]',
        TONE[action.tone],
      )}
    >
      <span
        className={cn(
          'flex items-center gap-1.5 [&_svg]:shrink-0',
          wide ? 'justify-between [&_svg]:size-5' : '[&_svg]:size-4',
        )}
      >
        {busy ? <Loader2 className="animate-spin" aria-hidden /> : action.icon}
        {kbd}
      </span>
      <span className={cn('w-full', wide ? 'truncate' : 'line-clamp-2')}>
        {t(`actions.${action.id}`)}
      </span>
    </button>
  )
}

export function ActionBar({ className }: { className?: string }) {
  const { t } = useTranslation('pos')
  const pos = usePos()
  const secondary = SECONDARY.filter((a) => a.id !== 'return' || pos.perms.returns)
  return (
    <nav
      aria-label={t('actions.label')}
      className={cn(
        'flex items-stretch gap-2 border-t border-border bg-surface px-3 py-2',
        className,
      )}
    >
      <div
        className="grid min-w-0 flex-1 gap-2"
        style={{ gridTemplateColumns: `repeat(${secondary.length}, minmax(0, 1fr))` }}
      >
        {secondary.map((a) => (
          <KeyTile key={a.id} action={a} wide={false} />
        ))}
      </div>
      <div className="grid w-[min(44%,36rem)] shrink-0 grid-cols-[1fr_1.3fr_1.2fr] gap-2">
        {PRIMARY.map((a) => (
          <KeyTile key={a.id} action={a} wide />
        ))}
      </div>
    </nav>
  )
}

export function MobileActionBar({ className }: { className?: string }) {
  const { t } = useTranslation('pos')
  const { run, enabled } = usePosActions()
  const pos = usePos()
  return (
    <nav
      aria-label={t('actions.label')}
      className={cn(
        'flex items-center gap-2 border-t border-border bg-surface px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-overlay',
        className,
      )}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="lg" aria-label={t('actions.more')}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top">
          {SECONDARY.filter((a) => a.id !== 'return' || pos.perms.returns).map((a) => (
            <DropdownMenuItem
              key={a.id}
              icon={a.icon}
              disabled={!enabled(a.id)}
              onSelect={() => run(a.id)}
              tone={a.id === 'clear' ? 'danger' : undefined}
            >
              {t(`actions.${a.id}`)}
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem icon={<Printer />} onSelect={() => run('reprint')}>
            {t('actions.reprint')}
          </DropdownMenuItem>
          <DropdownMenuItem icon={<ClipboardList />} onSelect={() => run('sync')}>
            {t('actions.sync')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] text-muted-foreground">
          {t('totals.items', { count: pos.pricing.item_count })}
        </div>
        <div className="whitespace-nowrap text-xl font-extrabold tabular-nums">
          {formatMoney(pos.pricing.result.total_paise)}
        </div>
      </div>
      <Button
        size="xl"
        variant="primary"
        leftIcon={<CreditCard />}
        className="shrink-0 px-5"
        disabled={!enabled('pay')}
        onClick={() => run('pay')}
      >
        {t('actions.pay')}
      </Button>
    </nav>
  )
}
