/**
 * Add / edit a supplier: contact, GSTIN (live check, state and PAN from it), drug licence
 * (pharmacies), payment terms, opening payable, bank details (account number is write-only —
 * only the last 4 digits are kept) and UPI ID. Validated against SupplierCreateSchema /
 * SupplierUpdateSchema; edits send only what changed.
 */
import { Building2, Phone } from 'lucide-react'
import { useMemo, useRef } from 'react'
import { Controller, FormProvider, type Path, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import {
  OPENING_BALANCE_EDIT_PERMISSION,
  type Supplier,
  SupplierCreateSchema,
  SupplierUpdateSchema,
} from '@kadai/shared/api/parties'
import { panFromGstin } from '@kadai/shared/gst'
import { newId } from '@kadai/shared/ids'
import { Button, Checkbox, Dialog, Input, NumberInput, notify } from '@/components/ui'
import { Textarea } from '@/components/ui/textarea'
import { isApiError } from '@/lib/api'
import { useCan, useMe } from '@/lib/auth'
import { useCreateSupplier, useUpdateSupplier } from '../api'
import { contractResolver } from '../lib/forms'
import {
  emptySupplierValues,
  type SupplierFormValues,
  supplierCreateBody,
  supplierFieldOf,
  supplierPatchBody,
  supplierToValues,
} from '../lib/supplier-form'
import { FormSection } from './CustomerFormDialog'
import { AddressFields } from './form/AddressFields'
import { GstinStateFields } from './form/GstinStateFields'
import { OpeningBalanceField } from './form/OpeningBalanceField'
import { PartyField } from './form/PartyField'
import { useValidationKeyText } from '../lib/validation-text'

export interface SupplierFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  supplier?: Supplier | null
  onSaved?: (supplier: Supplier) => void
}

export function SupplierFormDialog(props: SupplierFormDialogProps) {
  if (!props.open) return null
  return <SupplierFormBody {...props} />
}

function SupplierFormBody({ onOpenChange, supplier, onSaved }: SupplierFormDialogProps) {
  const { t } = useTranslation(['parties', 'common'])
  const me = useMe()
  const keyText = useValidationKeyText()
  const editing = Boolean(supplier)
  const canEditOpening = useCan(OPENING_BALANCE_EDIT_PERMISSION) || !editing
  const pharmacy = me?.tenant.business_type === 'pharmacy'
  const idempotencyKey = useRef(newId()).current
  const formId = useRef(`supplier-form-${newId()}`).current

  const initial = useMemo(
    () =>
      supplier ? supplierToValues(supplier) : emptySupplierValues(me?.tenant.state_code ?? null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- defaults are fixed per opening
    [],
  )
  const form = useForm<SupplierFormValues>({
    defaultValues: initial,
    mode: 'onTouched',
    resolver: supplier
      ? contractResolver<SupplierFormValues>(
          SupplierUpdateSchema,
          (v) => supplierPatchBody(v, initial, supplier.updated_at),
          supplierFieldOf,
        )
      : contractResolver<SupplierFormValues>(
          SupplierCreateSchema,
          supplierCreateBody,
          supplierFieldOf,
        ),
  })
  const create = useCreateSupplier()
  const update = useUpdateSupplier()
  const saving = create.isPending || update.isPending

  const handleError = (error: unknown): void => {
    if (isApiError(error) && error.is('DUPLICATE')) {
      const constraint = String(error.details?.constraint ?? '')
      form.setError(constraint.includes('code') ? 'code' : 'gstin', {
        type: 'server',
        message: constraint.includes('code') ? 'duplicate_code' : 'duplicate_supplier',
      })
      return
    }
    if (isApiError(error) && error.details?.reason === 'opening_balance_permission') {
      form.setError('opening_amount_paise', {
        type: 'server',
        message: 'opening_balance_permission',
      })
      return
    }
    if (isApiError(error) && error.code === 'VALIDATION_ERROR' && error.validationIssues.length) {
      let applied = false
      for (const issue of error.validationIssues) {
        const field = supplierFieldOf(issue.path)
        if (!field) continue
        form.setError(field as Path<SupplierFormValues>, { type: 'server', message: issue.message })
        applied = true
      }
      if (applied) return
    }
    notify.error(error)
  }

  const onSubmit = form.handleSubmit((values) => {
    if (supplier) {
      update.mutate(
        {
          params: { id: supplier.id },
          body: supplierPatchBody(values, initial, supplier.updated_at),
        },
        {
          onSuccess: (res) => {
            notify.success(t('supplier_form.updated', { name: res.data.name }))
            onSaved?.(res.data)
            onOpenChange(false)
          },
          onError: handleError,
        },
      )
    } else {
      create.mutate(
        { body: supplierCreateBody(values), idempotencyKey },
        {
          onSuccess: (res) => {
            notify.success(t('supplier_form.created', { name: res.data.name }))
            onSaved?.(res.data)
            onOpenChange(false)
          },
          onError: handleError,
        },
      )
    }
  })

  const rootError = keyText(form.formState.errors.root?.message)
  const last4 = supplier?.bank_details.account_no_last4
  const clearAccount = form.watch('clear_account_no')

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!saving) onOpenChange(o)
      }}
      title={editing ? t('supplier_form.edit_title') : t('supplier_form.add_title')}
      description={editing ? undefined : t('supplier_form.add_description')}
      size="lg"
      dismissible={!form.formState.isDirty}
      footer={
        <>
          {rootError ? (
            <p role="alert" className="me-auto self-center text-sm font-medium text-danger">
              {rootError}
            </p>
          ) : null}
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={saving}>
            {editing ? t('common:actions.save_changes') : t('supplier_form.save')}
          </Button>
        </>
      }
    >
      <FormProvider {...form}>
        <form id={formId} onSubmit={onSubmit} noValidate className="grid gap-6 pb-2 [&>*]:min-w-0">
          <section className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
            <PartyField
              name="name"
              label={t('fields.supplier_name')}
              required
              className="sm:col-span-2"
            >
              <Input
                autoFocus
                autoComplete="organization"
                startAdornment={<Building2 />}
                placeholder={t('placeholders.supplier_name')}
                {...form.register('name')}
              />
            </PartyField>
            <PartyField name="contact_person" label={t('fields.contact_person')} optional>
              <Input autoComplete="off" {...form.register('contact_person')} />
            </PartyField>
            <PartyField name="phone" label={t('fields.phone')} optional>
              <Input
                type="tel"
                inputMode="tel"
                autoComplete="off"
                startAdornment={<Phone />}
                placeholder="98765 43210"
                className="tabular-nums"
                {...form.register('phone')}
              />
            </PartyField>
            <PartyField name="email" label={t('fields.email')} optional>
              <Input
                type="email"
                inputMode="email"
                autoComplete="off"
                {...form.register('email')}
              />
            </PartyField>
            <PartyField name="code" label={t('fields.code')} optional>
              <Input autoComplete="off" maxLength={20} {...form.register('code')} />
            </PartyField>
          </section>

          <FormSection title={t('supplier_form.section_gst')}>
            <GstinStateFields
              onValidGstin={(gstin) => {
                // The PAN is part of the GSTIN, so a new GSTIN always brings its PAN along.
                const pan = panFromGstin(gstin)
                if (pan && form.getValues('pan') !== pan)
                  form.setValue('pan', pan, { shouldDirty: true, shouldValidate: true })
              }}
            />
            <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
              <PartyField
                name="pan"
                label={t('fields.pan')}
                optional
                hint={t('supplier_form.pan_hint')}
              >
                <Input
                  autoCapitalize="characters"
                  maxLength={10}
                  className="font-mono uppercase"
                  {...form.register('pan', {
                    setValueAs: (v: unknown) =>
                      typeof v === 'string' ? v.trim().toUpperCase() : v,
                  })}
                />
              </PartyField>
              {pharmacy || initial.drug_license_no ? (
                <PartyField
                  name="drug_license_no"
                  label={t('fields.drug_license_no')}
                  optional
                  hint={t('supplier_form.drug_license_hint')}
                >
                  <Input autoComplete="off" maxLength={100} {...form.register('drug_license_no')} />
                </PartyField>
              ) : null}
            </div>
          </FormSection>

          <FormSection title={t('supplier_form.section_payment')}>
            <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
              <PartyField
                name="payment_terms_days"
                label={t('fields.payment_terms')}
                hint={t('supplier_form.payment_terms_hint')}
              >
                <Controller
                  control={form.control}
                  name="payment_terms_days"
                  render={({ field }) => (
                    <NumberInput
                      value={field.value}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                      min={0}
                      max={365}
                      placeholder="30"
                      suffix={t('customer_form.days')}
                    />
                  )}
                />
              </PartyField>
              <PartyField
                name="lead_time_days"
                label={t('fields.lead_time')}
                optional
                hint={t('supplier_form.lead_time_hint')}
              >
                <Controller
                  control={form.control}
                  name="lead_time_days"
                  render={({ field }) => (
                    <NumberInput
                      value={field.value ?? null}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                      min={1}
                      max={365}
                      placeholder="3"
                      suffix={t('customer_form.days')}
                    />
                  )}
                />
              </PartyField>
              <PartyField
                name="upi_vpa"
                label={t('fields.upi_vpa')}
                optional
                hint={t('supplier_form.upi_hint')}
              >
                <Input
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="name@okbank"
                  {...form.register('upi_vpa')}
                />
              </PartyField>
            </div>
            <OpeningBalanceField
              partyType="supplier"
              disabled={!canEditOpening}
              hint={
                !canEditOpening
                  ? t('opening.edit_locked')
                  : editing
                    ? t('opening.edit_hint')
                    : undefined
              }
            />
          </FormSection>

          <FormSection title={t('supplier_form.section_bank')}>
            <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
              <PartyField name="bank.account_name" label={t('fields.account_name')} optional>
                <Input autoComplete="off" {...form.register('bank.account_name')} />
              </PartyField>
              <PartyField
                name="bank.account_number"
                label={t('fields.account_number')}
                optional
                hint={
                  last4 && !clearAccount
                    ? t('supplier_form.account_saved', { last4 })
                    : t('supplier_form.account_hint')
                }
              >
                <Input
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={22}
                  className="font-mono tabular-nums"
                  placeholder={last4 ? `•••• ${last4}` : undefined}
                  disabled={clearAccount}
                  {...form.register('bank.account_number')}
                />
              </PartyField>
              <PartyField
                name="bank.ifsc"
                label={t('fields.ifsc')}
                optional
                hint={t('supplier_form.ifsc_hint')}
              >
                <Input
                  autoCapitalize="characters"
                  maxLength={11}
                  className="font-mono uppercase"
                  placeholder="SBIN0001234"
                  {...form.register('bank.ifsc')}
                />
              </PartyField>
              <PartyField name="bank.bank_name" label={t('fields.bank_name')} optional>
                <Input autoComplete="off" {...form.register('bank.bank_name')} />
              </PartyField>
              {last4 ? (
                <Controller
                  control={form.control}
                  name="clear_account_no"
                  render={({ field }) => (
                    <label className="flex items-center gap-2 text-sm sm:col-span-2">
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={(v) => field.onChange(v === true)}
                      />
                      {t('supplier_form.clear_account', { last4 })}
                    </label>
                  )}
                />
              ) : null}
            </div>
          </FormSection>

          <FormSection title={t('customer_form.section_address')}>
            <AddressFields />
          </FormSection>

          <PartyField name="notes" label={t('fields.notes')} optional>
            <Textarea rows={2} maxLength={1000} {...form.register('notes')} />
          </PartyField>
        </form>
      </FormProvider>
    </Dialog>
  )
}
