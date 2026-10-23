/**
 * Customer-facing display (/pos/display): a second window on a monitor / tablet turned towards
 * the customer. It receives the cart, totals, the UPI QR and the thank-you screen from the POS
 * window over BroadcastChannel (same browser, works offline). Large Tamil-first typography.
 */
import { CheckCircle2, QrCode, ShoppingBag, XCircle } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BrandMark } from '@/app/layout/BrandMark'
import { cn } from '@/lib/cn'
import { type DisplayBranding, type DisplayCart, openDisplayChannel } from '@/lib/display-channel'
import { formatMoney, formatQty } from '@/lib/format'
import { getLanguage } from '@/lib/i18n'
import { type DisplayScreen, THANK_YOU_MS, nextScreen } from '../lib/display'
import { qrSvg } from '../print/qr'

function Names({
  name,
  nameTa,
  className,
}: {
  name: string
  nameTa: string | null
  className?: string
}) {
  const ta = getLanguage() === 'ta'
  const primary = ta && nameTa ? nameTa : name
  const secondary = nameTa && nameTa !== name ? (ta ? name : nameTa) : null
  return (
    <div className={cn('min-w-0', className)}>
      <div className="truncate font-semibold">{primary}</div>
      {secondary ? (
        <div className="truncate text-base text-muted-foreground">{secondary}</div>
      ) : null}
    </div>
  )
}

function CartView({ cart }: { cart: DisplayCart }) {
  const { t } = useTranslation('pos')
  const lines = cart.lines.slice(-8)
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
      <ul
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden"
        aria-label={t('display.items')}
      >
        {cart.lines.length > lines.length ? (
          <li className="text-center text-base text-muted-foreground">
            {t('display.more_items', { count: cart.lines.length - lines.length })}
          </li>
        ) : null}
        {lines.map((l) => (
          <li
            key={l.key}
            className="flex items-center gap-4 rounded-2xl bg-surface px-5 py-3 text-xl shadow-card"
          >
            <Names name={l.name} nameTa={l.name_ta} className="flex-1" />
            <span className="whitespace-nowrap text-lg text-muted-foreground tabular-nums">
              {formatQty(l.qty_milli, l.unit)} × {formatMoney(l.unit_price_paise)}
            </span>
            <span className="w-36 text-end text-2xl font-bold tabular-nums">
              {formatMoney(l.total_paise)}
            </span>
          </li>
        ))}
      </ul>
      <div className="flex flex-col justify-end gap-3 rounded-3xl bg-primary p-6 text-primary-foreground lg:w-[26rem]">
        {cart.customer_name ? (
          <div className="text-xl">{t('display.welcome_name', { name: cart.customer_name })}</div>
        ) : null}
        <div className="flex justify-between text-xl">
          <span>{t('display.items_count', { count: cart.item_count })}</span>
          {cart.discount_paise > 0 ? <span>−{formatMoney(cart.discount_paise)}</span> : null}
        </div>
        {cart.mrp_savings_paise > 0 ? (
          <div className="rounded-xl bg-white/15 px-4 py-2 text-center text-2xl font-bold">
            {t('totals.you_saved', { amount: formatMoney(cart.mrp_savings_paise) })}
          </div>
        ) : null}
        <div className="text-lg opacity-90">{t('display.to_pay')}</div>
        <div className="text-7xl font-extrabold tabular-nums tracking-tight">
          {formatMoney(cart.total_paise)}
        </div>
      </div>
    </div>
  )
}

export default function CustomerDisplayPage() {
  const { t } = useTranslation('pos')
  const [screen, setScreen] = useState<DisplayScreen>({ kind: 'idle' })
  const [branding, setBranding] = useState<DisplayBranding | null>(null)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    const channel = openDisplayChannel()
    const off = channel.subscribe((m) => {
      setConnected(true)
      if (m.type === 'branding') setBranding(m.branding)
      else setScreen((s) => nextScreen(s, m))
    })
    channel.send({ type: 'hello', role: 'display' })
    return () => {
      off()
      channel.close()
    }
  }, [])

  // The thank-you screen goes back to the welcome screen after a while.
  useEffect(() => {
    if (screen.kind !== 'thanks') return
    const timer = setTimeout(() => setScreen({ kind: 'idle' }), THANK_YOU_MS)
    return () => clearTimeout(timer)
  }, [screen])

  useEffect(() => {
    document.title = branding?.store_name ?? t('display.title')
  }, [branding, t])

  const qr = useMemo(
    () =>
      screen.kind === 'upi'
        ? qrSvg(screen.uri, { size: '100%', title: t('display.scan_to_pay') })
        : null,
    [screen, t],
  )
  const shop = branding
    ? getLanguage() === 'ta' && branding.store_name_ta
      ? branding.store_name_ta
      : branding.store_name
    : null

  return (
    <div className="flex h-dvh flex-col gap-6 overflow-hidden bg-background p-6 font-tamil text-foreground lg:p-10">
      <header className="flex items-center gap-4">
        {branding?.logo_url ? (
          <img src={branding.logo_url} alt="" className="h-14 w-auto object-contain" />
        ) : (
          <BrandMark size="lg" withName={false} />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-3xl font-bold">{shop ?? t('display.title')}</div>
          {branding?.store_name_ta && branding.store_name_ta !== branding.store_name ? (
            <div className="truncate text-lg text-muted-foreground">
              {getLanguage() === 'ta' ? branding.store_name : branding.store_name_ta}
            </div>
          ) : null}
        </div>
        {!connected ? (
          <span className="text-sm text-muted-foreground">{t('display.waiting')}</span>
        ) : null}
      </header>

      {screen.kind === 'idle' ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
          <ShoppingBag className="size-24 text-primary" aria-hidden />
          <div className="text-5xl font-bold">{t('display.welcome')}</div>
          <div className="text-2xl text-muted-foreground">{t('display.welcome_sub')}</div>
        </div>
      ) : screen.kind === 'cart' ? (
        <CartView cart={screen.cart} />
      ) : screen.kind === 'upi' ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-6 lg:flex-row lg:gap-16">
          <div
            className="aspect-square w-[min(60vh,80vw)] rounded-3xl bg-white p-4 shadow-overlay"
            dangerouslySetInnerHTML={{ __html: qr ?? '' }}
          />
          <div className="flex flex-col items-center gap-3 text-center lg:items-start lg:text-start">
            <QrCode className="size-12 text-primary" aria-hidden />
            <div className="text-4xl font-bold">{t('display.scan_to_pay')}</div>
            <div className="text-7xl font-extrabold tabular-nums">
              {formatMoney(screen.amount_paise)}
            </div>
            <div className="text-2xl text-muted-foreground">{screen.payee}</div>
            <div className="text-lg text-muted-foreground">{t('display.any_upi_app')}</div>
          </div>
        </div>
      ) : screen.kind === 'status' ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
          {screen.status === 'paid' ? (
            <>
              <CheckCircle2 className="size-28 text-success" aria-hidden />
              <div className="text-5xl font-bold text-success">{t('display.payment_received')}</div>
            </>
          ) : screen.status === 'pending' ? (
            <div className="text-4xl font-bold">{t('display.waiting_payment')}</div>
          ) : (
            <>
              <XCircle className="size-24 text-danger" aria-hidden />
              <div className="text-4xl font-bold">{t('display.payment_not_done')}</div>
            </>
          )}
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-5 text-center">
          <CheckCircle2 className="size-28 text-success" aria-hidden />
          <div className="text-6xl font-bold">{t('display.thank_you')}</div>
          <div className="text-3xl text-muted-foreground">{t('display.visit_again')}</div>
          <div className="mt-4 grid grid-cols-2 gap-x-10 gap-y-2 text-2xl">
            <span className="text-muted-foreground">{t('display.bill_total')}</span>
            <span className="text-end font-bold tabular-nums">
              {formatMoney(screen.total_paise)}
            </span>
            {screen.change_paise > 0 ? (
              <>
                <span className="text-muted-foreground">{t('display.change')}</span>
                <span className="text-end text-4xl font-extrabold tabular-nums text-success">
                  {formatMoney(screen.change_paise)}
                </span>
              </>
            ) : null}
          </div>
          {screen.number ? (
            <div className="font-mono text-xl text-muted-foreground">{screen.number}</div>
          ) : null}
        </div>
      )}
    </div>
  )
}
