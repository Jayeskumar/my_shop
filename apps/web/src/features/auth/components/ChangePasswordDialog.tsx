import { zodResolver } from '@hookform/resolvers/zod'
import { FormProvider, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'
import { PasswordChangeRequestSchema } from '@kadai/shared/api/auth'
import { Button, Dialog, FormField, notify } from '@/components/ui'
import { isApiError } from '@/lib/api'
import { validationToken } from '@/lib/validation'
import { useChangePassword } from '../api'
import { applyServerFieldErrors } from '@/lib/form-errors'
import { PasswordInput } from './PasswordInput'

const FormSchema = PasswordChangeRequestSchema.and(
  z.object({ confirm_password: z.string() }),
).refine((v) => v.new_password === v.confirm_password, {
  path: ['confirm_password'],
  message: validationToken('password_mismatch'),
})
type FormInput = z.input<typeof FormSchema>
type FormOutput = z.output<typeof FormSchema>

export interface ChangePasswordDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** POST /auth/password/change. */
export function ChangePasswordDialog({ open, onOpenChange }: ChangePasswordDialogProps) {
  const { t } = useTranslation(['auth', 'common'])
  const mutation = useChangePassword()
  const form = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(FormSchema),
    defaultValues: { current_password: '', new_password: '', confirm_password: '' },
    mode: 'onTouched',
  })

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await mutation.mutateAsync({
        current_password: values.current_password,
        new_password: values.new_password,
      })
      notify.success(t('change_password.success'))
      form.reset()
      onOpenChange(false)
    } catch (error) {
      if (isApiError(error) && error.code === 'INVALID_CREDENTIALS') {
        form.setError('current_password', { type: 'server', message: error.code })
        notify.error(error)
        return
      }
      if (!applyServerFieldErrors(error, form.setError, ['current_password', 'new_password']))
        notify.error(error)
    }
  })

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) form.reset()
        onOpenChange(o)
      }}
      title={t('change_password.title')}
      description={t('change_password.description')}
      size="sm"
      dismissible={!mutation.isPending}
    >
      <FormProvider {...form}>
        <form id="change-password-form" onSubmit={onSubmit} className="grid gap-4 pb-2" noValidate>
          <FormField name="current_password" label={t('change_password.current')} required>
            <PasswordInput autoComplete="current-password" {...form.register('current_password')} />
          </FormField>
          <FormField
            name="new_password"
            label={t('change_password.new')}
            hint={t('signup.password_hint')}
            required
          >
            <PasswordInput autoComplete="new-password" {...form.register('new_password')} />
          </FormField>
          <FormField name="confirm_password" label={t('change_password.confirm')} required>
            <PasswordInput autoComplete="new-password" {...form.register('confirm_password')} />
          </FormField>
          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={mutation.isPending}
            >
              {t('common:actions.cancel')}
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              {t('change_password.submit')}
            </Button>
          </div>
        </form>
      </FormProvider>
    </Dialog>
  )
}
