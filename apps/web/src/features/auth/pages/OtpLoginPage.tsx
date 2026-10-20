/** Sign in with a one-time code sent to the mobile number (purpose 'login'). */
import { KeyRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { safeNext } from '@/app/guards'
import { Button, notify } from '@/components/ui'
import { acceptSession } from '@/lib/auth'
import { isSessionResponse } from '../api'
import { AuthLayout } from '../components/AuthLayout'
import { OtpFlow } from '../components/OtpFlow'

export default function OtpLoginPage() {
  const { t } = useTranslation(['auth', 'errors'])
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const next = params.get('next')

  return (
    <AuthLayout
      title={t('otp.title')}
      subtitle={t('otp.subtitle')}
      footer={
        <Button asChild variant="link">
          <Link to={next ? `/login?next=${encodeURIComponent(next)}` : '/login'}>
            <KeyRound className="size-4" />
            {t('login.with_password')}
          </Link>
        </Button>
      }
    >
      <OtpFlow
        purpose="login"
        phone={params.get('phone') ?? undefined}
        onVerified={async (result) => {
          if (!isSessionResponse(result)) {
            notify.error(t('errors:client.UNKNOWN'))
            return
          }
          const status = await acceptSession(result)
          if (status === 'needs_tenant') {
            void navigate(next ? `/select-business?next=${encodeURIComponent(next)}` : '/select-business', { replace: true })
          } else {
            void navigate(safeNext(next), { replace: true })
          }
        }}
      />
    </AuthLayout>
  )
}
