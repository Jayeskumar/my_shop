/** Password reset: OTP to the registered mobile → otp_token → new password (POST /auth/password/reset). */
import { zodResolver } from '@hookform/resolvers/zod'
import { ArrowLeft, Save } from 'lucide-react'
import { useState } from 'react'
import { FormProvider, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router'
import { z } from 'zod'
import { PasswordSchema } from '@kadai/shared/api/auth'
import { Button, FormField, notify } from '@/components/ui'
import { isApiError } from '@/lib/api'
import { validationToken } from '@/lib/validation'
import { authApi, isSessionResponse } from '../api'
import { AuthLayout } from '../components/AuthLayout'
import { OtpFlow } from '../components/OtpFlow'
import { PasswordInput } from '../components/PasswordInput'

const NewPasswordSchema = z
  .object({ new_password: PasswordSchema, confirm_password: z.string() })
  .refine((v) => v.new_password === v.confirm_password, {
    path: ['confirm_password'],
    message: validationToken('password_mismatch'),
  })
type NewPasswordForm = z.infer<typeof NewPasswordSchema>

export default function ForgotPasswordPage() {
  const { t } = useTranslation(['auth', 'common'])
  const navigate = useNavigate()
  const [otpToken, setOtpToken] = useState<string | null>(null)

  const form = useForm<NewPasswordForm>({
    resolver: zodResolver(NewPasswordSchema),
    defaultValues: { new_password: '', confirm_password: '' },
    mode: 'onTouched',
  })

  const onSubmit = form.handleSubmit(async (values) => {
    if (!otpToken) return
    try {
      await authApi.resetPassword({ otp_token: otpToken, new_password: values.new_password })
      notify.success(t('forgot.success'))
      void navigate('/login', { replace: true })
    } catch (error) {
      if (isApiError(error) && (error.code === 'OTP_EXPIRED' || error.code === 'OTP_INVALID')) {
        setOtpToken(null)
      }
      notify.error(error)
    }
  })

  const back = (
    <Link
      to="/login"
      className="inline-flex items-center gap-1.5 font-semibold text-primary hover:underline"
    >
      <ArrowLeft className="size-4 rtl:rotate-180" />
      {t('forgot.back_to_login')}
    </Link>
  )

  if (!otpToken) {
    return (
      <AuthLayout title={t('forgot.title')} subtitle={t('forgot.subtitle')} footer={back}>
        <OtpFlow
          purpose="reset_password"
          onVerified={(result) => {
            if (!isSessionResponse(result)) setOtpToken(result.otp_token)
          }}
        />
      </AuthLayout>
    )
  }

  return (
    <AuthLayout title={t('forgot.new_password_title')} footer={back}>
      <FormProvider {...form}>
        <form onSubmit={onSubmit} noValidate className="grid gap-5">
          <FormField
            name="new_password"
            label={t('forgot.new_password')}
            hint={t('signup.password_hint')}
            required
          >
            <PasswordInput
              size="lg"
              autoComplete="new-password"
              autoFocus
              {...form.register('new_password')}
            />
          </FormField>
          <FormField name="confirm_password" label={t('forgot.confirm_password')} required>
            <PasswordInput
              size="lg"
              autoComplete="new-password"
              {...form.register('confirm_password')}
            />
          </FormField>
          <Button
            type="submit"
            size="lg"
            fullWidth
            loading={form.formState.isSubmitting}
            leftIcon={<Save />}
          >
            {t('forgot.submit')}
          </Button>
        </form>
      </FormProvider>
    </AuthLayout>
  )
}
