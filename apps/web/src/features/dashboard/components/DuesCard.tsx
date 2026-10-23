/**
 * Dues to collect (khata): total, overdue, the top debtors with a one-tap reminder — WhatsApp via
 * the shop's provider when the customer opted in and the plan has messaging, otherwise a wa.me
 * link with the ready message and UPI payment link — plus links to the dues list and report.
 */
import { notificationsRoutes } from '@kadai/shared/api/notifications'
import type { Dashboard } from '@kadai/shared/api/reports'
import { HandCoins, MessageCircle, PartyPopper } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  CardTitle,
  EmptyState,
  IconButton,
  Money,
  PhoneLink,
  Skeleton,
  notify,
} from '@/components/ui'
import { useCan, useFeature } from '@/lib/auth'
import { useRouteMutation } from '@/lib/query'
import { nameOf } from '@/features/reports/lib/labels'

type Debtor = Dashboard['receivables']['top_debtors'][number]

export function DuesCard({ receivables }: { receivables: Dashboard['receivables'] | null }) {
  const { t } = useTranslation('dashboard')
  const canRemind = useCan('customers.write')
  const canSeeCustomers = useCan('customers.read')
  const messaging = useFeature('notifications')
  const [pending, setPending] = useState<string | null>(null)
  const remind = useRouteMutation(notificationsRoutes.remindCustomer, {
    onError: (error) => notify.error(error),
  })

  const send = (debtor: Debtor): void => {
    const viaProvider = messaging && debtor.whatsapp_opt_in
    // wa.me must open in the click's own task, or the browser blocks the pop-up.
    const popup = viaProvider ? null : window.open('', '_blank')
    if (popup) popup.opener = null
    setPending(debtor.customer_id)
    remind.mutate(
      {
        params: { id: debtor.customer_id },
        body: { channel: viaProvider ? 'whatsapp' : 'wa_me', include_payment_link: true },
      },
      {
        onSuccess: (res) => {
          if (viaProvider) {
            notify.success(t('dues.reminder_sent', { name: nameOf(debtor.name, debtor.name_ta) }))
            return
          }
          const url = res.data.wa_me_url
          if (url && popup) popup.location.href = url
          else if (url) window.open(url, '_blank', 'noopener')
          else popup?.close()
        },
        onError: () => popup?.close(),
        onSettled: () => setPending(null),
      },
    )
  }

  return (
    <Card className="flex min-w-0 flex-col">
      <CardHeader className="pb-2">
        <CardTitle>{t('dues.title')}</CardTitle>
        {receivables ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Money paise={receivables.total_paise} decimals={0} className="text-2xl font-bold" />
            {receivables.overdue_paise > 0 ? (
              <Badge tone="danger" size="sm">
                {t('dues.overdue')} <Money paise={receivables.overdue_paise} decimals={0} />
              </Badge>
            ) : null}
            <span className="text-sm text-muted-foreground">
              {t('dues.customers', { count: receivables.customers_with_due })}
            </span>
          </div>
        ) : null}
      </CardHeader>
      <div className="flex-1 px-5 pb-3">
        {!receivables ? (
          <div className="grid gap-3">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : receivables.top_debtors.length === 0 ? (
          <EmptyState
            compact
            icon={<PartyPopper />}
            title={t('dues.empty_title')}
            description={t('dues.empty_hint')}
          />
        ) : (
          <ul className="divide-y divide-border" aria-label={t('dues.top_debtors')}>
            {receivables.top_debtors.map((d) => (
              <li key={d.customer_id} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {canSeeCustomers ? (
                      <Link to={`/parties/customers/${d.customer_id}`} className="hover:underline">
                        {nameOf(d.name, d.name_ta)}
                      </Link>
                    ) : (
                      nameOf(d.name, d.name_ta)
                    )}
                  </p>
                  <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    {d.phone ? <PhoneLink phone={d.phone} /> : null}
                    {d.oldest_due_days !== null ? (
                      <span className={d.oldest_due_days > 30 ? 'text-danger' : undefined}>
                        {t('dues.days_old', { count: d.oldest_due_days })}
                      </span>
                    ) : null}
                  </p>
                </div>
                <Money paise={d.balance_paise} decimals={0} className="shrink-0 font-semibold" />
                {canRemind && d.phone ? (
                  <IconButton
                    icon={<MessageCircle />}
                    label={t('dues.remind', { name: nameOf(d.name, d.name_ta) })}
                    variant="outline"
                    size="md"
                    loading={pending === d.customer_id}
                    onClick={() => send(d)}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-5 py-2">
        {canSeeCustomers ? (
          <Button asChild variant="link" size="sm" className="gap-1.5">
            <Link to="/parties/customers?filter=due">
              <HandCoins className="size-4" aria-hidden />
              {t('dues.send_reminders')}
            </Link>
          </Button>
        ) : null}
        <Button asChild variant="link" size="sm">
          <Link to="/reports/customer-outstanding">{t('dues.open_report')}</Link>
        </Button>
      </div>
    </Card>
  )
}
