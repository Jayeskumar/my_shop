/**
 * Add / edit the shop's own UPI ID (provider `upi_vpa`): VPA, payee name shown in the
 * customer's UPI app, merchant category (preset by business type), store, settlement bank
 * account and default. While typing, a ₹1 test QR built locally from the same values lets the
 * owner scan it with their own phone and check that the right name appears before saving.
 *
 * Create → POST /payment-providers; edit → PATCH with only the changed fields + if_updated_at.
 */
import { Smartphone } from 'lucide-react'
import { useMemo, useRef } from 'react'
import { Controller, FormProvider, useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import {
  type PaymentProviderAccount,
  type PaymentProviderCreate,
  PaymentProviderCreateSchema,
  type PaymentProviderUpdate,
  PaymentProviderUpdateSchema,
  UPI_MCC_OPTIONS,
} from '@kadai/shared/api/payments'
import { newId } from '@kadai/shared/ids'
import { buildUpiUri, isValidVpa } from '@kadai/shared/upi'
import { defaultMccFor } from '@kadai/shared/verticals'
import { AccountPicker, ALL_STORES, StorePicker } from '@/components/pickers'
import { Button, Dialog, Input, Select, Switch, notify } from '@/components/ui'
import { useMe } from '@/lib/auth'
import { useUpdateProvider, useCreateProvider } from '../api'
import { PaymentsField } from '../components/PaymentsField'
import { QrCode } from '../components/QrCode'
import { applyContractErrors, contractResolver } from '../lib/forms'
import { pickLabel } from '../lib/labels'
import { notifyPaymentError } from '../lib/errors'

interface UpiFormValues {
  display_name: string
  vpa: string
  payee_name: string
  merchant_code: string
  /** Store id or 'all'. */
  store_id: string
  settlement_account_id: string | null
  is_default: boolean
}

const FIELDS = [
  'display_name',
  'vpa',
  'payee_name',
  'merchant_code',
  'store_id',
  'settlement_account_id',
  'is_default',
] as const

/** ₹1, the amount of the "scan with your own phone" check. */
export const TEST_AMOUNT_PAISE = 100

/** PATCH body with the given (changed) fields. */
function updateBody(
  v: UpiFormValues,
  fields: readonly (keyof UpiFormValues)[],
): PaymentProviderUpdate {
  const body: PaymentProviderUpdate = {}
  for (const key of fields) {
    switch (key) {
      case 'display_name':
        body.display_name = v.display_name
        break
      case 'vpa':
        body.vpa = v.vpa
        break
      case 'payee_name':
        body.payee_name = v.payee_name
        break
      case 'merchant_code':
        body.merchant_code = v.merchant_code || null
        break
      case 'store_id':
        body.store_id = v.store_id === ALL_STORES ? null : v.store_id
        break
      case 'settlement_account_id':
        body.settlement_account_id = v.settlement_account_id
        break
      case 'is_default':
        body.is_default = v.is_default
        break
    }
  }
  return body
}

export function UpiVpaDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  account?: PaymentProviderAccount | null
  /** Suggest making it the default (no default account yet). */
  suggestDefault?: boolean
  onSaved?: (account: PaymentProviderAccount) => void
}) {
  if (!props.open) return null
  return <UpiVpaDialogBody {...props} />
}

function UpiVpaDialogBody({
  onOpenChange,
  account,
  suggestDefault = false,
  onSaved,
}: {
  onOpenChange: (open: boolean) => void
  account?: PaymentProviderAccount | null
  suggestDefault?: boolean
  onSaved?: (account: PaymentProviderAccount) => void
}) {
  const { t, i18n } = useTranslation(['payments', 'common'])
  const me = useMe()
  const editing = Boolean(account)
  const formId = useRef(`upi-${newId()}`).current
  const idempotencyKey = useRef(newId()).current
  const multiStore = (me?.stores.filter((s) => s.is_active).length ?? 0) > 1
  const shopName = me?.tenant.name ?? ''
  const create = useCreateProvider()
  const update = useUpdateProvider()

  const defaults: UpiFormValues = {
    display_name: account?.display_name ?? t('settings.upi.default_name'),
    vpa: account?.vpa ?? '',
    payee_name: account?.payee_name ?? shopName.slice(0, 50),
    merchant_code:
      account?.merchant_code ?? (me ? defaultMccFor(me.tenant.business_type) : '5411'),
    store_id: account?.store_id ?? ALL_STORES,
    settlement_account_id: account?.settlement_account_id ?? null,
    is_default: account?.is_default ?? suggestDefault,
  }

  const createBody = (v: UpiFormValues): PaymentProviderCreate => ({
    provider: 'upi_vpa',
    display_name: v.display_name,
    vpa: v.vpa,
    payee_name: v.payee_name,
    ...(v.merchant_code ? { merchant_code: v.merchant_code } : {}),
    store_id: v.store_id === ALL_STORES ? null : v.store_id,
    ...(v.settlement_account_id ? { settlement_account_id: v.settlement_account_id } : {}),
    is_default: v.is_default,
  })

  const form = useForm<UpiFormValues>({
    defaultValues: defaults,
    resolver: editing
      ? contractResolver<UpiFormValues>(PaymentProviderUpdateSchema, (v) => updateBody(v, FIELDS))
      : contractResolver<UpiFormValues>(PaymentProviderCreateSchema, createBody),
  })

  const [vpa, payee, mcc] = useWatch({
    control: form.control,
    name: ['vpa', 'payee_name', 'merchant_code'],
  })
  const testUri = useMemo(() => {
    const v = vpa.trim()
    const name = payee.trim()
    if (!isValidVpa(v) || !name) return null
    try {
      return buildUpiUri({
        vpa: v,
        payee_name: name,
        amount_paise: TEST_AMOUNT_PAISE,
        note: t('settings.upi.test_note'),
        ...(mcc ? { mcc } : {}),
      })
    } catch {
      return null
    }
  }, [vpa, payee, mcc, t])

  const onDone = (saved: PaymentProviderAccount): void => {
    notify.success(
      editing ? t('settings.saved_toast') : t('settings.upi.added_toast', { vpa: saved.vpa ?? '' }),
    )
    onSaved?.(saved)
    onOpenChange(false)
  }
  const onFail = (error: unknown): void => {
    if (!applyContractErrors(error, form.setError, FIELDS)) notifyPaymentError(error)
  }

  const onSubmit = form.handleSubmit((values) => {
    if (account) {
      const dirty = FIELDS.filter((f) => form.formState.dirtyFields[f])
      if (dirty.length === 0) {
        onOpenChange(false)
        return
      }
      update.mutate(
        {
          params: { id: account.id },
          body: { ...updateBody(values, dirty), if_updated_at: account.updated_at },
        },
        { onSuccess: (res) => onDone(res.data), onError: onFail },
      )
    } else {
      create.mutate(
        { body: createBody(values), idempotencyKey },
        { onSuccess: (res) => onDone(res.data), onError: onFail },
      )
    }
  })

  const pending = create.isPending || update.isPending
  const mccOptions = UPI_MCC_OPTIONS.map((o) => ({
    value: o.code,
    label: `${o.code} · ${pickLabel(o, i18n.language)}`,
  }))

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!pending) onOpenChange(o)
      }}
      size="xl"
      title={editing ? t('settings.upi.edit_title') : t('settings.upi.add_title')}
      description={t('settings.upi.dialog_hint')}
      dismissible={!form.formState.isDirty}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={pending} size="lg">
            {editing ? t('common:actions.save_changes') : t('settings.upi.save')}
          </Button>
        </>
      }
    >
      <FormProvider {...form}>
        <form
          id={formId}
          onSubmit={onSubmit}
          noValidate
          className="grid gap-6 md:grid-cols-[minmax(0,1fr)_16rem]"
        >
          <div className="grid content-start gap-4 [&>*]:min-w-0">
            <PaymentsField
              name="vpa"
              label={t('fields.vpa')}
              required
              hint={t('settings.upi.vpa_hint')}
            >
              <Input
                autoFocus
                size="lg"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                inputMode="email"
                placeholder="murugan.stores@okaxis"
                startAdornment={<Smartphone aria-hidden className="size-4" />}
                {...form.register('vpa')}
              />
            </PaymentsField>
            <PaymentsField
              name="payee_name"
              label={t('fields.payee_name')}
              required
              hint={t('settings.upi.payee_hint')}
            >
              <Input maxLength={50} autoComplete="organization" {...form.register('payee_name')} />
            </PaymentsField>
            <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
              <PaymentsField
                name="merchant_code"
                label={t('fields.merchant_code')}
                hint={t('settings.upi.mcc_hint')}
              >
                <Controller
                  control={form.control}
                  name="merchant_code"
                  render={({ field }) => (
                    <Select
                      value={field.value || null}
                      onValueChange={field.onChange}
                      options={mccOptions}
                      aria-label={t('fields.merchant_code')}
                    />
                  )}
                />
              </PaymentsField>
              <PaymentsField name="display_name" label={t('fields.display_name')} required>
                <Input maxLength={80} {...form.register('display_name')} />
              </PaymentsField>
            </div>
            {multiStore ? (
              <PaymentsField name="store_id" label={t('fields.store')} hint={t('settings.store_hint')}>
                <Controller
                  control={form.control}
                  name="store_id"
                  render={({ field }) => (
                    <StorePicker
                      allowAll
                      clearable={false}
                      value={field.value}
                      onChange={(id) => field.onChange(id ?? ALL_STORES)}
                    />
                  )}
                />
              </PaymentsField>
            ) : null}
            <PaymentsField
              name="settlement_account_id"
              label={t('fields.settlement_account')}
              optional
              hint={t('settings.settlement_hint')}
            >
              <Controller
                control={form.control}
                name="settlement_account_id"
                render={({ field }) => (
                  <AccountPicker
                    money="bank"
                    value={field.value}
                    onChange={(id) => field.onChange(id)}
                  />
                )}
              />
            </PaymentsField>
            <Controller
              control={form.control}
              name="is_default"
              render={({ field }) => (
                <Switch
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  label={t('settings.make_default')}
                  description={t('settings.make_default_hint')}
                />
              )}
            />
          </div>

          <aside
            className="flex flex-col items-center gap-3 rounded-lg border border-border bg-surface-2 p-4 text-center"
            aria-label={t('settings.upi.test_title')}
          >
            <p className="text-sm font-semibold">{t('settings.upi.test_title')}</p>
            {testUri ? (
              <>
                <QrCode
                  value={testUri}
                  label={t('settings.upi.test_qr_label', { vpa: vpa.trim() })}
                  className="w-44 border border-border p-1"
                />
                <p className="text-xs text-muted-foreground">
                  {t('settings.upi.test_steps', { payee: payee.trim() })}
                </p>
              </>
            ) : (
              <p className="flex min-h-44 items-center text-xs text-muted-foreground">
                {t('settings.upi.test_empty')}
              </p>
            )}
          </aside>
        </form>
      </FormProvider>
    </Dialog>
  )
}
