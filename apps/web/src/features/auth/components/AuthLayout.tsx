import { BadgeIndianRupee, BookOpenCheck, PackageSearch, QrCode, ShieldCheck } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { BrandMark } from '@/app/layout/BrandMark'
import { LanguageToggle } from '@/app/layout/LanguageToggle'
import { cn } from '@/lib/cn'

export interface AuthLayoutProps {
  title: ReactNode
  subtitle?: ReactNode
  children: ReactNode
  footer?: ReactNode
  /** Wider form column (signup / setup wizard). */
  wide?: boolean
}

/** Split screen: brand panel (lg+) and the form card; language toggle always visible. */
export function AuthLayout({ title, subtitle, children, footer, wide }: AuthLayoutProps) {
  const { t } = useTranslation('auth')
  const features = [
    { icon: BadgeIndianRupee, text: t('brand.feature_billing') },
    { icon: BookOpenCheck, text: t('brand.feature_khata') },
    { icon: QrCode, text: t('brand.feature_upi') },
    { icon: PackageSearch, text: t('brand.feature_stock') },
  ]
  return (
    <div className="flex min-h-dvh bg-background">
      <aside className="relative hidden w-[44%] max-w-2xl flex-col justify-between overflow-hidden bg-gradient-to-br from-primary-600 via-primary-700 to-primary-900 p-10 text-white lg:flex xl:p-14">
        {/* Decorative kolam-like dots pattern */}
        <svg className="pointer-events-none absolute -end-24 -top-24 size-[28rem] opacity-[0.12]" viewBox="0 0 200 200" aria-hidden>
          {Array.from({ length: 10 }, (_, r) =>
            Array.from({ length: 10 }, (_, c) => (
              <circle key={`${r}-${c}`} cx={10 + c * 20} cy={10 + r * 20} r={(r + c) % 3 === 0 ? 3 : 1.6} fill="white" />
            )),
          )}
        </svg>
        <div className="relative">
          <BrandMark size="lg" inverted />
        </div>
        <div className="relative flex flex-col gap-8">
          <div className="flex flex-col gap-4">
            <h2 className="text-3xl font-bold leading-tight xl:text-4xl">{t('brand.headline')}</h2>
            <p className="max-w-md text-base text-primary-100">{t('brand.subline')}</p>
          </div>
          <ul className="grid gap-4">
            {features.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-white/12 ring-1 ring-white/20">
                  <Icon className="size-5 text-accent-300" />
                </span>
                <span className="text-[15px] font-medium text-white/95">{text}</span>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative flex items-center gap-2 text-sm text-primary-100">
          <ShieldCheck className="size-4 shrink-0" />
          {t('brand.trust')}
        </p>
      </aside>

      <main className="flex flex-1 flex-col">
        <div className="flex items-center justify-between px-4 py-4 sm:px-8">
          <BrandMark size="sm" className="lg:invisible" />
          <LanguageToggle />
        </div>
        <div className="flex flex-1 items-start justify-center px-4 pb-10 pt-2 sm:items-center sm:px-8">
          <div className={cn('w-full', wide ? 'max-w-2xl' : 'max-w-md')}>
            <div className="mb-6 flex flex-col gap-1.5">
              <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">{title}</h1>
              {subtitle ? <p className="text-[15px] text-muted-foreground">{subtitle}</p> : null}
            </div>
            {children}
            {footer ? <div className="mt-8 text-center text-sm text-muted-foreground">{footer}</div> : null}
          </div>
        </div>
      </main>
    </div>
  )
}
