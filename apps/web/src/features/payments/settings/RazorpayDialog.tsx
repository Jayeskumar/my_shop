/**
 * Connect / edit a Razorpay account (provider `razorpay`, plan feature `upi_dynamic`): API key
 * id + secret (write-only, the server keeps them encrypted and returns only the masked id),
 * webhook secret, test/live mode (must match the key prefix rzp_test_ / rzp_live_), store,
 * settlement bank account and default. After connecting, the dialog shows the webhook URL and
 * the events to enable, and offers a connection test.
 */
import { CheckCircle2, KeyRound, PlugZap } from 'lucide-react'
import { useRef, useState } from 'react'
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
import type { ProviderMode } from '@kadai/shared/enums'
import { newId } from '@kadai/shared/ids'
import { defaultMccFor } from '@kadai/shared/verticals'
import { AccountPicker, ALL_STORES, StorePicker } from '@/components/pickers'
import {
  Button,
  Checkbox,
  Dialog,
  Input,
  RadioGroup,
  Select,
  Switch,
  notify,
} from '@/components/ui'
import { useMe } from '@/lib/auth'
import { useCreateProvider, useTestProvider, useUpdateProvider } from '../api'
import { PaymentsField } from '../components/PaymentsField'
import { applyContractErrors, contractResolver, textOrUndefined } from '../lib/forms'
import { pickLabel } from '../lib/labels'
import { WebhookSetup } from './WebhookSetup'
import { notifyPaymentError } from '../lib/errors'

interface RazorpayFormValues {
  display_name: string
  mode: ProviderMode
  key_id: string
  key_secret: string
  webhook_secret: string
  payee_name: string
  merchant_code: string
  store_id: string
  settlement_account_id: string | null
  is_default: boolean
  /** Edit only: replace the API keys (and with them the mode). */
  change_keys: boolean
  /** Edit only: delete the stored webhook secret. */
  remove_webhook_secret: boolean
}

const FIELDS = [
  'display_name',
  'mode',
  'key_id',
  'key_secret',
  'webhook_secret',
  'payee_name',
  'merchant_code',
  'store_id',
  'settlement_account_id',
  'is_default',
] as const

/** Body paths → form fields (credentials are nested in the contract). */
function mapPath(path: string): string | null {
  if (path === 'credentials.key_id' || path === 'credentials') return 'key_id'
  if (path === 'credentials.key_secret') return 'key_secret'
  return path
}

function createBody(v: RazorpayFormValues): PaymentProviderCreate {
  const webhookSecret = textOrUndefined(v.webhook_secret)
  const payee = textOrUndefined(v.payee_name)
  return {
    provider: 'razorpay',
    display_name: v.display_name,
    mode: v.mode,
    credentials: { key_id: v.key_id.trim(), key_secret: v.key_secret.trim() },
    ...(webhookSecret ? { webhook_secret: webhookSecret } : {}),
    ...(payee ? { payee_name: payee } : {}),
    ...(v.merchant_code ? { merchant_code: v.merchant_code } : {}),
    store_id: v.store_id === ALL_STORES ? null : v.store_id,
    ...(v.settlement_account_id ? { settlement_account_id: v.settlement_account_id } : {}),
    is_default: v.is_default,
  }
}

function updateBody(
  v: RazorpayFormValues,
  dirty: (f: keyof RazorpayFormValues) => boolean,
): PaymentProviderUpdate {
  const body: PaymentProviderUpdate = {}
  if (dirty('display_name')) body.display_name = v.display_name
  if (v.change_keys) {
    body.credentials = { key_id: v.key_id.trim(), key_secret: v.key_secret.trim() }
    body.mode = v.mode
  }
  if (v.remove_webhook_secret) body.webhook_secret = null
  else if (textOrUndefined(v.webhook_secret)) body.webhook_secret = v.webhook_secret.trim()
  if (dirty('payee_name')) body.payee_name = textOrUndefined(v.payee_name) ?? null
  if (dirty('merchant_code')) body.merchant_code = v.merchant_code || null
  if (dirty('store_id')) body.store_id = v.store_id === ALL_STORES ? null : v.store_id
  if (dirty('settlement_account_id')) body.settlement_account_id = v.settlement_account_id
  if (dirty('is_default')) body.is_default = v.is_default
  return body
}

export function RazorpayDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  account?: PaymentProviderAccount | null
  suggestDefault?: boolean
  onSaved?: (account: PaymentProviderAccount) => void
}) {
  if (!props.open) return null
  return <RazorpayDialogBody {...props} />
}

function RazorpayDialogBody({
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
  const formId = useRef(`rzp-${newId()}`).current
  const idempotencyKey = useRef(newId()).current
  const multiStore = (me?.stores.filter((s) => s.is_active).length ?? 0) > 1
  const create = useCreateProvider()
  const update = useUpdateProvider()
  const test = useTestProvider()
  const [connected, setConnected] = useState<PaymentProviderAccount | null>(null)

  const form = useForm<RazorpayFormValues>({
    defaultValues: {
      display_name: account?.display_name ?? 'Razorpay',
      mode: account?.mode ?? 'live',
      key_id: '',
      key_secret: '',
      webhook_secret: '',
      payee_name: account?.payee_name ?? '',
      merchant_code:
        account?.merchant_code ?? (me ? defaultMccFor(me.tenant.business_type) : '5411'),
      store_id: account?.store_id ?? ALL_STORES,
      settlement_account_id: account?.settlement_account_id ?? null,
      is_default: account?.is_default ?? suggestDefault,
      change_keys: !account,
      remove_webhook_secret: false,
    },
    resolver: async (values, context, options) => {
      if (!account) {
        return contractResolver<RazorpayFormValues>(
          PaymentProviderCreateSchema,
          createBody,
          mapPath,
        )(values, context, options)
      }
      const result = await contractResolver<RazorpayFormValues>(
        PaymentProviderUpdateSchema,
        (v) => updateBody(v, () => true),
        mapPath,
      )(values, context, options)
      // The create schema checks the key prefix against the mode; PATCH has no such refinement.
      const keyId = values.key_id.trim()
      if (values.change_keys && keyId && !keyId.startsWith(`rzp_${values.mode}_`)) {
        return {
          values: {},
          errors: {
            ...result.errors,
            key_id: { type: 'custom', message: 'razorpay_key_mode_mismatch' },
          },
        }
      }
      return result
    },
  })
  const [mode, changeKeys] = useWatch({ control: form.control, name: ['mode', 'change_keys'] })

  const finish = (saved: PaymentProviderAccount): void => {
    onSaved?.(saved)
    if (editing) {
      notify.success(t('settings.saved_toast'))
      onOpenChange(false)
    } else {
      notify.success(t('settings.razorpay.connected_toast'))
      setConnected(saved)
    }
  }
  const onFail = (error: unknown): void => {
    if (!applyContractErrors(error, form.setError, FIELDS, mapPath)) notifyPaymentError(error)
  }

  const onSubmit = form.handleSubmit((values) => {
    if (account) {
      const dirtyFields = form.formState.dirtyFields as Partial<
        Record<keyof RazorpayFormValues, boolean>
      >
      const body = updateBody(values, (f) => Boolean(dirtyFields[f]))
      if (Object.keys(body).length === 0) {
        onOpenChange(false)
        return
      }
      update.mutate(
        { params: { id: account.id }, body: { ...body, if_updated_at: account.updated_at } },
        { onSuccess: (res) => finish(res.data), onError: onFail },
      )
    } else {
      create.mutate(
        { body: createBody(values), idempotencyKey },
        { onSuccess: (res) => finish(res.data), onError: onFail },
      )
    }
  })

  const runTest = (target: PaymentProviderAccount): void => {
    test.mutate(
      { params: { id: target.id } },
      {
        onSuccess: (res) => {
          if (res.data.ok) notify.success(t('settings.test_ok_razorpay'))
          else
            notify.warning(t('settings.test_failed'), {
              description: res.data.message ?? res.data.error_code ?? undefined,
            })
        },
        onError: notifyPaymentError,
      },
    )
  }

  const pending = create.isPending || update.isPending
  const mccOptions = UPI_MCC_OPTIONS.map((o) => ({
    value: o.code,
    label: `${o.code} · ${pickLabel(o, i18n.language)}`,
  }))

  if (connected) {
    return (
      <Dialog
        open
        onOpenChange={onOpenChange}
        size="lg"
        title={t('settings.razorpay.connected_title')}
        description={t('settings.razorpay.connected_hint')}
        footer={
          <>
            <Button
              variant="outline"
              leftIcon={<PlugZap />}
              loading={test.isPending}
              onClick={() => runTest(connected)}
            >
              {t('settings.test_connection')}
            </Button>
            <Button onClick={() => onOpenChange(false)}>{t('common:actions.done')}</Button>
          </>
        }
      >
        <div className="grid gap-4">
          <p className="flex items-center gap-2 rounded-md bg-success-soft px-3 py-2 text-sm text-success-soft-foreground">
            <CheckCircle2 className="size-4 shrink-0" aria-hidden />
            {t('settings.razorpay.saved_key', { key: connected.key_id_masked ?? '' })}
          </p>
          <WebhookSetup account={connected} />
        </div>
      </Dialog>
    )
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!pending) onOpenChange(o)
      }}
      size="lg"
      title={editing ? t('settings.razorpay.edit_title') : t('settings.razorpay.add_title')}
      description={t('settings.razorpay.dialog_hint')}
      dismissible={!form.formState.isDirty}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={pending} size="lg">
            {editing ? t('common:actions.save_changes') : t('settings.razorpay.save')}
          </Button>
        </>
      }
    >
      <FormProvider {...form}>
        <form id={formId} onSubmit={onSubmit} noValidate className="grid gap-4 [&>*]:min-w-0">
          {editing ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
              <span className="flex items-center gap-2 text-sm">
                <KeyRound className="size-4 text-muted-foreground" aria-hidden />
                {t('settings.razorpay.current_key', {
                  key: account?.key_id_masked ?? '—',
                })}
              </span>
              <Controller
                control={form.control}
                name="change_keys"
                render={({ field }) => (
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                    label={t('settings.razorpay.change_keys')}
                  />
                )}
              />
            </div>
          ) : null}

          {changeKeys ? (
            <>
              <PaymentsField name="mode" label={t('fields.mode')}>
                <Controller
                  control={form.control}
                  name="mode"
                  render={({ field }) => (
                    <RadioGroup
                      value={field.value}
                      onValueChange={field.onChange}
                      variant="cards"
                      orientation="horizontal"
                      aria-label={t('fields.mode')}
                      options={[
                        {
                          value: 'live',
                          label: t('mode.live'),
                          description: t('settings.razorpay.live_hint'),
                        },
                        {
                          value: 'test',
                          label: t('mode.test'),
                          description: t('settings.razorpay.test_hint'),
                        },
                      ]}
                    />
                  )}
                />
              </PaymentsField>
              <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
                <PaymentsField
                  name="key_id"
                  label={t('fields.key_id')}
                  required
                  hint={t('settings.razorpay.key_hint', { prefix: `rzp_${mode}_` })}
                >
                  <Input
                    autoFocus={!editing}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={`rzp_${mode}_…`}
                    {...form.register('key_id')}
                  />
                </PaymentsField>
                <PaymentsField name="key_secret" label={t('fields.key_secret')} required>
                  <Input
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    {...form.register('key_secret')}
                  />
                </PaymentsField>
              </div>
            </>
          ) : null}

          <PaymentsField
            name="webhook_secret"
            label={t('fields.webhook_secret')}
            optional
            hint={
              account?.has_webhook_secret
                ? t('settings.razorpay.webhook_secret_set')
                : t('settings.razorpay.webhook_secret_hint')
            }
          >
            <Input
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              placeholder={account?.has_webhook_secret ? '••••••••' : undefined}
              {...form.register('webhook_secret')}
            />
          </PaymentsField>
          {account?.has_webhook_secret ? (
            <Controller
              control={form.control}
              name="remove_webhook_secret"
              render={({ field }) => (
                <Checkbox
                  checked={field.value}
                  onCheckedChange={(v) => field.onChange(v === true)}
                  label={t('settings.razorpay.remove_webhook_secret')}
                />
              )}
            />
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
            <PaymentsField name="display_name" label={t('fields.display_name')} required>
              <Input maxLength={80} {...form.register('display_name')} />
            </PaymentsField>
            <PaymentsField
              name="payee_name"
              label={t('fields.payee_name')}
              optional
              hint={t('settings.razorpay.payee_hint')}
            >
              <Input maxLength={50} {...form.register('payee_name')} />
            </PaymentsField>
            <PaymentsField name="merchant_code" label={t('fields.merchant_code')}>
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
            {multiStore ? (
              <PaymentsField name="store_id" label={t('fields.store')}>
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
          </div>
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
        </form>
      </FormProvider>
    </Dialog>
  )
}
