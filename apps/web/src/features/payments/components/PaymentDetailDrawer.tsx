/**
 * Receipt / payment voucher detail (GET /payments/:id) in a side drawer (/payments?id=…):
 * amount, party, method & reference, UPI details, what it settled (allocations with document
 * links and current dues) and the advance left; print a bilingual receipt; cancel a manual
 * payment (POS tenders and return settlements are cancelled with their document).
 */
import { Ban, Printer } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { documentPath } from '@kadai/shared/api/identity'
import { isPaymentCancellable } from '@kadai/shared/api/payments'
import { Badge, Button, Drawer, Skeleton } from '@/components/ui'
import { useCan } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { formatDate, formatDateTime, formatMoney } from '@/lib/format'
import { usePayment } from '../api'
import { methodLabel, signedAmount } from '../lib/labels'
import { usePrintReceipt } from '../lib/use-print-receipt'
import { CancelPaymentDialog } from './CancelPaymentDialog'
import { PaymentMethodIcon } from './PaymentMethodIcon'
import { PaymentStatusBadge } from './StatusBadges'

export function PaymentDetailDrawer({
  paymentId,
  onOpenChange,
}: {
  paymentId: string | null
  onOpenChange: (open: boolean) => void
}) {
  const { t, i18n } = useTranslation(['payments', 'common'])
  const query = usePayment(paymentId)
  const payment = query.data?.data ?? null
  const print = usePrintReceipt()
  const [cancelOpen, setCancelOpen] = useState(false)
  const canCancel = useCan(payment?.direction === 'out' ? 'payments.pay' : 'payments.collect')
  const cancellable = payment ? isPaymentCancellable(payment) : false

  const title = payment
    ? (payment.number ??
      (payment.origin === 'sales_tender' ? t('origin.sales_tender') : t('detail.title_fallback')))
    : t('detail.title_fallback')

  return (
    <>
      <Drawer
        open={Boolean(paymentId)}
        onOpenChange={onOpenChange}
        title={title}
        description={
          payment
            ? t(payment.direction === 'in' ? 'direction.in_long' : 'direction.out_long')
            : undefined
        }
        className="sm:max-w-lg"
        footer={
          payment ? (
            <div className="flex w-full flex-wrap justify-end gap-2">
              {cancellable && canCancel ? (
                <Button
                  variant="outline"
                  className="text-danger"
                  leftIcon={<Ban />}
                  onClick={() => setCancelOpen(true)}
                >
                  {t('detail.cancel')}
                </Button>
              ) : null}
              <Button leftIcon={<Printer />} onClick={() => void print(payment)}>
                {payment.direction === 'in' ? t('detail.print_receipt') : t('detail.print_voucher')}
              </Button>
            </div>
          ) : null
        }
      >
        {query.isPending && paymentId ? (
          <div className="grid gap-3" aria-busy>
            <Skeleton className="h-10 w-40" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : query.isError ? (
          <div className="grid gap-3">
            <p className="text-sm text-danger">{t('detail.load_failed')}</p>
            <Button variant="outline" onClick={() => void query.refetch()}>
              {t('common:actions.retry')}
            </Button>
          </div>
        ) : payment ? (
          <div className="grid gap-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p
                className={cn(
                  'text-3xl font-bold tabular-nums',
                  payment.status === 'cancelled'
                    ? 'text-muted-foreground line-through'
                    : payment.direction === 'in'
                      ? 'text-success'
                      : 'text-danger',
                )}
                data-testid="payment-amount"
              >
                {formatMoney(signedAmount(payment.direction, payment.amount_paise), {
                  symbol: true,
                })}
              </p>
              <PaymentStatusBadge status={payment.status} />
            </div>

            {payment.status === 'cancelled' ? (
              <div className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-soft-foreground">
                <p className="font-medium">
                  {t('detail.cancelled_on', {
                    date: formatDateTime(payment.cancelled_at),
                    name: payment.cancelled_by_name ?? '',
                  })}
                </p>
                {payment.cancel_reason ? <p>{payment.cancel_reason}</p> : null}
              </div>
            ) : null}

            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
              <Fact label={payment.direction === 'in' ? t('fields.from') : t('fields.to')}>
                {payment.party_name && payment.party_id && payment.party_type ? (
                  <PartyLink type={payment.party_type} id={payment.party_id}>
                    {payment.party_name}
                  </PartyLink>
                ) : (
                  (payment.party_name ?? t('common:misc.walk_in'))
                )}
              </Fact>
              <Fact label={t('fields.date')}>
                {formatDate(payment.payment_date)}
                <span className="ms-2 text-muted-foreground">{formatDateTime(payment.paid_at)}</span>
              </Fact>
              <Fact label={t('fields.method')}>
                <span className="inline-flex items-center gap-1.5">
                  <PaymentMethodIcon method={payment.method} />
                  {methodLabel(payment.method, i18n.language)}
                </span>
              </Fact>
              {payment.reference ? (
                <Fact label={t('fields.reference')}>
                  <span className="font-mono">{payment.reference}</span>
                </Fact>
              ) : null}
              {payment.intent ? (
                <>
                  <Fact label={t('fields.upi_reference')}>
                    <span className="font-mono">{payment.intent.reference_code}</span>
                  </Fact>
                  {payment.intent.utr ? (
                    <Fact label={t('fields.utr')}>
                      <span className="font-mono">{payment.intent.utr}</span>
                    </Fact>
                  ) : null}
                  {payment.intent.payer_vpa ? (
                    <Fact label={t('fields.payer_vpa')}>
                      <span className="font-mono">{payment.intent.payer_vpa}</span>
                    </Fact>
                  ) : null}
                </>
              ) : null}
              <Fact label={t('fields.account')}>{payment.account_name}</Fact>
              <Fact label={t('fields.origin')}>{t(`origin.${payment.origin}`)}</Fact>
              {payment.created_by_name ? (
                <Fact label={t('fields.created_by')}>{payment.created_by_name}</Fact>
              ) : null}
              {payment.notes ? <Fact label={t('fields.notes')}>{payment.notes}</Fact> : null}
            </dl>

            <section className="grid gap-2" aria-labelledby="alloc-title">
              <h3 id="alloc-title" className="text-sm font-semibold">
                {t('detail.settled_title')}
              </h3>
              {payment.allocations.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('detail.no_allocations')}</p>
              ) : (
                <ul className="grid divide-y divide-border rounded-md border border-border">
                  {payment.allocations.map((a) => {
                    const path = documentPath(a.target_type, a.target_id)
                    const label =
                      a.target_type === 'opening_balance'
                        ? t('allocation.opening_balance')
                        : (a.document_number ?? t('allocation.unnumbered'))
                    return (
                      <li key={a.id} className="flex items-start justify-between gap-3 px-3 py-2 text-sm">
                        <div className="min-w-0">
                          <div className="truncate font-medium">
                            {path ? (
                              <Link to={path} className="text-primary hover:underline">
                                {label}
                              </Link>
                            ) : (
                              label
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {[
                              t(`target.${a.target_type}`),
                              a.document_date ? formatDate(a.document_date) : null,
                              a.document_total_paise !== null
                                ? t('detail.doc_total', { amount: formatMoney(a.document_total_paise) })
                                : null,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </div>
                        </div>
                        <div className="text-end">
                          <div className="font-medium tabular-nums">{formatMoney(a.amount_paise)}</div>
                          {a.document_due_paise !== null ? (
                            a.document_due_paise > 0 ? (
                              <div className="text-xs text-warning-soft-foreground">
                                {t('detail.still_due', { amount: formatMoney(a.document_due_paise) })}
                              </div>
                            ) : (
                              <Badge tone="success" size="sm">
                                {t('detail.cleared')}
                              </Badge>
                            )
                          ) : null}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
              {payment.unallocated_paise > 0 ? (
                <p className="flex justify-between gap-2 rounded-md bg-surface-2 px-3 py-2 text-sm">
                  <span>{t('detail.advance')}</span>
                  <span className="font-medium tabular-nums">
                    {formatMoney(payment.unallocated_paise)}
                  </span>
                </p>
              ) : null}
              {!cancellable && payment.status === 'completed' && payment.origin !== 'manual' ? (
                <p className="text-xs text-muted-foreground">{t(`detail.cancel_via.${payment.origin}`)}</p>
              ) : null}
            </section>
          </div>
        ) : null}
      </Drawer>
      <CancelPaymentDialog
        payment={cancelOpen ? payment : null}
        onOpenChange={setCancelOpen}
        onCancelled={() => void query.refetch()}
      />
    </>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  )
}

function PartyLink({
  type,
  id,
  children,
}: {
  type: 'customer' | 'supplier'
  id: string
  children: ReactNode
}) {
  const path = documentPath(type, id)
  return path ? (
    <Link to={path} className="font-medium text-primary hover:underline">
      {children}
    </Link>
  ) : (
    <span className="font-medium">{children}</span>
  )
}
