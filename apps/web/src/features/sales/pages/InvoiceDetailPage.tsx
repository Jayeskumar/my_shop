/**
 * Invoice / estimate detail (/sales/invoices/:id): header with number, document type and status,
 * store / counter / cashier, the customer with a link to their khata, lines with tax details,
 * GST breakup, payments (method, UTR, time), linked credit notes, prescription (pharmacy) and the
 * audit trail. Actions follow permissions and state: print (format / language), share on
 * WhatsApp / SMS, collect the due, accept a return, cancel (with consequences), convert an
 * estimate, delete a held bill / draft. Ctrl+P prints the bill instead of the page.
 */
import {
  ArrowRightLeft,
  BookOpenText,
  Ban,
  CircleAlert,
  FileText,
  HandCoins,
  MoreHorizontal,
  RotateCcw,
  Share2,
  Stethoscope,
  Trash2,
  Undo2,
} from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams } from 'react-router'
import type { SalesInvoiceDetail } from '@kadai/shared/api/sales'
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  IconButton,
  Money,
  PageHeader,
  PhoneLink,
  Skeleton,
  notify,
  useConfirm,
} from '@/components/ui'
import { printSalesDocument } from '@/features/pos/print'
import { isApiError } from '@/lib/api'
import { useCan, useMe } from '@/lib/auth'
import { errorText } from '@/lib/errors'
import { formatDate, formatDateTime, formatMoney, formatQty, formatTime } from '@/lib/format'
import { useHotkeyScope, useHotkeys } from '@/lib/hotkeys'
import { getLanguage } from '@/lib/i18n'
import { useCancelInvoice, useDeleteInvoice, useInvoice } from '../api'
import { CancelReasonDialog } from '../components/CancelReasonDialog'
import { CollectPaymentDialog } from '../components/CollectPaymentDialog'
import { ConvertEstimateDialog } from '../components/ConvertEstimateDialog'
import {
  AuditTrail,
  type DocLine,
  LinesTable,
  PaymentsList,
  Section,
  TaxBreakup,
  TotalsList,
  TotalsRow,
} from '../components/DocumentParts'
import { PrintMenu } from '../components/PrintMenu'
import { ShareDialog } from '../components/ShareDialog'
import {
  CreditNoteStatusBadge,
  DocTypeBadge,
  EstimateStateBadge,
  InvoiceStatusBadge,
  OfflineBadge,
  PaymentStatusBadge,
} from '../components/StatusBadges'
import { errorReason } from '../lib/forms'
import {
  addressText,
  bilingual,
  docTypeLabel,
  estimateState,
  reasonLabel,
  settlementLabel,
  stateName,
} from '../lib/labels'
import { useTenantCalendar } from '../lib/use-tenant-calendar'

const DETAIL_SCOPE = 'sales-detail'

export default function InvoiceDetailPage() {
  const { id = '' } = useParams()
  const { t } = useTranslation(['sales', 'common'])
  const query = useInvoice(id)

  if (query.isLoading) return <DetailSkeleton />
  if (query.error || !query.data) {
    const missing = isApiError(query.error) && query.error.status === 404
    return (
      <EmptyState
        icon={<FileText />}
        title={missing ? t('invoice.not_found') : t('invoice.load_failed')}
        description={missing ? t('invoice.not_found_hint') : errorText(query.error)}
        action={
          <>
            {!missing ? (
              <Button onClick={() => void query.refetch()}>{t('common:actions.retry')}</Button>
            ) : null}
            <Button variant="outline" asChild>
              <Link to="/sales/invoices">{t('invoice.back_to_list')}</Link>
            </Button>
          </>
        }
      />
    )
  }
  return <InvoiceDetail invoice={query.data.data} />
}

function InvoiceDetail({ invoice }: { invoice: SalesInvoiceDetail }) {
  const { t, i18n } = useTranslation(['sales', 'common'])
  const navigate = useNavigate()
  const confirm = useConfirm()
  const me = useMe()
  const { today } = useTenantCalendar()
  const tz = me?.tenant.timezone
  const canCancel = useCan('sales.cancel')
  const canReturn = useCan('sales.return')
  const canCollect = useCan('payments.collect')
  const canCreate = useCan('sales.create')
  const canCustomers = useCan('customers.read')
  const cancel = useCancelInvoice()
  const remove = useDeleteInvoice()
  const [dialog, setDialog] = useState<'collect' | 'share' | 'cancel' | 'convert' | null>(null)
  const [cancelError, setCancelError] = useState<string | null>(null)

  const isEstimate = invoice.doc_type === 'estimate'
  const completed = invoice.status === 'completed'
  const liveNotes = invoice.credit_notes.filter((c) => c.status === 'completed')
  const returnable = invoice.lines.some((l) => l.returnable_qty_milli > 0)
  const due = invoice.due_paise
  const showCollect = !isEstimate && completed && due > 0 && canCollect
  const showReturn = !isEstimate && completed && canReturn && returnable
  const showCancel = completed && canCancel && liveNotes.length === 0
  const showConvert = isEstimate && completed && canCreate
  const showShare = (completed || invoice.status === 'converted') && invoice.number !== null
  const showDelete = (invoice.status === 'held' || invoice.status === 'draft') && canCreate
  const printable = invoice.status !== 'held' && invoice.status !== 'draft'
  const title =
    invoice.number ?? (invoice.status === 'held' ? t('invoice.held_bill') : t('invoice.draft_bill'))

  useHotkeyScope(DETAIL_SCOPE)
  useHotkeys(
    {
      'ctrl+p': () => {
        if (!printable) return
        void printSalesDocument({ kind: 'invoice', id: invoice.id, locale: getLanguage() }).catch(
          (e: unknown) => notify.error(e),
        )
      },
    },
    { scope: DETAIL_SCOPE, preventDefault: true },
  )

  const doCancel = (reason: string): void => {
    setCancelError(null)
    cancel.mutate(
      { params: { id: invoice.id }, body: { reason } },
      {
        onSuccess: (res) => {
          setDialog(null)
          const refunds = res.data.refunds
          const manual = refunds.filter((r) => r.psp_refund_required)
          const cash = refunds
            .filter((r) => r.method === 'cash')
            .reduce((s, r) => s + r.amount_paise, 0)
          notify.success(t('cancel.done', { number: invoice.number ?? '' }), {
            description:
              [
                cash > 0 ? t('cancel.return_cash', { amount: formatMoney(cash) }) : null,
                ...manual.map((r) =>
                  t('cancel.refund_in_app', {
                    amount: formatMoney(r.amount_paise),
                    utr: r.utr ?? '—',
                  }),
                ),
              ]
                .filter(Boolean)
                .join(' ') || undefined,
            duration: manual.length > 0 ? 15_000 : 6_000,
          })
        },
        onError: (e) => {
          const reason = errorReason(e)
          setCancelError(
            isApiError(e) && e.status === 409 && liveNotes.length === 0 && !reason
              ? t('cancel.has_returns')
              : errorText(e),
          )
        },
      },
    )
  }

  const doDelete = async (): Promise<void> => {
    const ok = await confirm({
      title: t('invoice.delete_title'),
      description: t('invoice.delete_description'),
      confirmLabel: t('common:actions.delete'),
      tone: 'danger',
    })
    if (!ok) return
    remove.mutate(
      { params: { id: invoice.id } },
      {
        onSuccess: () => {
          notify.success(t('invoice.deleted'))
          navigate('/sales/invoices', { replace: true })
        },
        onError: (e) => notify.error(e),
      },
    )
  }

  const consequences: ReactNode[] = isEstimate
    ? [t('cancel.estimate_effect')]
    : [
        t('cancel.effect_stock'),
        t('cancel.effect_books'),
        ...(invoice.payments.some((p) => p.status === 'completed' && p.direction === 'in')
          ? [
              t('cancel.effect_payments', {
                amount: formatMoney(invoice.paid_paise),
              }),
            ]
          : []),
        ...(invoice.loyalty_points_earned > 0 || invoice.loyalty_points_redeemed > 0
          ? [t('cancel.effect_loyalty')]
          : []),
        ...(due > 0 && invoice.customer_id ? [t('cancel.effect_khata')] : []),
        t('cancel.effect_number'),
      ]

  const lines: DocLine[] = invoice.lines.map((l) => ({
    ...l,
    tags: (
      <>
        {l.returned_qty_milli > 0 ? (
          <Badge tone="info" size="sm" icon={<Undo2 />}>
            {t('lines.returned', { qty: formatQty(l.returned_qty_milli, l.unit) })}
          </Badge>
        ) : null}
        {l.promotion_name ? (
          <Badge tone="accent" size="sm">
            {l.promotion_name}
          </Badge>
        ) : null}
        {l.meta.offline_negative_stock ? (
          <Badge tone="warning" size="sm">
            {t('lines.negative_stock')}
          </Badge>
        ) : null}
      </>
    ),
    details: [
      l.meta.variant ? Object.values(l.meta.variant).join(' / ') : null,
      l.serial_numbers.length ? t('lines.serials', { list: l.serial_numbers.join(', ') }) : null,
      l.meta.note ?? null,
    ].filter((d): d is string => Boolean(d)),
  }))

  const actions = (
    <>
      {showCollect ? (
        <Button leftIcon={<HandCoins />} onClick={() => setDialog('collect')}>
          {t('invoice.collect')}
        </Button>
      ) : null}
      {showConvert ? (
        <Button leftIcon={<ArrowRightLeft />} onClick={() => setDialog('convert')}>
          {t('invoice.convert')}
        </Button>
      ) : null}
      {printable ? <PrintMenu kind="invoice" id={invoice.id} /> : null}
      {showShare ? (
        <Button variant="outline" leftIcon={<Share2 />} onClick={() => setDialog('share')}>
          {t('invoice.share')}
        </Button>
      ) : null}
      {showReturn ? (
        <Button variant="outline" leftIcon={<RotateCcw />} asChild>
          <Link to={`/sales/returns/new?invoice_id=${invoice.id}`}>{t('invoice.return')}</Link>
        </Button>
      ) : null}
      {showCancel || showDelete ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton
              icon={<MoreHorizontal />}
              label={t('common:actions.more')}
              variant="outline"
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {showCancel ? (
              <DropdownMenuItem
                tone="danger"
                icon={<Ban />}
                onSelect={() => {
                  setCancelError(null)
                  setDialog('cancel')
                }}
              >
                {isEstimate ? t('invoice.cancel_estimate') : t('invoice.cancel')}
              </DropdownMenuItem>
            ) : null}
            {showDelete ? (
              <DropdownMenuItem tone="danger" icon={<Trash2 />} onSelect={() => void doDelete()}>
                {t('invoice.delete')}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </>
  )

  const estimateBadge = isEstimate ? (
    <EstimateStateBadge state={estimateState(invoice, today)} size="md" />
  ) : (
    <InvoiceStatusBadge status={invoice.status} size="md" />
  )

  return (
    <div className="pb-8">
      <PageHeader
        className="pb-3"
        backTo={isEstimate ? '/sales/estimates' : '/sales/invoices'}
        breadcrumbs={
          isEstimate
            ? [{ label: t('estimates.title'), to: '/sales/estimates' }, { label: title }]
            : [{ label: t('invoices.title'), to: '/sales/invoices' }, { label: title }]
        }
        title={<span className="tabular-nums">{title}</span>}
        description={
          <span className="flex flex-col gap-1.5">
            <span className="flex flex-wrap items-center gap-1.5">
              <DocTypeBadge docType={invoice.doc_type} size="md" />
              {estimateBadge}
              {completed && !isEstimate ? (
                <PaymentStatusBadge status={invoice.payment_status} size="md" />
              ) : null}
              {invoice.offline ? <OfflineBadge size="md" /> : null}
            </span>
            <span>
              {t('invoice.subtitle', {
                date: formatDate(invoice.invoice_date),
                time: formatTime(invoice.invoice_at, tz),
                store: `${invoice.store.code} · ${invoice.store.name}`,
              })}
            </span>
          </span>
        }
      />
      <div
        className="mb-4 flex flex-wrap items-center gap-2"
        role="toolbar"
        aria-label={t('invoice.actions')}
      >
        {actions}
      </div>

      {/* Phones: the money first, the full summary is further down. */}
      {!isEstimate && completed ? (
        <dl className="mb-4 grid grid-cols-3 gap-2 rounded-xl border border-border bg-surface p-3 text-center shadow-card lg:hidden">
          <div>
            <dt className="text-xs text-muted-foreground">{t('totals.total')}</dt>
            <dd className="font-semibold">
              <Money paise={invoice.total_paise} decimals="auto" />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t('totals.paid')}</dt>
            <dd className="font-semibold text-success">
              <Money paise={invoice.paid_paise} decimals="auto" />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t('totals.due')}</dt>
            <dd className={due > 0 ? 'font-semibold text-danger' : 'font-semibold'}>
              <Money paise={Math.max(0, due)} decimals="auto" />
            </dd>
          </div>
        </dl>
      ) : null}

      {invoice.status === 'cancelled' ? (
        <Banner tone="danger" icon={<Ban />}>
          {t('invoice.cancelled_banner', {
            date: formatDateTime(invoice.cancelled_at, tz),
            by: invoice.cancelled_by_name ?? '—',
            reason: invoice.cancel_reason ?? '—',
          })}
        </Banner>
      ) : null}
      {isEstimate && invoice.status === 'converted' && invoice.converted_to_id ? (
        <Banner tone="success" icon={<ArrowRightLeft />}>
          {t('invoice.converted_banner')}{' '}
          <Link
            className="font-semibold underline"
            to={`/sales/invoices/${invoice.converted_to_id}`}
          >
            {t('invoice.open_bill')}
          </Link>
        </Banner>
      ) : null}
      {isEstimate && completed && invoice.due_date && invoice.due_date < today ? (
        <Banner tone="warning" icon={<CircleAlert />}>
          {t('invoice.estimate_expired', { date: formatDate(invoice.due_date) })}
        </Banner>
      ) : null}
      {invoice.source_estimate ? (
        <Banner tone="info" icon={<FileText />}>
          {t('invoice.from_estimate')}{' '}
          <Link
            className="font-semibold underline"
            to={`/sales/invoices/${invoice.source_estimate.id}`}
          >
            {invoice.source_estimate.number ?? t('invoice.estimate')}
          </Link>
        </Banner>
      ) : null}
      {invoice.status === 'held' || invoice.status === 'draft' ? (
        <Banner tone="info" icon={<CircleAlert />}>
          {t('invoice.held_banner')}
        </Banner>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-2">
          <Section
            title={t('invoice.items', { count: invoice.lines.length })}
            action={
              invoice.price_includes_tax ? (
                <span className="text-xs text-muted-foreground">
                  {t('invoice.prices_incl_tax')}
                </span>
              ) : null
            }
          >
            <LinesTable lines={lines} label={t('invoice.items_label')} />
          </Section>

          {invoice.tax_breakup.length > 0 && invoice.tax_paise > 0 ? (
            <Section
              title={t('tax.title')}
              action={
                <span className="text-xs text-muted-foreground">
                  {t('tax.place_of_supply', {
                    state: stateName(invoice.place_of_supply, i18n.language),
                  })}
                  {invoice.is_interstate ? ` · ${t('tax.interstate')}` : ''}
                </span>
              }
            >
              <TaxBreakup rows={invoice.tax_breakup} placeOfSupply={invoice.place_of_supply} />
            </Section>
          ) : null}

          {!isEstimate && (completed || invoice.status === 'cancelled') ? (
            <Section
              title={t('payments.title')}
              action={
                showCollect ? (
                  <Button size="sm" variant="outline" onClick={() => setDialog('collect')}>
                    {t('invoice.collect')}
                  </Button>
                ) : null
              }
            >
              <PaymentsList payments={invoice.payments} timezone={tz} empty={t('payments.none')} />
            </Section>
          ) : null}

          {invoice.credit_notes.length > 0 ? (
            <Section title={t('invoice.credit_notes')}>
              <ul className="divide-y divide-border">
                {invoice.credit_notes.map((cn) => (
                  <li
                    key={cn.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-2.5"
                  >
                    <div className="min-w-0">
                      <Link
                        to={`/sales/returns/${cn.id}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {cn.number}
                      </Link>
                      <div className="text-xs text-muted-foreground">
                        {[
                          formatDate(cn.note_date),
                          reasonLabel(cn.reason, i18n.language),
                          settlementLabel(cn.settlement, i18n.language),
                        ].join(' · ')}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <CreditNoteStatusBadge status={cn.status} />
                      <Money
                        paise={cn.total_paise}
                        className={
                          cn.status === 'cancelled' ? 'line-through opacity-60' : 'font-semibold'
                        }
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {invoice.rx ? <RxCard rx={invoice.rx} /> : null}
        </div>

        <div className="flex min-w-0 flex-col gap-4 lg:order-none">
          <Section title={isEstimate ? t('invoice.estimate_summary') : t('invoice.summary')}>
            <TotalsList
              totals={invoice}
              estimate={isEstimate}
              placeOfSupply={invoice.place_of_supply}
              after={
                isEstimate ? null : (
                  <>
                    {invoice.paid_paise > 0 ? (
                      <TotalsRow
                        label={t('totals.paid')}
                        paise={invoice.paid_paise}
                        tone="success"
                      />
                    ) : null}
                    {invoice.returned_paise > 0 ? (
                      <TotalsRow
                        label={t('totals.returned')}
                        paise={invoice.returned_paise}
                        tone="muted"
                      />
                    ) : null}
                    {completed ? (
                      <TotalsRow
                        label={t('totals.due')}
                        paise={Math.max(0, due)}
                        tone={due > 0 ? 'danger' : 'success'}
                        strong
                      />
                    ) : null}
                  </>
                )
              }
            />
            {invoice.loyalty_points_earned > 0 || invoice.loyalty_points_redeemed > 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">
                {[
                  invoice.loyalty_points_earned > 0
                    ? t('invoice.points_earned', { count: invoice.loyalty_points_earned })
                    : null,
                  invoice.loyalty_points_redeemed > 0
                    ? t('invoice.points_redeemed', { count: invoice.loyalty_points_redeemed })
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            ) : null}
          </Section>

          <CustomerCard invoice={invoice} canOpenKhata={canCustomers} />

          <Section title={t('invoice.details')}>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              <Detail
                label={t('invoice.doc_type')}
                value={docTypeLabel(invoice.doc_type, i18n.language)}
              />
              <Detail
                label={t('invoice.date_time')}
                value={formatDateTime(invoice.invoice_at, tz)}
              />
              {isEstimate && invoice.due_date ? (
                <Detail label={t('invoice.valid_until')} value={formatDate(invoice.due_date)} />
              ) : null}
              <Detail
                label={t('invoice.store')}
                value={`${invoice.store.code} · ${invoice.store.name}`}
              />
              {invoice.register ? (
                <Detail
                  label={t('invoice.register')}
                  value={`${invoice.register.code} · ${invoice.register.name}`}
                />
              ) : null}
              {invoice.created_by_name ? (
                <Detail label={t('invoice.cashier')} value={invoice.created_by_name} />
              ) : null}
              {invoice.salesperson_name ? (
                <Detail label={t('invoice.salesperson')} value={invoice.salesperson_name} />
              ) : null}
              <Detail label={t('invoice.channel')} value={t(`channel.${invoice.channel}`)} />
              <Detail
                label={t('invoice.place_of_supply')}
                value={`${stateName(invoice.place_of_supply, i18n.language)} (${invoice.place_of_supply})`}
              />
              {invoice.shift ? (
                <Detail
                  label={t('invoice.shift')}
                  value={t('invoice.shift_value', {
                    time: formatDateTime(invoice.shift.opened_at, tz),
                    by: invoice.shift.opened_by_name ?? '—',
                  })}
                />
              ) : null}
              {invoice.offline_created_at ? (
                <Detail
                  label={t('invoice.offline_created')}
                  value={formatDateTime(invoice.offline_created_at, tz)}
                />
              ) : null}
              {invoice.notes ? <Detail label={t('invoice.notes')} value={invoice.notes} /> : null}
            </dl>
          </Section>

          <AuditTrail entries={invoice.audit} timezone={tz} />
        </div>
      </div>

      <CollectPaymentDialog
        open={dialog === 'collect'}
        onOpenChange={(o) => setDialog(o ? 'collect' : null)}
        invoice={invoice}
      />
      <ShareDialog
        open={dialog === 'share'}
        onOpenChange={(o) => setDialog(o ? 'share' : null)}
        invoiceId={invoice.id}
        customerPhone={invoice.customer_phone}
        shareUrl={invoice.share_url}
      />
      <ConvertEstimateDialog
        open={dialog === 'convert'}
        onOpenChange={(o) => setDialog(o ? 'convert' : null)}
        estimate={invoice}
      />
      <CancelReasonDialog
        open={dialog === 'cancel'}
        onOpenChange={(o) => setDialog(o ? 'cancel' : null)}
        title={
          isEstimate
            ? t('cancel.estimate_title', { number: invoice.number ?? '' })
            : t('cancel.title', { number: invoice.number ?? '' })
        }
        description={
          isEstimate
            ? undefined
            : t('cancel.description', { amount: formatMoney(invoice.total_paise) })
        }
        consequences={consequences}
        quickReasons={[
          t('cancel.reason_wrong_items'),
          t('cancel.reason_customer_cancelled'),
          t('cancel.reason_duplicate'),
          t('cancel.reason_wrong_price'),
        ]}
        confirmLabel={isEstimate ? t('cancel.confirm_estimate') : t('cancel.confirm')}
        pending={cancel.isPending}
        error={cancelError}
        onConfirm={doCancel}
      />
    </div>
  )
}

function Detail({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{value}</dd>
    </>
  )
}

function Banner({
  tone,
  icon,
  children,
}: {
  tone: 'danger' | 'success' | 'warning' | 'info'
  icon: ReactNode
  children: ReactNode
}) {
  const classes = {
    danger: 'border-danger/40 bg-danger-soft text-danger-soft-foreground',
    success: 'border-success/40 bg-success-soft text-success-soft-foreground',
    warning: 'border-warning/40 bg-warning-soft text-warning-soft-foreground',
    info: 'border-info/40 bg-info-soft text-info-soft-foreground',
  }[tone]
  return (
    <div
      role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}
      className={`mb-4 flex items-start gap-2 rounded-lg border px-4 py-3 text-sm ${classes} [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0`}
    >
      {icon}
      <div className="min-w-0">{children}</div>
    </div>
  )
}

function CustomerCard({
  invoice,
  canOpenKhata,
}: {
  invoice: SalesInvoiceDetail
  canOpenKhata: boolean
}) {
  const { t, i18n } = useTranslation(['sales', 'common'])
  if (!invoice.customer_name && !invoice.customer) {
    return (
      <Section title={t('invoice.customer')}>
        <p className="text-sm text-muted-foreground">{t('invoice.walk_in')}</p>
      </Section>
    )
  }
  const khata = invoice.customer
  const address = addressText(invoice.customer_address, i18n.language)
  return (
    <Section
      title={t('invoice.customer')}
      action={
        khata && canOpenKhata ? (
          <Button variant="link" size="sm" leftIcon={<BookOpenText />} asChild>
            <Link to={`/parties/customers/${khata.id}`}>{t('invoice.open_khata')}</Link>
          </Button>
        ) : null
      }
    >
      <div className="flex flex-col gap-1.5 text-sm">
        <div className="text-base font-semibold">
          {bilingual(invoice.customer_name ?? khata?.name ?? '', null, i18n.language).primary}
        </div>
        <PhoneLink phone={invoice.customer_phone ?? khata?.phone} whatsapp />
        {invoice.customer_gstin ? (
          <div className="text-muted-foreground">
            GSTIN <span className="font-mono text-foreground">{invoice.customer_gstin}</span>
          </div>
        ) : null}
        {address ? <div className="text-muted-foreground">{address}</div> : null}
        {khata ? (
          <div className="mt-2 flex items-center justify-between rounded-md bg-surface-2 px-3 py-2">
            <span className="text-muted-foreground">
              {khata.balance_paise >= 0 ? t('invoice.khata_due') : t('invoice.khata_advance')}
            </span>
            <Money
              paise={Math.abs(khata.balance_paise)}
              className={
                khata.balance_paise > 0 ? 'font-semibold text-danger' : 'font-semibold text-success'
              }
            />
          </div>
        ) : null}
        {khata && khata.loyalty_points > 0 ? (
          <div className="text-xs text-muted-foreground">
            {t('invoice.loyalty_balance', { count: khata.loyalty_points })}
          </div>
        ) : null}
      </div>
    </Section>
  )
}

function RxCard({ rx }: { rx: NonNullable<SalesInvoiceDetail['rx']> }) {
  const { t } = useTranslation('sales')
  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <Stethoscope className="size-4 text-muted-foreground" aria-hidden />
          {t('rx.title')}
        </span>
      }
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <Detail label={t('rx.doctor')} value={rx.doctor_name} />
        {rx.doctor_reg_no ? <Detail label={t('rx.reg_no')} value={rx.doctor_reg_no} /> : null}
        <Detail
          label={t('rx.patient')}
          value={[
            rx.patient_name,
            rx.patient_age != null ? t('rx.age', { age: rx.patient_age }) : null,
            rx.patient_gender ? t(`rx.gender_${rx.patient_gender}`) : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        />
        {rx.patient_address ? <Detail label={t('rx.address')} value={rx.patient_address} /> : null}
        {rx.rx_date ? <Detail label={t('rx.date')} value={formatDate(rx.rx_date)} /> : null}
      </dl>
    </Section>
  )
}

function DetailSkeleton() {
  return (
    <div aria-busy="true">
      <Skeleton className="mb-2 h-4 w-40" />
      <Skeleton className="mb-6 h-8 w-64" />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <Skeleton className="h-72 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
        <div className="flex flex-col gap-4">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    </div>
  )
}
