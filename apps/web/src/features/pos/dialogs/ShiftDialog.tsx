/**
 * Shift of the counter (plan feature `shifts`, accounting contract): the open shift comes from
 * GET /shifts/current (live) or the bootstrap (offline). Without one the cashier is asked to
 * open a shift with the opening cash — counted by note denominations or typed as a total
 * (POST /shifts/open). When settings.pos.require_open_shift is on, billing waits for it.
 */
import { Clock, Wallet } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import {
  DENOMINATION_NOTES,
  type DenominationsInput,
  accountingRoutes,
  denominationsTotalPaise,
} from '@kadai/shared/api/accounting'
import { newId } from '@kadai/shared/ids'
import { Button, Dialog, MoneyInput, NumberInput, notify } from '@/components/ui'
import { callRoute } from '@/lib/api'
import { formatMoney, formatTime } from '@/lib/format'
import { invalidateRoutes } from '@/lib/query'
import { useShiftStatus } from '../hooks/use-shift-status'
import { usePos } from '../state/pos-context'

export function ShiftDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('pos')
  const pos = usePos()
  const queryClient = useQueryClient()
  const status = useShiftStatus()
  const [mode, setMode] = useState<'notes' | 'total'>('total')
  const [total, setTotal] = useState<number | null>(null)
  const [notes, setNotes] = useState<DenominationsInput>({})
  const [saving, setSaving] = useState(false)
  const clientRef = useMemo(() => newId(), [])
  const noteTotal = denominationsTotalPaise(notes)
  const opening = mode === 'notes' ? noteTotal : (total ?? 0)
  const registerId = pos.scope?.registerId ?? null
  const canOpen = pos.perms.shiftsOperate && pos.online && registerId !== null

  const open = async (): Promise<void> => {
    if (!registerId) return
    setSaving(true)
    try {
      await callRoute(accountingRoutes.openShift, {
        body: {
          register_id: registerId,
          opening_cash_paise: opening,
          ...(mode === 'notes' ? { denominations: notes } : {}),
          client_ref: clientRef,
        },
        idempotencyKey: clientRef,
      })
      await invalidateRoutes(queryClient, [accountingRoutes.currentShift])
      void pos.refreshCatalog()
      notify.success(t('shift.opened', { amount: formatMoney(opening) }))
      onClose()
    } catch (e) {
      notify.error(e)
    } finally {
      setSaving(false)
    }
  }

  if (status.shift) {
    return (
      <Dialog
        open
        onOpenChange={(o) => !o && onClose()}
        title={t('shift.current_title')}
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={onClose}>
              {t('shift.close_dialog')}
            </Button>
            {pos.perms.shiftsOperate ? (
              <Button asChild>
                <Link to={`/accounting/shifts/${status.shift.id}`}>{t('shift.close_shift')}</Link>
              </Button>
            ) : null}
          </>
        }
      >
        <div className="flex flex-col gap-2 pb-2 text-sm">
          <div className="flex items-center gap-2">
            <Clock className="size-4" aria-hidden />
            {t('shift.opened_at', {
              time: formatTime(status.shift.opened_at),
              name: status.shift.opened_by_name ?? '',
            })}
          </div>
          <div className="flex items-center gap-2">
            <Wallet className="size-4" aria-hidden />
            {t('shift.opening_cash', { amount: formatMoney(status.shift.opening_cash_paise) })}
          </div>
        </div>
      </Dialog>
    )
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('shift.open_title')}
      description={status.required ? t('shift.required') : t('shift.open_description')}
      size="md"
      dismissible={!status.required}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('shift.later')}
          </Button>
          <Button onClick={() => void open()} loading={saving} disabled={!canOpen}>
            {t('shift.open', { amount: formatMoney(opening) })}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 pb-2">
        {!pos.perms.shiftsOperate ? (
          <p className="rounded-md bg-warning-soft p-2 text-sm text-warning-soft-foreground">
            {t('shift.no_permission')}
          </p>
        ) : !pos.online ? (
          <p className="rounded-md bg-warning-soft p-2 text-sm text-warning-soft-foreground">
            {t('shift.offline')}
          </p>
        ) : null}
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-surface-2 p-1">
          <button
            type="button"
            onClick={() => setMode('total')}
            aria-pressed={mode === 'total'}
            className={`rounded-md py-2 text-sm font-semibold ${mode === 'total' ? 'bg-surface shadow-card' : 'text-muted-foreground'}`}
          >
            {t('shift.by_total')}
          </button>
          <button
            type="button"
            onClick={() => setMode('notes')}
            aria-pressed={mode === 'notes'}
            className={`rounded-md py-2 text-sm font-semibold ${mode === 'notes' ? 'bg-surface shadow-card' : 'text-muted-foreground'}`}
          >
            {t('shift.by_notes')}
          </button>
        </div>
        {mode === 'total' ? (
          <MoneyInput
            value={total}
            onChange={setTotal}
            size="xl"
            autoFocus
            aria-label={t('shift.opening_cash_label')}
          />
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {DENOMINATION_NOTES.map((n) => (
              <label key={n} className="flex flex-col gap-1 text-sm font-medium">
                ₹{n}
                <NumberInput
                  value={
                    (notes[String(n) as keyof DenominationsInput] as number | undefined) ?? null
                  }
                  onChange={(v) => setNotes((d) => ({ ...d, [String(n)]: v ?? 0 }))}
                  min={0}
                  aria-label={t('shift.notes_of', { note: n })}
                />
              </label>
            ))}
            <label className="col-span-2 flex flex-col gap-1 text-sm font-medium">
              {t('shift.coins')}
              <MoneyInput
                value={notes.coins ?? null}
                onChange={(v) => setNotes((d) => ({ ...d, coins: v ?? 0 }))}
              />
            </label>
          </div>
        )}
        <div className="flex justify-between rounded-lg bg-surface-2 px-3 py-2">
          <span>{t('shift.opening_cash_label')}</span>
          <span className="text-lg font-bold tabular-nums">{formatMoney(opening)}</span>
        </div>
      </div>
    </Dialog>
  )
}
