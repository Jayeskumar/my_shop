/**
 * UPI QR panel for the counter (POS tender, dues collection, invoice "collect now").
 *
 *  - `intent` mode: renders the intent's `upi_uri` as a QR (or the provider's hosted
 *    `image_url`), the amount, a clock-skew-free countdown (`expires_in_seconds`), and the live
 *    status over SSE with a long-poll fallback (usePaymentIntentStatus). A shop-UPI-ID intent
 *    (`upi_vpa`, no bank callback) gets "Payment received" with an optional UTR, which confirms
 *    it on the server (audited). Cancel closes the QR at the provider; an expired / failed QR
 *    offers "New QR" (`onRegenerate`, the caller creates the next intent).
 *  - `static` mode: a QR built locally from the shop VPA (works offline, no intent); the cashier
 *    confirms receipt through `onManualConfirm`.
 */
import {
  CheckCircle2,
  CircleAlert,
  Clock,
  Hourglass,
  RefreshCw,
  Smartphone,
  Wifi,
  XCircle,
} from 'lucide-react'
import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PaymentIntent } from '@kadai/shared/api/payments'
import { buildUpiUri } from '@kadai/shared/upi'
import { Badge, Button, Input, Spinner, notify } from '@/components/ui'
import { isApiError } from '@/lib/api'
import { useCan } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { formatMoney } from '@/lib/format'
import { useCancelIntent, useConfirmIntent } from '../api'
import { useValidationKeyText } from '../lib/validation-text'
import { usePaymentIntentStatus } from './intent-hooks'
import { QrCode } from './QrCode'
import { notifyPaymentError } from '../lib/errors'

/** A QR without an intent: the shop's own UPI ID with a fixed amount. */
export interface StaticUpiQr {
  vpa: string
  payee_name: string
  amount_paise: number
  /** UPI note (`tn`), e.g. the bill number. */
  note?: string
  /** UPI transaction reference (`tr`), letters and digits. */
  reference?: string
  merchant_code?: string | null
}

type Source =
  { intent: PaymentIntent; static?: undefined } | { static: StaticUpiQr; intent?: undefined }

export type UpiQrPanelProps = Source & {
  /** Intent mode: called once when the intent is paid (live update or manual confirm). */
  onPaid?: (intent: PaymentIntent) => void
  /** Every status change of the intent (customer display, POS state). */
  onStatusChange?: (intent: PaymentIntent) => void
  /** After cancel (intent cancelled at the server; static mode: null). */
  onCancelled?: (intent: PaymentIntent | null) => void
  /** "New QR" for an expired / failed / cancelled intent. */
  onRegenerate?: () => void
  /** Static mode: the cashier saw the money arrive. */
  onManualConfirm?: (input: { utr: string | null }) => void
  /** Offer "Payment received" for shop-UPI-ID QRs (default: users with payments.collect). */
  allowManualConfirm?: boolean
  /** Hide the cancel button (the caller has its own). */
  hideCancel?: boolean
  className?: string
}

const UTR_RE = /^[A-Za-z0-9]{6,35}$/

/** Seconds left until `deadline` (epoch ms), ticking every second while > 0. */
function useCountdown(deadline: number | null): number | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (deadline === null) return undefined
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [deadline])
  if (deadline === null) return null
  return Math.max(0, Math.ceil((deadline - now) / 1_000))
}

function formatClock(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function UpiQrPanel(props: UpiQrPanelProps) {
  if (props.static) return <StaticPanel {...props} qr={props.static} />
  return <IntentPanel {...props} initial={props.intent} />
}

// ---------------------------------------------------------------------------------------------

function IntentPanel({
  initial,
  onPaid,
  onStatusChange,
  onCancelled,
  onRegenerate,
  allowManualConfirm,
  hideCancel = false,
  className,
}: Omit<UpiQrPanelProps, 'intent' | 'static'> & { initial: PaymentIntent }) {
  const { t } = useTranslation('payments')
  const canCollect = useCan('payments.collect')
  const live = usePaymentIntentStatus(initial.id, { initial })
  const intent = live.intent ?? initial
  const status = intent.status
  const isVpa = intent.provider === 'upi_vpa'
  const manualAllowed = (allowManualConfirm ?? canCollect) && isVpa
  const confirm = useConfirmIntent()
  const cancel = useCancelIntent()
  const keyText = useValidationKeyText()
  const utrId = useId()
  const [utr, setUtr] = useState('')
  const [utrError, setUtrError] = useState<string | null>(null)

  // Deadline from the server's relative countdown, taken when that intent snapshot arrived.
  const [deadline, setDeadline] = useState<number | null>(null)
  const seenSnapshot = useRef<string | null>(null)
  useEffect(() => {
    const key = `${intent.id}:${intent.updated_at}:${intent.expires_in_seconds ?? ''}`
    if (seenSnapshot.current === key) return
    seenSnapshot.current = key
    setDeadline(
      intent.expires_in_seconds === null ? null : Date.now() + intent.expires_in_seconds * 1_000,
    )
  }, [intent.id, intent.updated_at, intent.expires_in_seconds])
  const waiting = status === 'created' || status === 'pending'
  const secondsLeft = useCountdown(waiting ? deadline : null)
  const timedOut = waiting && secondsLeft === 0

  // Ask the server once when the local countdown runs out (it expires the intent).
  const { refresh } = live
  useEffect(() => {
    if (timedOut) void refresh().catch(() => undefined)
  }, [timedOut, refresh])

  const reportedStatus = useRef<string | null>(null)
  useEffect(() => {
    const key = `${intent.id}:${status}`
    if (reportedStatus.current === key) return
    reportedStatus.current = key
    onStatusChange?.(intent)
    if (status === 'paid') onPaid?.(intent)
    // Report each status once per intent; the callbacks may change identity every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent.id, status])

  const submitManual = (event?: FormEvent): void => {
    event?.preventDefault()
    const value = utr.trim()
    if (value && !UTR_RE.test(value)) {
      setUtrError('utr_invalid')
      return
    }
    setUtrError(null)
    confirm.mutate(
      { params: { id: intent.id }, body: value ? { utr: value } : {} },
      {
        onSuccess: (res) => {
          live.update(res.data)
          notify.success(t('qr.confirmed_toast', { amount: formatMoney(res.data.amount_paise) }))
        },
        onError: (error) => {
          const issue = isApiError(error)
            ? error.validationIssues.find((i) => i.path === 'utr')
            : null
          if (issue) setUtrError(issue.message)
          else if (isApiError(error) && error.status === 409) void live.refresh().catch(() => null)
          else notifyPaymentError(error)
        },
      },
    )
  }

  const doCancel = (): void => {
    cancel.mutate(
      { params: { id: intent.id }, body: {} },
      {
        onSuccess: (res) => {
          live.update(res.data)
          onCancelled?.(res.data)
        },
        onError: (error) => {
          // Already paid / closed: show what the server has now.
          if (isApiError(error) && error.status === 409) void live.refresh().catch(() => null)
          else notifyPaymentError(error)
        },
      },
    )
  }

  const amountLabel = formatMoney(intent.amount_paise)
  const qrLabel = t('qr.qr_label', { amount: amountLabel })

  return (
    <section
      className={cn('flex flex-col items-center gap-4 text-center', className)}
      aria-label={t('qr.panel_label')}
    >
      <div>
        <p className="text-sm text-muted-foreground">
          {status === 'paid' ? t('qr.received') : t('qr.scan_to_pay')}
        </p>
        <p className="text-3xl font-bold tabular-nums sm:text-4xl" data-testid="upi-amount">
          {amountLabel}
        </p>
      </div>

      {status === 'paid' ? (
        <PaidState intent={intent} />
      ) : waiting && !timedOut ? (
        <div className="relative">
          <IntentQr intent={intent} label={qrLabel} />
        </div>
      ) : (
        <ClosedState status={timedOut ? 'expired' : status} reason={intent.failure_reason} />
      )}

      <div aria-live="polite" className="min-h-6 text-sm">
        {waiting && !timedOut ? (
          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
            <span className="inline-flex items-center gap-1.5 font-medium">
              <span className="relative flex size-2.5" aria-hidden>
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-warning opacity-60 motion-reduce:animate-none" />
                <span className="relative inline-flex size-2.5 rounded-full bg-warning" />
              </span>
              {isVpa ? t('qr.waiting_vpa') : t('qr.waiting')}
            </span>
            {secondsLeft !== null ? (
              <span className="inline-flex items-center gap-1 tabular-nums text-muted-foreground">
                <Clock className="size-3.5" aria-hidden />
                {t('qr.time_left', { time: formatClock(secondsLeft) })}
              </span>
            ) : null}
            {!isVpa ? <ModeChip mode={live.mode} /> : null}
          </div>
        ) : null}
      </div>

      {waiting && !timedOut && isVpa ? (
        <p className="max-w-xs text-xs text-muted-foreground">{t('qr.vpa_hint')}</p>
      ) : null}

      {waiting && !timedOut && manualAllowed ? (
        <form onSubmit={submitManual} className="flex w-full max-w-sm flex-col gap-2" noValidate>
          <label htmlFor={utrId} className="text-start text-sm font-medium">
            {t('qr.utr_label')}
            <span className="ms-1 font-normal text-muted-foreground">({t('qr.optional')})</span>
          </label>
          <Input
            id={utrId}
            value={utr}
            onChange={(e) => {
              setUtr(e.target.value.replace(/\s+/g, ''))
              setUtrError(null)
            }}
            inputMode="numeric"
            autoComplete="off"
            maxLength={35}
            placeholder={t('qr.utr_placeholder')}
            aria-invalid={utrError ? true : undefined}
            aria-describedby={utrError ? `${utrId}-error` : undefined}
          />
          {utrError ? (
            <p id={`${utrId}-error`} role="alert" className="text-start text-sm text-danger">
              {keyText(utrError) ?? utrError}
            </p>
          ) : null}
          <Button
            type="submit"
            variant="success"
            size="lg"
            fullWidth
            loading={confirm.isPending}
            leftIcon={<CheckCircle2 />}
          >
            {t('qr.mark_received')}
          </Button>
        </form>
      ) : null}

      <div className="flex flex-wrap items-center justify-center gap-2">
        {waiting && !timedOut && !hideCancel ? (
          <Button variant="outline" size="lg" onClick={doCancel} loading={cancel.isPending}>
            {t('qr.cancel')}
          </Button>
        ) : null}
        {waiting && !timedOut && !isVpa ? (
          <Button
            variant="ghost"
            size="lg"
            leftIcon={<RefreshCw />}
            onClick={() => void live.refresh().catch((e: unknown) => notifyPaymentError(e))}
          >
            {t('qr.check_now')}
          </Button>
        ) : null}
        {(timedOut || status === 'expired' || status === 'failed' || status === 'cancelled') &&
        onRegenerate ? (
          <Button size="lg" leftIcon={<RefreshCw />} onClick={onRegenerate}>
            {t('qr.regenerate')}
          </Button>
        ) : null}
      </div>
    </section>
  )
}

function IntentQr({ intent, label }: { intent: PaymentIntent; label: string }) {
  const { t } = useTranslation('payments')
  const value = intent.upi_uri ?? intent.short_url
  if (value)
    return <QrCode value={value} label={label} className="w-56 border border-border p-1 sm:w-64" />
  if (intent.image_url) {
    return (
      <img
        src={intent.image_url}
        alt={label}
        className="block w-56 rounded-md border border-border bg-white p-1 sm:w-64"
      />
    )
  }
  return (
    <div className="flex size-56 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground sm:size-64">
      {t('qr.no_qr')}
    </div>
  )
}

function ModeChip({ mode }: { mode: ReturnType<typeof usePaymentIntentStatus>['mode'] }) {
  const { t } = useTranslation('payments')
  if (mode === 'sse') {
    return (
      <Badge tone="success" size="sm" icon={<Wifi aria-hidden />}>
        {t('qr.mode_live')}
      </Badge>
    )
  }
  if (mode === 'poll') {
    return (
      <Badge tone="info" size="sm" icon={<RefreshCw aria-hidden />}>
        {t('qr.mode_poll')}
      </Badge>
    )
  }
  if (mode === 'connecting') return <Spinner className="size-3.5" label={t('qr.mode_connecting')} />
  return null
}

function PaidState({ intent }: { intent: PaymentIntent }) {
  const { t } = useTranslation('payments')
  const received = intent.paid_amount_paise ?? intent.amount_paise
  return (
    <div className="flex flex-col items-center gap-3" data-testid="upi-paid">
      <div className="flex size-40 items-center justify-center rounded-full bg-success-soft motion-safe:animate-zoom-in sm:size-48">
        <CheckCircle2
          className="size-24 text-success motion-safe:animate-pop-in sm:size-28"
          strokeWidth={1.75}
          aria-hidden
        />
      </div>
      <p className="text-lg font-semibold text-success">
        {t('qr.paid_title', { amount: formatMoney(received) })}
      </p>
      <dl className="grid gap-0.5 text-sm text-muted-foreground">
        {intent.payer_name || intent.payer_vpa ? (
          <div>
            <dt className="sr-only">{t('fields.payer')}</dt>
            <dd>{[intent.payer_name, intent.payer_vpa].filter(Boolean).join(' · ')}</dd>
          </div>
        ) : null}
        {intent.utr ? (
          <div>
            <dt className="inline">{t('fields.utr')}: </dt>
            <dd className="inline font-mono">{intent.utr}</dd>
          </div>
        ) : null}
      </dl>
      {intent.amount_mismatch ? (
        <p
          role="alert"
          className="flex items-center gap-2 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning-soft-foreground"
        >
          <CircleAlert className="size-4 shrink-0" aria-hidden />
          {t('qr.amount_mismatch', {
            received: formatMoney(received),
            expected: formatMoney(intent.amount_paise),
          })}
        </p>
      ) : null}
    </div>
  )
}

function ClosedState({
  status,
  reason,
}: {
  status: PaymentIntent['status']
  reason: string | null
}) {
  const { t } = useTranslation('payments')
  const Icon = status === 'failed' ? XCircle : status === 'expired' ? Hourglass : XCircle
  return (
    <div
      className={cn(
        'flex size-56 flex-col items-center justify-center gap-2 rounded-md border border-dashed p-4 sm:size-64',
        status === 'failed' ? 'border-danger text-danger' : 'border-border text-muted-foreground',
      )}
    >
      <Icon className="size-12" aria-hidden />
      <p className="font-medium">
        {t(
          `qr.closed.${status === 'failed' ? 'failed' : status === 'expired' ? 'expired' : 'cancelled'}`,
        )}
      </p>
      {status === 'failed' && reason ? <p className="text-xs">{reason}</p> : null}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------

function StaticPanel({
  qr,
  onManualConfirm,
  onCancelled,
  hideCancel = false,
  className,
}: Omit<UpiQrPanelProps, 'intent' | 'static'> & { qr: StaticUpiQr }) {
  const { t } = useTranslation('payments')
  const keyText = useValidationKeyText()
  const utrId = useId()
  const [utr, setUtr] = useState('')
  const [utrError, setUtrError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const uri = useMemo(() => {
    try {
      return buildUpiUri({
        vpa: qr.vpa,
        payee_name: qr.payee_name,
        amount_paise: qr.amount_paise,
        ...(qr.note ? { note: qr.note } : {}),
        ...(qr.reference ? { reference: qr.reference } : {}),
        ...(qr.merchant_code ? { mcc: qr.merchant_code } : {}),
      })
    } catch {
      return null
    }
  }, [qr.vpa, qr.payee_name, qr.amount_paise, qr.note, qr.reference, qr.merchant_code])
  const amountLabel = formatMoney(qr.amount_paise)

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const value = utr.trim()
    if (value && !UTR_RE.test(value)) {
      setUtrError('utr_invalid')
      return
    }
    setDone(true)
    onManualConfirm?.({ utr: value || null })
  }

  return (
    <section
      className={cn('flex flex-col items-center gap-4 text-center', className)}
      aria-label={t('qr.panel_label')}
    >
      <div>
        <p className="text-sm text-muted-foreground">{t('qr.scan_to_pay')}</p>
        <p className="text-3xl font-bold tabular-nums sm:text-4xl" data-testid="upi-amount">
          {amountLabel}
        </p>
      </div>
      {uri ? (
        <QrCode
          value={uri}
          label={t('qr.qr_label', { amount: amountLabel })}
          className="w-56 border border-border p-1 sm:w-64"
        />
      ) : (
        <div className="flex size-56 items-center justify-center rounded-md border border-dashed border-danger p-4 text-sm text-danger">
          {t('qr.invalid_vpa')}
        </div>
      )}
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Smartphone className="size-4" aria-hidden />
        <span>
          {qr.payee_name} · <span className="font-mono">{qr.vpa}</span>
        </span>
      </p>
      <p className="max-w-xs text-xs text-muted-foreground">{t('qr.vpa_hint')}</p>
      {onManualConfirm ? (
        <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-2" noValidate>
          <label htmlFor={utrId} className="text-start text-sm font-medium">
            {t('qr.utr_label')}
            <span className="ms-1 font-normal text-muted-foreground">({t('qr.optional')})</span>
          </label>
          <Input
            id={utrId}
            value={utr}
            onChange={(e) => {
              setUtr(e.target.value.replace(/\s+/g, ''))
              setUtrError(null)
            }}
            inputMode="numeric"
            autoComplete="off"
            maxLength={35}
            placeholder={t('qr.utr_placeholder')}
            aria-invalid={utrError ? true : undefined}
          />
          {utrError ? (
            <p role="alert" className="text-start text-sm text-danger">
              {keyText(utrError) ?? utrError}
            </p>
          ) : null}
          <Button
            type="submit"
            variant="success"
            size="lg"
            fullWidth
            disabled={!uri || done}
            leftIcon={<CheckCircle2 />}
          >
            {t('qr.mark_received')}
          </Button>
        </form>
      ) : null}
      {!hideCancel && onCancelled ? (
        <Button variant="outline" size="lg" onClick={() => onCancelled(null)}>
          {t('qr.cancel')}
        </Button>
      ) : null}
    </section>
  )
}
