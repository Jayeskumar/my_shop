/**
 * Close a shift (POST /shifts/:id/close): count the drawer note by note (or type the total), see
 * the expected cash (opening + cash sales − cash refunds + pay-ins − pay-outs − cash expenses)
 * and the difference live. A shortage / excess posts to "Cash short / excess"; closing cannot be
 * undone, so a difference asks for confirmation. Reusable from the POS and the shift page.
 */
import { Calculator, ChevronDown, Keyboard } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  type DenominationsInput,
  type ShiftDetail,
  ShiftCloseSchema,
  denominationsTotalPaise,
  shiftDifference,
} from '@kadai/shared/api/accounting'
import {
  Button,
  Dialog,
  FormField,
  MoneyInput,
  RadioGroup,
  notify,
  useConfirm,
} from '@/components/ui'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/cn'
import { formatDateTime, formatMoney } from '@/lib/format'
import { useCloseShift, useShift } from '../api'
import { notifyAccountingError, validationText } from '../lib/errors'
import { textOrNull } from '../lib/forms'
import { differenceLabel, differenceTone } from '../lib/labels'
import { DenominationCounter } from './DenominationCounter'

type Mode = 'count' | 'total'

export interface CloseShiftDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The open shift (its live X report gives the expected cash; refreshed when the dialog opens). */
  shift: ShiftDetail
  onClosed?: (shift: ShiftDetail) => void
}

export function CloseShiftDialog({ open, onOpenChange, shift, onClosed }: CloseShiftDialogProps) {
  const { t } = useTranslation(['accounting', 'common'])
  const confirm = useConfirm()
  const fresh = useShift(open ? shift.id : null)
  const current = fresh.data?.data ?? shift
  const mutation = useCloseShift()

  const [mode, setMode] = useState<Mode>('count')
  const [notes, setNotes] = useState<DenominationsInput>({})
  const [total, setTotal] = useState<number | null>(null)
  const [remarks, setRemarks] = useState('')
  const [showBreakup, setShowBreakup] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setMode('count')
    setNotes({})
    setTotal(null)
    setRemarks('')
    setError(null)
  }, [open])

  const cash = current.summary.cash
  const expected = cash.expected_cash_paise
  const counted = mode === 'count' ? denominationsTotalPaise(notes) : (total ?? 0)
  const diff = shiftDifference(expected, counted)
  const hasCount = mode === 'count' ? Object.keys(notes).length > 0 : total !== null

  const submit = async (): Promise<void> => {
    setError(null)
    const body = {
      counted_cash_paise: counted,
      ...(mode === 'count' ? { denominations: notes } : {}),
      notes: textOrNull(remarks),
    }
    const parsed = ShiftCloseSchema.safeParse(body)
    if (!parsed.success) {
      setError(validationText(parsed.error.issues[0]?.message) ?? t('common:misc.required'))
      return
    }
    if (diff.status !== 'balanced') {
      const ok = await confirm({
        title: t(
          diff.status === 'short' ? 'shifts.close.confirm_short' : 'shifts.close.confirm_excess',
          { amount: formatMoney(Math.abs(diff.difference_paise)) },
        ),
        description: t('shifts.close.confirm_description'),
        confirmLabel: t('shifts.close.submit'),
        tone: diff.status === 'short' ? 'danger' : 'primary',
      })
      if (!ok) return
    }
    mutation.mutate(
      { params: { id: current.id }, body },
      {
        onSuccess: (res) => {
          notify.success(t('shifts.close.done'), {
            description: t('shifts.close.done_hint'),
          })
          onClosed?.(res.data)
          onOpenChange(false)
        },
        onError: notifyAccountingError,
      },
    )
  }

  const breakup: Array<[string, number, '+' | '−' | '']> = [
    [t('shifts.cash.opening'), cash.opening_cash_paise, ''],
    [t('shifts.cash.receipts'), cash.cash_receipts_paise, '+'],
    [t('shifts.cash.payments'), cash.cash_payments_paise, '−'],
    [t('shifts.cash.pay_ins'), cash.pay_ins_paise, '+'],
    [t('shifts.cash.pay_outs'), cash.pay_outs_paise, '−'],
    [t('shifts.cash.expenses'), cash.cash_expenses_paise, '−'],
  ]

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}
      title={t('shifts.close.title', { register: current.register_name })}
      description={t('shifts.close.description', {
        name: current.opened_by_name ?? '—',
        time: formatDateTime(current.opened_at),
      })}
      size="lg"
      dismissible={false}
      footer={
        <>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
          >
            {t('common:actions.cancel')}
          </Button>
          <Button
            variant={diff.status === 'short' ? 'danger' : 'primary'}
            size="lg"
            onClick={() => void submit()}
            loading={mutation.isPending}
            disabled={!hasCount}
          >
            {t('shifts.close.submit')}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_15rem] md:items-start">
        <div className="flex flex-col gap-4">
          <RadioGroup<Mode>
            aria-label={t('shifts.open.mode_label')}
            variant="cards"
            orientation="horizontal"
            className="grid-cols-2"
            value={mode}
            onValueChange={setMode}
            options={[
              { value: 'count', label: t('shifts.open.mode_count'), icon: <Calculator /> },
              { value: 'total', label: t('shifts.open.mode_total'), icon: <Keyboard /> },
            ]}
          />
          {mode === 'count' ? (
            <DenominationCounter value={notes} onChange={setNotes} autoFocus />
          ) : (
            <FormField label={t('shifts.close.counted_cash')}>
              <MoneyInput value={total} onChange={setTotal} size="xl" autoFocus />
            </FormField>
          )}
        </div>
        <div className="flex flex-col gap-3">
          <div className="rounded-lg border border-border bg-surface-2/60 p-3">
            <button
              type="button"
              className="flex w-full items-center justify-between gap-2 text-start"
              aria-expanded={showBreakup}
              onClick={() => setShowBreakup((v) => !v)}
            >
              <span className="text-sm text-muted-foreground">{t('shifts.cash.expected')}</span>
              <span className="flex items-center gap-1 text-lg font-semibold tabular-nums">
                {formatMoney(expected)}
                <ChevronDown
                  className={cn(
                    'size-4 text-muted-foreground transition-transform',
                    showBreakup && 'rotate-180',
                  )}
                  aria-hidden
                />
              </span>
            </button>
            {showBreakup ? (
              <dl className="mt-2 grid gap-1 border-t border-border pt-2 text-sm">
                {breakup.map(([label, amount, sign]) => (
                  <div key={label} className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="tabular-nums">
                      {sign ? `${sign} ` : ''}
                      {formatMoney(amount)}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </div>
          <div
            className={cn(
              'sticky bottom-0 z-10 flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 shadow-card md:static md:shadow-none',
              diff.status === 'short' && 'bg-danger-soft text-danger-soft-foreground',
              diff.status === 'excess' && 'bg-warning-soft text-warning-soft-foreground',
              diff.status === 'balanced' && 'bg-success-soft text-success-soft-foreground',
            )}
            aria-live="polite"
            data-testid="shift-difference"
            data-tone={differenceTone(diff.status)}
          >
            <span className="text-sm font-medium">
              {t('shifts.cash.difference')} · {differenceLabel(diff.status)}
            </span>
            <span className="text-lg font-semibold tabular-nums">
              {diff.difference_paise > 0 ? '+' : ''}
              {formatMoney(diff.difference_paise)}
            </span>
          </div>
          <FormField
            label={diff.status === 'balanced' ? t('fields.notes') : t('shifts.close.reason')}
            optional
            hint={diff.status === 'balanced' ? undefined : t('shifts.close.reason_hint')}
          >
            <Textarea
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              rows={2}
              maxLength={500}
            />
          </FormField>
          {error ? (
            <p role="alert" className="text-sm font-medium text-danger">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </Dialog>
  )
}
