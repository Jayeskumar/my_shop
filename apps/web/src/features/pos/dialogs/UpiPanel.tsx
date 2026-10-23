/**
 * UPI collection inside the payment dialog.
 *
 *  - Dynamic QR (Razorpay / mock, online): POST /payments/intents for the amount, show the QR
 *    (upi_uri or the provider's image) with a countdown, follow the status over the intent SSE
 *    stream (long-poll fallback) and add the tender automatically when paid.
 *  - The shop's own UPI ID (works offline): a QR with the amount from shared buildUpiUri; the
 *    cashier confirms "payment received" (soundbox / phone), optionally with the UTR.
 *
 * The QR is mirrored on the customer display.
 */
import { CheckCircle2, Clock, QrCode, RefreshCcw, XCircle } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  INTENT_STREAM_EVENT,
  type PaymentIntent,
  PaymentIntentSchema,
  type PaymentProviderPublic,
  isTerminalIntentStatus,
  paymentsRoutes,
} from '@kadai/shared/api/payments'
import { routeUrl } from '@kadai/shared/api/common'
import { generateReferenceCode } from '@kadai/shared/upi'
import { Badge, Button, Input, Spinner, notify } from '@/components/ui'
import { callRoute, isApiError, subscribeSse } from '@/lib/api'
import { formatMoney } from '@/lib/format'
import { dynamicUpiProvider, staticUpiProvider, staticUpiUri } from '../lib/upi'
import { qrSvg } from '../print/qr'
import { usePos } from '../state/pos-context'

export interface UpiPaid {
  amount_paise: number
  payment_intent_id?: string
  provider_account_id?: string
  reference?: string
}

function QrBox({
  uri,
  imageUrl,
  label,
}: {
  uri: string | null
  imageUrl: string | null
  label: string
}) {
  const svg = useMemo(
    () => (uri ? qrSvg(uri, { size: '100%', margin: 2, title: label }) : null),
    [uri, label],
  )
  return (
    <div className="mx-auto aspect-square w-full max-w-64 rounded-xl border border-border bg-white p-2">
      {svg ? (
        <div className="size-full" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : imageUrl ? (
        <img src={imageUrl} alt={label} className="size-full object-contain" />
      ) : (
        <div className="flex size-full items-center justify-center">
          <Spinner label="" />
        </div>
      )}
    </div>
  )
}

function useCountdown(seconds: number | null, startedAt: number | null): number | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (seconds === null) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [seconds])
  if (seconds === null || startedAt === null) return null
  return Math.max(0, seconds - Math.floor((now - startedAt) / 1000))
}

function mmss(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function UpiPanel({
  amountPaise,
  onPaid,
  autoStart = true,
}: {
  amountPaise: number
  onPaid: (paid: UpiPaid) => void
  autoStart?: boolean
}) {
  const { t } = useTranslation('pos')
  const pos = usePos()
  const context = pos.context
  const storeId = pos.scope?.storeId ?? ''
  const dynamic =
    context && pos.online && pos.perms.collect && pos.hasFeature('upi_dynamic')
      ? dynamicUpiProvider(context.payment_providers, storeId)
      : null
  const staticAcct = context ? staticUpiProvider(context.payment_providers, storeId) : null
  const [mode, setMode] = useState<'dynamic' | 'static'>(dynamic ? 'dynamic' : 'static')
  useEffect(() => {
    if (!dynamic && mode === 'dynamic') setMode('static')
  }, [dynamic, mode])

  if (amountPaise <= 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">{t('payment.nothing_left')}</p>
    )
  }
  if (mode === 'dynamic' && dynamic) {
    return (
      <DynamicUpi
        provider={dynamic}
        amountPaise={amountPaise}
        onPaid={onPaid}
        autoStart={autoStart}
        onUseStatic={staticAcct ? () => setMode('static') : undefined}
      />
    )
  }
  if (!staticAcct) {
    return (
      <div className="rounded-lg border border-warning bg-warning-soft p-4 text-sm text-warning-soft-foreground">
        {t('payment.upi_not_setup')}
      </div>
    )
  }
  return (
    <StaticUpi
      provider={staticAcct}
      amountPaise={amountPaise}
      onPaid={onPaid}
      onUseDynamic={dynamic ? () => setMode('dynamic') : undefined}
    />
  )
}

function StaticUpi({
  provider,
  amountPaise,
  onPaid,
  onUseDynamic,
}: {
  provider: PaymentProviderPublic
  amountPaise: number
  onPaid: (paid: UpiPaid) => void
  onUseDynamic?: () => void
}) {
  const { t } = useTranslation('pos')
  const pos = usePos()
  const [utr, setUtr] = useState('')
  const reference = useMemo(() => generateReferenceCode('KD'), [])
  const payee = pos.context?.tenant.name ?? ''
  const uri = useMemo(
    () => staticUpiUri(provider, { payee, amount_paise: amountPaise, note: payee, reference }),
    [provider, payee, amountPaise, reference],
  )
  const { display } = pos
  useEffect(() => {
    if (!uri) return
    display.setPaused(true)
    display.send({
      type: 'upi_qr',
      upi_uri: uri,
      amount_paise: amountPaise,
      payee_name: provider.payee_name ?? payee,
      expires_at: null,
    })
    return () => display.setPaused(false)
    // display functions are stable; re-send only when the QR changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uri])
  const utrOk = utr.trim() === '' || /^[A-Za-z0-9]{6,35}$/.test(utr.trim())
  return (
    <div className="flex flex-col gap-3">
      <QrBox
        uri={uri}
        imageUrl={null}
        label={t('payment.scan_to_pay', { amount: formatMoney(amountPaise) })}
      />
      <div className="text-center">
        <div className="text-2xl font-bold tabular-nums">{formatMoney(amountPaise)}</div>
        <div className="text-sm text-muted-foreground">{provider.vpa}</div>
      </div>
      <label className="text-sm font-medium" htmlFor="pos-upi-utr">
        {t('payment.utr_optional')}
      </label>
      <Input
        id="pos-upi-utr"
        value={utr}
        onChange={(e) => setUtr(e.target.value)}
        inputMode="numeric"
        maxLength={35}
        placeholder={t('payment.utr_placeholder')}
        aria-invalid={!utrOk}
      />
      <Button
        size="xl"
        variant="success"
        leftIcon={<CheckCircle2 />}
        disabled={!utrOk || !uri}
        onClick={() => {
          display.send({ type: 'payment_status', status: 'paid' })
          onPaid({
            amount_paise: amountPaise,
            provider_account_id: provider.id,
            ...(utr.trim() ? { reference: utr.trim() } : {}),
          })
        }}
      >
        {t('payment.upi_received')}
      </Button>
      <p className="text-xs text-muted-foreground">{t('payment.upi_static_hint')}</p>
      {onUseDynamic ? (
        <Button variant="link" size="sm" onClick={onUseDynamic}>
          {t('payment.use_dynamic_qr')}
        </Button>
      ) : null}
    </div>
  )
}

function DynamicUpi({
  provider,
  amountPaise,
  onPaid,
  autoStart,
  onUseStatic,
}: {
  provider: PaymentProviderPublic
  amountPaise: number
  onPaid: (paid: UpiPaid) => void
  autoStart: boolean
  onUseStatic?: () => void
}) {
  const { t } = useTranslation('pos')
  const pos = usePos()
  const [intent, setIntent] = useState<PaymentIntent | null>(null)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [creating, setCreating] = useState(false)
  const paidReported = useRef<string | null>(null)
  const intentRef = useRef<PaymentIntent | null>(null)
  const { display } = pos
  const cartId = pos.cart.id
  const scope = pos.scope

  const remaining = useCountdown(intent?.expires_in_seconds ?? null, startedAt)

  const create = useCallback(async () => {
    if (!scope) return
    setCreating(true)
    setError(null)
    try {
      const key = `${cartId}:upi:${amountPaise}:${Date.now()}`
      const res = await callRoute(paymentsRoutes.createIntent, {
        body: {
          amount_paise: amountPaise,
          purpose: 'pos_sale',
          store_id: scope.storeId,
          ...(scope.registerId ? { register_id: scope.registerId } : {}),
          ref_type: 'pos_cart',
          ref_id: cartId,
          ...(pos.cart.customer ? { customer_id: pos.cart.customer.id } : {}),
          provider_account_id: provider.id,
          note: (pos.context?.tenant.name ?? '').slice(0, 50) || undefined,
          idempotency_key: key,
        },
        idempotencyKey: key,
      })
      setIntent(res.data)
      intentRef.current = res.data
      setStartedAt(Date.now())
    } catch (e) {
      setError(e)
    } finally {
      setCreating(false)
    }
    // pos.cart.customer / context are read at click time
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, cartId, amountPaise, provider.id])

  useEffect(() => {
    if (autoStart && !intent && !creating && !error) void create()
    // start once per amount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountPaise])

  // Live status: SSE stream, long poll as a fallback.
  const intentId = intent?.id ?? null
  useEffect(() => {
    if (!intentId) return
    let closed = false
    const controller = new AbortController()
    const apply = (next: PaymentIntent): void => {
      if (closed) return
      setIntent(next)
      intentRef.current = next
    }
    const sub = subscribeSse(routeUrl(paymentsRoutes.streamIntent, { id: intentId }), {
      signal: controller.signal,
      onMessage: (m) => {
        if (m.event !== INTENT_STREAM_EVENT) return
        try {
          const parsed = PaymentIntentSchema.safeParse(JSON.parse(m.data))
          if (parsed.success) apply(parsed.data)
        } catch {
          // ignore malformed frames
        }
      },
      onError: () => {
        if (closed) return
        // Fallback: one long poll at a time until the intent settles.
        void (async () => {
          while (!closed) {
            const current = intentRef.current
            if (!current || isTerminalIntentStatus(current.status)) return
            try {
              const r = await callRoute(paymentsRoutes.getIntent, {
                params: { id: intentId },
                query: { wait: 20, since_status: current.status },
                signal: controller.signal,
                timeoutMs: 30_000,
              })
              apply(r.data)
            } catch {
              await new Promise((res) => setTimeout(res, 3_000))
            }
          }
        })()
      },
    })
    return () => {
      closed = true
      sub.close()
      controller.abort()
    }
  }, [intentId])

  // Customer display mirror.
  useEffect(() => {
    if (!intent) return
    if (intent.status === 'pending' || intent.status === 'created') {
      display.setPaused(true)
      if (intent.upi_uri) {
        display.send({
          type: 'upi_qr',
          upi_uri: intent.upi_uri,
          amount_paise: intent.amount_paise,
          payee_name: provider.payee_name ?? pos.context?.tenant.name ?? '',
          expires_at: intent.expires_at,
        })
      }
    } else {
      display.send({
        type: 'payment_status',
        status:
          intent.status === 'paid'
            ? 'paid'
            : intent.status === 'failed'
              ? 'failed'
              : intent.status === 'expired'
                ? 'expired'
                : 'cancelled',
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent?.status, intent?.upi_uri])
  const setPaused = display.setPaused
  useEffect(() => () => setPaused(false), [setPaused])

  // Paid → tender.
  useEffect(() => {
    if (intent?.status === 'paid' && paidReported.current !== intent.id) {
      paidReported.current = intent.id
      onPaid({
        amount_paise: intent.paid_amount_paise ?? intent.amount_paise,
        payment_intent_id: intent.id,
      })
    }
  }, [intent, onPaid])

  // Leaving the panel with a pending QR closes it at the provider.
  useEffect(
    () => () => {
      const current = intentRef.current
      if (current && !isTerminalIntentStatus(current.status)) {
        void callRoute(paymentsRoutes.cancelIntent, { params: { id: current.id }, body: {} }).catch(
          () => undefined,
        )
      }
    },
    [],
  )

  const status = intent?.status ?? null
  const expired = status === 'expired' || (remaining === 0 && status === 'pending')
  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <div className="rounded-lg border border-danger bg-danger-soft p-3 text-sm text-danger-soft-foreground">
          {t('payment.qr_failed')}{' '}
          {isApiError(error) ? <span className="opacity-80">({error.code})</span> : null}
        </div>
      ) : null}
      {status === 'paid' ? (
        <div className="flex flex-col items-center gap-2 py-6 text-success">
          <CheckCircle2 className="size-16" aria-hidden />
          <div className="text-xl font-bold">
            {t('payment.upi_paid', { amount: formatMoney(intent?.amount_paise ?? 0) })}
          </div>
          {intent?.utr ? (
            <div className="text-sm text-muted-foreground">UTR {intent.utr}</div>
          ) : null}
        </div>
      ) : status === 'failed' || status === 'cancelled' || expired ? (
        <div className="flex flex-col items-center gap-3 py-6">
          <XCircle className="size-12 text-danger" aria-hidden />
          <div className="font-semibold">
            {expired ? t('payment.qr_expired') : t('payment.qr_failed_status')}
          </div>
          <Button leftIcon={<RefreshCcw />} onClick={() => void create()} loading={creating}>
            {t('payment.new_qr')}
          </Button>
        </div>
      ) : intent || creating ? (
        <>
          <QrBox
            uri={intent?.upi_uri ?? null}
            imageUrl={intent?.image_url ?? null}
            label={t('payment.scan_to_pay', { amount: formatMoney(amountPaise) })}
          />
          <div className="flex items-center justify-center gap-3">
            <div className="text-2xl font-bold tabular-nums">
              {formatMoney(intent?.amount_paise ?? amountPaise)}
            </div>
            {remaining !== null ? (
              <Badge tone={remaining < 60 ? 'warning' : 'neutral'} icon={<Clock />}>
                {mmss(remaining)}
              </Badge>
            ) : null}
          </div>
          <div
            className="flex items-center justify-center gap-2 text-sm text-muted-foreground"
            aria-live="polite"
          >
            <Spinner size="sm" label="" /> {t('payment.waiting_upi')}
          </div>
          {provider.provider === 'mock' && intent ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void callRoute(paymentsRoutes.mockPayIntent, {
                  params: { id: intent.id },
                  body: { outcome: 'paid' },
                })
                  .then((r) => {
                    setIntent(r.data)
                    intentRef.current = r.data
                  })
                  .catch((e: unknown) => notify.error(e))
              }
            >
              {t('payment.mock_pay')}
            </Button>
          ) : null}
        </>
      ) : (
        <Button size="xl" leftIcon={<QrCode />} onClick={() => void create()}>
          {t('payment.show_qr', { amount: formatMoney(amountPaise) })}
        </Button>
      )}
      {onUseStatic && status !== 'paid' ? (
        <Button variant="link" size="sm" onClick={onUseStatic}>
          {t('payment.use_static_qr')}
        </Button>
      ) : null}
    </div>
  )
}
