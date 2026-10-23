/**
 * Admin security actions on a member:
 *  - Reset PIN: set a new 4–6 digit POS PIN (clears a PIN lock) or remove the PIN.
 *  - Reset password: generate a temporary password (shown once by the caller) or set one;
 *    signs the member out everywhere for this business. Needs no SMS (works on-prem).
 */
import { KeyRound } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PasswordSchema, PinSchema } from '@kadai/shared/api/auth'
import type { Member, ResetPasswordResult } from '@kadai/shared/api/identity'
import { Button, Dialog, FormField, Input, RadioGroup, notify } from '@/components/ui'
import { isApiError } from '@/lib/api'
import { formatDateTime } from '@/lib/format'
import { localizeValidationMessage } from '@/lib/validation'
import { useResetPassword, useResetPin } from '../api'
import { digitsOnly } from '../lib/forms'
import { notifySettingsError, useValidationKeyText } from '../lib/messages'

export function ResetPinDialog({
  open,
  onOpenChange,
  member,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  member: Member | null
}) {
  const { t } = useTranslation(['settings', 'common', 'errors'])
  const keyText = useValidationKeyText()
  const reset = useResetPin()
  const [pin, setPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setPin('')
      setConfirmPin('')
      setError(null)
    }
  }, [open])

  if (!member) return null
  const locked = member.pin_locked_until !== null && new Date(member.pin_locked_until) > new Date()

  const save = async (value: string | null): Promise<void> => {
    if (value !== null) {
      if (!PinSchema.safeParse(value).success) {
        setError(t('errors:validation.pin'))
        return
      }
      if (value !== confirmPin) {
        setError(t('users.pin_mismatch'))
        return
      }
    }
    try {
      await reset.mutateAsync({ params: { id: member.id }, body: { pin: value } })
      notify.success(
        value === null
          ? t('users.pin_removed', { name: member.full_name })
          : t('users.pin_set', { name: member.full_name }),
      )
      onOpenChange(false)
    } catch (e) {
      const issue = isApiError(e) ? e.validationIssues.find((i) => i.path === 'pin') : undefined
      if (issue) {
        setError(
          keyText(issue.message) ?? localizeValidationMessage(issue.message) ?? issue.message,
        )
        return
      }
      notifySettingsError(e)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !reset.isPending && onOpenChange(o)}
      title={t('users.pin_title', { name: member.full_name })}
      description={t('users.pin_description')}
      footer={
        <>
          {member.has_pin ? (
            <Button
              variant="ghost"
              className="me-auto text-danger"
              onClick={() => void save(null)}
              disabled={reset.isPending}
            >
              {t('users.pin_remove')}
            </Button>
          ) : null}
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={reset.isPending}>
            {t('common:actions.cancel')}
          </Button>
          <Button loading={reset.isPending} onClick={() => void save(pin)}>
            {t('users.pin_save')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          void save(pin)
        }}
      >
        {locked ? (
          <p className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning-soft-foreground">
            {t('users.pin_locked_note', { until: formatDateTime(member.pin_locked_until) })}
          </p>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={t('users.new_pin')} error={error} required>
            <Input
              value={pin}
              onChange={(e) => {
                setPin(digitsOnly(e.target.value, 6))
                setError(null)
              }}
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              maxLength={6}
              autoFocus
              className="tracking-[0.4em]"
            />
          </FormField>
          <FormField label={t('users.confirm_pin')} required>
            <Input
              value={confirmPin}
              onChange={(e) => {
                setConfirmPin(digitsOnly(e.target.value, 6))
                setError(null)
              }}
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              maxLength={6}
              className="tracking-[0.4em]"
            />
          </FormField>
        </div>
        <p className="text-xs text-muted-foreground">{t('users.pin_rules')}</p>
        <button type="submit" className="sr-only" tabIndex={-1} aria-hidden>
          {t('users.pin_save')}
        </button>
      </form>
    </Dialog>
  )
}

export function ResetPasswordDialog({
  open,
  onOpenChange,
  member,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  member: Member | null
  onDone: (result: ResetPasswordResult) => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const reset = useResetPassword()
  const [mode, setMode] = useState<'generate' | 'set'>('generate')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setMode('generate')
      setPassword('')
      setError(null)
    }
  }, [open])

  if (!member) return null

  const save = async (): Promise<void> => {
    if (mode === 'set') {
      const parsed = PasswordSchema.safeParse(password)
      if (!parsed.success) {
        setError(localizeValidationMessage(parsed.error.issues[0]?.message) ?? null)
        return
      }
    }
    try {
      const res = await reset.mutateAsync({
        params: { id: member.id },
        body: mode === 'set' ? { password } : {},
      })
      onOpenChange(false)
      if (res.data.temporary_password === null)
        notify.success(t('users.password_set', { name: member.full_name }))
      onDone(res.data)
    } catch (e) {
      const issue = isApiError(e)
        ? e.validationIssues.find((i) => i.path === 'password')
        : undefined
      if (issue) {
        setError(localizeValidationMessage(issue.message) ?? issue.message)
        return
      }
      notifySettingsError(e)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !reset.isPending && onOpenChange(o)}
      title={t('users.password_title', { name: member.full_name })}
      description={t('users.password_description')}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={reset.isPending}>
            {t('common:actions.cancel')}
          </Button>
          <Button leftIcon={<KeyRound />} loading={reset.isPending} onClick={() => void save()}>
            {t('users.password_reset_action')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <RadioGroup<'generate' | 'set'>
          variant="cards"
          value={mode}
          onValueChange={setMode}
          options={[
            {
              value: 'generate',
              label: t('users.password_generate'),
              description: t('users.password_generate_hint'),
            },
            {
              value: 'set',
              label: t('users.password_choose'),
              description: t('users.password_choose_hint'),
            },
          ]}
        />
        {mode === 'set' ? (
          <FormField
            label={t('users.password')}
            hint={t('users.password_hint')}
            error={error}
            required
          >
            <Input
              value={password}
              onChange={(e) => {
                setPassword(e.target.value)
                setError(null)
              }}
              type="password"
              autoComplete="new-password"
              autoFocus
            />
          </FormField>
        ) : null}
      </div>
    </Dialog>
  )
}
