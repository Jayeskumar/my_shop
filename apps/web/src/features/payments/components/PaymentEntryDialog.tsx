/**
 * "Receive payment" (customer → shop, direction in, payments.collect) and "Pay supplier"
 * (shop → supplier, direction out, payments.pay) through POST /payments.
 *
 *  - Party picker (customer / supplier); the amount defaults to the party's total due.
 *  - Method cards, reference / UTR / cheque number, date, store (multi-store shops).
 *  - Allocation over the open items (GET /payments/open-items): FIFO auto-fill (sent as
 *    `auto_allocate: 'fifo'`, which the server computes with the same allocateFifo) or manual
 *    amounts (sent as `allocations`); the rest stays as the party's advance.
 *  - Cash taken at this counter while its shift is open goes into that shift's drawer.
 *
 * The request body is validated with the contract schema before it is sent; the
 * Idempotency-Key is kept for the whole dialog session, so a double click records one payment.
 */
import { useEffect, useMemo, useRef } from 'react'
import { Controller, FormProvider, type Resolver, useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import {
  allocateFifo,
  type OpenItemsQuery,
  type PaymentCreate,
  PaymentCreateSchema,
  type PaymentDetail,
} from '@kadai/shared/api/payments'
import type { PartyType, PaymentDirection, PaymentMethod } from '@kadai/shared/enums'
import { todayIn } from '@kadai/shared/fy'
import { newId } from '@kadai/shared/ids'
import { CustomerPicker, StorePicker, SupplierPicker } from '@/components/pickers'
import {
  Button,
  Checkbox,
  DatePicker,
  Dialog,
  Input,
  MoneyInput,
  RadioGroup,
  Skeleton,
  notify,
} from '@/components/ui'
import { Textarea } from '@/components/ui/textarea'
import { useCan, useCurrentRegister, useCurrentStore, useFeature, useMe } from '@/lib/auth'
import { formatMoney } from '@/lib/format'
import { useCreatePayment, useCurrentShift, useOpenItems } from '../api'
import { applyContractErrors, contractResolver, textOrUndefined } from '../lib/forms'
import { methodLabel } from '../lib/labels'
import { useValidationKeyText } from '../lib/validation-text'
import { itemKey } from '../lib/allocation'
import { AllocationTable } from './AllocationTable'
import { PaymentMethodIcon } from './PaymentMethodIcon'
import { PaymentsField } from './PaymentsField'
import { notifyPaymentError } from '../lib/errors'

export interface PaymentPartyRef {
  type: PartyType
  id: string
  name: string
}

interface FormValues {
  party: { id: string; name: string } | null
  amount_paise: number | null
  method: PaymentMethod
  reference: string
  payment_date: string | null
  store_id: string | null
  /** 'auto' = FIFO follows the amount; 'manual' = the amounts in `manual`. */
  allocation_mode: 'auto' | 'manual'
  manual: Record<string, number>
  notes: string
  to_shift: boolean
}

const FIELDS = [
  'party',
  'amount_paise',
  'method',
  'reference',
  'payment_date',
  'store_id',
  'manual',
  'notes',
] as const

const IN_METHODS: readonly PaymentMethod[] = [
  'cash',
  'upi',
  'card',
  'bank_transfer',
  'cheque',
  'other',
]
const OUT_METHODS: readonly PaymentMethod[] = [
  'cash',
  'upi',
  'bank_transfer',
  'cheque',
  'card',
  'other',
]

function mapPath(path: string): string | null {
  if (path === 'party_id' || path === 'party_type') return 'party'
  if (path.startsWith('allocations')) return 'manual'
  if (path === 'auto_allocate') return 'manual'
  if (path === 'shift_id' || path === 'direction') return null
  return path
}

export function PaymentEntryDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  direction: PaymentDirection
  /** Preselected party (from a customer / supplier screen). */
  party?: PaymentPartyRef | null
  onDone?: (payment: PaymentDetail) => void
}) {
  if (!props.open) return null
  return <PaymentEntryBody {...props} />
}

function PaymentEntryBody({
  onOpenChange,
  direction,
  party: presetParty,
  onDone,
}: {
  onOpenChange: (open: boolean) => void
  direction: PaymentDirection
  party?: PaymentPartyRef | null
  onDone?: (payment: PaymentDetail) => void
}) {
  const { t, i18n } = useTranslation(['payments', 'common'])
  const me = useMe()
  const currentStore = useCurrentStore()
  const partyType: PartyType = direction === 'in' ? 'customer' : 'supplier'
  const today = todayIn(me?.tenant.timezone)
  const idempotencyKey = useRef(newId()).current
  const formId = useRef(`payment-${newId()}`).current
  const multiStore = (me?.stores.filter((s) => s.is_active).length ?? 0) > 1
  const create = useCreatePayment()
  const keyText = useValidationKeyText()
  // The contract resolver closes over this render's open items and shift (see below).
  const resolverRef = useRef<Resolver<FormValues> | null>(null)

  const form = useForm<FormValues>({
    resolver: (values, context, options) =>
      resolverRef.current ? resolverRef.current(values, context, options) : { values, errors: {} },
    defaultValues: {
      party: presetParty ? { id: presetParty.id, name: presetParty.name } : null,
      amount_paise: null,
      method: 'cash',
      reference: '',
      payment_date: today,
      store_id: currentStore?.id ?? me?.stores[0]?.id ?? null,
      allocation_mode: 'auto',
      manual: {},
      notes: '',
      to_shift: true,
    },
  })
  const [party, amount, method, mode, manual, storeId, toShift] = useWatch({
    control: form.control,
    name: ['party', 'amount_paise', 'method', 'allocation_mode', 'manual', 'store_id', 'to_shift'],
  })

  const openQuery: OpenItemsQuery | null = party
    ? { party_type: partyType, party_id: party.id, direction }
    : null
  const openItems = useOpenItems(openQuery)
  const open = openItems.data?.data
  const items = useMemo(() => open?.items ?? [], [open])
  const storeCredit = direction === 'in' ? (open?.party.store_credit_paise ?? 0) : 0

  // Default amount = what the party owes (only until the user types an amount).
  const seededFor = useRef<string | null>(null)
  useEffect(() => {
    if (!open || !party || seededFor.current === party.id) return
    seededFor.current = party.id
    if (!form.getFieldState('amount_paise').isDirty && open.total_due_paise > 0) {
      form.setValue('amount_paise', open.total_due_paise, {
        shouldValidate: form.formState.isSubmitted,
      })
    }
  }, [open, party, form])

  // The counter's open shift (cash drawer).
  const register = useCurrentRegister()
  const shiftsOn = useFeature('shifts')
  const canShift = useCan(['shifts.operate', 'pos.use'])
  const shiftQuery = useCurrentShift(register?.id ?? null, shiftsOn && canShift)
  const openShift = shiftQuery.data?.data?.status === 'open' ? shiftQuery.data.data : null
  const drawerShift =
    openShift && method === 'cash' && storeId === openShift.store_id ? openShift : null

  const fifo = useMemo(() => allocateFifo(items, Math.max(0, amount ?? 0)), [items, amount])
  const amounts = useMemo<Record<string, number>>(() => {
    if (mode === 'manual') return manual
    return Object.fromEntries(fifo.allocations.map((a) => [itemKey(a), a.amount_paise]))
  }, [mode, manual, fifo])

  const toBody = (v: FormValues): PaymentCreate => {
    const shift = drawerShift && v.to_shift ? drawerShift : null
    const reference = v.method === 'cash' ? undefined : textOrUndefined(v.reference)
    const notes = textOrUndefined(v.notes)
    const base: PaymentCreate = {
      direction,
      store_id: v.store_id ?? '',
      party_type: partyType,
      party_id: v.party?.id ?? '',
      method: v.method,
      amount_paise: v.amount_paise ?? 0,
      ...(v.payment_date ? { payment_date: v.payment_date } : {}),
      ...(reference ? { reference } : {}),
      ...(notes ? { notes } : {}),
      ...(shift ? { shift_id: shift.id, register_id: shift.register_id } : {}),
      client_ref: idempotencyKey,
    }
    if (items.length === 0) return base
    if (v.allocation_mode === 'auto') return { ...base, auto_allocate: 'fifo' }
    const allocations = items.flatMap((item) => {
      const a = v.manual[itemKey(item)] ?? 0
      return a > 0
        ? [{ target_type: item.target_type, target_id: item.target_id, amount_paise: a }]
        : []
    })
    return { ...base, allocations }
  }

  resolverRef.current = contractResolver<FormValues>(PaymentCreateSchema, toBody, mapPath)

  const onSubmit = form.handleSubmit((values) => {
    create.mutate(
      { body: toBody(values), idempotencyKey },
      {
        onSuccess: (res) => {
          notify.success(
            t(direction === 'in' ? 'entry.received_toast' : 'entry.paid_toast', {
              amount: formatMoney(res.data.amount_paise),
              name: res.data.party_name ?? values.party?.name ?? '',
            }),
            res.data.number
              ? { description: t('entry.number', { number: res.data.number }) }
              : undefined,
          )
          onDone?.(res.data)
          onOpenChange(false)
        },
        onError: (error) => {
          if (!applyContractErrors(error, form.setError, FIELDS, mapPath)) notifyPaymentError(error)
        },
      },
    )
  })

  const setManual = (key: string, value: number | null): void => {
    const next = mode === 'manual' ? { ...manual } : { ...amounts }
    if (value && value > 0) next[key] = value
    else delete next[key]
    form.setValue('allocation_mode', 'manual')
    form.setValue('manual', next, { shouldDirty: true })
  }

  const methods = (direction === 'in' ? IN_METHODS : OUT_METHODS).concat(
    storeCredit > 0 ? ['store_credit'] : [],
  )
  const referenceLabel =
    method === 'upi'
      ? t('entry.reference_upi')
      : method === 'cheque'
        ? t('entry.reference_cheque')
        : method === 'card'
          ? t('entry.reference_card')
          : method === 'bank_transfer'
            ? t('entry.reference_bank')
            : t('fields.reference')
  const due = open?.total_due_paise ?? 0
  const balance = open?.party.balance_paise ?? 0
  const pending = create.isPending
  const rawManualError = (form.formState.errors.manual as { message?: string } | undefined)?.message
  // allocations_exceed_amount is already shown under the allocation totals.
  const manualError =
    rawManualError && rawManualError !== 'allocations_exceed_amount'
      ? (keyText(rawManualError) ?? rawManualError)
      : null

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!pending) onOpenChange(o)
      }}
      size="lg"
      title={direction === 'in' ? t('entry.receive_title') : t('entry.pay_title')}
      description={direction === 'in' ? t('entry.receive_hint') : t('entry.pay_hint')}
      dismissible={!form.formState.isDirty}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={pending} size="lg">
            {direction === 'in'
              ? t('entry.receive_submit', { amount: formatMoney(amount ?? 0) })
              : t('entry.pay_submit', { amount: formatMoney(amount ?? 0) })}
          </Button>
        </>
      }
    >
      <FormProvider {...form}>
        <form
          id={formId}
          onSubmit={(e) => void onSubmit(e)}
          noValidate
          className="grid gap-5 pb-2 [&>*]:min-w-0"
        >
          <PaymentsField
            name="party"
            label={direction === 'in' ? t('fields.customer') : t('fields.supplier')}
            required
          >
            <Controller
              control={form.control}
              name="party"
              render={({ field }) =>
                direction === 'in' ? (
                  <CustomerPicker
                    value={field.value}
                    onChange={(c) => {
                      field.onChange(c ? { id: c.id, name: c.name } : null)
                      form.setValue('allocation_mode', 'auto')
                      form.setValue('manual', {})
                    }}
                    disabled={Boolean(presetParty)}
                  />
                ) : (
                  <SupplierPicker
                    value={field.value}
                    onChange={(s) => {
                      field.onChange(s ? { id: s.id, name: s.name } : null)
                      form.setValue('allocation_mode', 'auto')
                      form.setValue('manual', {})
                    }}
                    disabled={Boolean(presetParty)}
                  />
                )
              }
            />
          </PaymentsField>

          {party && open ? (
            <p className="-mt-3 text-sm text-muted-foreground" data-testid="party-balance">
              {balance > 0
                ? t(direction === 'in' ? 'entry.owes' : 'entry.we_owe', {
                    amount: formatMoney(balance),
                  })
                : balance < 0
                  ? t('entry.has_advance', { amount: formatMoney(-balance) })
                  : t('entry.settled')}
            </p>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
            <PaymentsField name="amount_paise" label={t('fields.amount')} required>
              <Controller
                control={form.control}
                name="amount_paise"
                render={({ field }) => (
                  <MoneyInput
                    size="xl"
                    value={field.value}
                    onChange={(v) => field.onChange(v)}
                    onBlur={field.onBlur}
                    placeholder="0.00"
                  />
                )}
              />
            </PaymentsField>
            {due > 0 && amount !== due ? (
              <Button
                type="button"
                variant="secondary"
                size="lg"
                onClick={() => form.setValue('amount_paise', due, { shouldDirty: true })}
              >
                {t('entry.full_due', { amount: formatMoney(due) })}
              </Button>
            ) : null}
          </div>

          <PaymentsField name="method" label={t('fields.method')}>
            <Controller
              control={form.control}
              name="method"
              render={({ field }) => (
                <RadioGroup
                  value={field.value}
                  onValueChange={field.onChange}
                  variant="cards"
                  className="grid-cols-2 sm:grid-cols-3"
                  aria-label={t('fields.method')}
                  options={methods.map((m) => ({
                    value: m,
                    label: methodLabel(m, i18n.language),
                    icon: (
                      <span className="hidden sm:inline-flex">
                        <PaymentMethodIcon method={m} />
                      </span>
                    ),
                    ...(m === 'store_credit'
                      ? {
                          description: t('entry.store_credit_available', {
                            amount: formatMoney(storeCredit),
                          }),
                        }
                      : {}),
                  }))}
                />
              )}
            />
          </PaymentsField>

          <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
            {method !== 'cash' && method !== 'store_credit' ? (
              <PaymentsField name="reference" label={referenceLabel} optional>
                <Input autoComplete="off" maxLength={100} {...form.register('reference')} />
              </PaymentsField>
            ) : null}
            <PaymentsField name="payment_date" label={t('fields.date')}>
              <Controller
                control={form.control}
                name="payment_date"
                render={({ field }) => (
                  <DatePicker value={field.value} onChange={field.onChange} max={today} />
                )}
              />
            </PaymentsField>
            {multiStore ? (
              <PaymentsField name="store_id" label={t('fields.store')}>
                <Controller
                  control={form.control}
                  name="store_id"
                  render={({ field }) => (
                    <StorePicker
                      value={field.value}
                      onChange={(id) => field.onChange(id)}
                      clearable={false}
                    />
                  )}
                />
              </PaymentsField>
            ) : null}
          </div>

          {drawerShift ? (
            <Controller
              control={form.control}
              name="to_shift"
              render={({ field }) => (
                <Checkbox
                  checked={field.value}
                  onCheckedChange={(v) => field.onChange(v === true)}
                  label={t('entry.to_shift', { counter: drawerShift.register_name })}
                  description={toShift ? t('entry.to_shift_hint') : t('entry.to_shift_off_hint')}
                />
              )}
            />
          ) : null}

          {party ? (
            <section className="grid gap-3 rounded-lg border border-border p-3 sm:p-4">
              {openItems.isPending ? (
                <div className="grid gap-2" aria-busy>
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : openItems.isError ? (
                <div
                  role="alert"
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning-soft-foreground"
                >
                  <span>{t('allocation.load_failed')}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void openItems.refetch()}
                  >
                    {t('common:actions.retry')}
                  </Button>
                </div>
              ) : items.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {direction === 'in' ? t('allocation.none_in') : t('allocation.none_out')}
                </p>
              ) : (
                <AllocationTable
                  items={items}
                  amounts={amounts}
                  mode={mode}
                  totalPaise={amount ?? 0}
                  onChange={setManual}
                  onAutoFill={() => {
                    form.setValue('allocation_mode', 'auto')
                    form.setValue('manual', {})
                  }}
                />
              )}
              {manualError ? (
                <p role="alert" className="text-sm font-medium text-danger">
                  {manualError}
                </p>
              ) : null}
            </section>
          ) : null}

          <PaymentsField name="notes" label={t('fields.notes')} optional>
            <Textarea rows={2} maxLength={1000} {...form.register('notes')} />
          </PaymentsField>
        </form>
      </FormProvider>
    </Dialog>
  )
}
