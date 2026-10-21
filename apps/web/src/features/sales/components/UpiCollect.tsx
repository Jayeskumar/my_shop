/**
 * UPI collection of one tender in the "Collect payment" dialog.
 *
 *  - Shop's UPI ID (static, every plan): GET /payments/upi-qr gives a QR with the amount; the
 *    shopkeeper confirms "payment received" (soundbox / phone), optionally with the UTR. The
 *    tender carries the receiving UPI account (provider_account_id) and the reference.
 *  - Auto-confirm QR (plan feature upi_dynamic): POST /payments/intents (purpose invoice_due,
 *    ref sales_invoice) shows a single-use QR and follows its status over the SSE stream (long
 *    poll as a fallback); a UPI-ID intent is confirmed by hand (POST …/confirm). When paid, the
 *    tender carries payment_intent_id with the amount actually received.
 * A pending QR is closed at the provider when the panel goes away.
 */
import { CheckCircle2, QrCode, RefreshCcw, XCircle } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { routeUrl } from '@kadai/shared/api/common'
import {
  INTENT_STREAM_EVENT,
  type PaymentIntent,
  PaymentIntentSchema,
  isTerminalIntentStatus,
  paymentsRoutes,
} from '@kadai/shared/api/payments'
import { newId } from '@kadai/shared/ids'
import { Button, FormField, Input, Spinner, notify } from '@/components/ui'
import { qrSvg } from '@/features/pos/print'
import { callRoute, isApiError, subscribeSse } from '@/lib/api'
import { formatMoney } from '@/lib/format'
import { useConfirmIntent, useCreateIntent, useUpiQr } from '../api'

export interface UpiPaid {
  amount_paise: number
  payment_intent_id?: string
  provider_account_id?: string
  reference?: string
}

const UTR_RE = /^[A-Za-z0-9]{6,35}$/

function useDebounced<T>(value: T, ms: number): T {
  const [current, setCurrent] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setCurrent(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return current
}

export interface UpiCollectProps {
  amountPaise: number
  storeId: string
  registerId: string | null
  invoice: { id: string; number: string | null; customer_id: string | null }
  dynamicAllowed: boolean
  onPaid: (paid: UpiPaid) => void
}

export function UpiCollect(props: UpiCollectProps) {
  const [mode, setMode] = useState<'static' | 'dynamic'>(
    props.dynamicAllowed ? 'dynamic' : 'static',
  )
  if (props.amountPaise <= 0) return null
  return mode === 'dynamic' ? (
    <DynamicUpi {...props} onUseStatic={() => setMode('static')} />
  ) : (
    <StaticUpi
      {...props}
      onUseDynamic={props.dynamicAllowed ? () => setMode('dynamic') : undefined}
    />
  )
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
  const svg = useMemo(() => (uri ? qrSvg(uri, { size: '100%', margin: 2 }) : null), [uri])
  return (
    <div
      className="mx-auto aspect-square w-full max-w-52 rounded-xl border border-border bg-white p-2"
      role="img"
      aria-label={label}
    >
      {svg ? (
        <div className="size-full" aria-hidden dangerouslySetInnerHTML={{ __html: svg }} />
      ) : imageUrl ? (
        <img src={imageUrl} alt="" className="size-full object-contain" />
      ) : (
        <div className="flex size-full items-center justify-center">
          <Spinner label="" />
        </div>
      )}
    </div>
  )
}

function UtrField({
  id,
  value,
  onChange,
  invalid,
}: {
  id: string
  value: string
  onChange: (v: string) => void
  invalid: boolean
}) {
  const { t } = useTranslation('sales')
  return (
    <FormField
      id={id}
      label={t('collect.utr')}
      optional
      error={invalid ? t('collect.utr_invalid') : null}
      hint={t('collect.utr_hint')}
    >
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode="numeric"
        maxLength={35}
        placeholder={t('collect.utr_placeholder')}
      />
    </FormField>
  )
}

function StaticUpi({
  amountPaise,
  storeId,
  invoice,
  onPaid,
  onUseDynamic,
}: UpiCollectProps & { onUseDynamic: (() => void) | undefined }) {
  const { t } = useTranslation('sales')
  const [utr, setUtr] = useState('')
  const idRef = useRef(`utr-${newId()}`)
  // The amount is typed digit by digit: ask for the QR once it settles.
  const settled = useDebounced(amountPaise, 400)
  const qr = useUpiQr({
    store_id: storeId,
    amount_paise: settled,
    ...(invoice.number ? { note: invoice.number.slice(0, 50) } : {}),
  })
  const utrOk = utr.trim() === '' || UTR_RE.test(utr.trim())
  const label = t('collect.scan_to_pay', { amount: formatMoney(amountPaise) })
  const ready = qr.data !== undefined && settled === amountPaise

  if (qr.isError) {
    return (
      <div className="flex flex-col gap-3">
        <div className="rounded-lg border border-warning bg-warning-soft p-3 text-sm text-warning-soft-foreground">
          {isApiError(qr.error) && (qr.error.status === 404 || qr.error.status === 422)
            ? t('collect.upi_not_setup')
            : t('collect.qr_failed')}
        </div>
        <UtrField id={idRef.current} value={utr} onChange={setUtr} invalid={!utrOk} />
        <Button
          variant="success"
          leftIcon={<CheckCircle2 />}
          disabled={!utrOk}
          onClick={() =>
            onPaid({ amount_paise: amountPaise, ...(utr.trim() ? { reference: utr.trim() } : {}) })
          }
        >
          {t('collect.upi_received', { amount: formatMoney(amountPaise) })}
        </Button>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-3">
      <QrBox uri={ready ? (qr.data?.data.upi_uri ?? null) : null} imageUrl={null} label={label} />
      {qr.data ? (
        <p className="text-center text-sm text-muted-foreground">{qr.data.data.vpa}</p>
      ) : null}
      <UtrField id={idRef.current} value={utr} onChange={setUtr} invalid={!utrOk} />
      <Button
        variant="success"
        leftIcon={<CheckCircle2 />}
        disabled={!utrOk || !ready}
        onClick={() =>
          onPaid({
            amount_paise: amountPaise,
            ...(qr.data ? { provider_account_id: qr.data.data.provider_account_id } : {}),
            ...(utr.trim() ? { reference: utr.trim() } : {}),
          })
        }
      >
        {t('collect.upi_received', { amount: formatMoney(amountPaise) })}
      </Button>
      <p className="text-xs text-muted-foreground">{t('collect.upi_static_hint')}</p>
      {onUseDynamic ? (
        <Button variant="link" size="sm" onClick={onUseDynamic}>
          {t('collect.use_dynamic_qr')}
        </Button>
      ) : null}
    </div>
  )
}

function DynamicUpi({
  amountPaise,
  storeId,
  registerId,
  invoice,
  onPaid,
  onUseStatic,
}: UpiCollectProps & { onUseStatic: () => void }) {
  const { t } = useTranslation('sales')
  const create = useCreateIntent()
  const confirm = useConfirmIntent()
  const [intent, setIntent] = useState<PaymentIntent | null>(null)
  const [utr, setUtr] = useState('')
  const intentRef = useRef<PaymentIntent | null>(null)
  const reported = useRef<string | null>(null)
  const idRef = useRef(`utr-${newId()}`)

  const apply = (next: PaymentIntent): void => {
    intentRef.current = next
    setIntent(next)
  }

  const start = (): void => {
    const key = newId()
    create.mutate(
      {
        body: {
          amount_paise: amountPaise,
          purpose: 'invoice_due',
          store_id: storeId,
          ...(registerId ? { register_id: registerId } : {}),
          ref_type: 'sales_invoice',
          ref_id: invoice.id,
          ...(invoice.customer_id ? { customer_id: invoice.customer_id } : {}),
          ...(invoice.number ? { note: invoice.number.slice(0, 50) } : {}),
          idempotency_key: key,
        },
        idempotencyKey: key,
      },
      { onSuccess: (res) => apply(res.data) },
    )
  }

  // Live status: SSE stream; long poll while the stream is down.
  const intentId = intent?.id ?? null
  useEffect(() => {
    if (!intentId) return
    let closed = false
    let polling = false
    const controller = new AbortController()
    const update = (next: PaymentIntent): void => {
      if (closed) return
      intentRef.current = next
      setIntent(next)
    }
    const poll = async (): Promise<void> => {
      if (polling) return
      polling = true
      while (!closed) {
        const current = intentRef.current
        if (!current || isTerminalIntentStatus(current.status)) break
        try {
          const r = await callRoute(paymentsRoutes.getIntent, {
            params: { id: intentId },
            query: { wait: 20, since_status: current.status },
            signal: controller.signal,
            timeoutMs: 30_000,
          })
          update(r.data)
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 3_000))
        }
      }
      polling = false
    }
    const sub = subscribeSse(routeUrl(paymentsRoutes.streamIntent, { id: intentId }), {
      signal: controller.signal,
      onMessage: (m) => {
        if (m.event !== INTENT_STREAM_EVENT) return
        try {
          const parsed = PaymentIntentSchema.safeParse(JSON.parse(m.data))
          if (parsed.success) update(parsed.data)
        } catch {
          // A malformed frame is ignored; the next one carries the full intent again.
        }
      },
      onError: () => {
        if (!closed) void poll()
      },
    })
    return () => {
      closed = true
      sub.close()
      controller.abort()
    }
  }, [intentId])

  // Paid → tender (the amount actually received).
  useEffect(() => {
    if (intent?.status === 'paid' && reported.current !== intent.id) {
      reported.current = intent.id
      onPaid({
        amount_paise: intent.paid_amount_paise ?? intent.amount_paise,
        payment_intent_id: intent.id,
      })
    }
  }, [intent, onPaid])

  // Leaving with a pending QR closes it at the provider.
  useEffect(
    () => () => {
      const current = intentRef.current
      if (current && !isTerminalIntentStatus(current.status)) {
        void callRoute(paymentsRoutes.cancelIntent, {
          params: { id: current.id },
          body: {},
        }).catch(() => undefined)
      }
    },
    [],
  )

  const status = intent?.status ?? null
  const label = t('collect.scan_to_pay', { amount: formatMoney(amountPaise) })
  const manual = intent?.provider === 'upi_vpa'
  const utrOk = utr.trim() === '' || UTR_RE.test(utr.trim())

  if (create.isError) {
    return (
      <div className="flex flex-col gap-3">
        <div className="rounded-lg border border-danger bg-danger-soft p-3 text-sm text-danger-soft-foreground">
          {t('collect.qr_failed')}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            leftIcon={<RefreshCcw />}
            onClick={start}
            loading={create.isPending}
          >
            {t('collect.try_again')}
          </Button>
          <Button variant="link" onClick={onUseStatic}>
            {t('collect.use_static_qr')}
          </Button>
        </div>
      </div>
    )
  }
  if (!intent) {
    return (
      <div className="flex flex-col gap-2">
        <Button size="lg" leftIcon={<QrCode />} onClick={start} loading={create.isPending}>
          {t('collect.show_qr', { amount: formatMoney(amountPaise) })}
        </Button>
        <Button variant="link" size="sm" onClick={onUseStatic}>
          {t('collect.use_static_qr')}
        </Button>
      </div>
    )
  }
  if (status === 'paid') {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-success-soft p-3 text-success-soft-foreground">
        <CheckCircle2 className="size-5" aria-hidden />
        <span className="font-medium">
          {t('collect.upi_paid', {
            amount: formatMoney(intent.paid_amount_paise ?? intent.amount_paise),
          })}
        </span>
        {intent.utr ? <span className="text-xs">UTR {intent.utr}</span> : null}
      </div>
    )
  }
  if (status === 'failed' || status === 'cancelled' || status === 'expired') {
    return (
      <div className="flex flex-col items-center gap-3 py-4">
        <XCircle className="size-10 text-danger" aria-hidden />
        <div className="font-semibold">
          {status === 'expired' ? t('collect.qr_expired') : t('collect.qr_not_paid')}
        </div>
        <Button
          leftIcon={<RefreshCcw />}
          onClick={() => {
            intentRef.current = null
            setIntent(null)
            start()
          }}
        >
          {t('collect.new_qr')}
        </Button>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-3">
      <QrBox uri={intent.upi_uri} imageUrl={intent.image_url} label={label} />
      <div className="text-center text-xl font-bold tabular-nums">
        {formatMoney(intent.amount_paise)}
      </div>
      {manual ? (
        <>
          <UtrField id={idRef.current} value={utr} onChange={setUtr} invalid={!utrOk} />
          <Button
            variant="success"
            leftIcon={<CheckCircle2 />}
            disabled={!utrOk}
            loading={confirm.isPending}
            onClick={() =>
              confirm.mutate(
                { params: { id: intent.id }, body: utr.trim() ? { utr: utr.trim() } : {} },
                { onSuccess: (res) => apply(res.data), onError: (e) => notify.error(e) },
              )
            }
          >
            {t('collect.upi_received', { amount: formatMoney(intent.amount_paise) })}
          </Button>
        </>
      ) : (
        <div
          className="flex items-center justify-center gap-2 text-sm text-muted-foreground"
          aria-live="polite"
        >
          <Spinner size="sm" label="" /> {t('collect.waiting_upi')}
        </div>
      )}
      <Button variant="link" size="sm" onClick={onUseStatic}>
        {t('collect.use_static_qr')}
      </Button>
    </div>
  )
}
