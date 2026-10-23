/**
 * Profile tab of the khata page: buying insights from GET /customers/:id/summary (lifetime sales,
 * bills, average bill, last 12 months, favourite items, open payment links) and every stored
 * detail, with edit / deactivate / delete for users who may change customers.
 */
import { Link2, Pencil, RotateCcw, Trash2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CUSTOMER_TYPE_LABELS,
  type Customer,
  type CustomerSummary,
  PRICE_TIER_LABELS,
} from '@kadai/shared/api/parties'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CopyButton,
  Skeleton,
  Stat,
  statusTone,
} from '@/components/ui'
import { useMe } from '@/lib/auth'
import { cn } from '@/lib/cn'
import {
  formatDate,
  formatDateTime,
  formatMoney,
  formatNumber,
  formatPhone,
  formatQty,
} from '@/lib/format'
import { formatAddress, langOf, pickLabel, stateName } from '../lib/labels'

export function CustomerProfile({
  customer,
  summary,
  summaryLoading,
  canWrite,
  onEdit,
  onDelete,
  onReactivate,
}: {
  customer: Customer
  summary: CustomerSummary | undefined
  summaryLoading: boolean
  canWrite: boolean
  onEdit: () => void
  onDelete: () => void
  onReactivate: () => void
}) {
  const { t, i18n } = useTranslation(['parties', 'common'])
  const me = useMe()
  const lang = langOf(i18n.language)
  const address = formatAddress(customer.address, lang)
  const defaultDays = me?.settings.credit.default_credit_days ?? 30

  const details: { label: string; value: ReactNode }[] = [
    { label: t('fields.phone'), value: customer.phone ? formatPhone(customer.phone, true) : null },
    { label: t('fields.alt_phone'), value: customer.alt_phone },
    { label: t('fields.email'), value: customer.email },
    {
      label: t('fields.customer_type'),
      value: pickLabel(CUSTOMER_TYPE_LABELS[customer.customer_type], lang),
    },
    {
      label: t('fields.price_tier'),
      value: pickLabel(PRICE_TIER_LABELS[customer.price_tier], lang),
    },
    {
      label: t('fields.gstin'),
      value: customer.gstin ? (
        <span className="inline-flex items-center gap-1 font-mono">
          {customer.gstin}
          <CopyButton value={customer.gstin} />
        </span>
      ) : null,
    },
    { label: t('fields.state'), value: stateName(customer.state_code, lang) || null },
    { label: t('fields.address'), value: address || null },
    {
      label: t('fields.credit_limit'),
      value:
        customer.credit_limit_paise === null
          ? t('credit.no_limit')
          : formatMoney(customer.credit_limit_paise),
    },
    {
      label: t('fields.credit_days'),
      value:
        customer.credit_days === null
          ? t('profile.default_days', { days: defaultDays })
          : t('profile.days', { count: customer.credit_days }),
    },
    {
      label: t('profile.opening'),
      value:
        customer.opening_balance_paise === 0
          ? null
          : `${formatMoney(Math.abs(customer.opening_balance_paise))} · ${
              customer.opening_balance_paise > 0 ? t('balance.due') : t('balance.advance')
            }`,
    },
    {
      label: t('fields.date_of_birth'),
      value: customer.date_of_birth ? formatDate(customer.date_of_birth) : null,
    },
    {
      label: t('fields.anniversary'),
      value: customer.anniversary ? formatDate(customer.anniversary) : null,
    },
    {
      label: t('fields.whatsapp_opt_in'),
      value: customer.whatsapp_opt_in ? t('profile.whatsapp_yes') : t('profile.whatsapp_no'),
    },
    { label: t('fields.code'), value: customer.code },
    {
      label: t('fields.tags'),
      value: customer.tags.length ? (
        <span className="flex flex-wrap gap-1">
          {customer.tags.map((tag) => (
            <Badge key={tag} size="sm" appearance="outline">
              #{tag}
            </Badge>
          ))}
        </span>
      ) : null,
    },
    { label: t('fields.notes'), value: customer.notes },
    { label: t('profile.customer_since'), value: formatDate(customer.created_at) },
  ]

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
      <div className="grid content-start gap-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat
            label={t('profile.lifetime_sales')}
            value={summary ? formatMoney(summary.lifetime_sales_paise, { decimals: 0 }) : '—'}
            loading={summaryLoading}
          />
          <Stat
            label={t('profile.bills')}
            value={summary ? formatNumber(summary.invoice_count) : '—'}
            loading={summaryLoading}
          />
          <Stat
            label={t('profile.average_bill')}
            value={summary ? formatMoney(summary.average_bill_paise, { decimals: 0 }) : '—'}
            loading={summaryLoading}
          />
          <Stat
            label={t('profile.returns')}
            value={summary ? formatMoney(summary.returns_paise, { decimals: 0 }) : '—'}
            loading={summaryLoading}
          />
        </div>

        <Card>
          <CardHeader>
            <CardTitle>{t('profile.last_12_months')}</CardTitle>
          </CardHeader>
          <CardContent>
            {summaryLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : (
              <MonthlyBars summary={summary} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('profile.top_items')}</CardTitle>
          </CardHeader>
          <CardContent>
            {summaryLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : summary && summary.top_items.length > 0 ? (
              <ol className="grid gap-2">
                {summary.top_items.map((item, i) => (
                  <li
                    key={`${item.product_id ?? item.name}-${i}`}
                    className="flex items-center justify-between gap-3 text-sm"
                  >
                    <span className="min-w-0 truncate">
                      <span className="me-2 text-muted-foreground tabular-nums">{i + 1}.</span>
                      {lang === 'ta' && item.name_ta ? item.name_ta : item.name}
                    </span>
                    <span className="shrink-0 text-end text-xs text-muted-foreground tabular-nums">
                      {formatQty(item.qty_milli, item.unit)} ·{' '}
                      {formatMoney(item.amount_paise, { decimals: 0 })}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-muted-foreground">{t('profile.no_items')}</p>
            )}
          </CardContent>
        </Card>

        {summary && summary.open_payment_links.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>{t('profile.open_links')}</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="grid gap-2">
                {summary.open_payment_links.map((l) => (
                  <li
                    key={l.id}
                    className="flex flex-wrap items-center justify-between gap-2 text-sm"
                  >
                    <span className="inline-flex items-center gap-2">
                      <Link2 className="size-4 text-muted-foreground" aria-hidden />
                      <span className="font-semibold tabular-nums">
                        {formatMoney(l.amount_paise)}
                      </span>
                      <Badge size="sm" tone={statusTone(l.status)}>
                        {t(`link.status.${l.status}`)}
                      </Badge>
                    </span>
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      {l.expires_at
                        ? t('link.valid_till', { when: formatDateTime(l.expires_at) })
                        : formatDateTime(l.created_at)}
                      {l.short_url ? <CopyButton value={l.short_url} /> : null}
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ) : null}
      </div>

      <Card className="content-start">
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>{t('profile.details')}</CardTitle>
          {canWrite ? (
            <Button variant="outline" size="sm" leftIcon={<Pencil />} onClick={onEdit}>
              {t('common:actions.edit')}
            </Button>
          ) : null}
        </CardHeader>
        <CardContent>
          <dl className="grid gap-0 text-sm">
            {details
              .filter((d) => d.value !== null && d.value !== undefined && d.value !== '')
              .map((d) => (
                <div
                  key={d.label}
                  className="grid grid-cols-[40%_1fr] gap-3 border-b border-border py-2 last:border-0"
                >
                  <dt className="text-muted-foreground">{d.label}</dt>
                  <dd className="min-w-0 break-words">{d.value}</dd>
                </div>
              ))}
          </dl>
          {canWrite ? (
            <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-4">
              {customer.is_active ? (
                <Button
                  variant="ghost"
                  className="text-danger"
                  leftIcon={<Trash2 />}
                  onClick={onDelete}
                >
                  {t('profile.delete')}
                </Button>
              ) : (
                <Button variant="outline" leftIcon={<RotateCcw />} onClick={onReactivate}>
                  {t('profile.reactivate')}
                </Button>
              )}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}

function MonthlyBars({ summary }: { summary: CustomerSummary | undefined }) {
  const { t, i18n } = useTranslation('parties')
  const months = summary?.monthly ?? []
  const max = Math.max(1, ...months.map((m) => m.sales_paise))
  if (months.every((m) => m.sales_paise === 0)) {
    return <p className="text-sm text-muted-foreground">{t('profile.no_sales_yet')}</p>
  }
  const fmt = new Intl.DateTimeFormat(i18n.language === 'en' ? 'en-IN' : 'ta-IN', {
    month: 'short',
  })
  return (
    <ol className="flex h-36 items-end gap-1.5" aria-label={t('profile.last_12_months')}>
      {months.map((m) => {
        const pct = Math.round((m.sales_paise * 100) / max)
        const label = fmt.format(new Date(`${m.period}-15T00:00:00Z`))
        return (
          <li
            key={m.period}
            className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1"
          >
            <div
              className={cn(
                'w-full rounded-t-sm',
                m.sales_paise > 0 ? 'bg-primary' : 'bg-surface-3',
              )}
              style={{ height: `${Math.max(pct, 2)}%` }}
              title={`${label}: ${formatMoney(m.sales_paise)} · ${m.invoice_count}`}
            >
              <span className="sr-only">
                {label}: {formatMoney(m.sales_paise)}
              </span>
            </div>
            <span className="truncate text-[10px] text-muted-foreground">{label}</span>
          </li>
        )
      })}
    </ol>
  )
}
