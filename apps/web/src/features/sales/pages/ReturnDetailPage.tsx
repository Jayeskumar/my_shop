/**
 * Credit note (/sales/returns/:id): number, status, the original bill (rule 53), reason and how
 * the value went back (refund / due adjusted / store credit with its payments), returned lines
 * with restock state, GST breakup and totals, loyalty points taken back / restored. Actions:
 * print (format / language) and cancel (sales.cancel; reverses stock, books and settlement).
 * Right after a return is accepted the page offers the print straight away.
 */
import { Ban, FileText, PackageCheck, PackageX, Printer } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation, useParams } from 'react-router'
import type { CreditNoteDetail } from '@kadai/shared/api/sales'
import { Badge, Button, EmptyState, Money, PageHeader, Skeleton, notify } from '@/components/ui'
import { printSalesDocument } from '@/features/pos/print'
import { isApiError } from '@/lib/api'
import { useCan, useMe } from '@/lib/auth'
import { errorText } from '@/lib/errors'
import { formatDate, formatDateTime, formatMoney } from '@/lib/format'
import { getLanguage } from '@/lib/i18n'
import { useCancelCreditNote, useCreditNote } from '../api'
import { CancelReasonDialog } from '../components/CancelReasonDialog'
import {
  type DocLine,
  LinesTable,
  PaymentsList,
  Section,
  TaxBreakup,
  TotalsList,
  TotalsRow,
} from '../components/DocumentParts'
import { PrintMenu } from '../components/PrintMenu'
import { CreditNoteStatusBadge, DocTypeBadge } from '../components/StatusBadges'
import { reasonLabel, settlementLabel, stateName } from '../lib/labels'

export default function ReturnDetailPage() {
  const { id = '' } = useParams()
  const { t } = useTranslation(['sales', 'common'])
  const query = useCreditNote(id)
  if (query.isLoading) {
    return (
      <div aria-busy="true">
        <Skeleton className="mb-6 h-8 w-64" />
        <div className="grid gap-4 lg:grid-cols-3">
          <Skeleton className="h-72 w-full lg:col-span-2" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    )
  }
  if (query.error || !query.data) {
    const missing = isApiError(query.error) && query.error.status === 404
    return (
      <EmptyState
        icon={<FileText />}
        title={missing ? t('credit_note.not_found') : t('invoice.load_failed')}
        description={missing ? t('credit_note.not_found_hint') : errorText(query.error)}
        action={
          <Button variant="outline" asChild>
            <Link to="/sales/returns">{t('credit_note.back_to_list')}</Link>
          </Button>
        }
      />
    )
  }
  return <CreditNoteView note={query.data.data} />
}

function CreditNoteView({ note }: { note: CreditNoteDetail }) {
  const { t, i18n } = useTranslation(['sales', 'common'])
  const location = useLocation()
  const me = useMe()
  const tz = me?.tenant.timezone
  const canCancel = useCan('sales.cancel')
  const cancel = useCancelCreditNote()
  const [cancelOpen, setCancelOpen] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)
  const [printing, setPrinting] = useState(false)
  const justCreated = (location.state as { created?: boolean } | null)?.created === true
  const live = note.status === 'completed'

  const printNow = async (): Promise<void> => {
    setPrinting(true)
    try {
      await printSalesDocument({ kind: 'credit_note', id: note.id, locale: getLanguage() })
    } catch (error) {
      notify.error(error)
    } finally {
      setPrinting(false)
    }
  }

  const lines: DocLine[] = note.lines.map((l) => ({
    ...l,
    tags: l.restock ? (
      <Badge tone="success" size="sm" icon={<PackageCheck />}>
        {t('credit_note.restocked')}
      </Badge>
    ) : (
      <Badge tone="neutral" size="sm" icon={<PackageX />}>
        {t('credit_note.not_restocked')}
      </Badge>
    ),
  }))

  const consequences: ReactNode[] = [
    ...(note.lines.some((l) => l.restock) ? [t('credit_note.cancel_effect_stock')] : []),
    t('credit_note.cancel_effect_books'),
    note.settlement === 'adjust_due'
      ? t('credit_note.cancel_effect_due', { amount: formatMoney(note.total_paise) })
      : note.settlement === 'store_credit'
        ? t('credit_note.cancel_effect_credit', { amount: formatMoney(note.total_paise) })
        : t('credit_note.cancel_effect_refund', { amount: formatMoney(note.settled_paise) }),
    ...(note.loyalty_points_reversed > 0 || note.loyalty_points_restored > 0
      ? [t('credit_note.cancel_effect_loyalty')]
      : []),
  ]

  const doCancel = (reason: string): void => {
    setCancelError(null)
    cancel.mutate(
      { params: { id: note.id }, body: { reason } },
      {
        onSuccess: () => {
          setCancelOpen(false)
          notify.success(t('credit_note.cancelled_toast', { number: note.number }))
        },
        onError: (e) => setCancelError(errorText(e)),
      },
    )
  }

  return (
    <div className="pb-8">
      <PageHeader
        className="pb-3"
        backTo="/sales/returns"
        breadcrumbs={[{ label: t('returns.title'), to: '/sales/returns' }, { label: note.number }]}
        title={<span className="tabular-nums">{note.number}</span>}
        description={
          <span className="flex flex-col gap-1.5">
            <span className="flex flex-wrap items-center gap-1.5">
              <DocTypeBadge docType="credit_note" size="md" />
              <CreditNoteStatusBadge status={note.status} size="md" />
            </span>
            <span>
              {t('credit_note.subtitle', {
                date: formatDate(note.note_date),
                reason: reasonLabel(note.reason, i18n.language),
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
        <PrintMenu kind="credit_note" id={note.id} />
        {live && canCancel ? (
          <Button
            variant="outline"
            leftIcon={<Ban />}
            onClick={() => {
              setCancelError(null)
              setCancelOpen(true)
            }}
          >
            {t('credit_note.cancel')}
          </Button>
        ) : null}
      </div>

      {justCreated && live ? (
        <div
          role="status"
          className="mb-4 flex flex-col gap-3 rounded-xl border border-success/40 bg-success-soft p-4 text-success-soft-foreground sm:flex-row sm:items-center sm:justify-between"
        >
          <div>
            <div className="font-semibold">
              {t('credit_note.created_title', { amount: formatMoney(note.total_paise) })}
            </div>
            <div className="text-sm">
              <SettlementSentence note={note} />
            </div>
          </div>
          <Button
            size="lg"
            leftIcon={<Printer />}
            onClick={() => void printNow()}
            loading={printing}
          >
            {t('credit_note.print_now')}
          </Button>
        </div>
      ) : null}

      {note.status === 'cancelled' ? (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger-soft-foreground"
        >
          {t('credit_note.cancelled_banner', {
            date: formatDateTime(note.cancelled_at, tz),
            by: note.cancelled_by_name ?? '—',
            reason: note.cancel_reason ?? '—',
          })}
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-2">
          <Section title={t('credit_note.items', { count: note.lines.length })}>
            <LinesTable lines={lines} label={t('credit_note.items_label')} />
          </Section>
          {note.tax_breakup.length > 0 && note.tax_paise > 0 ? (
            <Section title={t('tax.title')}>
              <TaxBreakup rows={note.tax_breakup} placeOfSupply={note.place_of_supply} />
            </Section>
          ) : null}
          <Section title={t('credit_note.settlement')}>
            <p className="mb-2 text-sm">
              <SettlementSentence note={note} />
            </p>
            {note.payments.length > 0 ? (
              <PaymentsList payments={note.payments} timezone={tz} empty={t('payments.none')} />
            ) : null}
            {note.notes ? (
              <p className="mt-2 text-sm text-muted-foreground">
                {t('credit_note.notes')}: {note.notes}
              </p>
            ) : null}
          </Section>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Section title={t('credit_note.summary')}>
            <TotalsList
              totals={{ ...note }}
              placeOfSupply={note.place_of_supply}
              after={
                note.settled_paise > 0 ? (
                  <TotalsRow
                    label={t('credit_note.settled')}
                    paise={note.settled_paise}
                    tone="success"
                  />
                ) : null
              }
            />
            {note.loyalty_points_reversed > 0 || note.loyalty_points_restored > 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">
                {[
                  note.loyalty_points_reversed > 0
                    ? t('credit_note.points_reversed', { count: note.loyalty_points_reversed })
                    : null,
                  note.loyalty_points_restored > 0
                    ? t('credit_note.points_restored', { count: note.loyalty_points_restored })
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            ) : null}
          </Section>

          <Section title={t('credit_note.original_bill')}>
            {note.invoice ? (
              <div className="flex items-center justify-between gap-2 text-sm">
                <div>
                  <Link
                    to={`/sales/invoices/${note.invoice.id}`}
                    className="font-semibold text-primary hover:underline"
                  >
                    {note.invoice.number ?? t('returns.open_bill')}
                  </Link>
                  <div className="text-xs text-muted-foreground">
                    {formatDate(note.invoice.invoice_date)}
                  </div>
                </div>
                <Money paise={note.invoice.total_paise} />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('returns.no_bill')}</p>
            )}
          </Section>

          <Section title={t('invoice.customer')}>
            <div className="text-sm">
              <div className="font-semibold">{note.customer_name ?? t('invoice.walk_in')}</div>
              {note.customer_gstin ? (
                <div className="text-muted-foreground">GSTIN {note.customer_gstin}</div>
              ) : null}
              <div className="mt-1 text-xs text-muted-foreground">
                {t('tax.place_of_supply', {
                  state: stateName(note.place_of_supply, i18n.language),
                })}
              </div>
              {note.customer_id ? (
                <Button variant="link" size="sm" asChild className="mt-1">
                  <Link to={`/parties/customers/${note.customer_id}`}>
                    {t('invoice.open_khata')}
                  </Link>
                </Button>
              ) : null}
            </div>
          </Section>

          <Section title={t('invoice.details')}>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">{t('credit_note.reason')}</dt>
              <dd>{reasonLabel(note.reason, i18n.language)}</dd>
              <dt className="text-muted-foreground">{t('credit_note.settlement')}</dt>
              <dd>{settlementLabel(note.settlement, i18n.language)}</dd>
              <dt className="text-muted-foreground">{t('invoice.date_time')}</dt>
              <dd>{formatDateTime(note.created_at, tz)}</dd>
              {note.created_by_name ? (
                <>
                  <dt className="text-muted-foreground">{t('credit_note.by')}</dt>
                  <dd>{note.created_by_name}</dd>
                </>
              ) : null}
            </dl>
          </Section>
        </div>
      </div>

      <CancelReasonDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title={t('credit_note.cancel_title', { number: note.number })}
        consequences={consequences}
        quickReasons={[
          t('credit_note.reason_wrong_qty'),
          t('credit_note.reason_wrong_bill'),
          t('credit_note.reason_customer_took_back'),
        ]}
        confirmLabel={t('credit_note.cancel_confirm')}
        pending={cancel.isPending}
        error={cancelError}
        onConfirm={doCancel}
      />
    </div>
  )
}

function SettlementSentence({ note }: { note: CreditNoteDetail }) {
  const { t } = useTranslation('sales')
  const amount = formatMoney(note.total_paise)
  switch (note.settlement) {
    case 'cash':
      return t('credit_note.settled_cash', { amount })
    case 'upi':
      return t('credit_note.settled_upi', { amount })
    case 'bank_transfer':
      return t('credit_note.settled_bank', { amount })
    case 'adjust_due':
      return t('credit_note.settled_due', { amount })
    case 'store_credit':
      return t('credit_note.settled_store_credit', { amount })
  }
}
