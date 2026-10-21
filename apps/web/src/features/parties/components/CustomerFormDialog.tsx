/**
 * Add / edit a customer. The form validates the exact request body with the contract schemas
 * (CustomerCreateSchema / CustomerUpdateSchema) through `contractResolver`; edits send only the
 * changed fields plus `if_updated_at`. `compact` starts with the few fields a cashier needs
 * (name, mobile, Tamil name, type, WhatsApp consent) and can expand to the full form — that is
 * the POS quick-add. There a mobile number that already belongs to a customer offers "Use this
 * customer" (picks the existing one) instead of leaving the bill for the khata page.
 */
import { ChevronDown, ChevronUp, ExternalLink, Phone, User } from 'lucide-react'
import { type ReactNode, useMemo, useRef, useState } from 'react'
import { Controller, FormProvider, type Path, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import {
  CUSTOMER_TYPE_LABELS,
  type Customer,
  CustomerCreateSchema,
  partiesRoutes,
  CustomerUpdateSchema,
  OPENING_BALANCE_EDIT_PERMISSION,
  PRICE_TIER_LABELS,
} from '@kadai/shared/api/parties'
import { newId } from '@kadai/shared/ids'
import {
  Button,
  DatePicker,
  Dialog,
  Input,
  MoneyInput,
  NumberInput,
  RadioGroup,
  Select,
  Switch,
  notify,
} from '@/components/ui'
import { Textarea } from '@/components/ui/textarea'
import { callRoute, isApiError } from '@/lib/api'
import { useCan, useFeature, useMe } from '@/lib/auth'
import { useCreateCustomer, useUpdateCustomer } from '../api'
import {
  CUSTOMER_TYPES,
  type CustomerDraftInput,
  type CustomerFormValues,
  customerCreateBody,
  customerFieldOf,
  customerPatchBody,
  customerToValues,
  emptyCustomerValues,
} from '../lib/customer-form'
import { contractResolver } from '../lib/forms'
import { pickLabel } from '../lib/labels'
import { AddressFields } from './form/AddressFields'
import { GstinStateFields } from './form/GstinStateFields'
import { OpeningBalanceField } from './form/OpeningBalanceField'
import { PartyField } from './form/PartyField'
import { useValidationKeyText } from '../lib/validation-text'
import { TagsInput } from './form/TagsInput'

const TAG_SUGGESTIONS = ['regular', 'monthly', 'vip', 'staff', 'nearby'] as const

export interface CustomerFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Edit this customer (PATCH); create when absent. */
  customer?: Customer | null
  /** Prefill for a new customer. */
  draft?: CustomerDraftInput
  /** Start with the short form (POS quick add). */
  compact?: boolean
  onSaved?: (customer: Customer) => void
}

export function CustomerFormDialog(props: CustomerFormDialogProps) {
  // Remount per opening so defaults and the idempotency key are fresh.
  if (!props.open) return null
  return <CustomerFormDialogBody {...props} />
}

function CustomerFormDialogBody({
  open,
  onOpenChange,
  customer,
  draft,
  compact = false,
  onSaved,
}: CustomerFormDialogProps) {
  const { t, i18n } = useTranslation(['parties', 'common'])
  const me = useMe()
  const khata = useFeature('khata')
  const keyText = useValidationKeyText()
  const editing = Boolean(customer)
  // Changing an existing opening balance posts an adjusting journal (accounting permission).
  const canEditOpening = useCan(OPENING_BALANCE_EDIT_PERMISSION) || !editing
  const [expanded, setExpanded] = useState(!compact || editing)
  const [existingId, setExistingId] = useState<string | null>(null)
  const [pickingExisting, setPickingExisting] = useState(false)
  // Quick add (POS): pick the customer who already has this number instead of navigating away.
  const quickAdd = compact && !editing && Boolean(onSaved)
  const idempotencyKey = useRef(newId()).current
  const formId = useRef(`customer-form-${newId()}`).current

  const initial = useMemo(
    () =>
      customer
        ? customerToValues(customer)
        : emptyCustomerValues(draft, me?.tenant.state_code ?? null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- defaults are fixed per opening
    [],
  )

  const form = useForm<CustomerFormValues>({
    defaultValues: initial,
    mode: 'onTouched',
    resolver: customer
      ? contractResolver<CustomerFormValues>(
          CustomerUpdateSchema,
          (v) => customerPatchBody(v, initial, customer.updated_at),
          customerFieldOf,
        )
      : contractResolver<CustomerFormValues>(
          CustomerCreateSchema,
          customerCreateBody,
          customerFieldOf,
        ),
  })
  const create = useCreateCustomer()
  const update = useUpdateCustomer()
  const saving = create.isPending || update.isPending

  const handleError = (error: unknown): void => {
    if (isApiError(error) && error.is('DUPLICATE')) {
      const existing = error.details?.existing_id
      const constraint = String(error.details?.constraint ?? '')
      if (typeof existing !== 'string' && constraint.includes('code')) {
        form.setError('code', { type: 'server', message: 'duplicate_code' })
      } else {
        setExistingId(typeof existing === 'string' ? existing : null)
        form.setError('phone', { type: 'server', message: 'duplicate_phone' })
      }
      setExpanded(true)
      return
    }
    if (isApiError(error) && error.details?.reason === 'opening_balance_permission') {
      form.setError('opening_amount_paise', {
        type: 'server',
        message: 'opening_balance_permission',
      })
      setExpanded(true)
      return
    }
    if (isApiError(error) && error.code === 'VALIDATION_ERROR' && error.validationIssues.length) {
      let applied = false
      for (const issue of error.validationIssues) {
        const field = customerFieldOf(issue.path)
        if (!field) continue
        form.setError(field as Path<CustomerFormValues>, { type: 'server', message: issue.message })
        applied = true
      }
      if (applied) {
        setExpanded(true)
        return
      }
    }
    notify.error(error)
  }

  const onSubmit = form.handleSubmit(
    (values) => {
      setExistingId(null)
      if (customer) {
        update.mutate(
          {
            params: { id: customer.id },
            body: customerPatchBody(values, initial, customer.updated_at),
          },
          {
            onSuccess: (res) => {
              notify.success(t('customer_form.updated', { name: res.data.name }))
              onSaved?.(res.data)
              onOpenChange(false)
            },
            onError: handleError,
          },
        )
      } else {
        create.mutate(
          { body: customerCreateBody(values), idempotencyKey },
          {
            onSuccess: (res) => {
              notify.success(t('customer_form.created', { name: res.data.name }))
              onSaved?.(res.data)
              onOpenChange(false)
            },
            onError: handleError,
          },
        )
      }
    },
    () => setExpanded(true),
  )

  const pickExisting = (id: string): void => {
    setPickingExisting(true)
    callRoute(partiesRoutes.getCustomer, { params: { id } })
      .then((res) => {
        onSaved?.(res.data)
        onOpenChange(false)
      })
      .catch((e: unknown) => notify.error(e))
      .finally(() => setPickingExisting(false))
  }

  const rootError = keyText(form.formState.errors.root?.message)
  const typeOptions = CUSTOMER_TYPES.map((type) => ({
    value: type,
    label: pickLabel(CUSTOMER_TYPE_LABELS[type], i18n.language),
  }))
  const tierOptions = [
    { value: 'auto' as const, label: t('customer_form.price_tier_auto') },
    ...(['retail', 'wholesale'] as const).map((tier) => ({
      value: tier,
      label: pickLabel(PRICE_TIER_LABELS[tier], i18n.language),
    })),
  ]
  const defaultDays = me?.settings.credit.default_credit_days ?? 30

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!saving) onOpenChange(o)
      }}
      title={editing ? t('customer_form.edit_title') : t('customer_form.add_title')}
      description={editing ? undefined : t('customer_form.add_description')}
      size={expanded ? 'lg' : 'md'}
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
            {editing ? t('common:actions.save_changes') : t('customer_form.save')}
          </Button>
        </>
      }
    >
      <FormProvider {...form}>
        <form id={formId} onSubmit={onSubmit} noValidate className="grid gap-6 pb-2 [&>*]:min-w-0">
          <section className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
            <PartyField name="name" label={t('fields.name')} required>
              <Input
                autoFocus={!draft?.name}
                autoComplete="off"
                startAdornment={<User />}
                placeholder={t('placeholders.customer_name')}
                {...form.register('name')}
              />
            </PartyField>
            <PartyField name="name_ta" label={t('fields.name_ta')} optional>
              <Input
                lang="ta"
                autoComplete="off"
                placeholder={t('placeholders.customer_name_ta')}
                {...form.register('name_ta')}
              />
            </PartyField>
            <PartyField
              name="phone"
              label={t('fields.phone')}
              hint={t('customer_form.phone_hint')}
              labelAction={
                existingId && quickAdd ? (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-xs"
                    loading={pickingExisting}
                    onClick={() => pickExisting(existingId)}
                  >
                    {t('customer_form.use_existing')}
                  </Button>
                ) : existingId ? (
                  <Link
                    to={`/parties/customers/${existingId}`}
                    className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                    onClick={() => onOpenChange(false)}
                  >
                    {t('customer_form.open_existing')}
                    <ExternalLink className="size-3" aria-hidden />
                  </Link>
                ) : undefined
              }
            >
              <Input
                type="tel"
                inputMode="tel"
                autoComplete="off"
                autoFocus={Boolean(draft?.name)}
                startAdornment={<Phone />}
                placeholder="98765 43210"
                className="tabular-nums"
                {...form.register('phone')}
              />
            </PartyField>
            <div className="self-end pb-1">
              <Controller
                control={form.control}
                name="whatsapp_opt_in"
                render={({ field }) => (
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                    label={t('fields.whatsapp_opt_in')}
                    description={t('customer_form.whatsapp_hint')}
                  />
                )}
              />
            </div>
            <PartyField
              name="customer_type"
              label={t('fields.customer_type')}
              className="sm:col-span-2"
            >
              <Controller
                control={form.control}
                name="customer_type"
                render={({ field }) => (
                  <RadioGroup
                    value={field.value}
                    onValueChange={field.onChange}
                    options={typeOptions}
                    orientation="horizontal"
                    variant="cards"
                    aria-label={t('fields.customer_type')}
                  />
                )}
              />
            </PartyField>
          </section>

          {expanded ? (
            <>
              <FormSection title={t('customer_form.section_gst')}>
                <GstinStateFields
                  onValidGstin={() => {
                    if (form.getValues('customer_type') === 'retail')
                      form.setValue('customer_type', 'business', { shouldDirty: true })
                  }}
                />
              </FormSection>

              <FormSection title={t('customer_form.section_khata')}>
                {khata ? (
                  <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
                    <PartyField
                      name="credit_limit_paise"
                      label={t('fields.credit_limit')}
                      hint={t('customer_form.credit_limit_hint')}
                    >
                      <Controller
                        control={form.control}
                        name="credit_limit_paise"
                        render={({ field }) => (
                          <MoneyInput
                            value={field.value}
                            onChange={field.onChange}
                            onBlur={field.onBlur}
                            placeholder={t('customer_form.no_limit')}
                          />
                        )}
                      />
                    </PartyField>
                    <PartyField
                      name="credit_days"
                      label={t('fields.credit_days')}
                      hint={t('customer_form.credit_days_hint', { days: defaultDays })}
                    >
                      <Controller
                        control={form.control}
                        name="credit_days"
                        render={({ field }) => (
                          <NumberInput
                            value={field.value}
                            onChange={field.onChange}
                            onBlur={field.onBlur}
                            min={0}
                            max={365}
                            placeholder={String(defaultDays)}
                            suffix={t('customer_form.days')}
                          />
                        )}
                      />
                    </PartyField>
                  </div>
                ) : null}
                <OpeningBalanceField
                  partyType="customer"
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

              <FormSection title={t('customer_form.section_address')}>
                <AddressFields />
              </FormSection>

              <FormSection title={t('customer_form.section_more')}>
                <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
                  <PartyField name="alt_phone" label={t('fields.alt_phone')} optional>
                    <Input
                      type="tel"
                      inputMode="tel"
                      autoComplete="off"
                      {...form.register('alt_phone')}
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
                  <PartyField name="date_of_birth" label={t('fields.date_of_birth')} optional>
                    <Controller
                      control={form.control}
                      name="date_of_birth"
                      render={({ field }) => (
                        <DatePicker
                          value={field.value}
                          onChange={field.onChange}
                          onBlur={field.onBlur}
                        />
                      )}
                    />
                  </PartyField>
                  <PartyField name="anniversary" label={t('fields.anniversary')} optional>
                    <Controller
                      control={form.control}
                      name="anniversary"
                      render={({ field }) => (
                        <DatePicker
                          value={field.value}
                          onChange={field.onChange}
                          onBlur={field.onBlur}
                        />
                      )}
                    />
                  </PartyField>
                  <PartyField
                    name="code"
                    label={t('fields.code')}
                    optional
                    hint={t('customer_form.code_hint')}
                  >
                    <Input autoComplete="off" maxLength={20} {...form.register('code')} />
                  </PartyField>
                  <PartyField name="price_tier" label={t('fields.price_tier')}>
                    <Controller
                      control={form.control}
                      name="price_tier"
                      render={({ field }) => (
                        <Select
                          value={field.value}
                          onValueChange={field.onChange}
                          options={tierOptions}
                        />
                      )}
                    />
                  </PartyField>
                  <PartyField
                    name="tags"
                    label={t('fields.tags')}
                    optional
                    className="sm:col-span-2"
                  >
                    <Controller
                      control={form.control}
                      name="tags"
                      render={({ field }) => (
                        <TagsInput
                          value={field.value}
                          onChange={field.onChange}
                          suggestions={TAG_SUGGESTIONS}
                        />
                      )}
                    />
                  </PartyField>
                  <PartyField
                    name="notes"
                    label={t('fields.notes')}
                    optional
                    className="sm:col-span-2"
                  >
                    <Textarea rows={2} maxLength={1000} {...form.register('notes')} />
                  </PartyField>
                </div>
              </FormSection>
            </>
          ) : (
            <Button
              type="button"
              variant="ghost"
              className="justify-self-start"
              leftIcon={<ChevronDown />}
              onClick={() => setExpanded(true)}
            >
              {t('customer_form.more_details')}
            </Button>
          )}
          {expanded && compact && !editing ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="justify-self-start"
              leftIcon={<ChevronUp />}
              onClick={() => setExpanded(false)}
            >
              {t('customer_form.fewer_details')}
            </Button>
          ) : null}
        </form>
      </FormProvider>
    </Dialog>
  )
}

export function FormSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-4 border-t border-border pt-5 [&>*]:min-w-0">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  )
}
