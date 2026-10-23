/**
 * Invite a member (mobile number, name, role, store access, optional POS PIN and how they sign
 * in the first time) or edit one (name, email, role, stores, language). Roles the caller may
 * not hand out are disabled with the reason; a plan limit (402) becomes an upgrade hint. The
 * create result (temporary password shown once / existing Kadai user / OTP) is handed to the
 * caller.
 */
import { useEffect, useMemo, useState } from 'react'
import { Controller, FormProvider, useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import {
  MemberCreateSchema,
  MemberUpdateSchema,
  type Member,
  type MemberCreate,
  type MemberCreateResult,
  type MemberUpdate,
} from '@kadai/shared/api/identity'
import type { Locale } from '@kadai/shared/enums'
import { Button, Dialog, Input, RadioGroup, Select, notify } from '@/components/ui'
import { isApiError } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { applyServerFieldErrors } from '@/lib/form-errors'
import { useCreateMember, useRoles, useUpdateMember } from '../api'
import { changedTopLevel, contractResolver, digitsOnly, textOrNull } from '../lib/forms'
import { canAssignRole, roleLabel } from '../lib/members'
import {
  errorReason,
  notifySettingsError,
  planBlockOf,
  reasonText,
  type PlanBlock,
} from '../lib/messages'
import { SettingsField } from './SettingsField'
import { StoreAccessField } from './StoreAccessField'
import { UpgradeHint } from './UpgradeHint'

type FirstLogin = 'temporary_password' | 'password' | 'otp'

interface MemberFormValues {
  phone: string
  full_name: string
  email: string
  role_id: string
  store_ids: string[] | null
  pin: string
  first_login: FirstLogin
  password: string
  preferred_locale: Locale
}

const FIELDS = [
  'phone',
  'full_name',
  'email',
  'role_id',
  'store_ids',
  'pin',
  'first_login',
  'password',
  'preferred_locale',
]

function fromMember(m: Member | null, defaultLocale: Locale): MemberFormValues {
  return {
    phone: m?.phone ? m.phone.replace(/^\+91/, '') : '',
    full_name: m?.full_name ?? '',
    email: m?.email ?? '',
    role_id: m?.role_id ?? '',
    store_ids: m ? m.store_ids : null,
    pin: '',
    first_login: 'temporary_password',
    password: '',
    preferred_locale: m?.preferred_locale ?? defaultLocale,
  }
}

function createBody(v: MemberFormValues): MemberCreate {
  return {
    phone: v.phone.trim(),
    full_name: v.full_name.trim(),
    email: textOrNull(v.email),
    role_id: v.role_id,
    store_ids: v.store_ids,
    ...(v.pin ? { pin: v.pin } : {}),
    first_login: v.first_login,
    ...(v.first_login === 'password' ? { password: v.password } : {}),
    preferred_locale: v.preferred_locale,
  }
}

function updateBody(v: MemberFormValues): {
  full_name: string
  email: string | null
  role_id: string
  store_ids: string[] | null
  preferred_locale: Locale
  [key: string]: unknown
} {
  return {
    full_name: v.full_name.trim(),
    email: textOrNull(v.email),
    role_id: v.role_id,
    store_ids: v.store_ids,
    preferred_locale: v.preferred_locale,
  }
}

export function MemberFormDialog({
  open,
  onOpenChange,
  member,
  onInvited,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null = invite a new member. */
  member: Member | null
  onInvited?: (result: MemberCreateResult) => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const me = useAuth((s) => s.me)
  const permissions = useAuth((s) => s.permissions)
  const mode = useAuth((s) => s.me?.mode ?? s.deployment.mode)
  const iAmOwner = me?.membership.role_code === 'owner'
  const editing = member !== null
  const defaultLocale = me?.tenant.default_locale ?? 'ta'
  const roles = useRoles({ limit: 200 })
  const [block, setBlock] = useState<PlanBlock | null>(null)
  const form = useForm<MemberFormValues>({
    defaultValues: fromMember(member, defaultLocale),
    resolver: contractResolver<MemberFormValues>(
      editing ? MemberUpdateSchema : MemberCreateSchema,
      editing ? updateBody : createBody,
    ),
    mode: 'onTouched',
  })
  const create = useCreateMember()
  const update = useUpdateMember()
  const saving = create.isPending || update.isPending
  const firstLogin = useWatch({ control: form.control, name: 'first_login' })
  const roleId = useWatch({ control: form.control, name: 'role_id' })

  useEffect(() => {
    if (open) {
      form.reset(fromMember(member, defaultLocale))
      setBlock(null)
    }
  }, [open, member, defaultLocale, form])

  const roleOptions = useMemo(() => {
    const list = [...(roles.data?.data ?? [])].sort(
      (a, b) => Number(b.is_system) - Number(a.is_system) || a.name.localeCompare(b.name),
    )
    return list.map((r) => {
      const allowed = canAssignRole(r, permissions, iAmOwner)
      return {
        value: r.id,
        label: roleLabel(r.name, r.name_ta),
        description: allowed.ok
          ? (r.description ?? undefined)
          : t(`users.role_not_allowed_${allowed.reason}`),
        disabled: !allowed.ok && r.id !== member?.role_id,
      }
    })
  }, [roles.data, permissions, iAmOwner, member, t])

  // Default role for invites: cashier when available.
  useEffect(() => {
    if (!open || editing || form.getValues('role_id')) return
    const cashier = roles.data?.data.find((r) => r.code === 'cashier')
    if (cashier) form.setValue('role_id', cashier.id)
  }, [open, editing, roles.data, form])

  const handleError = (error: unknown): void => {
    const plan = planBlockOf(error)
    if (plan) {
      setBlock(plan)
      return
    }
    const reason = errorReason(error)
    if (reason === 'already_member' || reason === 'account_disabled') {
      form.setError('phone', { type: 'server', message: reasonText(error) ?? reason })
      return
    }
    if (reason === 'email_taken') {
      form.setError('email', { type: 'server', message: reasonText(error) ?? reason })
      return
    }
    if (reason === 'sms_not_configured') {
      form.setError('first_login', { type: 'server', message: reasonText(error) ?? reason })
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
      if (!member) {
        const res = await create.mutateAsync({ body: createBody(values) })
        onOpenChange(false)
        onInvited?.(res.data)
        return
      }
      const diff = changedTopLevel(
        updateBody(fromMember(member, defaultLocale)),
        updateBody(values),
      )
      if (!diff) {
        onOpenChange(false)
        return
      }
      await update.mutateAsync({
        params: { id: member.id },
        body: { ...(diff as MemberUpdate), if_updated_at: member.updated_at },
      })
      notify.success(t('users.saved', { name: values.full_name.trim() }))
      onOpenChange(false)
    } catch (error) {
      handleError(error)
    }
  })

  const selectedRole = roles.data?.data.find((r) => r.id === roleId)
  const firstLoginOptions = [
    {
      value: 'temporary_password' as const,
      label: t('users.first_login_temporary'),
      description: t('users.first_login_temporary_hint'),
    },
    {
      value: 'password' as const,
      label: t('users.first_login_password'),
      description: t('users.first_login_password_hint'),
    },
    ...(mode === 'cloud'
      ? [
          {
            value: 'otp' as const,
            label: t('users.first_login_otp'),
            description: t('users.first_login_otp_hint'),
          },
        ]
      : []),
  ]

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !saving && onOpenChange(o)}
      title={editing ? t('users.edit_title', { name: member.full_name }) : t('users.invite_title')}
      description={editing ? undefined : t('users.invite_description')}
      size="lg"
      dismissible={!form.formState.isDirty}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" form="member-form" loading={saving}>
            {editing ? t('common:actions.save_changes') : t('users.invite_action')}
          </Button>
        </>
      }
    >
      <FormProvider {...form}>
        <form
          id="member-form"
          onSubmit={(e) => void submit(e)}
          noValidate
          className="flex flex-col gap-4"
        >
          {block ? <UpgradeHint block={block} /> : null}
          <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
            <SettingsField
              name="phone"
              label={t('common:fields.phone')}
              hint={editing ? t('users.phone_locked') : t('users.phone_hint')}
              required
            >
              <Input
                {...form.register('phone')}
                inputMode="tel"
                autoComplete="off"
                placeholder="98765 43210"
                disabled={editing}
                autoFocus={!editing}
                startAdornment={<span className="text-sm text-muted-foreground">+91</span>}
              />
            </SettingsField>
            <SettingsField name="full_name" label={t('users.full_name')} required>
              <Input {...form.register('full_name')} autoComplete="off" />
            </SettingsField>
          </div>
          <SettingsField name="role_id" label={t('users.role')} required>
            <Controller<MemberFormValues, 'role_id'>
              name="role_id"
              render={({ field }) => (
                <Select
                  value={field.value || null}
                  onValueChange={field.onChange}
                  options={roleOptions}
                  placeholder={t('users.role_placeholder')}
                  disabled={editing && member.is_self}
                />
              )}
            />
          </SettingsField>
          {selectedRole && editing && member.is_self ? (
            <p className="-mt-2 text-xs text-muted-foreground">{t('users.own_role_locked')}</p>
          ) : null}
          <SettingsField name="store_ids" label={t('users.store_access')}>
            <Controller<MemberFormValues, 'store_ids'>
              name="store_ids"
              render={({ field }) => (
                <StoreAccessField value={field.value} onChange={field.onChange} />
              )}
            />
          </SettingsField>
          <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
            <SettingsField name="email" label={t('common:fields.email')} optional>
              <Input
                {...form.register('email')}
                type="email"
                inputMode="email"
                autoComplete="off"
              />
            </SettingsField>
            <SettingsField name="preferred_locale" label={t('users.language')}>
              <Controller<MemberFormValues, 'preferred_locale'>
                name="preferred_locale"
                render={({ field }) => (
                  <Select
                    value={field.value}
                    onValueChange={field.onChange}
                    options={[
                      { value: 'ta', label: 'தமிழ்' },
                      { value: 'en', label: 'English' },
                    ]}
                  />
                )}
              />
            </SettingsField>
          </div>
          {!editing ? (
            <>
              <SettingsField name="pin" label={t('users.pin')} hint={t('users.pin_hint')} optional>
                <Controller<MemberFormValues, 'pin'>
                  name="pin"
                  render={({ field }) => (
                    <Input
                      value={field.value}
                      onChange={(e) => field.onChange(digitsOnly(e.target.value, 6))}
                      onBlur={field.onBlur}
                      type="password"
                      inputMode="numeric"
                      autoComplete="new-password"
                      maxLength={6}
                      className="max-w-40 tracking-[0.4em]"
                      placeholder="••••"
                    />
                  )}
                />
              </SettingsField>
              <SettingsField name="first_login" label={t('users.first_login')}>
                <Controller<MemberFormValues, 'first_login'>
                  name="first_login"
                  render={({ field }) => (
                    <RadioGroup<FirstLogin>
                      variant="cards"
                      value={field.value}
                      onValueChange={field.onChange}
                      options={firstLoginOptions}
                    />
                  )}
                />
              </SettingsField>
              {firstLogin === 'password' ? (
                <SettingsField
                  name="password"
                  label={t('users.password')}
                  hint={t('users.password_hint')}
                  required
                >
                  <Input
                    {...form.register('password')}
                    type="password"
                    autoComplete="new-password"
                  />
                </SettingsField>
              ) : null}
            </>
          ) : null}
        </form>
      </FormProvider>
    </Dialog>
  )
}
