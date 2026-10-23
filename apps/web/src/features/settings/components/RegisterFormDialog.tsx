/**
 * Add / edit a billing counter (register): code (part of POS bill numbers, S1-A/…), name, and
 * the counter's own hardware settings — receipt format (or the business default), auto / silent
 * print, customer display, cash drawer, printer name, and an optional weighing scale on the
 * serial port. Editing sends only changed settings (the server deep-merges them).
 */
import { ChevronDown, Scale } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Controller, FormProvider, useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import {
  RegisterCreateSchema,
  RegisterUpdateSchema,
  type Register,
  type RegisterUpdate,
} from '@kadai/shared/api/identity'
import {
  RegisterSettingsSchema,
  type PrintFormat,
  type RegisterScaleSettings,
  type RegisterSettings,
} from '@kadai/shared/settings'
import { Button, Dialog, Input, Select, Switch, notify } from '@/components/ui'
import { isApiError } from '@/lib/api'
import { useMe } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { applyServerFieldErrors } from '@/lib/form-errors'
import { localizedName } from '@/lib/i18n'
import { useCreateRegister, useUpdateRegister } from '../api'
import { changedFields, contractResolver, textOrNull } from '../lib/forms'
import {
  errorReason,
  notifySettingsError,
  planBlockOf,
  reasonText,
  type PlanBlock,
} from '../lib/messages'
import { SettingsField } from './SettingsField'
import { UpgradeHint } from './UpgradeHint'

const DEFAULT_REGISTER_SETTINGS: RegisterSettings = RegisterSettingsSchema.parse({})

interface ScaleFormValues extends Omit<
  RegisterScaleSettings,
  'request_command' | 'weight_pattern'
> {
  request_command: string
  weight_pattern: string
}

interface RegisterFormValues {
  store_id: string
  code: string
  name: string
  is_active: boolean
  print_format: PrintFormat | 'default'
  auto_print: boolean
  silent_print: boolean
  customer_display: boolean
  cash_drawer: boolean
  printer_name: string
  scale: ScaleFormValues
}

const FIELDS = ['store_id', 'code', 'name', 'is_active', 'settings']

function fromRegister(r: Register | null, storeId: string): RegisterFormValues {
  const s = r?.settings ?? DEFAULT_REGISTER_SETTINGS
  return {
    store_id: r?.store_id ?? storeId,
    code: r?.code ?? '',
    name: r?.name ?? '',
    is_active: r?.is_active ?? true,
    print_format: s.print_format ?? 'default',
    auto_print: s.auto_print,
    silent_print: s.silent_print,
    customer_display: s.customer_display,
    cash_drawer: s.cash_drawer,
    printer_name: s.printer_name ?? '',
    scale: {
      ...s.scale,
      request_command: s.scale.request_command ?? '',
      weight_pattern: s.scale.weight_pattern ?? '',
    },
  }
}

function settingsOf(v: RegisterFormValues): RegisterSettings {
  return {
    print_format: v.print_format === 'default' ? null : v.print_format,
    auto_print: v.auto_print,
    silent_print: v.silent_print,
    customer_display: v.customer_display,
    cash_drawer: v.cash_drawer,
    printer_name: textOrNull(v.printer_name),
    scale: {
      ...v.scale,
      request_command: textOrNull(v.scale.request_command),
      weight_pattern: textOrNull(v.scale.weight_pattern),
    },
  }
}

const createBody = (v: RegisterFormValues) => ({
  store_id: v.store_id,
  code: v.code.trim().toUpperCase(),
  name: v.name.trim(),
  settings: settingsOf(v),
})

const fullUpdateBody = (v: RegisterFormValues) => ({
  code: v.code.trim().toUpperCase(),
  name: v.name.trim(),
  is_active: v.is_active,
  settings: settingsOf(v),
})

const BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200] as const

function SwitchRow({
  name,
  label,
  description,
}: {
  name: 'auto_print' | 'silent_print' | 'customer_display' | 'cash_drawer' | 'is_active'
  label: string
  description?: string
}) {
  return (
    <Controller<RegisterFormValues, typeof name>
      name={name}
      render={({ field }) => (
        <Switch
          checked={field.value}
          onCheckedChange={field.onChange}
          label={label}
          description={description}
        />
      )}
    />
  )
}

function ScaleSection() {
  const { t } = useTranslation('settings')
  const form = useWatch<RegisterFormValues, 'scale'>({ name: 'scale' })
  const [open, setOpen] = useState(form.enabled)
  return (
    <div className="rounded-lg border border-border">
      <button
        type="button"
        className="flex w-full items-center gap-3 px-3 py-3 text-start"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Scale className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{t('registers.scale_title')}</span>
          <span className="block text-xs text-muted-foreground">
            {form.enabled ? t('registers.scale_on') : t('registers.scale_hint')}
          </span>
        </span>
        <ChevronDown
          className={cn('size-4 text-muted-foreground transition-transform', open && 'rotate-180')}
          aria-hidden
        />
      </button>
      {open ? (
        <div className="flex flex-col gap-4 border-t border-border p-3">
          <Controller<RegisterFormValues, 'scale.enabled'>
            name="scale.enabled"
            render={({ field }) => (
              <Switch
                checked={field.value}
                onCheckedChange={field.onChange}
                label={t('registers.scale_enabled')}
                description={t('registers.scale_enabled_hint')}
              />
            )}
          />
          {form.enabled ? (
            <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
              <SettingsField name="scale.baud_rate" label={t('registers.scale_baud')}>
                <Controller<RegisterFormValues, 'scale.baud_rate'>
                  name="scale.baud_rate"
                  render={({ field }) => (
                    <Select
                      value={String(field.value)}
                      onValueChange={(v) => field.onChange(Number(v))}
                      options={BAUD_RATES.map((b) => ({ value: String(b), label: String(b) }))}
                    />
                  )}
                />
              </SettingsField>
              <SettingsField name="scale.protocol" label={t('registers.scale_protocol')}>
                <Controller<RegisterFormValues, 'scale.protocol'>
                  name="scale.protocol"
                  render={({ field }) => (
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                      options={[
                        { value: 'continuous', label: t('registers.protocol_continuous') },
                        { value: 'on_request', label: t('registers.protocol_on_request') },
                      ]}
                    />
                  )}
                />
              </SettingsField>
              {form.protocol === 'on_request' ? (
                <SettingsField
                  name="scale.request_command"
                  label={t('registers.scale_command')}
                  hint={t('registers.scale_command_hint')}
                >
                  <ScaleTextInput name="scale.request_command" maxLength={16} placeholder="W" />
                </SettingsField>
              ) : null}
              <SettingsField name="scale.weight_unit" label={t('registers.scale_unit')}>
                <Controller<RegisterFormValues, 'scale.weight_unit'>
                  name="scale.weight_unit"
                  render={({ field }) => (
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                      options={[
                        { value: 'kg', label: t('registers.unit_kg') },
                        { value: 'g', label: t('registers.unit_g') },
                      ]}
                    />
                  )}
                />
              </SettingsField>
              <SettingsField name="scale.data_bits" label={t('registers.scale_serial')}>
                <div className="grid grid-cols-3 gap-2">
                  <Controller<RegisterFormValues, 'scale.data_bits'>
                    name="scale.data_bits"
                    render={({ field }) => (
                      <Select
                        value={String(field.value)}
                        onValueChange={(v) => field.onChange(Number(v) === 7 ? 7 : 8)}
                        options={[
                          { value: '8', label: t('registers.data_bits', { count: 8 }) },
                          { value: '7', label: t('registers.data_bits', { count: 7 }) },
                        ]}
                      />
                    )}
                  />
                  <Controller<RegisterFormValues, 'scale.parity'>
                    name="scale.parity"
                    render={({ field }) => (
                      <Select
                        value={field.value}
                        onValueChange={field.onChange}
                        options={[
                          { value: 'none', label: t('registers.parity_none') },
                          { value: 'even', label: t('registers.parity_even') },
                          { value: 'odd', label: t('registers.parity_odd') },
                        ]}
                      />
                    )}
                  />
                  <Controller<RegisterFormValues, 'scale.stop_bits'>
                    name="scale.stop_bits"
                    render={({ field }) => (
                      <Select
                        value={String(field.value)}
                        onValueChange={(v) => field.onChange(Number(v) === 2 ? 2 : 1)}
                        options={[
                          { value: '1', label: t('registers.stop_bits', { count: 1 }) },
                          { value: '2', label: t('registers.stop_bits', { count: 2 }) },
                        ]}
                      />
                    )}
                  />
                </div>
              </SettingsField>
              <SettingsField name="scale.flow_control" label={t('registers.scale_flow')}>
                <Controller<RegisterFormValues, 'scale.flow_control'>
                  name="scale.flow_control"
                  render={({ field }) => (
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                      options={[
                        { value: 'none', label: t('registers.flow_none') },
                        { value: 'hardware', label: t('registers.flow_hardware') },
                      ]}
                    />
                  )}
                />
              </SettingsField>
              <SettingsField
                name="scale.weight_pattern"
                label={t('registers.scale_pattern')}
                hint={t('registers.scale_pattern_hint')}
                optional
                className="sm:col-span-2"
              >
                <ScaleTextInput
                  name="scale.weight_pattern"
                  maxLength={200}
                  placeholder="([0-9]+\.[0-9]+)\s*kg"
                  mono
                />
              </SettingsField>
              <div className="sm:col-span-2">
                <Controller<RegisterFormValues, 'scale.stable_only'>
                  name="scale.stable_only"
                  render={({ field }) => (
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                      label={t('registers.scale_stable')}
                      description={t('registers.scale_stable_hint')}
                    />
                  )}
                />
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function ScaleTextInput({
  name,
  maxLength,
  placeholder,
  mono,
}: {
  name: 'scale.request_command' | 'scale.weight_pattern'
  maxLength: number
  placeholder: string
  mono?: boolean
}) {
  return (
    <Controller<RegisterFormValues, typeof name>
      name={name}
      render={({ field }) => (
        <Input
          value={field.value}
          onChange={(e) => field.onChange(e.target.value)}
          onBlur={field.onBlur}
          maxLength={maxLength}
          placeholder={placeholder}
          spellCheck={false}
          className={mono ? 'font-mono' : undefined}
        />
      )}
    />
  )
}

export function RegisterFormDialog({
  open,
  onOpenChange,
  register,
  defaultStoreId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null = add a counter. */
  register: Register | null
  defaultStoreId: string
}) {
  const { t } = useTranslation(['settings', 'common'])
  const me = useMe()
  const editing = register !== null
  const [block, setBlock] = useState<PlanBlock | null>(null)
  const form = useForm<RegisterFormValues>({
    defaultValues: fromRegister(register, defaultStoreId),
    resolver: contractResolver<RegisterFormValues>(
      editing ? RegisterUpdateSchema : RegisterCreateSchema,
      editing ? fullUpdateBody : createBody,
      // settings.print_format → print_format, settings.scale.baud_rate → scale.baud_rate
      (p) => (p.startsWith('settings.') ? p.slice('settings.'.length) : p),
    ),
    mode: 'onTouched',
  })
  const create = useCreateRegister()
  const update = useUpdateRegister()
  const saving = create.isPending || update.isPending
  const storeId = useWatch({ control: form.control, name: 'store_id' })
  const printFormat = useWatch({ control: form.control, name: 'print_format' })

  useEffect(() => {
    if (open) {
      form.reset(fromRegister(register, defaultStoreId))
      setBlock(null)
    }
  }, [open, register, defaultStoreId, form])

  const storeOptions = (me?.stores ?? [])
    .filter((s) => s.is_active)
    .map((s) => ({ value: s.id, label: `${s.code} · ${localizedName(s.name, s.name_ta)}` }))
  const storeCode = me?.stores.find((s) => s.id === storeId)?.code ?? ''
  const code = useWatch({ control: form.control, name: 'code' })

  const handleError = (error: unknown): void => {
    const plan = planBlockOf(error)
    if (plan) {
      setBlock(plan)
      return
    }
    if (errorReason(error) === 'register_code_locked') {
      form.setError('code', { type: 'server', message: reasonText(error) ?? '' })
      return
    }
    if (isApiError(error) && error.code === 'DUPLICATE') {
      form.setError('code', { type: 'server', message: t('registers.code_taken') })
      return
    }
    if (isApiError(error) && error.code === 'STALE_WRITE') {
      notify.error(t('common.stale_write'))
      return
    }
    if (!applyServerFieldErrors(error, form.setError, FIELDS)) notifySettingsError(error)
  }

  const submit = form.handleSubmit(async (values) => {
    try {
      if (!register) {
        await create.mutateAsync({ body: createBody(values) })
        notify.success(t('registers.created', { name: values.name.trim() }))
        onOpenChange(false)
        return
      }
      const base = fullUpdateBody(fromRegister(register, defaultStoreId))
      const next = fullUpdateBody(values)
      const diff = changedFields(base, next)
      if (!diff) {
        onOpenChange(false)
        return
      }
      await update.mutateAsync({
        params: { id: register.id },
        body: { ...(diff as RegisterUpdate), if_updated_at: register.updated_at },
      })
      notify.success(t('registers.saved'))
      onOpenChange(false)
    } catch (error) {
      handleError(error)
    }
  })

  const formatOptions = [
    { value: 'default', label: t('registers.print_default') },
    { value: 'thermal_80', label: t('print_format.thermal_80') },
    { value: 'thermal_58', label: t('print_format.thermal_58') },
    { value: 'a4', label: t('print_format.a4') },
  ] as const

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !saving && onOpenChange(o)}
      title={
        editing ? t('registers.edit_title', { name: register.name }) : t('registers.add_title')
      }
      description={editing ? undefined : t('registers.add_description')}
      size="lg"
      dismissible={!form.formState.isDirty}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" form="register-form" loading={saving}>
            {editing ? t('common:actions.save_changes') : t('registers.add')}
          </Button>
        </>
      }
    >
      <FormProvider {...form}>
        <form
          id="register-form"
          onSubmit={(e) => void submit(e)}
          noValidate
          className="flex flex-col gap-4"
        >
          {block ? <UpgradeHint block={block} /> : null}
          {!editing ? (
            <SettingsField name="store_id" label={t('common:fields.store')} required>
              <Select
                value={storeId}
                onValueChange={(v) => form.setValue('store_id', v, { shouldDirty: true })}
                options={storeOptions}
              />
            </SettingsField>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-[8rem_minmax(0,1fr)] [&>*]:min-w-0">
            <SettingsField
              name="code"
              label={t('registers.code')}
              hint={t('registers.code_example', {
                number: `${storeCode || 'S1'}-${(code || 'A').toUpperCase()}/2627/00001`,
              })}
              required
            >
              <Input
                {...form.register('code', {
                  setValueAs: (v: unknown) => (typeof v === 'string' ? v.toUpperCase() : v),
                })}
                maxLength={2}
                autoCapitalize="characters"
                className="font-mono uppercase tracking-wider"
                placeholder="B"
                autoFocus={!editing}
              />
            </SettingsField>
            <SettingsField name="name" label={t('registers.name')} required>
              <Input {...form.register('name')} placeholder={t('registers.name_placeholder')} />
            </SettingsField>
          </div>

          <fieldset className="flex flex-col gap-4 rounded-lg border border-border p-3">
            <legend className="px-1 text-sm font-semibold">{t('registers.printing')}</legend>
            <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
              <SettingsField name="print_format" label={t('registers.print_format')}>
                <Select
                  value={printFormat}
                  onValueChange={(v) => form.setValue('print_format', v, { shouldDirty: true })}
                  options={formatOptions}
                />
              </SettingsField>
              <SettingsField
                name="printer_name"
                label={t('registers.printer_name')}
                hint={t('registers.printer_name_hint')}
                optional
              >
                <Input {...form.register('printer_name')} placeholder="EPSON TM-T82" />
              </SettingsField>
            </div>
            <SwitchRow
              name="auto_print"
              label={t('registers.auto_print')}
              description={t('registers.auto_print_hint')}
            />
            <SwitchRow
              name="silent_print"
              label={t('registers.silent_print')}
              description={t('registers.silent_print_hint')}
            />
          </fieldset>

          <fieldset className="flex flex-col gap-4 rounded-lg border border-border p-3">
            <legend className="px-1 text-sm font-semibold">{t('registers.hardware')}</legend>
            <SwitchRow
              name="customer_display"
              label={t('registers.customer_display')}
              description={t('registers.customer_display_hint')}
            />
            <SwitchRow
              name="cash_drawer"
              label={t('registers.cash_drawer')}
              description={t('registers.cash_drawer_hint')}
            />
          </fieldset>

          <ScaleSection />

          {editing ? (
            <div className="rounded-lg border border-border p-3">
              <SwitchRow
                name="is_active"
                label={t('registers.active')}
                description={t('registers.active_hint')}
              />
            </div>
          ) : null}
        </form>
      </FormProvider>
    </Dialog>
  )
}
