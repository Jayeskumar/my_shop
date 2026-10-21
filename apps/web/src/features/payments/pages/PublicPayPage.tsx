/**
 * Public pay page for a dues link (/pay/:code, no sign-in): GET /public/v1/pay/:referenceCode
 * gives the shop, amount and status. While payable: a big "Pay with UPI" deep-link button (opens
 * the customer's UPI app on a phone), the same link as a QR (for paying from another phone /
 * a desktop browser) and the provider's hosted page when there is one. The page refreshes
 * itself until the payment is confirmed. Tamil / English toggle; no internal ids are shown.
 */
import { CheckCircle2, Clock, Hourglass, Smartphone, XCircle } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router'
import { paymentsRoutes, type PublicPayPage as PayPageModel } from '@kadai/shared/api/payments'
import { LanguageToggle } from '@/app/layout/LanguageToggle'
import { Avatar, Button, Card, PhoneLink, Skeleton } from '@/components/ui'
import { isApiError } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatDateTime, formatMoney } from '@/lib/format'
import { useRouteQuery } from '@/lib/query'
import { useBreakpoint } from '@/lib/use-media-query'
import { QrCode } from '../components/QrCode'

const CODE_RE = /^[0-9A-Z]{12}$/

export default function PublicPayPage() {
  const { t } = useTranslation(['payments', 'common'])
  const params = useParams()
  const code = (params.code ?? '').trim().toUpperCase()
  const valid = CODE_RE.test(code)
  const [tapped, setTapped] = useState(false)
  const query = useRouteQuery(
    paymentsRoutes.publicPayPage,
    { params: { referenceCode: code } },
    {
      enabled: valid,
      meta: { errorToast: false },
      retry: (count, error) => !(isApiError(error) && error.status === 404) && count < 2,
      refetchInterval: (q) => {
        const status = q.state.data?.data.status
        return status === 'pending' || status === 'created' ? (tapped ? 4_000 : 10_000) : false
      },
      refetchOnWindowFocus: true,
    },
  )
  const page = query.data?.data ?? null

  useEffect(() => {
    if (page?.shop.name) document.title = `${t('pay_page.title')} · ${page.shop.name}`
  }, [page?.shop.name, t])

  return (
    <div className="flex min-h-dvh flex-col items-center bg-surface-2 px-4 py-4 sm:py-8">
      <div className="flex w-full max-w-md justify-end pb-3">
        <LanguageToggle />
      </div>
      <main className="w-full max-w-md">
        {!valid || (query.isError && isApiError(query.error) && query.error.status === 404) ? (
          <Message
            icon={<XCircle className="size-12 text-danger" aria-hidden />}
            title={t('pay_page.not_found')}
            text={t('pay_page.not_found_hint')}
          />
        ) : query.isError ? (
          <Message
            icon={<XCircle className="size-12 text-danger" aria-hidden />}
            title={t('pay_page.load_failed')}
            text={t('pay_page.load_failed_hint')}
            action={
              <Button onClick={() => void query.refetch()}>{t('common:actions.retry')}</Button>
            }
          />
        ) : !page ? (
          <Card className="grid gap-4 p-6" aria-busy>
            <Skeleton className="mx-auto size-14 rounded-full" />
            <Skeleton className="mx-auto h-6 w-48" />
            <Skeleton className="mx-auto h-10 w-40" />
            <Skeleton className="h-14 w-full" />
          </Card>
        ) : (
          <PayCard page={page} onTap={() => setTapped(true)} tapped={tapped} />
        )}
        <p className="mt-6 text-center text-xs text-muted-foreground">{t('pay_page.powered_by')}</p>
      </main>
    </div>
  )
}

function PayCard({
  page,
  tapped,
  onTap,
}: {
  page: PayPageModel
  tapped: boolean
  onTap: () => void
}) {
  const { t, i18n } = useTranslation(['payments', 'common'])
  const desktop = useBreakpoint('md')
  const shopName = i18n.language === 'ta' && page.shop.name_ta ? page.shop.name_ta : page.shop.name
  const otherName =
    page.shop.name_ta && page.shop.name_ta !== page.shop.name
      ? i18n.language === 'ta'
        ? page.shop.name
        : page.shop.name_ta
      : null
  const payable = (page.status === 'pending' || page.status === 'created') && Boolean(page.upi_uri ?? page.short_url)
  const amount = formatMoney(page.amount_paise)

  return (
    <Card className="grid gap-5 p-5 text-center sm:p-6">
      <header className="flex flex-col items-center gap-2">
        {page.shop.logo_url ? (
          <img
            src={page.shop.logo_url}
            alt=""
            className="size-16 rounded-full border border-border object-cover"
          />
        ) : (
          <Avatar name={page.shop.name} size="xl" />
        )}
        <div>
          <h1 className="text-xl font-bold leading-tight">{shopName}</h1>
          {otherName ? <p className="text-sm text-muted-foreground">{otherName}</p> : null}
          {page.shop.city ? <p className="text-sm text-muted-foreground">{page.shop.city}</p> : null}
        </div>
      </header>

      <div>
        {page.customer_first_name ? (
          <p className="text-sm">{t('pay_page.greeting', { name: page.customer_first_name })}</p>
        ) : null}
        <p className="text-sm text-muted-foreground">{t(`pay_page.purpose.${page.purpose}`)}</p>
        <p className="mt-1 text-4xl font-bold tabular-nums" data-testid="pay-amount">
          {amount}
        </p>
      </div>

      {page.status === 'paid' ? (
        <div className="flex flex-col items-center gap-2" role="status">
          <div className="flex size-24 items-center justify-center rounded-full bg-success-soft motion-safe:animate-zoom-in">
            <CheckCircle2 className="size-14 text-success" aria-hidden />
          </div>
          <p className="text-lg font-semibold text-success">{t('pay_page.paid_title')}</p>
          {page.paid_at ? (
            <p className="text-sm text-muted-foreground">
              {t('pay_page.paid_on', { date: formatDateTime(page.paid_at) })}
            </p>
          ) : null}
          <p className="text-sm">{t('pay_page.thanks')}</p>
        </div>
      ) : payable ? (
        <div className={cn('flex flex-col gap-4', desktop && 'flex-col-reverse')}>
          <div className="grid gap-2">
            {page.upi_uri ? (
              <Button asChild size="xl" fullWidth leftIcon={<Smartphone />}>
                <a href={page.upi_uri} onClick={onTap}>
                  {t('pay_page.pay_upi', { amount })}
                </a>
              </Button>
            ) : null}
            {page.short_url ? (
              <Button asChild size="lg" variant={page.upi_uri ? 'outline' : 'primary'} fullWidth>
                <a href={page.short_url} target="_blank" rel="noopener noreferrer" onClick={onTap}>
                  {t('pay_page.pay_online')}
                </a>
              </Button>
            ) : null}
            {tapped ? (
              <p className="text-sm text-muted-foreground" role="status">
                {t('pay_page.after_pay')}
              </p>
            ) : null}
          </div>
          {page.upi_uri ? (
            <div className="flex flex-col items-center gap-2">
              <p className="text-sm text-muted-foreground">
                {desktop ? t('pay_page.scan_desktop') : t('pay_page.scan_other_phone')}
              </p>
              <QrCode
                value={page.upi_uri}
                label={t('qr.qr_label', { amount })}
                className="w-52 border border-border p-1"
              />
            </div>
          ) : null}
          {page.expires_at ? (
            <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
              <Clock className="size-3.5" aria-hidden />
              {t('pay_page.valid_till', { date: formatDateTime(page.expires_at) })}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2" role="status">
          {page.status === 'expired' ? (
            <Hourglass className="size-12 text-muted-foreground" aria-hidden />
          ) : (
            <XCircle className="size-12 text-danger" aria-hidden />
          )}
          <p className="text-lg font-semibold">
            {t(
              page.status === 'failed'
                ? 'pay_page.failed_title'
                : page.status === 'cancelled'
                  ? 'pay_page.cancelled_title'
                  : 'pay_page.expired_title',
            )}
          </p>
          <p className="text-sm text-muted-foreground">{t('pay_page.contact_shop')}</p>
        </div>
      )}

      <footer className="grid gap-1 border-t border-border pt-4 text-sm">
        <p>
          {t('pay_page.payee')}: <span className="font-medium">{page.payee.name}</span>
        </p>
        {page.payee.vpa ? <p className="font-mono text-xs text-muted-foreground">{page.payee.vpa}</p> : null}
        {page.shop.phone ? (
          <div className="flex justify-center">
            <PhoneLink phone={page.shop.phone} />
          </div>
        ) : null}
      </footer>
    </Card>
  )
}

function Message({
  icon,
  title,
  text,
  action,
}: {
  icon: ReactNode
  title: string
  text: string
  action?: ReactNode
}) {
  return (
    <Card className="flex flex-col items-center gap-3 p-6 text-center" role="alert">
      {icon}
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="text-sm text-muted-foreground">{text}</p>
      {action}
    </Card>
  )
}
