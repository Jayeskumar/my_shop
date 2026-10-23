/**
 * Cash in / out of the drawer during a shift (POST /shifts/:id/cash-entries): one-tap reasons
 * (deposited in bank, taken by owner, small expense, change added, cash from bank, other income)
 * set the counter account — a small expense asks which expense head. The journal is posted by
 * the server (cashEntryJournalLines); the X report's expected cash moves with it.
 */
import { ArrowDownToLine, ArrowUpFromLine } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ShiftCashEntryKind } from '@kadai/shared'
import {
  CASH_ENTRY_PRESETS,
  type CashEntryCounter,
  type ShiftCashEntry,
  ShiftCashEntryCreateSchema,
} from '@kadai/shared/api/accounting'
import { newId } from '@kadai/shared/ids'
import { AccountPicker } from '@/components/pickers'
import { Button, Dialog, FormField, Input, MoneyInput, RadioGroup, notify } from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatMoney } from '@/lib/format'
import { useAddCashEntry } from '../api'
import { notifyAccountingError, validationText } from '../lib/errors'
import { bi } from '../lib/labels'

type Preset = (typeof CASH_ENTRY_PRESETS)[number]

export interface CashEntryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  shift: { id: string; store_id: string }
  defaultKind?: ShiftCashEntryKind
  onSaved?: (entry: ShiftCashEntry) => void
}

const FIELDS = ['amount_paise', 'reason', 'account_id'] as const
type Errors = Partial<Record<(typeof FIELDS)[number] | 'form', string>>

export function CashEntryDialog({
  open,
  onOpenChange,
  shift,
  defaultKind = 'pay_out',
  onSaved,
}: CashEntryDialogProps) {
  const { t } = useTranslation(['accounting', 'common'])
  const mutation = useAddCashEntry()
  const [kind, setKind] = useState<ShiftCashEntryKind>(defaultKind)
  const [preset, setPreset] = useState<Preset | null>(null)
  const [amount, setAmount] = useState<number | null>(null)
  const [reason, setReason] = useState('')
  const [accountId, setAccountId] = useState<string | null>(null)
  const [clientRef, setClientRef] = useState(() => newId())
  const [errors, setErrors] = useState<Errors>({})

  useEffect(() => {
    if (!open) return
    setKind(defaultKind)
    setPreset(null)
    setAmount(null)
    setReason('')
    setAccountId(null)
    setClientRef(newId())
    setErrors({})
  }, [open, defaultKind])

  const presets = useMemo(() => CASH_ENTRY_PRESETS.filter((p) => p.kind === kind), [kind])

  const choosePreset = (p: Preset): void => {
    const previousLabel = preset ? bi(preset) : ''
    setPreset(p)
    if (!reason.trim() || reason === previousLabel) setReason(bi(p))
    if (!p.needs_account) setAccountId(null)
    setErrors({})
  }

  const changeKind = (k: ShiftCashEntryKind): void => {
    setKind(k)
    if (preset && preset.kind !== k) {
      if (reason === bi(preset)) setReason('')
      setPreset(null)
      setAccountId(null)
    }
  }

  const submit = (): void => {
    const next: Errors = {}
    if (preset?.needs_account && !accountId) next.account_id = t('shifts.cash_entry.pick_expense')
    const counter: CashEntryCounter | undefined =
      preset && !preset.needs_account && preset.counter ? preset.counter : undefined
    const body = {
      kind,
      amount_paise: amount ?? 0,
      reason: reason.trim(),
      ...(preset?.needs_account && accountId ? { account_id: accountId } : {}),
      ...(counter ? { counter } : {}),
      client_ref: clientRef,
    }
    const parsed = ShiftCashEntryCreateSchema.safeParse(body)
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '')
        const field: keyof Errors = (FIELDS as readonly string[]).includes(key)
          ? (key as keyof Errors)
          : 'form'
        next[field] ??=
          field === 'amount_paise' && !amount
            ? t('shifts.cash_entry.amount_required')
            : (validationText(issue.message) ?? issue.message)
      }
    }
    setErrors(next)
    if (Object.keys(next).length > 0) return
    mutation.mutate(
      { params: { id: shift.id }, body, idempotencyKey: clientRef },
      {
        onSuccess: (res) => {
          notify.success(
            t(kind === 'pay_in' ? 'shifts.cash_entry.done_in' : 'shifts.cash_entry.done_out', {
              amount: formatMoney(res.data.amount_paise),
            }),
          )
          onSaved?.(res.data)
          onOpenChange(false)
        },
        onError: notifyAccountingError,
      },
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}
      title={t('shifts.cash_entry.title')}
      description={t('shifts.cash_entry.description')}
      size="md"
      footer={
        <>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
          >
            {t('common:actions.cancel')}
          </Button>
          <Button size="lg" onClick={submit} loading={mutation.isPending}>
            {t(kind === 'pay_in' ? 'shifts.cash_entry.submit_in' : 'shifts.cash_entry.submit_out', {
              amount: formatMoney(amount ?? 0),
            })}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <RadioGroup<ShiftCashEntryKind>
          aria-label={t('shifts.cash_entry.kind')}
          variant="cards"
          orientation="horizontal"
          value={kind}
          onValueChange={changeKind}
          options={[
            {
              value: 'pay_out',
              label: t('shifts.cash_entry.pay_out'),
              description: t('shifts.cash_entry.pay_out_hint'),
              icon: <ArrowUpFromLine />,
            },
            {
              value: 'pay_in',
              label: t('shifts.cash_entry.pay_in'),
              description: t('shifts.cash_entry.pay_in_hint'),
              icon: <ArrowDownToLine />,
            },
          ]}
        />
        <div
          role="group"
          aria-label={t('shifts.cash_entry.presets')}
          className="flex flex-wrap gap-2"
        >
          {presets.map((p) => {
            const active = preset?.key === p.key
            return (
              <button
                key={p.key}
                type="button"
                aria-pressed={active}
                onClick={() => choosePreset(p)}
                className={cn(
                  'inline-flex min-h-10 items-center rounded-full border px-3.5 text-sm font-medium transition-colors',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                  active
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-surface hover:bg-surface-2',
                )}
              >
                {bi(p)}
              </button>
            )
          })}
        </div>
        {preset?.needs_account ? (
          <FormField label={t('shifts.cash_entry.expense_head')} required error={errors.account_id}>
            <AccountPicker
              value={accountId}
              onChange={(id) => setAccountId(id)}
              types={['expense']}
              storeId={shift.store_id}
            />
          </FormField>
        ) : null}
        <FormField label={t('fields.amount')} required error={errors.amount_paise}>
          <MoneyInput value={amount} onChange={setAmount} size="xl" autoFocus />
        </FormField>
        <FormField label={t('shifts.cash_entry.reason')} required error={errors.reason}>
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={200}
            placeholder={t('shifts.cash_entry.reason_placeholder')}
          />
        </FormField>
        {errors.form ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {errors.form}
          </p>
        ) : null}
      </div>
    </Dialog>
  )
}
