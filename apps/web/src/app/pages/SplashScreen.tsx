import { useTranslation } from 'react-i18next'
import { Spinner } from '@/components/ui'
import { BrandMark } from '../layout/BrandMark'

/** Shown while the session is being restored on start-up. */
export function SplashScreen() {
  const { t } = useTranslation('auth')
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-5 bg-background">
      <BrandMark size="lg" />
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner size="sm" label="" />
        {t('session.checking')}
      </div>
    </div>
  )
}
