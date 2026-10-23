/**
 * Open a shift on a counter (POST /shifts/open): the opening cash in the drawer, counted by note
 * (DenominationCounter — the server checks the total matches) or typed as one amount. One open
 * shift per counter: a 409 shift_already_open links to the shift that is already running.
 * Reusable from the POS (pass `registerId`) and the back office (counter picker).
 */
import { Calculator, Keyboard } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import {
  type DenominationsInput,
  type ShiftDetail,
  ShiftOpenSchema,
  denominationsTotalPaise,
} from '@kadai/shared/api/accounting'
import { newId } from '@kadai/shared/ids'
import { RegisterPicker } from '@/components/pickers'
import { Button, Dialog, FormField, MoneyInput, RadioGroup, notify } from '@/components/ui'
import { Textarea } from '@/components/ui/textarea'
import { isApiError } from '@/lib/api'
import { useCurrentRegister, useCurrentStore, useMe } from '@/lib/auth'
import { formatMoney } from '@/lib/format'
import { useOpenShift } from '../api'
import { errorReason, notifyAccountingError, validationText } from '../lib/errors'
import { textOrNull } from '../lib/forms'
import { DenominationCounter } from './DenominationCounter'

type Mode = 'count' | 'total'

export interface OpenShiftDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Counter to open (POS); without it the member picks one (default: the selected counter). */
  registerId?: string | null
  onOpened?: (shift: ShiftDetail) => void
}

export function OpenShiftDialog({
  open,
  onOpenChange,
  registerId,
  onOpened,
}: OpenShiftDialogProps) {
  const { t } = useTranslation(['accounting', 'common'])
  const me = useMe()
  const currentRegister = useCurrentRegister()
  const currentStore = useCurrentStore()
  const mutation = useOpenShift()

  const defaultRegister = useMemo(() => {
    if (registerId) return registerId
    if (currentRegister?.is_active) return currentRegister.id
    const registers = (me?.registers ?? []).filter((r) => r.is_active)
    return registers.find((r) => r.store_id === currentStore?.id)?.id ?? registers[0]?.id ?? null
  }, [registerId, currentRegister, currentStore, me])

  const [register, setRegister] = useState<string | null>(defaultRegister)
  const [mode, setMode] = useState<Mode>('count')
  const [notes, setNotes] = useState<DenominationsInput>({})
  const [total, setTotal] = useState<number | null>(null)
  const [remarks, setRemarks] = useState('')
  const [clientRef, setClientRef] = useState(() => newId())
  const [error, setError] = useState<string | null>(null)
  const [runningShiftId, setRunningShiftId] = useState<string | null>(null)

  // Fresh form (and idempotency key) every time the dialog opens.
  useEffect(() => {
    if (!open) return
    setRegister(defaultRegister)
    setMode('count')
    setNotes({})
    setTotal(null)
    setRemarks('')
    setClientRef(newId())
    setError(null)
    setRunningShiftId(null)
  }, [open, defaultRegister])

  const opening = mode === 'count' ? denominationsTotalPaise(notes) : (total ?? 0)

  const submit = (): void => {
    setError(null)
    setRunningShiftId(null)
    if (!register) {
      setError(t('shifts.open.pick_register'))
      return
    }
    const body = {
      register_id: register,
      opening_cash_paise: opening,
      ...(mode === 'count' ? { denominations: notes } : {}),
      notes: textOrNull(remarks),
      client_ref: clientRef,
    }
    const parsed = ShiftOpenSchema.safeParse(body)
    if (!parsed.success) {
      setError(validationText(parsed.error.issues[0]?.message) ?? t('common:misc.required'))
      return
    }
    mutation.mutate(
      { body, idempotencyKey: clientRef },
      {
        onSuccess: (res) => {
          notify.success(
            t('shifts.open.done', { amount: formatMoney(res.data.opening_cash_paise) }),
          )
          onOpened?.(res.data)
          onOpenChange(false)
        },
        onError: (e) => {
          if (errorReason(e) === 'shift_already_open') {
            const id = isApiError(e) ? e.details?.shift_id : undefined
            setRunningShiftId(typeof id === 'string' ? id : null)
            setError(t('errors.shift_already_open'))
            return
          }
          notifyAccountingError(e)
        },
      },
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}
      title={t('shifts.open.title')}
      description={t('shifts.open.description')}
      size="md"
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
          <Button onClick={submit} loading={mutation.isPending} size="lg">
            {t('shifts.open.submit', { amount: formatMoney(opening) })}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {registerId ? null : (
          <FormField label={t('fields.register')} required>
            <RegisterPicker value={register} onChange={(id) => setRegister(id)} clearable={false} />
          </FormField>
        )}
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
          <FormField label={t('shifts.open.opening_cash')} hint={t('shifts.open.opening_hint')}>
            <MoneyInput value={total} onChange={setTotal} size="xl" autoFocus />
          </FormField>
        )}
        <FormField label={t('fields.notes')} optional>
          <Textarea
            value={remarks}
            onChange={(e) => setRemarks(e.target.value)}
            rows={2}
            maxLength={500}
          />
        </FormField>
        {error ? (
          <div
            role="alert"
            className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-soft-foreground"
          >
            {error}
            {runningShiftId ? (
              <>
                {' '}
                <Link
                  to={`/accounting/shifts/${runningShiftId}`}
                  className="font-medium underline"
                  onClick={() => onOpenChange(false)}
                >
                  {t('shifts.open.view_running')}
                </Link>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </Dialog>
  )
}
