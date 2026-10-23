/**
 * Business details (/settings/business): names (English / Tamil / legal), GST registration
 * (scheme with a plain-language explanation, GSTIN with live check-character feedback that also
 * fills the state and PAN), contact, address with Tamil Nadu district suggestions, logo and the
 * default language of invoices and messages. Saves only the changed fields with if_updated_at;
 * a scheme change after invoices in this financial year asks for confirmation first.
 */
import { Building2, FileText, Languages, MapPin, ReceiptText } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { FormProvider, useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import type { Address } from '@kadai/shared/api/common'
import {
  BusinessProfileUpdateSchema,
  type BusinessProfile,
  type BusinessProfileUpdate,
} from '@kadai/shared/api/identity'
import type { GstScheme, Locale } from '@kadai/shared/enums'
import { getBusinessType } from '@kadai/shared/verticals'
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Input,
  RadioGroup,
  Skeleton,
  notify,
} from '@/components/ui'
import { isApiError } from '@/lib/api'
import { formatDateTime } from '@/lib/format'
import { applyServerFieldErrors } from '@/lib/form-errors'
import { getLanguage } from '@/lib/i18n'
import { useBusinessProfile, useUpdateBusinessProfile } from '../api'
import { AddressFields, GstinField, StateSelectField } from '../components/fields'
import { LogoField } from '../components/LogoField'
import { SaveBar, UnsavedChangesGuard } from '../components/SaveBar'
import { ReadOnlyNotice, SettingsCard } from '../components/SettingsCard'
import { SettingsField } from '../components/SettingsField'
import { SettingsPageHeader } from '../components/SettingsPageHeader'
import { useBusinessWideEdit } from '../lib/access'
import {
  addressFromRecord,
  addressToBody,
  changedTopLevel,
  contractResolver,
  EMPTY_ADDRESS,
  textOrNull,
  type AddressFormValues,
} from '../lib/forms'
import { errorReason, notifySettingsError, settingsErrorDisplay } from '../lib/messages'

interface BusinessFormValues {
  name: string
  name_ta: string
  legal_name: string
  gst_scheme: GstScheme
  gstin: string
  pan: string
  state_code: string
  phone: string
  email: string
  address: AddressFormValues
  logo_file_id: string | null
  default_locale: Locale
}

/** The whole profile as a PATCH body (the form validates it in full, then sends the diff). */
interface BusinessBody {
  name: string
  name_ta: string | null
  legal_name: string | null
  gst_scheme: GstScheme
  gstin: string | null
  pan: string | null
  state_code: string
  phone: string | null
  email: string | null
  address: Address
  logo_file_id: string | null
  default_locale: Locale
  [key: string]: unknown
}

const EMPTY: BusinessFormValues = {
  name: '',
  name_ta: '',
  legal_name: '',
  gst_scheme: 'regular',
  gstin: '',
  pan: '',
  state_code: '33',
  phone: '',
  email: '',
  address: EMPTY_ADDRESS,
  logo_file_id: null,
  default_locale: 'ta',
}

const FIELDS = Object.keys(EMPTY)

function nationalPhone(phone: string | null): string {
  return phone ? phone.replace(/^\+91/, '') : ''
}

function fromProfile(p: BusinessProfile): BusinessFormValues {
  return {
    name: p.name,
    name_ta: p.name_ta ?? '',
    legal_name: p.legal_name ?? '',
    gst_scheme: p.gst_scheme,
    gstin: p.gstin ?? '',
    pan: p.pan ?? '',
    state_code: p.state_code,
    phone: nationalPhone(p.phone),
    email: p.email ?? '',
    address: addressFromRecord(p.address),
    logo_file_id: p.logo_file_id,
    default_locale: p.default_locale,
  }
}

function toBody(v: BusinessFormValues): BusinessBody {
  return {
    name: v.name.trim(),
    name_ta: textOrNull(v.name_ta),
    legal_name: textOrNull(v.legal_name),
    gst_scheme: v.gst_scheme,
    gstin: v.gst_scheme === 'unregistered' ? null : textOrNull(v.gstin),
    pan: textOrNull(v.pan),
    state_code: v.state_code,
    phone: textOrNull(v.phone),
    email: textOrNull(v.email),
    address: addressToBody(v.address, v.state_code),
    logo_file_id: v.logo_file_id,
    default_locale: v.default_locale,
  }
}

const resolver = contractResolver<BusinessFormValues>(BusinessProfileUpdateSchema, toBody, (p) =>
  p.startsWith('address.state_code') ? 'state_code' : p,
)

function BusinessSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy>
      {[0, 1, 2].map((i) => (
        <div key={i} className="rounded-xl border border-border bg-surface p-5">
          <Skeleton className="mb-4 h-5 w-48" />
          <div className="grid gap-4 sm:grid-cols-2">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        </div>
      ))}
    </div>
  )
}

export default function BusinessPage() {
  const { t } = useTranslation(['settings', 'common', 'nav'])
  const profileQuery = useBusinessProfile()
  const profile = profileQuery.data?.data
  const { canEdit, storeScoped } = useBusinessWideEdit()
  const update = useUpdateBusinessProfile()
  const [confirmScheme, setConfirmScheme] = useState(false)
  const form = useForm<BusinessFormValues>({ defaultValues: EMPTY, resolver, mode: 'onTouched' })
  const loadedAt = useRef<string | null>(null)
  const initial = useRef<BusinessFormValues>(EMPTY)

  useEffect(() => {
    if (!profile || profile.updated_at === loadedAt.current) return
    if (loadedAt.current !== null && form.formState.isDirty) return
    loadedAt.current = profile.updated_at
    initial.current = fromProfile(profile)
    form.reset(initial.current)
  }, [profile, form])

  const scheme = useWatch({ control: form.control, name: 'gst_scheme' })
  const logo = useWatch({ control: form.control, name: 'logo_file_id' })
  const locale = useWatch({ control: form.control, name: 'default_locale' })
  const dirty = form.formState.isDirty

  const save = async (values: BusinessFormValues, confirmed: boolean): Promise<void> => {
    if (!profile) return
    const diff = changedTopLevel(toBody(initial.current), toBody(values))
    if (!diff) {
      form.reset(values)
      return
    }
    if (diff.gst_scheme !== undefined && profile.gst_scheme_change_requires_confirm && !confirmed) {
      setConfirmScheme(true)
      return
    }
    const body: BusinessProfileUpdate = {
      ...(diff as BusinessProfileUpdate),
      if_updated_at: profile.updated_at,
      ...(confirmed ? { confirm_gst_scheme_change: true } : {}),
    }
    try {
      const res = await update.mutateAsync({ body })
      loadedAt.current = res.data.updated_at
      initial.current = fromProfile(res.data)
      form.reset(initial.current)
      notify.success(t('business.saved'))
    } catch (error) {
      if (errorReason(error) === 'gst_scheme_change_requires_confirm') {
        setConfirmScheme(true)
        return
      }
      if (isApiError(error) && error.code === 'STALE_WRITE') {
        notify.error(t('common.stale_write'), {
          action: { label: t('common:actions.reload'), onClick: () => void reload() },
        })
        return
      }
      if (!applyServerFieldErrors(error, form.setError, FIELDS)) notifySettingsError(error)
    }
  }

  const reload = async (): Promise<void> => {
    loadedAt.current = null
    form.reset(initial.current)
    await profileQuery.refetch()
  }

  const submit = form.handleSubmit((values) => save(values, false))

  if (profileQuery.error && !profile) {
    const display = settingsErrorDisplay(profileQuery.error)
    return (
      <div>
        <SettingsPageHeader title={t('nav:titles.settings_business')} />
        <EmptyState
          icon={<Building2 />}
          title={display.title}
          description={display.description}
          action={
            <Button variant="outline" onClick={() => void profileQuery.refetch()}>
              {t('common:actions.retry')}
            </Button>
          }
        />
      </div>
    )
  }

  const businessType = profile ? getBusinessType(profile.business_type) : null
  const lng = getLanguage()
  const disabled = !canEdit || update.isPending

  return (
    <div className="max-w-4xl">
      <SettingsPageHeader
        title={t('nav:titles.settings_business')}
        description={t('business.description')}
        meta={
          profile ? (
            <span className="text-xs text-muted-foreground">
              {t('common.last_updated', { when: formatDateTime(profile.updated_at) })}
            </span>
          ) : null
        }
      />
      {storeScoped ? <ReadOnlyNotice>{t('common.store_scoped_readonly')}</ReadOnlyNotice> : null}
      {!profile ? (
        <BusinessSkeleton />
      ) : (
        <FormProvider {...form}>
          <form
            onSubmit={(e) => void submit(e)}
            className="flex flex-col gap-5"
            noValidate
            aria-label={t('nav:titles.settings_business')}
          >
            <SettingsCard
              id="business-names"
              icon={<Building2 />}
              title={t('business.section_names')}
              description={t('business.section_names_hint')}
            >
              <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
                <SettingsField name="name" label={t('business.name')} required>
                  <Input
                    {...form.register('name')}
                    disabled={disabled}
                    autoComplete="organization"
                  />
                </SettingsField>
                <SettingsField name="name_ta" label={t('business.name_ta')} optional>
                  <Input
                    {...form.register('name_ta')}
                    disabled={disabled}
                    lang="ta"
                    placeholder={t('business.name_ta_placeholder')}
                  />
                </SettingsField>
                <SettingsField
                  name="legal_name"
                  label={t('business.legal_name')}
                  hint={t('business.legal_name_hint')}
                  optional
                  className="sm:col-span-2"
                >
                  <Input {...form.register('legal_name')} disabled={disabled} />
                </SettingsField>
              </div>
              {businessType ? (
                <div className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-2 px-3 py-2.5 text-sm">
                  <span className="text-muted-foreground">{t('business.business_type')}</span>
                  <Badge tone="primary">
                    {lng === 'ta' ? businessType.name_ta : businessType.name_en}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {t('business.business_type_hint')}
                  </span>
                </div>
              ) : null}
              <SettingsField name="logo_file_id" label={t('logo.label')} optional>
                <LogoField
                  value={logo}
                  disabled={!canEdit}
                  onChange={(id) =>
                    form.setValue('logo_file_id', id, { shouldDirty: true, shouldValidate: true })
                  }
                />
              </SettingsField>
            </SettingsCard>

            <SettingsCard
              id="business-gst"
              icon={<ReceiptText />}
              title={t('business.section_gst')}
              description={t('business.section_gst_hint')}
            >
              <SettingsField name="gst_scheme" label={t('business.gst_scheme')} required>
                <RadioGroup<GstScheme>
                  variant="cards"
                  value={scheme}
                  disabled={disabled}
                  onValueChange={(v) =>
                    form.setValue('gst_scheme', v, { shouldDirty: true, shouldValidate: true })
                  }
                  options={(['regular', 'composition', 'unregistered'] as const).map((s) => ({
                    value: s,
                    label: t(`business.scheme_${s}`),
                    description: t(`business.scheme_${s}_hint`),
                  }))}
                />
              </SettingsField>
              <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
                {scheme !== 'unregistered' ? (
                  <GstinField<BusinessFormValues>
                    name="gstin"
                    label={t('business.gstin')}
                    required
                    disabled={disabled}
                    hint={t('business.gstin_hint')}
                    onValid={({ stateCode, pan }) => {
                      form.setValue('state_code', stateCode, { shouldDirty: true })
                      if (pan && form.getValues('pan') !== pan)
                        form.setValue('pan', pan, { shouldDirty: true })
                    }}
                  />
                ) : null}
                <SettingsField
                  name="pan"
                  label={t('business.pan')}
                  hint={t('business.pan_hint')}
                  optional
                >
                  <Input
                    {...form.register('pan', {
                      setValueAs: (v: unknown) =>
                        typeof v === 'string' ? v.trim().toUpperCase() : v,
                    })}
                    disabled={disabled}
                    maxLength={10}
                    autoCapitalize="characters"
                    spellCheck={false}
                    placeholder="AAAPL1234C"
                    className="font-mono uppercase tracking-wide"
                  />
                </SettingsField>
                <StateSelectField<BusinessFormValues>
                  name="state_code"
                  label={t('business.state')}
                  hint={t('business.state_hint')}
                  disabled={disabled}
                />
              </div>
            </SettingsCard>

            <SettingsCard
              id="business-contact"
              icon={<MapPin />}
              title={t('business.section_contact')}
              description={t('business.section_contact_hint')}
            >
              <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
                <SettingsField name="phone" label={t('common:fields.phone')} optional>
                  <Input
                    {...form.register('phone')}
                    disabled={disabled}
                    inputMode="tel"
                    autoComplete="tel"
                    placeholder="98765 43210"
                    startAdornment={<span className="text-sm text-muted-foreground">+91</span>}
                  />
                </SettingsField>
                <SettingsField name="email" label={t('common:fields.email')} optional>
                  <Input
                    {...form.register('email')}
                    disabled={disabled}
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                  />
                </SettingsField>
              </div>
              <AddressFields disabled={disabled} />
            </SettingsCard>

            <SettingsCard
              id="business-language"
              icon={<Languages />}
              title={t('business.section_language')}
              description={t('business.section_language_hint')}
            >
              <RadioGroup<Locale>
                variant="cards"
                orientation="horizontal"
                value={locale}
                disabled={disabled}
                onValueChange={(v) => form.setValue('default_locale', v, { shouldDirty: true })}
                options={[
                  { value: 'ta', label: 'தமிழ்', description: t('business.locale_ta_hint') },
                  { value: 'en', label: 'English', description: t('business.locale_en_hint') },
                ]}
              />
            </SettingsCard>

            <div className="flex items-start gap-2 rounded-lg bg-surface-2 px-4 py-3 text-sm text-muted-foreground">
              <FileText className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                {t('business.fy_note', {
                  fy: profile.current_fy,
                  month: t(`months.m${profile.fy_start_month}` as 'months.m4'),
                })}
              </span>
            </div>

            {canEdit ? (
              <SaveBar
                dirty={dirty}
                saving={update.isPending}
                onSave={() => void submit()}
                onDiscard={() => form.reset(initial.current)}
              />
            ) : null}
          </form>
        </FormProvider>
      )}
      <UnsavedChangesGuard dirty={dirty && !update.isPending} />
      <ConfirmDialog
        open={confirmScheme}
        onOpenChange={setConfirmScheme}
        tone="danger"
        title={t('business.scheme_confirm_title')}
        description={t('business.scheme_confirm_description')}
        confirmLabel={t('business.scheme_confirm_action')}
        onConfirm={() => save(form.getValues(), true)}
      />
    </div>
  )
}
