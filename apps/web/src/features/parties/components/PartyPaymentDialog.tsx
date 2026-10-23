/**
 * "Receive payment" (customer, direction in, payments.collect) and "Pay supplier" (direction
 * out, payments.pay) through POST /payments (payments contract). Default allocation is FIFO
 * (`auto_allocate: 'fifo'`): the preview shows which bills the amount clears, using the shared
 * allocateFifo over GET /payments/open-items — the same function the server runs. "Choose bills"
 * sends explicit allocations; anything left over stays as the party's advance.
 *
 * Cash received at a counter whose shift is open (plan feature `shifts`, this device's register)
 * goes into that shift's drawer (`shift_id`), so the shift's expected cash includes it; the
 * cashier can untick it for money taken elsewhere.
 */
import {
  Banknote,
  CircleEllipsis,
  CreditCard,
  FileText,
  Landmark,
  ListChecks,
  Smartphone,
  Wand2,
} from 'lucide-react'
import { type ReactNode, useMemo, useRef } from 'react'
import { Controller, FormProvider, useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import {
  allocateFifo,
  type OpenItem,
  PAYMENT_METHOD_LABELS,
  type PaymentCreate,
  PaymentCreateSchema,
  type PaymentDetail,
} from '@kadai/shared/api/payments'
import type { PartyType, PaymentMethod } from '@kadai/shared/enums'
import { todayIn } from '@kadai/shared/fy'
import { newId } from '@kadai/shared/ids'
import { StorePicker } from '@/components/pickers'
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
import { isApiError } from '@/lib/api'
import { useCan, useCurrentRegister, useCurrentStore, useFeature, useMe } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { formatDate, formatMoney } from '@/lib/format'
import { useCreatePayment, useCurrentShift, useOpenItems } from '../api'
import { contractResolver } from '../lib/forms'
import { pickLabel } from '../lib/labels'
import { PartyField } from './form/PartyField'
import { useValidationKeyText } from '../lib/validation-text'

/** Icons are hidden on phones so long Tamil method names fit two cards per row. */
const icon = (node: ReactNode): ReactNode => (
  <span className="hidden sm:inline-flex" aria-hidden>
    {node}
  </span>
)
const METHODS: readonly { method: PaymentMethod; icon: ReactNode }[] = [
  { method: 'cash', icon: icon(<Banknote />) },
  { method: 'upi', icon: icon(<Smartphone />) },
  { method: 'card', icon: icon(<CreditCard />) },
  { method: 'bank_transfer', icon: icon(<Landmark />) },
  { method: 'cheque', icon: icon(<FileText />) },
  { method: 'other', icon: icon(<CircleEllipsis />) },
]

export interface PaymentParty {
  type: PartyType
  id: string
  name: string
  /** Signed balance (customers: + owes; suppliers: + shop owes). */
  balance_paise: number
}

interface PaymentFormValues {
  amount_paise: number | null
  method: PaymentMethod
  reference: string
  payment_date: string | null
  store_id: string | null
  allocation: 'fifo' | 'manual'
  /** Manual allocation: target key → amount (paise). */
  manual: Record<string, number | null>
  notes: string
  /** Cash only: put the money into the open shift's drawer of this counter. */
  to_shift: boolean
}

const itemKey = (i: Pick<OpenItem, 'target_type' | 'target_id'>): string =>
  `${i.target_type}:${i.target_id}`

export function PartyPaymentDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  party: PaymentParty
  onDone?: (payment: PaymentDetail) => void
}) {
  if (!props.open) return null
  return <PaymentDialogBody {...props} />
}

function PaymentDialogBody({
  onOpenChange,
  party,
  onDone,
}: {
  onOpenChange: (open: boolean) => void
  party: PaymentParty
  onDone?: (payment: PaymentDetail) => void
}) {
  const { t, i18n } = useTranslation(['parties', 'common'])
  const me = useMe()
  const currentStore = useCurrentStore()
  const keyText = useValidationKeyText()
  const direction = party.type === 'customer' ? 'in' : 'out'
  const today = todayIn(me?.tenant.timezone)
  const idempotencyKey = useRef(newId()).current
  const formId = useRef(`payment-${newId()}`).current
  const multiStore = (me?.stores.filter((s) => s.is_active).length ?? 0) > 1

  const openItems = useOpenItems({ party_type: party.type, party_id: party.id, direction })
  const items = useMemo(() => openItems.data?.data.items ?? [], [openItems.data])

  // The open shift of this device's counter (cash drawer), when the plan has shifts.
  const register = useCurrentRegister()
  const shiftsOn = useFeature('shifts')
  const canShift = useCan(['shifts.operate', 'pos.use'])
  const currentShift = useCurrentShift(register?.id ?? null, {
    enabled: shiftsOn && canShift && Boolean(register),
  })
  const openShift =
    currentShift.data?.data && currentShift.data.data.status === 'open'
      ? currentShift.data.data
      : null
  const shiftFor = (v: Pick<PaymentFormValues, 'method' | 'store_id' | 'to_shift'>) =>
    openShift && v.method === 'cash' && v.to_shift && v.store_id === openShift.store_id
      ? openShift
      : null

  const toBody = (v: PaymentFormValues): PaymentCreate => {
    const base: PaymentCreate = {
      direction,
      store_id: v.store_id ?? '',
      party_type: party.type,
      party_id: party.id,
      method: v.method,
      amount_paise: v.amount_paise ?? 0,
      ...(v.payment_date ? { payment_date: v.payment_date } : {}),
      ...(v.reference.trim() && v.method !== 'cash' ? { reference: v.reference.trim() } : {}),
      ...(v.notes.trim() ? { notes: v.notes.trim() } : {}),
    }
    const shift = shiftFor(v)
    if (shift) base.shift_id = shift.id
    if (v.allocation === 'fifo') return { ...base, auto_allocate: 'fifo' }
    const allocations = items.flatMap((item) => {
      const amount = v.manual[itemKey(item)] ?? 0
      return amount > 0
        ? [{ target_type: item.target_type, target_id: item.target_id, amount_paise: amount }]
        : []
    })
    return { ...base, allocations }
  }

  const form = useForm<PaymentFormValues>({
    defaultValues: {
      amount_paise: party.balance_paise > 0 ? party.balance_paise : null,
      method: 'cash',
      reference: '',
      payment_date: today,
      store_id: currentStore?.id ?? me?.stores[0]?.id ?? null,
      allocation: 'fifo',
      manual: {},
      notes: '',
      to_shift: true,
    },
    resolver: contractResolver<PaymentFormValues>(PaymentCreateSchema, toBody, (path) => {
      if (path.startsWith('allocations')) return 'manual'
      if (path === 'auto_allocate') return 'allocation'
      return path
    }),
  })
  const create = useCreatePayment()
  const [amount, method, allocation, manual, storeId, toShift] = useWatch({
    control: form.control,
    name: ['amount_paise', 'method', 'allocation', 'manual', 'store_id', 'to_shift'],
  })
  const drawerShift =
    openShift && method === 'cash' && storeId === openShift.store_id ? openShift : null

  const fifo = useMemo(() => allocateFifo(items, Math.max(0, amount ?? 0)), [items, amount])
  const manualTotal = Object.values(manual ?? {}).reduce<number>((s, v) => s + (v ?? 0), 0)
  const allocated = allocation === 'fifo' ? (amount ?? 0) - fifo.unallocated_paise : manualTotal
  const advance = Math.max(0, (amount ?? 0) - allocated)
  const settledCount =
    allocation === 'fifo'
      ? fifo.allocations.filter((a) => {
          const item = items.find((i) => itemKey(i) === itemKey(a))
          return item ? a.amount_paise >= item.due_paise : false
        }).length
      : items.filter((i) => (manual?.[itemKey(i)] ?? 0) >= i.due_paise).length

  const fillFifo = (): void => {
    const next: Record<string, number | null> = {}
    for (const a of allocateFifo(items, Math.max(0, amount ?? 0)).allocations)
      next[itemKey(a)] = a.amount_paise
    form.setValue('manual', next, { shouldDirty: true, shouldValidate: true })
  }

  const onSubmit = form.handleSubmit((values) => {
    create.mutate(
      { body: toBody(values), idempotencyKey },
      {
        onSuccess: (res) => {
          notify.success(
            t(direction === 'in' ? 'payment.received_toast' : 'payment.paid_toast', {
              amount: formatMoney(res.data.amount_paise),
              name: party.name,
            }),
            res.data.number
              ? { description: t('payment.number', { number: res.data.number }) }
              : undefined,
          )
          onDone?.(res.data)
          onOpenChange(false)
        },
        onError: (error) => {
          if (isApiError(error) && error.code === 'VALIDATION_ERROR') {
            const issue = error.validationIssues[0]
            if (issue) {
              const field = issue.path.startsWith('allocations') ? 'manual' : issue.path
              if (
                [
                  'amount_paise',
                  'reference',
                  'payment_date',
                  'store_id',
                  'manual',
                  'method',
                ].includes(field)
              ) {
                form.setError(field as keyof PaymentFormValues, {
                  type: 'server',
                  message: issue.message,
                })
                return
              }
            }
          }
          notify.error(error)
        },
      },
    )
  })

  const methodOptions = METHODS.map(({ method: m, icon }) => ({
    value: m,
    label: pickLabel(PAYMENT_METHOD_LABELS[m], i18n.language),
    icon,
  }))
  const referenceLabel =
    method === 'upi'
      ? t('payment.reference_upi')
      : method === 'cheque'
        ? t('payment.reference_cheque')
        : method === 'card'
          ? t('payment.reference_card')
          : t('payment.reference_bank')

  const due = party.balance_paise
  const manualError = keyText(
    (form.formState.errors.manual as { message?: string } | undefined)?.message,
  )

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!create.isPending) onOpenChange(o)
      }}
      title={direction === 'in' ? t('payment.receive_title') : t('payment.pay_title')}
      description={
        due > 0
          ? t(direction === 'in' ? 'payment.due_now' : 'payment.payable_now', {
              name: party.name,
              amount: formatMoney(due),
            })
          : due < 0
            ? t('payment.advance_now', { name: party.name, amount: formatMoney(-due) })
            : t('payment.nothing_due', { name: party.name })
      }
      size="lg"
      dismissible={!form.formState.isDirty}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={create.isPending} size="lg">
            {direction === 'in'
              ? t('payment.receive_submit', { amount: formatMoney(amount ?? 0) })
              : t('payment.pay_submit', { amount: formatMoney(amount ?? 0) })}
          </Button>
        </>
      }
    >
      <FormProvider {...form}>
        <form id={formId} onSubmit={onSubmit} noValidate className="grid gap-5 pb-2 [&>*]:min-w-0">
          <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
            <PartyField name="amount_paise" label={t('payment.amount')} required>
              <Controller
                control={form.control}
                name="amount_paise"
                render={({ field }) => (
                  <MoneyInput
                    autoFocus
                    size="xl"
                    value={field.value}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    placeholder="0.00"
                  />
                )}
              />
            </PartyField>
            {due > 0 && amount !== due ? (
              <Button
                type="button"
                variant="secondary"
                size="lg"
                onClick={() => form.setValue('amount_paise', due, { shouldValidate: true })}
              >
                {t('payment.full_due', { amount: formatMoney(due) })}
              </Button>
            ) : null}
          </div>

          <PartyField name="method" label={t('payment.method')}>
            <Controller
              control={form.control}
              name="method"
              render={({ field }) => (
                <RadioGroup
                  value={field.value}
                  onValueChange={field.onChange}
                  options={methodOptions}
                  variant="cards"
                  className="grid-cols-2 sm:grid-cols-3"
                  aria-label={t('payment.method')}
                />
              )}
            />
          </PartyField>

          <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
            {method !== 'cash' ? (
              <PartyField name="reference" label={referenceLabel} optional>
                <Input autoComplete="off" maxLength={100} {...form.register('reference')} />
              </PartyField>
            ) : null}
            <PartyField name="payment_date" label={t('payment.date')}>
              <Controller
                control={form.control}
                name="payment_date"
                render={({ field }) => (
                  <DatePicker value={field.value} onChange={field.onChange} max={today} />
                )}
              />
            </PartyField>
            {multiStore ? (
              <PartyField name="store_id" label={t('payment.store')}>
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
              </PartyField>
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
                  label={t('payment.to_shift', { counter: drawerShift.register_name })}
                  description={
                    toShift ? t('payment.to_shift_hint') : t('payment.to_shift_off_hint')
                  }
                />
              )}
            />
          ) : null}

          <section className="grid gap-3 rounded-lg border border-border p-3 sm:p-4">
            <Controller
              control={form.control}
              name="allocation"
              render={({ field }) => (
                <RadioGroup
                  value={field.value}
                  onValueChange={field.onChange}
                  orientation="horizontal"
                  variant="cards"
                  aria-label={t('payment.allocation')}
                  options={[
                    {
                      value: 'fifo',
                      label: t('payment.alloc_fifo'),
                      description: t('payment.alloc_fifo_hint'),
                      icon: <Wand2 />,
                    },
                    {
                      value: 'manual',
                      label: t('payment.alloc_manual'),
                      description: t('payment.alloc_manual_hint'),
                      icon: <ListChecks />,
                    },
                  ]}
                />
              )}
            />

            {openItems.isLoading ? (
              <div className="grid gap-2">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
              </div>
            ) : openItems.isError ? (
              <div
                role="alert"
                className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning-soft-foreground"
              >
                <span>{t('payment.open_items_failed')}</span>
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
              <p className="text-sm text-muted-foreground">{t('payment.no_open_items')}</p>
            ) : (
              <>
                {allocation === 'manual' ? (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm text-muted-foreground">
                      {t('payment.manual_total', { amount: formatMoney(manualTotal) })}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      leftIcon={<Wand2 />}
                      onClick={fillFifo}
                    >
                      {t('payment.fill_oldest')}
                    </Button>
                  </div>
                ) : null}
                <ul
                  className="grid max-h-64 gap-1 overflow-y-auto"
                  aria-label={t('payment.open_items')}
                >
                  {items.map((item) => (
                    <OpenItemRow
                      key={itemKey(item)}
                      item={item}
                      mode={allocation}
                      fifoAmount={
                        fifo.allocations.find((a) => itemKey(a) === itemKey(item))?.amount_paise ??
                        0
                      }
                      manualAmount={manual?.[itemKey(item)] ?? null}
                      onManual={(v) =>
                        form.setValue(`manual.${itemKey(item)}`, v, {
                          shouldDirty: true,
                          shouldValidate: form.formState.isSubmitted,
                        })
                      }
                    />
                  ))}
                </ul>
              </>
            )}
            {manualError ? (
              <p role="alert" className="text-sm font-medium text-danger">
                {manualError}
              </p>
            ) : null}
            {(amount ?? 0) > 0 && !openItems.isError ? (
              <p className="rounded-md bg-surface-2 px-3 py-2 text-sm">
                {settledCount > 0
                  ? t('payment.preview_settles', { count: settledCount })
                  : allocated > 0
                    ? t('payment.preview_part', { amount: formatMoney(allocated) })
                    : t('payment.preview_none')}
                {advance > 0
                  ? ` ${t('payment.preview_advance', { amount: formatMoney(advance) })}`
                  : ''}
              </p>
            ) : null}
          </section>

          <PartyField name="notes" label={t('fields.notes')} optional>
            <Textarea rows={2} maxLength={1000} {...form.register('notes')} />
          </PartyField>
        </form>
      </FormProvider>
    </Dialog>
  )
}

function OpenItemRow({
  item,
  mode,
  fifoAmount,
  manualAmount,
  onManual,
}: {
  item: OpenItem
  mode: 'fifo' | 'manual'
  fifoAmount: number
  manualAmount: number | null
  onManual: (amount: number | null) => void
}) {
  const { t } = useTranslation('parties')
  const label =
    item.target_type === 'opening_balance'
      ? t('payment.opening_item')
      : (item.number ?? t('payment.unnumbered'))
  const checked = (manualAmount ?? 0) > 0
  const covered = mode === 'fifo' ? fifoAmount : (manualAmount ?? 0)
  return (
    <li
      className={cn(
        'flex flex-wrap items-center gap-3 rounded-md px-2 py-2 text-sm sm:flex-nowrap',
        covered >= item.due_paise ? 'bg-success-soft/50' : covered > 0 ? 'bg-warning-soft/50' : '',
      )}
    >
      {mode === 'manual' ? (
        <Checkbox
          checked={checked}
          aria-label={t('payment.select_item', { number: label })}
          onCheckedChange={(v) => onManual(v === true ? item.due_paise : null)}
        />
      ) : null}
      <div className="min-w-0 flex-1">
        <div className="font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">
          {[
            item.date ? formatDate(item.date) : null,
            item.days_overdue && item.days_overdue > 0
              ? t('payment.days_overdue', { count: item.days_overdue })
              : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
      </div>
      <div className="text-end">
        <div className="tabular-nums">{formatMoney(item.due_paise)}</div>
        {mode === 'fifo' && fifoAmount > 0 ? (
          <div className="text-xs font-medium text-success">
            {fifoAmount >= item.due_paise
              ? t('payment.clears')
              : t('payment.part', { amount: formatMoney(fifoAmount) })}
          </div>
        ) : null}
      </div>
      {mode === 'manual' ? (
        <MoneyInput
          value={manualAmount}
          onChange={(v) => onManual(v !== null && v > item.due_paise ? item.due_paise : v)}
          size="sm"
          className="w-28"
          aria-label={t('payment.allocate_amount', { number: label })}
        />
      ) : null}
    </li>
  )
}
