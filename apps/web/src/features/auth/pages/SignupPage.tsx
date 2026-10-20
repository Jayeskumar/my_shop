/**
 * Cloud self-signup (POST /auth/signup): shop type → business → owner. When the server requires
 * phone verification (VALIDATION_ERROR on `otp_token`, or OTP_INVALID / OTP_EXPIRED), an OTP
 * step verifies the owner's mobile and the signup is resubmitted with the `otp_token`.
 */
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation } from '@tanstack/react-query'
import { ArrowLeft, ServerCog } from 'lucide-react'
import { useState } from 'react'
import { useForm, type Resolver } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Link, Navigate, useNavigate } from 'react-router'
import { SignupRequestSchema, type SignupRequest } from '@kadai/shared/api/auth'
import { TAMIL_NADU_STATE_CODE } from '@kadai/shared/gst'
import { Button, EmptyState, notify } from '@/components/ui'
import { isApiError } from '@/lib/api'
import { acceptSession, useDeployment } from '@/lib/auth'
import { getLanguage } from '@/lib/i18n'
import { authApi, isSessionResponse } from '../api'
import type { BusinessFormValues } from '../business-rules'
import { AuthLayout } from '../components/AuthLayout'
import { OnboardingWizard } from '../components/OnboardingWizard'
import { OtpFlow } from '../components/OtpFlow'

/** Server signals that the owner's phone must be verified first. */
function needsPhoneVerification(error: unknown): boolean {
  if (!isApiError(error)) return false
  if (error.code === 'OTP_INVALID' || error.code === 'OTP_EXPIRED') return true
  return (
    error.code === 'VALIDATION_ERROR' && error.validationIssues.some((i) => i.path === 'otp_token')
  )
}

export default function SignupPage() {
  const { t } = useTranslation(['auth', 'common'])
  const navigate = useNavigate()
  const deployment = useDeployment()
  const [verifyPhone, setVerifyPhone] = useState<SignupRequest | null>(null)

  const form = useForm<BusinessFormValues, unknown, SignupRequest>({
    // The shared schema's input type is a structural subset of the wizard's form values.
    resolver: zodResolver(SignupRequestSchema) as unknown as Resolver<
      BusinessFormValues,
      unknown,
      SignupRequest
    >,
    defaultValues: {
      business_name: '',
      business_name_ta: '',
      state_code: TAMIL_NADU_STATE_CODE,
      gstin: '',
      gst_scheme: 'unregistered',
      owner_name: '',
      phone: '',
      password: '',
      email: '',
      locale: getLanguage(),
    },
    mode: 'onTouched',
  })

  const signup = useMutation({
    mutationFn: async (body: SignupRequest) => {
      const session = await authApi.signup(body)
      await acceptSession(session)
    },
    onSuccess: () => {
      notify.success(t('signup.success'))
      void navigate('/', { replace: true })
    },
    // errors are handled by the wizard / OTP step
    meta: { errorToast: false },
  })

  if (deployment.mode === 'onprem') {
    return deployment.setupRequired ? (
      <Navigate to="/setup" replace />
    ) : (
      <AuthLayout title={t('signup.title')}>
        <EmptyState
          icon={<ServerCog />}
          title={t('signup.onprem_redirect')}
          action={
            <Button asChild>
              <Link to="/login">{t('signup.sign_in')}</Link>
            </Button>
          }
        />
      </AuthLayout>
    )
  }

  const footer = (
    <>
      {t('signup.have_account')}{' '}
      <Link to="/login" className="font-semibold text-primary hover:underline">
        {t('signup.sign_in')}
      </Link>
    </>
  )

  if (verifyPhone) {
    return (
      <AuthLayout
        title={t('signup.verify_phone_title')}
        subtitle={t('signup.verify_phone_hint')}
        footer={footer}
      >
        <div className="flex flex-col gap-4">
          <OtpFlow
            purpose="signup"
            phone={verifyPhone.phone}
            lockPhone
            autoSend
            submitLabel={t('signup.submit')}
            onVerified={async (result) => {
              if (isSessionResponse(result)) {
                await acceptSession(result)
                void navigate('/', { replace: true })
                return
              }
              try {
                await signup.mutateAsync({ ...verifyPhone, otp_token: result.otp_token })
              } catch (error) {
                notify.error(error)
                setVerifyPhone(null)
              }
            }}
          />
          <Button
            variant="ghost"
            leftIcon={<ArrowLeft className="rtl:rotate-180" />}
            onClick={() => setVerifyPhone(null)}
          >
            {t('common:actions.back')}
          </Button>
        </div>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout title={t('signup.title')} subtitle={t('signup.subtitle')} footer={footer} wide>
      <OnboardingWizard<SignupRequest>
        form={form}
        submitLabel={t('signup.submit')}
        submitting={signup.isPending}
        onSubmit={async (values) => {
          try {
            await signup.mutateAsync(values)
          } catch (error) {
            if (needsPhoneVerification(error)) {
              setVerifyPhone(values)
              return
            }
            throw error
          }
        }}
        onServerError={(error) => {
          if (isApiError(error) && (error.code === 'DUPLICATE' || error.code === 'CONFLICT')) {
            form.setError('phone', { type: 'server', message: error.code })
            notify.error(error)
            return false
          }
          if (!isApiError(error) || error.code !== 'VALIDATION_ERROR') {
            notify.error(error)
            return true
          }
          return false
        }}
        finalNote={
          <p className="text-xs leading-relaxed text-muted-foreground">{t('signup.terms')}</p>
        }
      />
    </AuthLayout>
  )
}
