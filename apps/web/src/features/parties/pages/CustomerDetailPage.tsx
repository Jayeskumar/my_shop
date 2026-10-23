/**
 * Customer khata page (/parties/customers/:id): who they are, how much they owe right now (or
 * hold as advance), credit-limit use and overdue warning, with the money actions a shopkeeper
 * reaches for — receive payment, WhatsApp/SMS reminder with a UPI link, payment link. Tabs:
 * ledger (statement with running balance, print / share / CSV), bills, payments, loyalty and
 * profile. The active tab lives in ?tab= so links and refreshes keep it.
 */
import {
  AlertTriangle,
  BellRing,
  IndianRupee,
  Link2,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Phone,
  Trash2,
  UserX,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import {
  CUSTOMER_TYPE_LABELS,
  type Customer,
  type CustomerSummary,
} from '@kadai/shared/api/parties'
import { toWhatsAppNumber } from '@kadai/shared/phone'
import {
  Avatar,
  Badge,
  Button,
  Card,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  Kbd,
  PageHeader,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  notify,
  useConfirm,
} from '@/components/ui'
import { isApiError } from '@/lib/api'
import { useCan, useFeature } from '@/lib/auth'
import { formatDate, formatMoney, formatPhone } from '@/lib/format'
import { useHotkeyScope, useHotkeys } from '@/lib/hotkeys'
import { translate } from '@/lib/i18n'
import { useCustomer, useCustomerSummary, useDeleteCustomer, useUpdateCustomer } from '../api'
import { BalanceAmount } from '../components/BalanceAmount'
import { CreditLimitBar } from '../components/CreditLimitBar'
import { CustomerFormDialog } from '../components/CustomerFormDialog'
import { CustomerProfile } from '../components/CustomerProfile'
import { LoyaltyPanel } from '../components/LoyaltyPanel'
import { CustomerInvoices, PartyPayments } from '../components/PartyDocuments'
import { PartyLedgerPanel } from '../components/PartyLedgerPanel'
import { PartyPaymentDialog } from '../components/PartyPaymentDialog'
import { PaymentLinkDialog } from '../components/PaymentLinkDialog'
import { ReminderDialog } from '../components/ReminderDialog'
import { partyNames, pickLabel, PARTIES_HOTKEY_SCOPE } from '../lib/labels'

const TABS = ['ledger', 'invoices', 'payments', 'loyalty', 'profile'] as const
type Tab = (typeof TABS)[number]

export default function CustomerDetailPage() {
  const { id = '' } = useParams()
  const { t } = useTranslation(['parties', 'common'])
  const customer = useCustomer(id)
  const canReadSummary = Boolean(customer.data)
  const summary = useCustomerSummary(id, { enabled: canReadSummary })

  if (customer.isLoading) return <DetailSkeleton />
  if (customer.error || !customer.data) {
    const notFound = isApiError(customer.error) && customer.error.status === 404
    return (
      <div>
        <PageHeader title={translate('nav:titles.customer')} backTo="/parties/customers" />
        <div className="rounded-xl border border-dashed border-border bg-surface">
          <EmptyState
            icon={<UserX />}
            title={notFound ? t('khata.not_found') : t('khata.load_failed')}
            description={notFound ? t('khata.not_found_hint') : undefined}
            action={
              <>
                {!notFound ? (
                  <Button variant="outline" onClick={() => void customer.refetch()}>
                    {t('common:actions.retry')}
                  </Button>
                ) : null}
                <Button asChild>
                  <Link to="/parties/customers">{t('khata.back_to_list')}</Link>
                </Button>
              </>
            }
          />
        </div>
      </div>
    )
  }
  return (
    <Khata
      customer={customer.data.data}
      summary={summary.data?.data}
      summaryLoading={summary.isLoading}
    />
  )
}

function Khata({
  customer,
  summary,
  summaryLoading,
}: {
  customer: Customer
  summary: CustomerSummary | undefined
  summaryLoading: boolean
}) {
  const { t, i18n } = useTranslation(['parties', 'common'])
  const navigate = useNavigate()
  const confirm = useConfirm()
  const [params, setParams] = useSearchParams()
  const canWrite = useCan('customers.write')
  const canCollect = useCan('payments.collect')
  const canSales = useCan('sales.read')
  const canPayments = useCan('payments.read')
  const loyalty = useFeature('loyalty')
  const [dialog, setDialog] = useState<'payment' | 'reminder' | 'link' | 'edit' | null>(null)
  const del = useDeleteCustomer()
  const update = useUpdateCustomer()

  const tabs = TABS.filter(
    (tab) =>
      (tab !== 'invoices' || canSales) &&
      (tab !== 'payments' || canPayments) &&
      (tab !== 'loyalty' || loyalty),
  )
  const requested = params.get('tab') as Tab | null
  const tab: Tab = requested && tabs.includes(requested) ? requested : 'ledger'

  const names = partyNames(customer.name, customer.name_ta, i18n.language)
  const balance = summary?.balance_paise ?? customer.balance_paise
  const overdue = summary?.overdue_paise ?? customer.overdue_paise
  const hasDue = balance > 0
  const wa = customer.phone ? toWhatsAppNumber(customer.phone) : null

  useHotkeyScope(PARTIES_HOTKEY_SCOPE)
  useHotkeys(
    {
      'alt+r': () => {
        if (canCollect) setDialog('payment')
      },
      'alt+e': () => {
        if (canWrite) setDialog('edit')
      },
    },
    { scope: PARTIES_HOTKEY_SCOPE },
  )

  const remove = async (): Promise<void> => {
    const ok = await confirm({
      title: t('khata.delete_title', { name: customer.name }),
      description: t('khata.delete_description'),
      confirmLabel: t('khata.delete_confirm'),
      tone: 'danger',
    })
    if (!ok) return
    del.mutate(
      { params: { id: customer.id } },
      {
        onSuccess: (res) => {
          if (res.data.result === 'deleted') {
            notify.success(t('khata.deleted', { name: customer.name }))
            navigate('/parties/customers', { replace: true })
          } else {
            notify.info(t('khata.deactivated', { name: customer.name }))
          }
        },
        onError: (e) => notify.error(e),
      },
    )
  }

  const reactivate = (): void => {
    update.mutate(
      {
        params: { id: customer.id },
        body: { is_active: true, if_updated_at: customer.updated_at },
      },
      {
        onSuccess: () => notify.success(t('khata.reactivated', { name: customer.name })),
        onError: (e) => notify.error(e),
      },
    )
  }

  return (
    <div>
      <PageHeader
        title={names.primary}
        backTo="/parties/customers"
        breadcrumbs={[
          { label: translate('nav:titles.customers'), to: '/parties/customers' },
          { label: names.primary },
        ]}
        meta={
          <>
            {!customer.is_active ? <Badge>{t('common:status.inactive')}</Badge> : null}
            {customer.customer_type !== 'retail' ? (
              <Badge tone="info">
                {pickLabel(CUSTOMER_TYPE_LABELS[customer.customer_type], i18n.language)}
              </Badge>
            ) : null}
          </>
        }
      />

      <Card className="mb-5 grid gap-5 p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className="flex min-w-0 items-start gap-4 lg:col-start-1">
          <Avatar name={names.primary} size="xl" className="hidden sm:inline-flex" />
          <div className="min-w-0 flex-1">
            {names.secondary ? (
              <p className="text-sm text-muted-foreground">{names.secondary}</p>
            ) : null}
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {customer.phone ? (
                <>
                  <Button asChild variant="outline" size="lg">
                    <a
                      href={`tel:${customer.phone}`}
                      aria-label={t('khata.call', { phone: formatPhone(customer.phone) })}
                    >
                      <Phone aria-hidden />
                      <span className="tabular-nums">{formatPhone(customer.phone)}</span>
                    </a>
                  </Button>
                  {wa ? (
                    <Button asChild variant="outline" size="lg">
                      <a href={`https://wa.me/${wa}`} target="_blank" rel="noopener noreferrer">
                        <MessageCircle className="text-success" aria-hidden />
                        {t('khata.whatsapp')}
                      </a>
                    </Button>
                  ) : null}
                </>
              ) : (
                <span className="text-sm text-muted-foreground">{t('khata.no_phone')}</span>
              )}
            </div>
            {customer.tags.length ? (
              <div className="mt-3 flex flex-wrap gap-1">
                {customer.tags.map((tag) => (
                  <Link key={tag} to={`/parties/customers?tag=${encodeURIComponent(tag)}`}>
                    <Badge
                      size="sm"
                      appearance="outline"
                      className="hover:border-primary hover:text-primary"
                    >
                      #{tag}
                    </Badge>
                  </Link>
                ))}
              </div>
            ) : null}
          </div>
        </div>
        <div
          className="flex flex-col gap-3 rounded-xl bg-surface-2/70 p-4 lg:col-start-2 lg:row-span-2 lg:row-start-1"
          aria-live="polite"
        >
          <p className="text-sm font-medium text-muted-foreground">
            {balance > 0
              ? t('khata.current_due')
              : balance < 0
                ? t('khata.advance_held')
                : t('khata.all_settled')}
          </p>
          <BalanceAmount partyType="customer" balancePaise={balance} size="xl" showLabel={false} />
          {overdue > 0 ? (
            <div className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-soft-foreground">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                {t('khata.overdue_line', {
                  amount: formatMoney(overdue),
                  count: summary?.overdue_invoice_count ?? 0,
                })}
                {summary?.oldest_due_date
                  ? ` · ${t('khata.oldest_since', { date: formatDate(summary.oldest_due_date) })}`
                  : ''}
              </span>
            </div>
          ) : null}
          {summaryLoading ? (
            <Skeleton className="h-6 w-full" />
          ) : (
            <CreditLimitBar
              balancePaise={balance}
              creditLimitPaise={summary?.credit_limit_paise ?? customer.credit_limit_paise}
            />
          )}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap lg:col-start-1">
          {canCollect ? (
            <Button
              size="lg"
              leftIcon={<IndianRupee />}
              onClick={() => setDialog('payment')}
              className="col-span-2 sm:col-span-1"
            >
              {t('khata.receive_payment')}
              <Kbd
                combo="alt+r"
                className="ms-1 hidden border-primary-foreground/30 bg-primary-foreground/15 text-primary-foreground lg:inline-flex"
              />
            </Button>
          ) : null}
          {canWrite && hasDue ? (
            <Button
              size="lg"
              variant="outline"
              className="h-auto min-h-12 whitespace-normal py-2 leading-tight"
              leftIcon={<BellRing />}
              onClick={() => setDialog('reminder')}
            >
              {t('khata.send_reminder')}
            </Button>
          ) : null}
          {canCollect && hasDue ? (
            <Button
              size="lg"
              variant="outline"
              className="h-auto min-h-12 whitespace-normal py-2 leading-tight"
              leftIcon={<Link2 />}
              onClick={() => setDialog('link')}
            >
              {t('khata.payment_link')}
            </Button>
          ) : null}
          {canWrite ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="lg"
                  variant="ghost"
                  leftIcon={<MoreHorizontal />}
                  aria-label={t('common:actions.more')}
                >
                  <span className="sm:sr-only">{t('common:actions.more')}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  icon={<Pencil />}
                  shortcut={<Kbd combo="alt+e" />}
                  onSelect={() => setDialog('edit')}
                >
                  {t('khata.edit')}
                </DropdownMenuItem>
                {customer.is_active ? (
                  <DropdownMenuItem icon={<Trash2 />} tone="danger" onSelect={() => void remove()}>
                    {t('profile.delete')}
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </Card>

      <Tabs
        value={tab}
        onValueChange={(v) =>
          setParams(
            (prev) => {
              const next = new URLSearchParams(prev)
              if (v === 'ledger') next.delete('tab')
              else next.set('tab', v)
              return next
            },
            { replace: true },
          )
        }
      >
        <TabsList>
          {tabs.map((key) => (
            <TabsTrigger key={key} value={key}>
              {t(`khata.tab_${key}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="ledger">
          <PartyLedgerPanel partyType="customer" party={customer} />
        </TabsContent>
        {canSales ? (
          <TabsContent value="invoices">
            <CustomerInvoices customerId={customer.id} />
          </TabsContent>
        ) : null}
        {canPayments ? (
          <TabsContent value="payments">
            <PartyPayments partyType="customer" partyId={customer.id} />
          </TabsContent>
        ) : null}
        {loyalty ? (
          <TabsContent value="loyalty">
            <LoyaltyPanel customer={customer} />
          </TabsContent>
        ) : null}
        <TabsContent value="profile">
          <CustomerProfile
            customer={customer}
            summary={summary}
            summaryLoading={summaryLoading}
            canWrite={canWrite}
            onEdit={() => setDialog('edit')}
            onDelete={() => void remove()}
            onReactivate={reactivate}
          />
        </TabsContent>
      </Tabs>

      <PartyPaymentDialog
        open={dialog === 'payment'}
        onOpenChange={(o) => setDialog(o ? 'payment' : null)}
        party={{ type: 'customer', id: customer.id, name: names.primary, balance_paise: balance }}
      />
      <ReminderDialog
        open={dialog === 'reminder'}
        onOpenChange={(o) => setDialog(o ? 'reminder' : null)}
        customer={customer}
        summary={summary}
      />
      <PaymentLinkDialog
        open={dialog === 'link'}
        onOpenChange={(o) => setDialog(o ? 'link' : null)}
        customer={customer}
      />
      <CustomerFormDialog
        open={dialog === 'edit'}
        onOpenChange={(o) => setDialog(o ? 'edit' : null)}
        customer={customer}
      />
    </div>
  )
}

function DetailSkeleton() {
  return (
    <div aria-busy>
      <Skeleton className="mb-3 h-4 w-40" />
      <Skeleton className="mb-5 h-8 w-64" />
      <Card className="mb-5 grid gap-5 p-5 lg:grid-cols-[1fr_22rem]">
        <div className="grid gap-3">
          <Skeleton className="h-12 w-56" />
          <Skeleton className="h-12 w-80 max-w-full" />
        </div>
        <Skeleton className="h-32 w-full" />
      </Card>
      <Skeleton className="mb-4 h-10 w-full max-w-lg" />
      <Skeleton className="h-64 w-full" />
    </div>
  )
}
