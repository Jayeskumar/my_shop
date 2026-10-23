/**
 * Add / edit a store: code (part of every bill number), names, GSTIN with live checking (the
 * state follows it), address, contact, and the licences the vertical prints on bills — drug
 * licence numbers for pharmacies, FSSAI for food shops. Editing sends only the changed fields
 * with if_updated_at; a plan limit (402) turns into an upgrade hint inside the dialog.
 */
import { useEffect, useState } from 'react'
import { FormProvider, useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import type { Address } from '@kadai/shared/api/common'
import {
  StoreCreateSchema,
  StoreUpdateSchema,
  type Store,
  type StoreCreate,
  type StoreUpdate,
} from '@kadai/shared/api/identity'
import type { BusinessType } from '@kadai/shared/enums'
import { Button, Dialog, Input, Switch, notify } from '@/components/ui'
// Not re-exported by the UI kit index.
import { Textarea } from '@/components/ui/textarea'
import { isApiError } from '@/lib/api'
import { applyServerFieldErrors } from '@/lib/form-errors'
import { useCreateStore, useUpdateStore } from '../api'
import {
  addressFromRecord,
  addressToBody,
  changedTopLevel,
  contractResolver,
  EMPTY_ADDRESS,
  textOrNull,
  type AddressFormValues,
} from '../lib/forms'
import {
  errorReason,
  notifySettingsError,
  planBlockOf,
  reasonText,
  type PlanBlock,
} from '../lib/messages'
import { AddressFields, GstinField, StateSelectField } from './fields'
import { SettingsField } from './SettingsField'
import { UpgradeHint } from './UpgradeHint'

/** Verticals that print an FSSAI licence number (food). */
const FOOD_TYPES: readonly BusinessType[] = ['general_store', 'supermarket', 'bakery_sweets']

interface StoreFormValues {
  code: string
  name: string
  name_ta: string
  gstin: string
  state_code: string
  phone: string
  email: string
  address: AddressFormValues
  drug_license_numbers: string
  fssai_number: string
  is_active: boolean
}

interface StoreBody {
  code: string
  name: string
  name_ta: string | null
  gstin: string | null
  state_code: string
  phone: string | null
  email: string | null
  address: Address
  drug_license_numbers?: string | null
  fssai_number?: string | null
  is_active?: boolean
  [key: string]: unknown
}

const FIELDS = [
  'code',
  'name',
  'name_ta',
  'gstin',
  'state_code',
  'phone',
  'email',
  'address',
  'drug_license_numbers',
  'fssai_number',
  'is_active',
]

function fromStore(s: Store | null, stateCode: string): StoreFormValues {
  return {
    code: s?.code ?? '',
    name: s?.name ?? '',
    name_ta: s?.name_ta ?? '',
    gstin: s?.gstin ?? '',
    state_code: s?.state_code ?? stateCode,
    phone: s?.phone ? s.phone.replace(/^\+91/, '') : '',
    email: s?.email ?? '',
    address: s ? addressFromRecord(s.address) : EMPTY_ADDRESS,
    drug_license_numbers: s?.drug_license_numbers ?? '',
    fssai_number: s?.fssai_number ?? '',
    is_active: s?.is_active ?? true,
  }
}

function makeToBody(opts: { pharmacy: boolean; food: boolean; editing: boolean }) {
  return (v: StoreFormValues): StoreBody => ({
    code: v.code.trim().toUpperCase(),
    name: v.name.trim(),
    name_ta: textOrNull(v.name_ta),
    gstin: textOrNull(v.gstin),
    state_code: v.state_code,
    phone: textOrNull(v.phone),
    email: textOrNull(v.email),
    address: addressToBody(v.address, v.state_code),
    ...(opts.pharmacy ? { drug_license_numbers: textOrNull(v.drug_license_numbers) } : {}),
    ...(opts.food ? { fssai_number: textOrNull(v.fssai_number) } : {}),
    ...(opts.editing ? { is_active: v.is_active } : {}),
  })
}

export function StoreFormDialog({
  open,
  onOpenChange,
  store,
  businessType,
  defaultStateCode,
  canChangeCode = true,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null = add a new store. */
  store: Store | null
  businessType: BusinessType
  defaultStateCode: string
  canChangeCode?: boolean
  onCreated?: (store: Store) => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const editing = store !== null
  const pharmacy = businessType === 'pharmacy'
  const food = FOOD_TYPES.includes(businessType)
  const toBody = makeToBody({ pharmacy, food, editing })
  const [block, setBlock] = useState<PlanBlock | null>(null)
  const form = useForm<StoreFormValues>({
    defaultValues: fromStore(store, defaultStateCode),
    resolver: contractResolver<StoreFormValues>(
      editing ? StoreUpdateSchema : StoreCreateSchema,
      toBody,
      (p) => (p.startsWith('address.state_code') ? 'state_code' : p),
    ),
    mode: 'onTouched',
  })
  const create = useCreateStore()
  const update = useUpdateStore()
  const saving = create.isPending || update.isPending
  const isActive = useWatch({ control: form.control, name: 'is_active' })

  useEffect(() => {
    if (open) {
      form.reset(fromStore(store, defaultStateCode))
      setBlock(null)
    }
  }, [open, store, defaultStateCode, form])

  const handleError = (error: unknown): void => {
    const plan = planBlockOf(error)
    if (plan) {
      setBlock(plan)
      return
    }
    const reason = errorReason(error)
    if (reason === 'store_code_locked') {
      form.setError('code', { type: 'server', message: reasonText(error) ?? reason })
      return
    }
    if (isApiError(error) && error.code === 'DUPLICATE') {
      form.setError('code', { type: 'server', message: t('stores.code_taken') })
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
      if (!store) {
        const res = await create.mutateAsync({ body: toBody(values) as StoreCreate })
        notify.success(t('stores.created', { name: res.data.name }))
        onOpenChange(false)
        onCreated?.(res.data)
        return
      }
      const diff = changedTopLevel(toBody(fromStore(store, defaultStateCode)), toBody(values))
      if (!diff) {
        onOpenChange(false)
        return
      }
      await update.mutateAsync({
        params: { id: store.id },
        body: { ...(diff as StoreUpdate), if_updated_at: store.updated_at },
      })
      notify.success(t('stores.saved'))
      onOpenChange(false)
    } catch (error) {
      handleError(error)
    }
  })

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !saving && onOpenChange(o)}
      title={editing ? t('stores.edit_title', { name: store.name }) : t('stores.add_title')}
      description={editing ? undefined : t('stores.add_description')}
      size="lg"
      dismissible={!form.formState.isDirty}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" form="store-form" loading={saving}>
            {editing ? t('common:actions.save_changes') : t('stores.add')}
          </Button>
        </>
      }
    >
      <FormProvider {...form}>
        <form
          id="store-form"
          onSubmit={(e) => void submit(e)}
          noValidate
          className="flex flex-col gap-4"
        >
          {block ? <UpgradeHint block={block} /> : null}
          <div className="grid gap-4 sm:grid-cols-[8rem_minmax(0,1fr)] [&>*]:min-w-0">
            <SettingsField
              name="code"
              label={t('stores.code')}
              hint={canChangeCode ? t('stores.code_hint') : t('stores.code_locked_hint')}
              required
            >
              <Input
                {...form.register('code', {
                  setValueAs: (v: unknown) => (typeof v === 'string' ? v.toUpperCase() : v),
                })}
                maxLength={4}
                autoCapitalize="characters"
                className="font-mono uppercase tracking-wider"
                placeholder="S2"
                disabled={!canChangeCode}
                autoFocus={!editing}
              />
            </SettingsField>
            <SettingsField name="name" label={t('stores.name')} required>
              <Input {...form.register('name')} placeholder={t('stores.name_placeholder')} />
            </SettingsField>
          </div>
          <SettingsField name="name_ta" label={t('stores.name_ta')} optional>
            <Input {...form.register('name_ta')} lang="ta" />
          </SettingsField>
          <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
            <GstinField<StoreFormValues>
              name="gstin"
              label={t('stores.gstin')}
              hint={t('stores.gstin_hint')}
              onValid={({ stateCode }) =>
                form.setValue('state_code', stateCode, { shouldDirty: true })
              }
            />
            <StateSelectField<StoreFormValues> name="state_code" label={t('business.state')} />
          </div>
          <AddressFields />
          <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
            <SettingsField name="phone" label={t('common:fields.phone')} optional>
              <Input
                {...form.register('phone')}
                inputMode="tel"
                autoComplete="tel"
                placeholder="98765 43210"
                startAdornment={<span className="text-sm text-muted-foreground">+91</span>}
              />
            </SettingsField>
            <SettingsField name="email" label={t('common:fields.email')} optional>
              <Input {...form.register('email')} type="email" inputMode="email" />
            </SettingsField>
          </div>
          {pharmacy ? (
            <SettingsField
              name="drug_license_numbers"
              label={t('stores.drug_license')}
              hint={t('stores.drug_license_hint')}
              optional
            >
              <Textarea
                {...form.register('drug_license_numbers')}
                rows={2}
                placeholder="TN/MDU/20/1234, TN/MDU/21/1234"
              />
            </SettingsField>
          ) : null}
          {food ? (
            <SettingsField
              name="fssai_number"
              label={t('stores.fssai')}
              hint={t('stores.fssai_hint')}
              optional
            >
              <Input
                {...form.register('fssai_number')}
                inputMode="numeric"
                maxLength={14}
                className="font-mono tabular-nums"
                placeholder="12423012000123"
              />
            </SettingsField>
          ) : null}
          {editing ? (
            <div className="rounded-lg border border-border p-3">
              <Switch
                checked={isActive}
                onCheckedChange={(v) => form.setValue('is_active', v, { shouldDirty: true })}
                label={t('stores.active')}
                description={isActive ? t('stores.active_hint') : t('stores.inactive_hint')}
              />
            </div>
          ) : null}
        </form>
      </FormProvider>
    </Dialog>
  )
}
