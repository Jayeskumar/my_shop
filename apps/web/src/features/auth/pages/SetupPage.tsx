/**
 * On-prem first-run wizard (/setup): shown while GET /setup/status says setup is required.
 * Creates the single business, owner, main store and counter (POST /setup) and signs in.
 */
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation } from '@tanstack/react-query'
import { FileKey2, ServerCrash } from 'lucide-react'
import { useForm, type Resolver } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Link, Navigate, useNavigate } from 'react-router'
import { SetupRequestSchema, type SetupRequest } from '@kadai/shared/api/auth'
import { TAMIL_NADU_STATE_CODE } from '@kadai/shared/gst'
import { Button, EmptyState, PageSpinner, notify } from '@/components/ui'
import { isApiError } from '@/lib/api'
import { acceptSession, probeDeployment } from '@/lib/auth'
import { describeError } from '@/lib/errors'
import { getLanguage } from '@/lib/i18n'
import { authApi, useSetupStatus } from '../api'
import type { BusinessFormValues } from '../business-rules'
import { AuthLayout } from '../components/AuthLayout'
import { OnboardingWizard } from '../components/OnboardingWizard'

export default function SetupPage() {
  const { t } = useTranslation(['auth', 'common'])
  const navigate = useNavigate()
  const status = useSetupStatus()

  const form = useForm<BusinessFormValues, unknown, SetupRequest>({
    // The shared schema's input type is a structural subset of the wizard's form values.
    resolver: zodResolver(SetupRequestSchema) as unknown as Resolver<BusinessFormValues, unknown, SetupRequest>,
    defaultValues: {
      business_name: '',
      business_name_ta: '',
      legal_name: '',
      store_name: '',
      state_code: TAMIL_NADU_STATE_CODE,
      gstin: '',
      gst_scheme: 'unregistered',
      owner_name: '',
      phone: '',
      password: '',
      email: '',
      setup_token: '',
      locale: getLanguage(),
    },
    mode: 'onTouched',
  })

  const setup = useMutation({
    mutationFn: async (body: SetupRequest) => {
      const session = await authApi.setup(body)
      await acceptSession(session)
      void probeDeployment()
    },
    onSuccess: () => {
      notify.success(t('setup.done'))
      void navigate('/', { replace: true })
    },
    meta: { errorToast: false },
  })

  if (status.isLoading) {
    return (
      <AuthLayout title={t('setup.title')}>
        <PageSpinner label={t('setup.checking')} className="min-h-48" />
      </AuthLayout>
    )
  }

  if (status.error) {
    // Cloud deployments have no setup endpoint (404).
    if (isApiError(status.error) && status.error.status === 404) return <Navigate to="/login" replace />
    return (
      <AuthLayout title={t('setup.title')}>
        <EmptyState
          icon={<ServerCrash />}
          title={describeError(status.error).title}
          action={<Button onClick={() => void status.refetch()}>{t('common:actions.retry')}</Button>}
        />
      </AuthLayout>
    )
  }

  if (!status.data?.setup_required) {
    return (
      <AuthLayout title={t('setup.title')}>
        <EmptyState
          compact
          title={t('setup.already_done')}
          action={
            <Button asChild>
              <Link to="/login">{t('login.submit')}</Link>
            </Button>
          }
        />
      </AuthLayout>
    )
  }

  const tokenRequired = status.data.token_required
  return (
    <AuthLayout title={t('setup.title')} subtitle={t('setup.subtitle')} wide>
      <OnboardingWizard<SetupRequest>
        form={form}
        setup
        setupToken={tokenRequired}
        submitLabel={t('setup.submit')}
        submitting={setup.isPending}
        onSubmit={async (values) => {
          if (tokenRequired && !values.setup_token) {
            form.setError('setup_token', { type: 'required', message: '@kadai:required' })
            throw new Error('setup token required')
          }
          await setup.mutateAsync(values)
        }}
        onServerError={(error) => {
          if (isApiError(error) && error.code === 'SETUP_ALREADY_DONE') {
            notify.info(t('setup.already_done'))
            void status.refetch()
            return true
          }
          if (!isApiError(error) || error.code !== 'VALIDATION_ERROR') {
            if (isApiError(error)) notify.error(error)
            return true
          }
          return false
        }}
        finalNote={
          <p className="flex items-start gap-2 rounded-lg bg-info-soft p-3 text-sm text-info-soft-foreground">
            <FileKey2 className="mt-0.5 size-4 shrink-0" />
            {t('setup.license_later')}
          </p>
        }
      />
    </AuthLayout>
  )
}
