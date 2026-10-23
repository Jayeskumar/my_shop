/**
 * On-screen X (shift so far) / Z (shift closing) report: sales of the shift, payments in / out by
 * method, the cash drawer reconciliation (opening → expected → counted → short / excess), the
 * note count, cash in / out entries, cancelled bills, returns, discounts and the top items. The
 * printed version (thermal 80 mm / A4) is built from the same data in lib/print.
 */
import type { ShiftDetail } from '@kadai/shared/api/accounting'
import { DENOMINATION_NOTES, shiftDifference } from '@kadai/shared/api/accounting'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Badge, Card } from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatDateTime, formatMoney, formatQty, formatTime } from '@/lib/format'
import { localizedName } from '@/lib/i18n'
import { cashEntryKindLabel, differenceLabel, paymentMethodLabel } from '../lib/labels'

function Section({
  title,
  children,
  className,
}: {
  title: string
  children: ReactNode
  className?: string
}) {
  return (
    <Card className={cn('p-4', className)}>
      <h2 className="mb-2 text-sm font-semibold">{title}</h2>
      {children}
    </Card>
  )
}

function Line({
  label,
  value,
  strong,
  sign,
  muted,
}: {
  label: ReactNode
  value: ReactNode
  strong?: boolean
  sign?: '+' | '−'
  muted?: boolean
}) {
  return (
    <div
      className={cn(
        'flex items-baseline justify-between gap-3 py-1 text-sm',
        strong && 'border-t border-border pt-2 font-semibold',
        muted && 'text-muted-foreground',
      )}
    >
      <dt className="min-w-0">
        {sign ? <span className="me-1 inline-block w-3 text-muted-foreground">{sign}</span> : null}
        {label}
      </dt>
      <dd className="shrink-0 text-end tabular-nums">{value}</dd>
    </div>
  )
}

export function ShiftReport({ shift }: { shift: ShiftDetail }) {
  const { t } = useTranslation(['accounting', 'common'])
  const s = shift.summary
  const cash = s.cash
  const diff =
    cash.counted_cash_paise !== null
      ? shiftDifference(cash.expected_cash_paise, cash.counted_cash_paise)
      : null
  const d = shift.denominations

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Section title={t('shift_report.sales')}>
        <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div>
            <div className="text-xs text-muted-foreground">{t('shift_report.net_sales')}</div>
            <div className="text-xl font-semibold tabular-nums">
              {formatMoney(s.bills.total_paise)}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">{t('shift_report.bills')}</div>
            <div className="text-xl font-semibold tabular-nums">{s.bills.count}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">{t('shift_report.avg_bill')}</div>
            <div className="text-xl font-semibold tabular-nums">
              {formatMoney(s.bills.avg_bill_paise, { decimals: 'auto' })}
            </div>
          </div>
        </div>
        <dl>
          <Line label={t('shift_report.gross')} value={formatMoney(s.bills.gross_paise)} />
          <Line
            label={t('shift_report.discounts')}
            value={formatMoney(s.bills.discount_paise)}
            sign="−"
          />
          <Line label={t('shift_report.taxable')} value={formatMoney(s.bills.taxable_paise)} />
          <Line label={t('shift_report.tax')} value={formatMoney(s.bills.tax_paise)} sign="+" />
          <Line label={t('shift_report.round_off')} value={formatMoney(s.bills.round_off_paise)} />
          <Line
            label={t('shift_report.net_sales')}
            value={formatMoney(s.bills.total_paise)}
            strong
          />
          <Line
            label={t('shift_report.credit_given')}
            value={formatMoney(s.bills.credit_paise)}
            muted
          />
          <Line label={t('shift_report.items_sold')} value={String(s.bills.item_lines)} muted />
        </dl>
      </Section>

      <Section title={t('shift_report.drawer')}>
        <dl>
          <Line label={t('shifts.cash.opening')} value={formatMoney(cash.opening_cash_paise)} />
          <Line
            label={t('shifts.cash.receipts')}
            value={formatMoney(cash.cash_receipts_paise)}
            sign="+"
          />
          <Line
            label={t('shifts.cash.payments')}
            value={formatMoney(cash.cash_payments_paise)}
            sign="−"
          />
          <Line label={t('shifts.cash.pay_ins')} value={formatMoney(cash.pay_ins_paise)} sign="+" />
          <Line
            label={t('shifts.cash.pay_outs')}
            value={formatMoney(cash.pay_outs_paise)}
            sign="−"
          />
          <Line
            label={t('shifts.cash.expenses')}
            value={formatMoney(cash.cash_expenses_paise)}
            sign="−"
          />
          <Line
            label={t('shifts.cash.expected')}
            value={formatMoney(cash.expected_cash_paise)}
            strong
          />
          {cash.counted_cash_paise !== null ? (
            <Line label={t('shifts.cash.counted')} value={formatMoney(cash.counted_cash_paise)} />
          ) : null}
        </dl>
        {diff ? (
          <div
            className={cn(
              'mt-2 flex items-center justify-between rounded-lg px-3 py-2',
              diff.status === 'short' && 'bg-danger-soft text-danger-soft-foreground',
              diff.status === 'excess' && 'bg-warning-soft text-warning-soft-foreground',
              diff.status === 'balanced' && 'bg-success-soft text-success-soft-foreground',
            )}
          >
            <span className="text-sm font-medium">
              {t('shifts.cash.difference')} · {differenceLabel(diff.status)}
            </span>
            <span className="font-semibold tabular-nums">
              {diff.difference_paise > 0 ? '+' : ''}
              {formatMoney(diff.difference_paise)}
            </span>
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">
            {t('shift_report.live_hint', { time: formatTime(s.generated_at) })}
          </p>
        )}
        {d ? (
          <div className="mt-3 border-t border-border pt-2">
            <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('shift_report.denominations')}
            </h3>
            <ul className="grid grid-cols-2 gap-x-4 text-sm sm:grid-cols-3">
              {DENOMINATION_NOTES.filter((n) => d[`${n}`] > 0).map((n) => (
                <li key={n} className="flex justify-between gap-2 tabular-nums">
                  <span>
                    ₹{n} × {d[`${n}`]}
                  </span>
                  <span className="text-muted-foreground">
                    {formatMoney(d[`${n}`] * n * 100, { decimals: 'auto' })}
                  </span>
                </li>
              ))}
              {d.coins > 0 ? (
                <li className="flex justify-between gap-2 tabular-nums">
                  <span>{t('denominations.coins_short')}</span>
                  <span className="text-muted-foreground">
                    {formatMoney(d.coins, { decimals: 'auto' })}
                  </span>
                </li>
              ) : null}
            </ul>
          </div>
        ) : null}
      </Section>

      <Section title={t('shift_report.payments')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('shift_report.payments_in')}
            </h3>
            {s.payments_in.length ? (
              <dl>
                {s.payments_in.map((p) => (
                  <Line
                    key={p.method}
                    label={`${paymentMethodLabel(p.method)} (${p.count})`}
                    value={formatMoney(p.amount_paise)}
                  />
                ))}
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">{t('shift_report.none')}</p>
            )}
          </div>
          <div>
            <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('shift_report.payments_out')}
            </h3>
            {s.payments_out.length ? (
              <dl>
                {s.payments_out.map((p) => (
                  <Line
                    key={p.method}
                    label={`${paymentMethodLabel(p.method)} (${p.count})`}
                    value={formatMoney(p.amount_paise)}
                  />
                ))}
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">{t('shift_report.none')}</p>
            )}
          </div>
        </div>
        <dl className="mt-2 border-t border-border pt-1">
          <Line
            label={t('shift_report.dues_collected')}
            value={formatMoney(s.dues_collected_paise)}
          />
          <Line
            label={t('shift_report.returns', { count: s.returns.count })}
            value={formatMoney(s.returns.total_paise)}
          />
          <Line
            label={t('shift_report.discount_split', {
              item: formatMoney(s.discounts.item_paise),
              bill: formatMoney(s.discounts.bill_paise),
            })}
            value={formatMoney(s.discounts.total_paise)}
          />
          <Line
            label={t('shift_report.expenses', { count: s.expenses.count })}
            value={formatMoney(s.expenses.cash_paise)}
          />
        </dl>
      </Section>

      <Section title={t('shift_report.cash_entries')}>
        {shift.cash_entries.length ? (
          <ul className="flex flex-col divide-y divide-border">
            {shift.cash_entries.map((e) => (
              <li key={e.id} className="flex items-start justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Badge tone={e.kind === 'pay_in' ? 'success' : 'warning'} size="sm">
                      {cashEntryKindLabel(e.kind)}
                    </Badge>
                    <span className="truncate">{e.reason}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {[formatTime(e.created_at), e.created_by_name, e.account_name]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </div>
                <span className="shrink-0 font-medium tabular-nums">
                  {e.kind === 'pay_out' ? '−' : '+'}
                  {formatMoney(e.amount_paise)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t('shift_report.no_cash_entries')}</p>
        )}
      </Section>

      {s.cancelled_bills.count > 0 ? (
        <Section title={t('shift_report.cancelled', { count: s.cancelled_bills.count })}>
          <ul className="flex flex-col divide-y divide-border">
            {s.cancelled_bills.items.map((c) => (
              <li
                key={c.invoice_id}
                className="flex items-start justify-between gap-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <Link
                    to={`/sales/invoices/${c.invoice_id}`}
                    className="font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {c.number ?? '—'}
                  </Link>
                  <div className="text-xs text-muted-foreground">
                    {[c.reason, c.cancelled_by_name].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <span className="shrink-0 tabular-nums">{formatMoney(c.total_paise)}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section
        title={t('shift_report.top_items')}
        className={s.cancelled_bills.count > 0 ? undefined : 'lg:col-span-2'}
      >
        {s.top_items.length ? (
          <ol className="flex flex-col divide-y divide-border">
            {s.top_items.map((i, index) => (
              <li
                key={`${i.product_id ?? i.name}-${index}`}
                className="flex items-baseline justify-between gap-3 py-1.5 text-sm"
              >
                <span className="min-w-0 truncate">
                  <span className="me-2 inline-block w-5 text-end text-muted-foreground tabular-nums">
                    {index + 1}.
                  </span>
                  {localizedName(i.name, i.name_ta)}
                  <span className="ms-2 text-xs text-muted-foreground">
                    {formatQty(i.qty_milli, i.unit)}
                  </span>
                </span>
                <span className="shrink-0 tabular-nums">{formatMoney(i.total_paise)}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">{t('shift_report.none')}</p>
        )}
      </Section>

      {shift.notes ? (
        <Section title={t('fields.notes')} className="lg:col-span-2">
          <p className="whitespace-pre-line text-sm">{shift.notes}</p>
        </Section>
      ) : null}

      <p className="text-xs text-muted-foreground lg:col-span-2">
        {t('shift_report.generated', { report: s.report, time: formatDateTime(s.generated_at) })}
      </p>
    </div>
  )
}
