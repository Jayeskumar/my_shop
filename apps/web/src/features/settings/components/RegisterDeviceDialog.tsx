/**
 * "Register this computer as a counter": names the computer, binds it to a store and counter,
 * calls POST /devices and keeps the returned device secret in this browser
 * (saveDeviceCredentials). From then on cashiers switch on this computer with their PIN, and
 * offline bills get this counter's numbers. The secret is shown nowhere and never sent again
 * except to sign in with a PIN.
 */
import { CheckCircle2, MonitorSmartphone } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { DeviceCreateSchema, type Device } from '@kadai/shared/api/identity'
import { Button, Dialog, FormField, Input, Select, notify } from '@/components/ui'
import { saveDeviceCredentials, useMe } from '@/lib/auth'
import { localizedName } from '@/lib/i18n'
import { useCreateDevice } from '../api'
import { notifySettingsError, useValidationKeyText } from '../lib/messages'

const NO_REGISTER = '__none__'

/** A friendly default name: "Counter A PC" when a counter is chosen. */
function suggestedName(registerName: string | null, fallback: string): string {
  return registerName ? `${registerName} PC` : fallback
}

export function RegisterDeviceDialog({
  open,
  onOpenChange,
  defaultStoreId,
  onRegistered,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultStoreId: string | null
  onRegistered: (device: Device) => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const me = useMe()
  const keyText = useValidationKeyText()
  const create = useCreateDevice()
  const stores = (me?.stores ?? []).filter((s) => s.is_active)
  const [storeId, setStoreId] = useState<string>(defaultStoreId ?? stores[0]?.id ?? '')
  const [registerId, setRegisterId] = useState<string>(NO_REGISTER)
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)
  const [done, setDone] = useState<Device | null>(null)

  const registers = (me?.registers ?? []).filter((r) => r.store_id === storeId && r.is_active)
  const register = registers.find((r) => r.id === registerId) ?? null

  useEffect(() => {
    if (!open) return
    const firstStore = defaultStoreId ?? stores[0]?.id ?? ''
    const firstRegister = (me?.registers ?? []).find(
      (r) => r.store_id === firstStore && r.is_active,
    )
    setStoreId(firstStore)
    setRegisterId(firstRegister?.id ?? NO_REGISTER)
    setName(suggestedName(firstRegister?.name ?? null, t('devices.default_name')))
    setNameTouched(false)
    setNameError(null)
    setDone(null)
    // Only when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const chooseStore = (id: string): void => {
    setStoreId(id)
    const first = (me?.registers ?? []).find((r) => r.store_id === id && r.is_active)
    setRegisterId(first?.id ?? NO_REGISTER)
    if (!nameTouched) setName(suggestedName(first?.name ?? null, t('devices.default_name')))
  }

  const chooseRegister = (id: string): void => {
    setRegisterId(id)
    const r = registers.find((x) => x.id === id)
    if (!nameTouched) setName(suggestedName(r?.name ?? null, t('devices.default_name')))
  }

  const submit = async (): Promise<void> => {
    if (!me) return
    const body = {
      name: name.trim(),
      store_id: storeId,
      register_id: registerId === NO_REGISTER ? null : registerId,
    }
    const parsed = DeviceCreateSchema.safeParse(body)
    if (!parsed.success) {
      const issue = parsed.error.issues.find((i) => i.path[0] === 'name')
      setNameError(issue ? (keyText(issue.message) ?? t('devices.name_required')) : null)
      if (issue) return
    }
    try {
      const res = await create.mutateAsync({ body })
      saveDeviceCredentials({
        device_id: res.data.device.id,
        device_secret: res.data.device_secret,
        tenant_id: me.tenant.id,
        store_id: res.data.device.store_id,
        register_id: res.data.device.register_id,
        name: res.data.device.name,
        registered_at: new Date().toISOString(),
      })
      setDone(res.data.device)
      onRegistered(res.data.device)
      notify.success(t('devices.registered_toast'))
    } catch (error) {
      notifySettingsError(error)
    }
  }

  const storeOptions = stores.map((s) => ({
    value: s.id,
    label: `${s.code} · ${localizedName(s.name, s.name_ta)}`,
  }))
  const registerOptions = [
    ...registers.map((r) => ({ value: r.id, label: `${r.code} · ${r.name}` })),
    {
      value: NO_REGISTER,
      label: t('devices.no_register'),
      description: t('devices.no_register_hint'),
    },
  ]

  if (done) {
    const store = me?.stores.find((s) => s.id === done.store_id)
    return (
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        title={t('devices.done_title')}
        footer={<Button onClick={() => onOpenChange(false)}>{t('common:actions.done')}</Button>}
      >
        <div className="flex flex-col items-center gap-3 py-2 text-center">
          <span className="flex size-14 items-center justify-center rounded-full bg-success-soft text-success">
            <CheckCircle2 className="size-8" aria-hidden />
          </span>
          <p className="text-lg font-semibold">
            {done.register_name
              ? t('devices.done_counter', {
                  register: done.register_name,
                  store: store ? localizedName(store.name, store.name_ta) : done.store_name,
                })
              : t('devices.done_store', {
                  store: store ? localizedName(store.name, store.name_ta) : done.store_name,
                })}
          </p>
          <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
            {t('devices.done_hint')}
          </p>
        </div>
      </Dialog>
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !create.isPending && onOpenChange(o)}
      title={t('devices.register_title')}
      description={t('devices.register_description')}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            {t('common:actions.cancel')}
          </Button>
          <Button
            leftIcon={<MonitorSmartphone />}
            loading={create.isPending}
            disabled={!storeId}
            onClick={() => void submit()}
          >
            {t('devices.register_action')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <FormField label={t('common:fields.store')} required>
          <Select value={storeId} onValueChange={chooseStore} options={storeOptions} />
        </FormField>
        <FormField
          label={t('devices.register_field')}
          hint={registers.length === 0 ? undefined : t('devices.register_field_hint')}
        >
          <Select value={registerId} onValueChange={chooseRegister} options={registerOptions} />
        </FormField>
        {registers.length === 0 ? (
          <p className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning-soft-foreground">
            {t('devices.no_registers')}{' '}
            <Link
              to="#counters"
              className="font-medium underline"
              onClick={() => onOpenChange(false)}
            >
              {t('devices.add_counter_first')}
            </Link>
          </p>
        ) : null}
        <FormField
          label={t('devices.name')}
          hint={t('devices.name_hint')}
          error={nameError}
          required
        >
          <Input
            value={name}
            maxLength={60}
            onChange={(e) => {
              setName(e.target.value)
              setNameTouched(true)
              setNameError(null)
            }}
            placeholder={suggestedName(register?.name ?? null, t('devices.default_name'))}
          />
        </FormField>
        <button type="submit" className="sr-only" tabIndex={-1} aria-hidden>
          {t('devices.register_action')}
        </button>
      </form>
    </Dialog>
  )
}
