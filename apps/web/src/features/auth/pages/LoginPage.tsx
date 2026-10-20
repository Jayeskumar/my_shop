/**
 * Sign in with mobile number / email + password (POST /auth/login), or switch to OTP sign-in.
 * After sign-in: one business → straight in; several → /select-business; `?next=` is honoured.
 */
import { zodResolver } from '@hookform/resolvers/zod'
import { LogIn, MessageSquareText, Smartphone } from 'lucide-react'
import { FormProvider, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { LoginRequestSchema, type LoginRequest } from '@kadai/shared/api/auth'
import { normalizeIndianPhone } from '@kadai/shared/phone'
import { safeNext } from '@/app/safe-next'
import { Button, FormField, Input, notify, Separator } from '@/components/ui'
import { isApiError } from '@/lib/api'
import { login, useDeployment } from '@/lib/auth'
import { AuthLayout } from '../components/AuthLayout'
import { PasswordInput } from '../components/PasswordInput'

type LoginInput = LoginRequest

export default function LoginPage() {
  const { t } = useTranslation(['auth', 'common'])
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const deployment = useDeployment()
  const next = params.get('next')

  const form = useForm<LoginInput>({
    resolver: zodResolver(LoginRequestSchema),
    defaultValues: { identifier: '', password: '' },
    mode: 'onTouched',
  })

  const onSubmit = form.handleSubmit(async (values) => {
    // A 10-digit mobile is sent as E.164 (+91…), an email as typed (lower-cased).
    const phone = normalizeIndianPhone(values.identifier)
    const identifier = phone ?? values.identifier.trim().toLowerCase()
    try {
      const status = await login({ identifier, password: values.password })
      if (status === 'needs_tenant') {
        void navigate(
          next ? `/select-business?next=${encodeURIComponent(next)}` : '/select-business',
          { replace: true },
        )
      } else {
        void navigate(safeNext(next), { replace: true })
      }
    } catch (error) {
      if (
        isApiError(error) &&
        (error.code === 'INVALID_CREDENTIALS' || error.code === 'ACCOUNT_LOCKED')
      ) {
        form.setError('password', { type: 'server', message: error.code })
        form.setValue('password', '')
        return
      }
      notify.error(error)
    }
  })

  const cloud = deployment.mode !== 'onprem'
  return (
    <AuthLayout
      title={t('login.title')}
      subtitle={t('login.subtitle')}
      footer={
        cloud ? (
          <>
            {t('login.no_account')}{' '}
            <Link to="/signup" className="font-semibold text-primary hover:underline">
              {t('login.create_account')}
            </Link>
          </>
        ) : null
      }
    >
      {deployment.mode === 'onprem' && deployment.setupRequired ? (
        <div className="mb-5 flex items-center justify-between gap-3 rounded-lg bg-accent-soft p-3 text-sm text-accent-soft-foreground">
          <span>{t('login.setup_pending')}</span>
          <Button asChild size="sm" variant="accent">
            <Link to="/setup">{t('login.setup_link')}</Link>
          </Button>
        </div>
      ) : null}
      <FormProvider {...form}>
        <form onSubmit={onSubmit} noValidate className="grid gap-5">
          <FormField name="identifier" label={t('login.identifier')} required>
            <Input
              size="lg"
              autoComplete="username"
              inputMode="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
              placeholder={t('login.identifier_placeholder')}
              startAdornment={<Smartphone />}
              {...form.register('identifier')}
            />
          </FormField>
          <FormField
            name="password"
            label={t('login.password')}
            required
            labelAction={
              <Link
                to="/forgot-password"
                className="text-sm font-medium text-primary hover:underline"
              >
                {t('login.forgot')}
              </Link>
            }
          >
            <PasswordInput
              size="lg"
              autoComplete="current-password"
              placeholder={t('login.password_placeholder')}
              {...form.register('password')}
            />
          </FormField>
          <Button
            type="submit"
            size="lg"
            fullWidth
            loading={form.formState.isSubmitting}
            leftIcon={<LogIn />}
          >
            {t('login.submit')}
          </Button>
        </form>
      </FormProvider>
      <div className="my-6 flex items-center gap-3">
        <Separator className="flex-1" />
        <span className="text-xs font-medium uppercase text-muted-foreground">{t('login.or')}</span>
        <Separator className="flex-1" />
      </div>
      <Button asChild variant="outline" size="lg" fullWidth>
        <Link to={next ? `/otp?next=${encodeURIComponent(next)}` : '/otp'}>
          <MessageSquareText />
          {t('login.with_otp')}
        </Link>
      </Button>
    </AuthLayout>
  )
}
