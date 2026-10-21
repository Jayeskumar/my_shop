/**
 * Quick "Add expense" (POST /expenses), built for daily use at the counter: tap a category tile,
 * type the bill amount (GST-inclusive by default, as small-shop bills are), pick how it was paid
 * and save — Enter / Ctrl+S saves, "Save & add another" keeps the date, store and payment method.
 * GST with input-tax credit (regular GST businesses only), the supplier (required "on credit"),
 * bill number, note and a bill photo are optional. The body is validated with the contract's
 * ExpenseCreateSchema before sending; one idempotency key per entry makes a re-submit safe.
 */
import { ChevronDown } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Controller, FormProvider, useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import type { ExpensePaymentMethod } from '@kadai/shared'
import {
  type ExpenseCreate,
  ExpenseCreateSchema,
  type ExpenseDetail,
  computeExpenseAmounts,
  defaultPaidFromKind,
} from '@kadai/shared/api/accounting'
import { ExpensePaymentMethodSchema } from '@kadai/shared/enums'
import { GST_RATES_BP, type GstRateBp, isValidGstRate } from '@kadai/shared/gst'
import { newId } from '@kadai/shared/ids'
import { AccountPicker, StorePicker, SupplierPicker } from '@/components/pickers'
import type { SupplierPickerValue } from '@/components/pickers'
import {
  Button,
  DatePicker,
  Dialog,
  Input,
  Kbd,
  MoneyInput,
  Select,
  Switch,
  notify,
} from '@/components/ui'
import { Textarea } from '@/components/ui/textarea'
import { applyServerFieldErrors } from '@/lib/form-errors'
import { useCurrentRegister, useCurrentStore } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { formatBp, formatMoney } from '@/lib/format'
import { useHotkeys } from '@/lib/hotkeys'
import { useCreateExpense } from '../api'
import { errorReason, notifyAccountingError, validationText } from '../lib/errors'
import { contractResolver, textOrNull } from '../lib/forms'
import { expenseMethodLabel } from '../lib/labels'
import { useTenantInfo } from '../lib/tenant'
import { AccountingField } from './AccountingField'
import { BillPhotoField } from './BillPhotoField'
import { ExpenseCategoryTiles } from './ExpenseCategoryTiles'

/** GST rate chips (GST 2.0 slabs); the other notified rates are in the "Other rate" list. */
const QUICK_RATES = [0, 500, 1800, 4000] as const
const OTHER_RATES = GST_RATES_BP.filter((r) => !(QUICK_RATES as readonly number[]).includes(r))

export interface ExpenseFormValues {
  expense_account_id: string | null
  amount_paise: number | null
  /** The amount typed is the bill total incl. GST (default) or the value before GST. */
  amount_includes_gst: boolean
  gst_rate_bp: GstRateBp
  itc_eligible: boolean
  payment_method: ExpensePaymentMethod
  paid_from_account_id: string | null
  supplier: SupplierPickerValue | null
  supplier_state_code: string | null
  expense_date: string
  store_id: string
  reference: string
  description: string
  attachment_file_id: string | null
  /** Cash taken from the current counter's drawer (joins its open shift). */
  from_drawer: boolean
}

const FORM_FIELDS = [
  'expense_account_id',
  'amount_paise',
  'gst_rate_bp',
  'itc_eligible',
  'payment_method',
  'paid_from_account_id',
  'supplier',
  'expense_date',
  'store_id',
  'reference',
  'description',
] as const

/** Body path → form field. */
function mapPath(path: string): string | null {
  if (path === 'total_paise' || path === 'taxable_paise') return 'amount_paise'
  if (path === 'supplier_id') return 'supplier'
  if (path === 'register_id' || path === 'client_ref' || path === 'is_interstate') return 'root'
  const head = path.split('.')[0] ?? path
  return (FORM_FIELDS as readonly string[]).includes(head) ? head : 'root'
}

export interface ExpenseFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved?: (expense: ExpenseDetail) => void
  /** Preselected category (e.g. the filtered one). */
  defaultAccountId?: string | null
}

export function ExpenseFormDialog({
  open,
  onOpenChange,
  onSaved,
  defaultAccountId,
}: ExpenseFormDialogProps) {
  const { t } = useTranslation(['accounting', 'common'])
  const tenant = useTenantInfo()
  const currentStore = useCurrentStore()
  const currentRegister = useCurrentRegister()
  const mutation = useCreateExpense()
  const [clientRef, setClientRef] = useState(() => newId())
  const [uploading, setUploading] = useState(false)
  const [showMore, setShowMore] = useState(false)
  const [addAnother, setAddAnother] = useState(false)
  const addAnotherRef = useRef(false)

  const defaults = useMemo<ExpenseFormValues>(
    () => ({
      expense_account_id: defaultAccountId ?? null,
      amount_paise: null,
      amount_includes_gst: true,
      gst_rate_bp: 0,
      itc_eligible: false,
      payment_method: 'cash',
      paid_from_account_id: null,
      supplier: null,
      supplier_state_code: null,
      expense_date: tenant.today,
      store_id: currentStore?.id ?? tenant.stores[0]?.id ?? '',
      reference: '',
      description: '',
      attachment_file_id: null,
      from_drawer: true,
    }),
    [defaultAccountId, tenant.today, tenant.stores, currentStore],
  )

  const drawerRegister = (storeId: string) =>
    currentRegister && currentRegister.store_id === storeId ? currentRegister : null

  const toBody = (v: ExpenseFormValues): ExpenseCreate => {
    const amount = v.amount_paise ?? undefined
    const register =
      v.payment_method === 'cash' && v.from_drawer ? drawerRegister(v.store_id) : null
    return {
      store_id: v.store_id,
      expense_date: v.expense_date,
      expense_account_id: v.expense_account_id ?? '',
      description: textOrNull(v.description),
      ...(v.amount_includes_gst || v.gst_rate_bp === 0
        ? { total_paise: amount }
        : { taxable_paise: amount }),
      gst_rate_bp: v.gst_rate_bp,
      itc_eligible: tenant.canClaimItc && v.gst_rate_bp > 0 ? v.itc_eligible : false,
      payment_method: v.payment_method,
      ...(v.payment_method !== 'credit' && v.paid_from_account_id
        ? { paid_from_account_id: v.paid_from_account_id }
        : {}),
      supplier_id: v.supplier?.id ?? null,
      reference: textOrNull(v.reference),
      attachment_file_id: v.attachment_file_id,
      ...(register ? { register_id: register.id } : {}),
      client_ref: clientRef,
    }
  }

  const form = useForm<ExpenseFormValues>({
    defaultValues: defaults,
    resolver: contractResolver<ExpenseFormValues>(ExpenseCreateSchema, toBody, mapPath),
  })
  const { control, handleSubmit, reset, setValue, setError, formState } = form

  useEffect(() => {
    if (!open) return
    reset(defaults)
    setClientRef(newId())
    setShowMore(false)
  }, [open, defaults, reset])

  const v = useWatch({ control })
  const method = v.payment_method ?? 'cash'
  const rate = v.gst_rate_bp ?? 0
  const storeId = v.store_id ?? ''
  const storeState = tenant.stores.find((s) => s.id === storeId)?.state_code ?? null
  const interstate = Boolean(
    v.supplier_state_code && storeState && v.supplier_state_code !== storeState,
  )
  const amounts =
    v.amount_paise && v.amount_paise > 0
      ? computeExpenseAmounts({
          ...(v.amount_includes_gst || rate === 0
            ? { total_paise: v.amount_paise }
            : { taxable_paise: v.amount_paise }),
          gst_rate_bp: rate,
          is_interstate: interstate,
        })
      : null
  const register = method === 'cash' ? drawerRegister(storeId) : null
  const moneyKind = defaultPaidFromKind(method)

  const save = (values: ExpenseFormValues): void => {
    const body = toBody(values)
    mutation.mutate(
      { body, idempotencyKey: clientRef },
      {
        onSuccess: (res) => {
          notify.success(
            t('expenses.form.saved', {
              amount: formatMoney(res.data.total_paise),
              number: res.data.number ?? '',
            }),
          )
          onSaved?.(res.data)
          if (addAnotherRef.current) {
            reset({
              ...defaults,
              expense_date: values.expense_date,
              store_id: values.store_id,
              payment_method: values.payment_method,
              from_drawer: values.from_drawer,
            })
            setClientRef(newId())
          } else {
            onOpenChange(false)
          }
        },
        onError: (error) => {
          if (applyServerFieldErrors(error, setError, [...FORM_FIELDS, 'total_paise'])) return
          const reason = errorReason(error)
          if (reason === 'itc_not_allowed') setValue('itc_eligible', false)
          notifyAccountingError(error)
        },
      },
    )
  }

  const submit = (another: boolean) => {
    addAnotherRef.current = another
    setAddAnother(another)
    void handleSubmit(save)()
  }

  useHotkeys(
    { 'ctrl+s, mod+enter': () => submit(false) },
    { scope: 'dialog', allowInInputs: true, enabled: open },
  )

  const busy = mutation.isPending || uploading
  const rootError = validationText(formState.errors.root?.message)

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}
      title={t('expenses.form.title')}
      size="lg"
      dismissible={false}
      footer={
        <>
          <div className="grid grid-cols-2 gap-2 sm:flex">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={mutation.isPending}
            >
              {t('common:actions.cancel')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => submit(true)}
              disabled={busy}
              loading={mutation.isPending && addAnother}
            >
              {t('expenses.form.save_another')}
            </Button>
          </div>
          <Button
            type="submit"
            form="expense-form"
            size="lg"
            disabled={busy}
            loading={mutation.isPending && !addAnother}
          >
            {amounts
              ? t('expenses.form.save_amount', { amount: formatMoney(amounts.total_paise) })
              : t('expenses.form.save')}
            <Kbd
              combo="ctrl+s"
              className="ms-1 hidden border-primary-foreground/30 bg-primary-foreground/15 text-primary-foreground lg:inline-flex"
            />
          </Button>
        </>
      }
    >
      <FormProvider {...form}>
        <form
          id="expense-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            submit(false)
          }}
          className="grid gap-5 md:grid-cols-2 md:gap-6"
        >
          <div className="flex flex-col gap-4">
            <Controller
              control={control}
              name="expense_account_id"
              render={({ field, fieldState }) => (
                <ExpenseCategoryTiles
                  value={field.value}
                  onChange={(id) => {
                    field.onChange(id)
                    // Next step: the amount.
                    requestAnimationFrame(() => form.setFocus('amount_paise'))
                  }}
                  storeId={storeId || null}
                  error={fieldState.error?.message ? t('expenses.form.pick_category') : undefined}
                />
              )}
            />
          </div>

          <div className="flex flex-col gap-4">
            <AccountingField name="amount_paise" label={t('expenses.form.amount')} required>
              <Controller
                control={control}
                name="amount_paise"
                render={({ field }) => (
                  <MoneyInput
                    ref={field.ref}
                    value={field.value}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    size="xl"
                  />
                )}
              />
            </AccountingField>

            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium" id="gst-rate-label">
                {t('expenses.form.gst')}
              </span>
              <Controller
                control={control}
                name="gst_rate_bp"
                render={({ field }) => (
                  <div
                    className="flex flex-wrap items-center gap-2"
                    role="group"
                    aria-labelledby="gst-rate-label"
                  >
                    {QUICK_RATES.map((r) => (
                      <button
                        key={r}
                        type="button"
                        aria-pressed={field.value === r}
                        onClick={() => field.onChange(r)}
                        className={cn(
                          'inline-flex h-10 min-w-14 items-center justify-center rounded-full border px-3 text-sm font-medium transition-colors',
                          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                          field.value === r
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-border bg-surface hover:bg-surface-2',
                        )}
                      >
                        {r === 0 ? t('expenses.form.no_gst') : formatBp(r)}
                      </button>
                    ))}
                    <Select<string>
                      aria-label={t('expenses.form.other_rate')}
                      value={
                        (OTHER_RATES as readonly number[]).includes(field.value)
                          ? String(field.value)
                          : null
                      }
                      onValueChange={(x) => {
                        const r = Number(x)
                        if (isValidGstRate(r)) field.onChange(r)
                      }}
                      placeholder={t('expenses.form.other_rate')}
                      options={OTHER_RATES.map((r) => ({ value: String(r), label: formatBp(r) }))}
                      className="h-10 w-auto min-w-28"
                    />
                  </div>
                )}
              />
              {rate > 0 ? (
                <div className="flex flex-col gap-2 rounded-lg bg-surface-2/60 p-3">
                  <Controller
                    control={control}
                    name="amount_includes_gst"
                    render={({ field }) => (
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        label={t('expenses.form.includes_gst')}
                      />
                    )}
                  />
                  {tenant.canClaimItc ? (
                    <Controller
                      control={control}
                      name="itc_eligible"
                      render={({ field }) => (
                        <Switch
                          checked={field.value}
                          onCheckedChange={field.onChange}
                          label={t('expenses.form.itc')}
                          description={t('expenses.form.itc_hint')}
                        />
                      )}
                    />
                  ) : null}
                  {amounts ? (
                    <dl
                      className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-sm"
                      data-testid="gst-breakup"
                    >
                      <dt className="text-muted-foreground">{t('expenses.fields.taxable')}</dt>
                      <dd className="text-end tabular-nums">
                        {formatMoney(amounts.taxable_paise)}
                      </dd>
                      {interstate ? (
                        <>
                          <dt className="text-muted-foreground">IGST</dt>
                          <dd className="text-end tabular-nums">
                            {formatMoney(amounts.igst_paise)}
                          </dd>
                        </>
                      ) : (
                        <>
                          <dt className="text-muted-foreground">CGST</dt>
                          <dd className="text-end tabular-nums">
                            {formatMoney(amounts.cgst_paise)}
                          </dd>
                          <dt className="text-muted-foreground">SGST</dt>
                          <dd className="text-end tabular-nums">
                            {formatMoney(amounts.sgst_paise)}
                          </dd>
                        </>
                      )}
                      <dt className="font-medium">{t('expenses.fields.total')}</dt>
                      <dd className="text-end font-semibold tabular-nums">
                        {formatMoney(amounts.total_paise)}
                      </dd>
                    </dl>
                  ) : null}
                </div>
              ) : null}
            </div>

            <AccountingField name="payment_method" label={t('expenses.form.paid_via')} required>
              <Controller
                control={control}
                name="payment_method"
                render={({ field }) => (
                  <div
                    role="radiogroup"
                    aria-label={t('expenses.form.paid_via')}
                    className="grid grid-cols-3 gap-2"
                  >
                    {ExpensePaymentMethodSchema.options.map((m) => (
                      <button
                        key={m}
                        type="button"
                        role="radio"
                        aria-checked={field.value === m}
                        onClick={() => {
                          field.onChange(m)
                          setValue('paid_from_account_id', null)
                        }}
                        className={cn(
                          'flex min-h-11 items-center justify-center rounded-lg border px-2 py-1.5 text-center text-sm font-medium leading-tight transition-colors',
                          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                          field.value === m
                            ? 'border-primary bg-primary-soft text-primary-soft-foreground shadow-card'
                            : 'border-border bg-surface hover:bg-surface-2',
                        )}
                      >
                        {m === 'credit' ? t('expenses.form.on_credit') : expenseMethodLabel(m)}
                      </button>
                    ))}
                  </div>
                )}
              />
            </AccountingField>

            {method === 'credit' ? (
              <AccountingField
                name="supplier"
                label={t('expenses.fields.supplier')}
                required
                hint={t('expenses.form.credit_hint')}
              >
                <Controller
                  control={control}
                  name="supplier"
                  render={({ field }) => (
                    <SupplierPicker
                      value={field.value}
                      onChange={(s) => {
                        field.onChange(s)
                        setValue('supplier_state_code', s?.state_code ?? null)
                      }}
                    />
                  )}
                />
              </AccountingField>
            ) : register ? (
              <Controller
                control={control}
                name="from_drawer"
                render={({ field }) => (
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                    label={t('expenses.form.from_drawer', {
                      register: `${register.code} · ${register.name}`,
                    })}
                    description={t('expenses.form.from_drawer_hint')}
                  />
                )}
              />
            ) : null}

            <button
              type="button"
              className="flex items-center gap-1 self-start text-sm font-medium text-primary"
              aria-expanded={showMore}
              onClick={() => setShowMore((s) => !s)}
            >
              <ChevronDown
                className={cn('size-4 transition-transform', showMore && 'rotate-180')}
                aria-hidden
              />
              {t('expenses.form.more')}
            </button>
            <div className={cn('grid gap-4 sm:grid-cols-2', !showMore && 'hidden')}>
              <AccountingField name="expense_date" label={t('common:fields.date')} required>
                <Controller
                  control={control}
                  name="expense_date"
                  render={({ field }) => (
                    <DatePicker
                      value={field.value}
                      onChange={(d) => field.onChange(d ?? '')}
                      max={tenant.today}
                    />
                  )}
                />
              </AccountingField>
              {tenant.multiStore ? (
                <AccountingField name="store_id" label={t('common:fields.store')} required>
                  <Controller
                    control={control}
                    name="store_id"
                    render={({ field }) => (
                      <StorePicker
                        value={field.value}
                        onChange={(id) => field.onChange(id ?? '')}
                        clearable={false}
                      />
                    )}
                  />
                </AccountingField>
              ) : null}
              <AccountingField name="reference" label={t('expenses.fields.reference')} optional>
                <Input
                  {...form.register('reference')}
                  maxLength={100}
                  placeholder={t('expenses.form.reference_placeholder')}
                />
              </AccountingField>
              {method !== 'credit' ? (
                <AccountingField name="supplier" label={t('expenses.fields.supplier')} optional>
                  <Controller
                    control={control}
                    name="supplier"
                    render={({ field }) => (
                      <SupplierPicker
                        value={field.value}
                        onChange={(s) => {
                          field.onChange(s)
                          setValue('supplier_state_code', s?.state_code ?? null)
                        }}
                      />
                    )}
                  />
                </AccountingField>
              ) : null}
              {method !== 'credit' && moneyKind ? (
                <AccountingField
                  name="paid_from_account_id"
                  label={t('expenses.fields.paid_from')}
                  optional
                  hint={t(
                    moneyKind === 'cash'
                      ? 'expenses.form.paid_from_cash_hint'
                      : 'expenses.form.paid_from_bank_hint',
                  )}
                  className="sm:col-span-2"
                >
                  <Controller
                    control={control}
                    name="paid_from_account_id"
                    render={({ field }) => (
                      <AccountPicker
                        value={field.value}
                        onChange={(id) => field.onChange(id)}
                        types={['asset']}
                        money={moneyKind}
                        storeId={storeId || null}
                      />
                    )}
                  />
                </AccountingField>
              ) : null}
              <AccountingField
                name="description"
                label={t('expenses.fields.note')}
                optional
                className="sm:col-span-2"
              >
                <Textarea {...form.register('description')} rows={2} maxLength={500} />
              </AccountingField>
              <div className="sm:col-span-2">
                <span className="mb-1.5 block text-sm font-medium">
                  {t('expenses.fields.photo')}
                </span>
                <Controller
                  control={control}
                  name="attachment_file_id"
                  render={({ field }) => (
                    <BillPhotoField
                      value={field.value}
                      onChange={field.onChange}
                      onUploadingChange={setUploading}
                    />
                  )}
                />
              </div>
            </div>
            {rootError ? (
              <p role="alert" className="text-sm font-medium text-danger">
                {rootError}
              </p>
            ) : null}
          </div>
        </form>
      </FormProvider>
    </Dialog>
  )
}
