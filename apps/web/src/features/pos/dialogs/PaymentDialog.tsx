/**
 * Payment (F8): split tenders — cash (amount handed over, quick notes, "exact", change shown
 * huge), UPI (dynamic QR with live status, or the shop's UPI ID with a received confirmation),
 * card (approval code), customer advance, loyalty points, and khata (credit) for the rest.
 * Completing asks the server for an authoritative quote first (online) and shows anything that
 * blocks the bill; offline it queues the bill and prints at once.
 */
import {
  AlertTriangle,
  Banknote,
  BookUser,
  CreditCard,
  Gift,
  Printer,
  QrCode,
  Trash2,
  Wallet,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { creditCheck, type SalesIssue } from '@kadai/shared/api/sales'
import { PAYMENT_METHOD_LABELS } from '@kadai/shared/api/payments'
import { maxRedeemablePoints } from '@kadai/shared/api/parties'
import { newId } from '@kadai/shared/ids'
import {
  Badge,
  Button,
  Checkbox,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogRoot,
  DialogTitle,
  IconButton,
  Input,
  Kbd,
  MoneyInput,
  NumberInput,
} from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatMoney } from '@/lib/format'
import { useHotkeys } from '@/lib/hotkeys'
import { getLanguage } from '@/lib/i18n'
import { issueMessage } from '../lib/issues'
import {
  type PosTender,
  QUICK_NOTES_PAISE,
  cashNeeded,
  remainingForNonCash,
  suggestNonCash,
  suggestTendered,
  summarizeTenders,
} from '../lib/tenders'
import { type SaleOutcome, usePos } from '../state/pos-context'
import { RxDialog } from './RxDialog'
import { UpiPanel } from './UpiPanel'

type Tab = 'cash' | 'upi' | 'card' | 'credit' | 'advance' | 'points'

export function PaymentDialog({
  initialMethod,
  initialOutcome,
  onClose,
}: {
  initialMethod?: 'cash' | 'upi' | 'card' | 'credit'
  initialOutcome?: SaleOutcome
  onClose: () => void
}) {
  const { t } = useTranslation('pos')
  const pos = usePos()
  const customer = pos.cart.customer
  const settings = pos.context?.settings
  const localTotal = pos.pricing.result.total_paise
  const [serverTotal, setServerTotal] = useState<number | null>(
    initialOutcome?.status === 'price_changed' ? initialOutcome.server_total_paise : null,
  )
  const total = serverTotal ?? localTotal
  const [tab, setTab] = useState<Tab>(
    initialMethod ?? settings?.pos.default_payment_method ?? 'cash',
  )
  const [tenders, setTenders] = useState<PosTender[]>([])
  const [cash, setCash] = useState<number | null>(null)
  const [cardAmount, setCardAmount] = useState<number | null>(null)
  const [cardRef, setCardRef] = useState('')
  const [advanceAmount, setAdvanceAmount] = useState<number | null>(null)
  const [onCredit, setOnCredit] = useState(initialMethod === 'credit')
  const [override, setOverride] = useState(false)
  const [issues, setIssues] = useState<SalesIssue[]>(
    initialOutcome?.status === 'blocked' ? initialOutcome.issues : [],
  )
  const [message, setMessage] = useState<string | null>(
    initialOutcome?.status === 'error' ? initialOutcome.message : null,
  )
  const [rxOpen, setRxOpen] = useState(initialOutcome?.status === 'needs_rx')
  const cashRef = useRef<HTMLInputElement>(null)

  const nonCash = tenders
  const all: PosTender[] = useMemo(
    () => [
      ...nonCash,
      ...(cash && cash > 0 ? [{ id: 'cash', method: 'cash' as const, amount_paise: cash }] : []),
    ],
    [nonCash, cash],
  )
  const summary = summarizeTenders(total, all)
  const needCash = cashNeeded(total, nonCash)
  const leftForNonCash = remainingForNonCash(total, nonCash)
  const nonCashDefault = suggestNonCash(total, nonCash, cash ?? 0)
  const khataAllowed = Boolean(customer) && pos.hasFeature('khata') && pos.perms.credit
  const credit =
    customer && summary.due_paise > 0
      ? creditCheck({
          due_paise: summary.due_paise,
          balance_paise: customer.balance_paise,
          credit_limit_paise: customer.credit_limit_paise,
          block_over_limit: settings?.credit.block_over_limit ?? true,
          override,
        })
      : null
  const advanceAvailable = customer && customer.balance_paise < 0 ? -customer.balance_paise : 0
  const loyaltyOn =
    pos.hasFeature('loyalty') && settings?.loyalty.enabled === true && Boolean(customer)
  const maxPoints =
    loyaltyOn && customer && settings
      ? maxRedeemablePoints({
          balance_points: customer.loyalty_points,
          bill_total_paise: localTotal + pos.pricing.result.loyalty_redeem_paise,
          settings: settings.loyalty,
        })
      : 0

  const readyToComplete =
    pos.cart.lines.length > 0 &&
    pos.busy === null &&
    !pos.rxNeeded &&
    summary.issue === null &&
    (summary.due_paise === 0 || (onCredit && khataAllowed && !(credit?.blocked ?? false)))

  useEffect(() => {
    if (tab === 'cash') requestAnimationFrame(() => cashRef.current?.focus())
  }, [tab])

  const addTender = useCallback(
    (tender: Omit<PosTender, 'id'>) => {
      const next = [...tenders, { ...tender, id: newId() }]
      setTenders(next)
      // Non-cash now covers the bill: the cash typed earlier is not being handed over.
      if (remainingForNonCash(total, next) === 0) setCash(null)
      setIssues([])
      setMessage(null)
    },
    [tenders, total],
  )

  const complete = useCallback(
    async (list: PosTender[] = all) => {
      setIssues([])
      setMessage(null)
      const outcome = await pos.completeSale(list, {
        credit_limit_override: override,
        accept_server_total: serverTotal !== null,
      })
      switch (outcome.status) {
        case 'done':
          return
        case 'blocked':
          setIssues(outcome.issues)
          if (outcome.issues.some((i) => i.code === 'rx_required')) setRxOpen(true)
          return
        case 'price_changed':
          setServerTotal(outcome.server_total_paise)
          return
        case 'needs_rx':
          setRxOpen(true)
          return
        case 'error':
          setMessage(outcome.message)
          return
      }
    },
    [all, pos, override, serverTotal],
  )

  const exactCash = (): void => {
    setCash(needCash)
    void complete([...nonCash, { id: 'cash', method: 'cash', amount_paise: needCash }])
  }

  const onUpiPaid = useCallback(
    (paid: {
      amount_paise: number
      payment_intent_id?: string
      provider_account_id?: string
      reference?: string
    }) => {
      const next = [...tenders, { id: newId(), method: 'upi' as const, ...paid }]
      setTenders(next)
      // Cash still part of the payment (₹500 cash + rest by UPI) stays; otherwise it is dropped.
      const keptCash =
        remainingForNonCash(total, next) > 0 && cash !== null && cash > 0 ? cash : null
      setCash(keptCash)
      setIssues([])
      setMessage(null)
      const full: PosTender[] = keptCash
        ? [...next, { id: 'cash', method: 'cash', amount_paise: keptCash }]
        : next
      const after = summarizeTenders(total, full)
      // Auto-complete when the UPI payment settles the bill (settings.payments.upi_auto_complete).
      if (
        paid.payment_intent_id &&
        settings?.payments.upi_auto_complete !== false &&
        after.due_paise === 0 &&
        after.issue === null
      ) {
        setTimeout(() => void complete(full), 0)
      }
      setTab('cash')
    },
    [tenders, cash, settings, total, complete],
  )

  useHotkeys(
    {
      F8: () => setTab('cash'),
      F9: () => exactCash(),
      F10: () => setTab('upi'),
      'F12, ctrl+enter': () => {
        if (readyToComplete) void complete()
      },
    },
    { scope: 'dialog', enabled: !rxOpen, allowInInputs: true },
  )

  const tabs: Array<{
    id: Tab
    icon: React.ReactNode
    label: string
    show: boolean
    key?: string
  }> = [
    { id: 'cash', icon: <Banknote />, label: t('payment.cash'), show: true, key: 'F8' },
    { id: 'upi', icon: <QrCode />, label: t('payment.upi'), show: true, key: 'F10' },
    { id: 'card', icon: <CreditCard />, label: t('payment.card'), show: pos.online },
    { id: 'credit', icon: <BookUser />, label: t('payment.khata'), show: khataAllowed },
    {
      id: 'advance',
      icon: <Wallet />,
      label: t('payment.advance'),
      show: advanceAvailable > 0 && pos.online,
    },
    {
      id: 'points',
      icon: <Gift />,
      label: t('payment.points'),
      show: loyaltyOn && (customer?.loyalty_points ?? 0) > 0,
    },
  ]

  const lng = getLanguage()
  return (
    <DialogRoot open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        size="xl"
        className="max-h-[calc(100dvh-1rem)]"
        aria-describedby={undefined}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-baseline gap-x-3">
            {t('payment.title')}
            <span className="text-2xl font-extrabold tabular-nums">{formatMoney(total)}</span>
            {customer ? (
              <span className="text-sm font-normal text-muted-foreground">{customer.name}</span>
            ) : null}
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="grid gap-4 md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          {/* ---- left: methods ---- */}
          <div className="flex min-w-0 flex-col gap-3">
            <div
              className="grid grid-cols-[repeat(auto-fit,minmax(4.5rem,1fr))] gap-2"
              role="tablist"
              aria-label={t('payment.methods')}
            >
              {tabs
                .filter((x) => x.show)
                .map((x) => (
                  <button
                    key={x.id}
                    type="button"
                    role="tab"
                    aria-selected={tab === x.id}
                    onClick={() => setTab(x.id)}
                    className={cn(
                      'flex min-h-16 flex-col items-center justify-center gap-1 rounded-lg border px-2 py-2 text-sm font-semibold transition-colors [&_svg]:size-5',
                      tab === x.id
                        ? 'border-primary bg-primary text-primary-foreground shadow-card'
                        : 'border-border bg-surface hover:bg-surface-2',
                    )}
                  >
                    {x.icon}
                    <span className="leading-tight">{x.label}</span>
                  </button>
                ))}
            </div>

            {tab === 'cash' ? (
              <div className="flex flex-col gap-3">
                <label htmlFor="pos-cash" className="text-sm font-medium">
                  {t('payment.cash_received')}
                </label>
                <MoneyInput
                  id="pos-cash"
                  ref={cashRef}
                  size="xl"
                  value={cash}
                  onChange={setCash}
                  className="text-2xl font-bold"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && readyToComplete) {
                      e.preventDefault()
                      void complete()
                    }
                  }}
                />
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                  {QUICK_NOTES_PAISE.map((n) => (
                    <Button
                      key={n}
                      variant="outline"
                      size="lg"
                      onClick={() => setCash((c) => (c ?? 0) + n)}
                    >
                      +{formatMoney(n, { decimals: 0 })}
                    </Button>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    size="lg"
                    onClick={exactCash}
                    disabled={needCash <= 0}
                  >
                    {t('payment.exact', { amount: formatMoney(needCash) })} <Kbd combo="F9" />
                  </Button>
                  {suggestTendered(needCash).map((s) => (
                    <Button key={s} variant="outline" size="lg" onClick={() => setCash(s)}>
                      {formatMoney(s, { decimals: 0 })}
                    </Button>
                  ))}
                  {cash ? (
                    <Button variant="ghost" size="lg" onClick={() => setCash(null)}>
                      {t('payment.clear_cash')}
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}

            {tab === 'upi' ? <UpiPanel amountPaise={nonCashDefault} onPaid={onUpiPaid} /> : null}

            {tab === 'card' ? (
              <div className="flex flex-col gap-3">
                <label htmlFor="pos-card-amount" className="text-sm font-medium">
                  {t('payment.card_amount')}
                </label>
                <MoneyInput
                  id="pos-card-amount"
                  size="lg"
                  value={cardAmount ?? nonCashDefault}
                  onChange={setCardAmount}
                />
                <label htmlFor="pos-card-ref" className="text-sm font-medium">
                  {t('payment.approval_code')}
                </label>
                <Input
                  id="pos-card-ref"
                  size="lg"
                  value={cardRef}
                  onChange={(e) => setCardRef(e.target.value)}
                  maxLength={100}
                />
                <Button
                  size="lg"
                  disabled={
                    (cardAmount ?? nonCashDefault) <= 0 ||
                    (cardAmount ?? nonCashDefault) > leftForNonCash
                  }
                  onClick={() => {
                    addTender({
                      method: 'card',
                      amount_paise: cardAmount ?? nonCashDefault,
                      ...(cardRef.trim() ? { reference: cardRef.trim() } : {}),
                    })
                    setCardAmount(null)
                    setCardRef('')
                    setTab('cash')
                  }}
                >
                  {t('payment.add_card')}
                </Button>
              </div>
            ) : null}

            {tab === 'advance' && customer ? (
              <div className="flex flex-col gap-3">
                <p className="text-sm">
                  {t('payment.advance_available', { amount: formatMoney(advanceAvailable) })}
                </p>
                <MoneyInput
                  size="lg"
                  value={advanceAmount ?? Math.min(advanceAvailable, leftForNonCash)}
                  onChange={setAdvanceAmount}
                  aria-label={t('payment.advance')}
                />
                <Button
                  size="lg"
                  onClick={() => {
                    const amount = Math.min(
                      advanceAmount ?? Math.min(advanceAvailable, leftForNonCash),
                      advanceAvailable,
                      leftForNonCash,
                    )
                    if (amount > 0) addTender({ method: 'store_credit', amount_paise: amount })
                    setAdvanceAmount(null)
                    setTab('cash')
                  }}
                >
                  {t('payment.use_advance')}
                </Button>
              </div>
            ) : null}

            {tab === 'points' && customer && settings ? (
              <PointsPanel
                available={customer.loyalty_points}
                max={maxPoints}
                current={pos.cart.loyalty_redeem_points}
                pointValuePaise={settings.loyalty.point_value_paise}
                minPoints={settings.loyalty.min_redeem_points}
                onApply={(p) => {
                  pos.dispatch({ type: 'set_loyalty', points: p })
                  setServerTotal(null)
                  setTab('cash')
                }}
              />
            ) : null}

            {tab === 'credit' && customer ? (
              <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <span className="text-muted-foreground">{t('payment.due_now')}</span>
                  <span className="text-end tabular-nums">
                    {formatMoney(Math.max(0, customer.balance_paise))}
                  </span>
                  <span className="text-muted-foreground">{t('payment.this_bill_credit')}</span>
                  <span className="text-end font-semibold tabular-nums">
                    {formatMoney(summary.due_paise)}
                  </span>
                  <span className="text-muted-foreground">{t('payment.new_due')}</span>
                  <span className="text-end font-bold tabular-nums">
                    {formatMoney(customer.balance_paise + summary.due_paise)}
                  </span>
                  <span className="text-muted-foreground">{t('payment.credit_limit')}</span>
                  <span className="text-end tabular-nums">
                    {customer.credit_limit_paise === null
                      ? t('payment.no_limit')
                      : formatMoney(customer.credit_limit_paise)}
                  </span>
                </div>
                {credit?.over_limit ? (
                  <div className="flex items-start gap-2 rounded-md bg-warning-soft p-2 text-sm text-warning-soft-foreground">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                    <span>{t('payment.over_limit')}</span>
                  </div>
                ) : null}
                {credit?.over_limit && settings?.credit.block_over_limit ? (
                  <Checkbox
                    checked={override}
                    onCheckedChange={(v) => setOverride(v === true)}
                    label={t('payment.override_limit')}
                    description={t('payment.override_limit_hint')}
                  />
                ) : null}
                <Button
                  size="lg"
                  variant={onCredit ? 'secondary' : 'primary'}
                  onClick={() => setOnCredit((v) => !v)}
                  disabled={summary.due_paise <= 0 && !onCredit}
                >
                  {onCredit
                    ? t('payment.credit_selected')
                    : t('payment.put_on_credit', { amount: formatMoney(summary.due_paise) })}
                </Button>
              </div>
            ) : null}
          </div>

          {/* ---- right: summary ---- */}
          <div className="flex min-w-0 flex-col gap-3 rounded-xl bg-surface-2 p-4">
            {serverTotal !== null ? (
              <div
                className="flex items-start gap-2 rounded-md bg-warning-soft p-2 text-sm text-warning-soft-foreground"
                role="alert"
              >
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>
                  {t('payment.price_changed', {
                    from: formatMoney(localTotal),
                    to: formatMoney(serverTotal),
                  })}
                </span>
              </div>
            ) : null}
            <dl className="flex flex-col gap-1 text-sm">
              <div className="flex justify-between">
                <dt>{t('payment.bill_total')}</dt>
                <dd className="font-semibold tabular-nums">{formatMoney(total)}</dd>
              </div>
              {all.map((x) => (
                <div key={x.id} className="flex items-center justify-between gap-2">
                  <dt className="flex min-w-0 items-center gap-1.5">
                    <Badge tone="neutral" size="sm">
                      {PAYMENT_METHOD_LABELS[x.method][lng]}
                    </Badge>
                    {x.reference ? (
                      <span className="truncate text-xs text-muted-foreground">{x.reference}</span>
                    ) : null}
                  </dt>
                  <dd className="flex items-center gap-1 tabular-nums">
                    {formatMoney(x.amount_paise)}
                    <IconButton
                      icon={<Trash2 />}
                      size="sm"
                      label={t('payment.remove_tender')}
                      onClick={() =>
                        x.method === 'cash'
                          ? setCash(null)
                          : setTenders((l) => l.filter((y) => y.id !== x.id))
                      }
                    />
                  </dd>
                </div>
              ))}
            </dl>
            <div className="border-t border-border pt-3">
              {summary.change_paise > 0 ? (
                <div className="text-center">
                  <div className="text-sm font-medium text-muted-foreground">
                    {t('payment.change')}
                  </div>
                  <div
                    className="text-6xl font-extrabold tabular-nums text-success"
                    data-testid="pos-change"
                  >
                    {formatMoney(summary.change_paise)}
                  </div>
                </div>
              ) : summary.due_paise > 0 ? (
                <div className="text-center">
                  <div className="text-sm font-medium text-muted-foreground">
                    {onCredit ? t('payment.on_credit') : t('payment.balance_to_pay')}
                  </div>
                  <div
                    className={cn(
                      'text-5xl font-extrabold tabular-nums',
                      onCredit ? 'text-accent-soft-foreground' : 'text-danger',
                    )}
                  >
                    {formatMoney(summary.due_paise)}
                  </div>
                </div>
              ) : (
                <div className="text-center text-lg font-bold text-success">
                  {t('payment.fully_paid')}
                </div>
              )}
            </div>
            {pos.rxNeeded ? (
              <div className="flex items-center justify-between gap-2 rounded-md bg-danger-soft p-2 text-sm text-danger-soft-foreground">
                <span>{t('payment.rx_needed')}</span>
                <Button size="sm" variant="danger" onClick={() => setRxOpen(true)}>
                  {t('payment.enter_rx')}
                </Button>
              </div>
            ) : null}
            {!pos.online ? (
              <p className="text-xs text-muted-foreground">{t('payment.offline_note')}</p>
            ) : null}
            {summary.issue ? (
              <p className="text-sm text-danger" role="alert">
                {summary.issue.code === 'tender_exceeds_due'
                  ? t('payment.tender_exceeds_due')
                  : t('payment.cash_not_needed')}
              </p>
            ) : null}
            {issues.length || message ? (
              <ul
                className="flex flex-col gap-1 rounded-md border border-danger bg-danger-soft p-2 text-sm text-danger-soft-foreground"
                role="alert"
              >
                {message ? <li>{message}</li> : null}
                {issues.map((i) => (
                  <li key={`${i.code}-${i.line_key ?? ''}`}>
                    {issueMessage(
                      i,
                      pos.cart.lines.find(
                        (l) => l.key === i.line_key || i.line_key?.startsWith(`${l.key}#`),
                      )?.product.name,
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" size="lg" onClick={onClose}>
            {t('payment.back')}
          </Button>
          <Button
            size="xl"
            variant="primary"
            leftIcon={<Printer />}
            disabled={!readyToComplete}
            loading={pos.busy === 'checkout'}
            onClick={() => void complete()}
            className="sm:min-w-64"
          >
            {serverTotal !== null
              ? t('payment.complete_new_total', { amount: formatMoney(serverTotal) })
              : t('payment.complete')}
            <Kbd combo="F12" className="border-white/30 bg-white/15 text-current" />
          </Button>
          {/* Phones: the summary scrolls below the methods, so the change / balance shows here (top of the reversed column). */}
          {summary.change_paise > 0 || summary.due_paise > 0 ? (
            <div
              className="flex items-baseline justify-between gap-3 sm:order-first sm:me-auto md:hidden"
              aria-hidden
            >
              <span className="text-sm font-medium text-muted-foreground">
                {summary.change_paise > 0
                  ? t('payment.change')
                  : onCredit
                    ? t('payment.on_credit')
                    : t('payment.balance_to_pay')}
              </span>
              <span
                className={cn(
                  'text-2xl font-extrabold tabular-nums',
                  summary.change_paise > 0
                    ? 'text-success'
                    : onCredit
                      ? 'text-accent-soft-foreground'
                      : 'text-danger',
                )}
              >
                {formatMoney(summary.change_paise > 0 ? summary.change_paise : summary.due_paise)}
              </span>
            </div>
          ) : null}
        </DialogFooter>
        {rxOpen ? <RxDialog onClose={() => setRxOpen(false)} /> : null}
      </DialogContent>
    </DialogRoot>
  )
}

function PointsPanel({
  available,
  max,
  current,
  pointValuePaise,
  minPoints,
  onApply,
}: {
  available: number
  max: number
  current: number
  pointValuePaise: number
  minPoints: number
  onApply: (points: number) => void
}) {
  const { t } = useTranslation('pos')
  const [points, setPoints] = useState<number | null>(current || max || null)
  const value = (points ?? 0) * pointValuePaise
  const invalid = points !== null && points > 0 && (points < minPoints || points > max)
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">
        {t('payment.points_available', {
          points: available,
          amount: formatMoney(available * pointValuePaise),
        })}
      </p>
      {max === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('payment.points_min', { points: minPoints })}
        </p>
      ) : null}
      <NumberInput
        value={points}
        onChange={setPoints}
        min={0}
        max={max}
        size="lg"
        aria-label={t('payment.points')}
        aria-invalid={invalid}
      />
      <p className="text-sm text-muted-foreground">
        {t('payment.points_value', { amount: formatMoney(value) })}
      </p>
      <div className="flex gap-2">
        <Button size="lg" disabled={invalid || max === 0} onClick={() => onApply(points ?? 0)}>
          {t('payment.redeem')}
        </Button>
        {current > 0 ? (
          <Button size="lg" variant="ghost" onClick={() => onApply(0)}>
            {t('payment.remove_points')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
