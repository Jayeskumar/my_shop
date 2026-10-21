/**
 * Debit note (/purchases/returns/:id): supplier, the bill it was raised against, reason and
 * settlement (how much reduced the bill's due, refunds received), the returned lines with batch
 * and expiry, totals with the GST split. Print the bilingual debit note for the supplier; cancel
 * (stock, journal and settlement reversed) with a reason.
 */
import { PAYMENT_METHOD_LABELS } from '@kadai/shared/api/payments'
import type { DebitNoteDetail, DebitNoteLine } from '@kadai/shared/api/purchases'
import { Ban, Printer } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
import {
  Button,
  Card,
  DataTable,
  type DataTableColumn,
  Money,
  PageHeader,
  Qty,
  notify,
} from '@/components/ui'
import { useCan, useMe } from '@/lib/auth'
import { formatBp, formatDate, formatDateTime, formatMoney } from '@/lib/format'
import { localizedName } from '@/lib/i18n'
import { useCancelDebitNote, useDebitNote } from '../api'
import { DetailError, DetailSkeleton } from '../components/PageState'
import { ReasonDialog } from '../components/ReasonDialog'
import { DebitNoteStatusBadge } from '../components/StatusBadges'
import { TaxBreakupTable, TotalsBlock } from '../components/TaxBreakup'
import { notifyPurchasesError } from '../lib/errors'
import { bilingual, packUnitFor } from '../lib/labels'
import { debitNoteHtml, printPurchaseDocument } from '../lib/print-docs'

export default function ReturnPage() {
  const { t } = useTranslation('purchases')
  const { id } = useParams<{ id: string }>()
  const query = useDebitNote(id)
  const note = query.data?.data
  if (query.isLoading) return <DetailSkeleton />
  if (!note) {
    return (
      <DetailError
        error={query.error}
        backTo="/purchases/returns"
        backLabel={t('returns.back_to_list')}
        onRetry={() => void query.refetch()}
      />
    )
  }
  return <ReturnDetail note={note} />
}

function ReturnDetail({ note }: { note: DebitNoteDetail }) {
  const { t } = useTranslation(['purchases', 'common'])
  const me = useMe()
  const location = useLocation()
  const navigate = useNavigate()
  const canWrite = useCan('purchases.write')
  const [cancelOpen, setCancelOpen] = useState(false)
  const cancel = useCancelDebitNote()
  const livePayments = note.payments.filter((p) => p.status !== 'cancelled')

  const print = (): void => {
    void printPurchaseDocument(debitNoteHtml(note, me), note.number).catch((e: unknown) =>
      notify.error(e),
    )
  }

  // Just created: offer printing right away.
  useEffect(() => {
    const state = location.state as { print?: boolean } | null
    if (state?.print) {
      navigate(location.pathname, { replace: true, state: null })
      // A stable id: the arrival effect may run twice (React strict mode) — one toast only.
      notify.info(t('returns.print_prompt', { number: note.number }), {
        id: `debit-note-print-${note.id}`,
        action: { label: t('common:actions.print'), onClick: print },
      })
    }
    // only on arrival
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const columns = useMemo<DataTableColumn<DebitNoteLine>[]>(
    () => [
      {
        id: 'product',
        size: 300,
        header: t('lines.item'),
        meta: { mobile: 'title' },
        cell: ({ row }) => (
          <div className="min-w-0">
            <div className="font-medium [overflow-wrap:anywhere]">
              {row.original.line_no}.{' '}
              {localizedName(row.original.product.name, row.original.product.name_ta)}
            </div>
            <div className="text-xs text-muted-foreground">
              {row.original.hsn_code ? `HSN ${row.original.hsn_code}` : row.original.product.sku}
            </div>
          </div>
        ),
      },
      {
        id: 'batch',
        size: 170,
        header: t('lines.batch_expiry'),
        meta: { mobile: 'subtitle', label: t('lines.batch_expiry') },
        cell: ({ row }) =>
          row.original.batch_no ? (
            <span className="text-sm">
              <span className="font-mono">{row.original.batch_no}</span>
              {row.original.expiry_date ? ` · ${formatDate(row.original.expiry_date)}` : ''}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: 'qty',
        size: 110,
        header: t('lines.qty'),
        meta: { align: 'right', label: t('lines.qty') },
        cell: ({ row }) => (
          <Qty
            milli={row.original.qty_milli}
            unit={row.original.unit}
            packSize={row.original.pack_size}
            packUnit={packUnitFor(row.original.unit)}
          />
        ),
      },
      {
        id: 'rate',
        size: 110,
        header: t('lines.rate'),
        meta: { align: 'right', label: t('lines.rate') },
        cell: ({ row }) => (
          <div className="text-end">
            <Money paise={row.original.unit_cost_paise} />
            <div className="text-xs text-muted-foreground">
              {formatBp(row.original.gst_rate_bp)}
            </div>
          </div>
        ),
      },
      {
        id: 'taxable',
        size: 120,
        header: t('lines.taxable'),
        meta: { align: 'right', label: t('lines.taxable') },
        cell: ({ row }) => <Money paise={row.original.taxable_paise} />,
      },
      {
        id: 'total',
        size: 120,
        header: t('lines.amount'),
        meta: { align: 'right', mobile: 'value', label: t('lines.amount') },
        cell: ({ row }) => <Money paise={row.original.total_paise} className="font-semibold" />,
      },
    ],
    [t],
  )

  return (
    <div className="pb-6">
      <PageHeader
        backTo="/purchases/returns"
        title={note.number}
        description={note.supplier_name}
        meta={<DebitNoteStatusBadge status={note.status} size="md" />}
        actions={
          <>
            <Button variant="outline" leftIcon={<Printer />} onClick={print}>
              {t('returns.print')}
            </Button>
            {canWrite && note.status === 'completed' ? (
              <Button
                variant="ghost"
                className="text-danger"
                leftIcon={<Ban />}
                onClick={() => setCancelOpen(true)}
              >
                {t('returns.cancel')}
              </Button>
            ) : null}
          </>
        }
      />

      {note.status === 'cancelled' ? (
        <div
          role="status"
          className="mb-4 rounded-xl border border-danger/40 bg-danger-soft/40 p-3 text-sm"
        >
          <div className="font-semibold text-danger">{t('returns.cancelled_banner')}</div>
          <div className="text-muted-foreground">
            {[
              note.cancel_reason,
              note.cancelled_by_name,
              note.cancelled_at ? formatDateTime(note.cancelled_at) : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
      ) : null}

      <div className="mb-4 grid gap-3 md:grid-cols-3">
        <Card className="p-4">
          <div className="text-xs font-medium text-muted-foreground">{t('detail.supplier')}</div>
          <div className="mt-1 text-base font-semibold">{note.supplier.name}</div>
          <div className="text-xs text-muted-foreground">
            {note.supplier.gstin ?? t('supplier.unregistered')}
          </div>
          <div className="text-xs text-muted-foreground">
            {note.is_interstate ? t('detail.interstate') : t('detail.intrastate')}
          </div>
        </Card>
        <Card className="p-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">{t('returns.note_date')}</dt>
            <dd className="tabular-nums">{formatDate(note.note_date)}</dd>
            <dt className="text-muted-foreground">{t('returns.reason')}</dt>
            <dd>{t(`reasons.${note.reason}`)}</dd>
            <dt className="text-muted-foreground">{t('returns.bill')}</dt>
            <dd>
              {note.bill_id ? (
                <Link
                  className="text-primary underline-offset-4 hover:underline"
                  to={`/purchases/bills/${note.bill_id}`}
                >
                  {note.bill_number ?? t('bills.draft_number')}
                </Link>
              ) : (
                t('returns.without_bill')
              )}
              {note.supplier_invoice_no ? (
                <span className="text-muted-foreground"> · {note.supplier_invoice_no}</span>
              ) : null}
            </dd>
            {note.created_by_name ? (
              <>
                <dt className="text-muted-foreground">{t('orders.created_by')}</dt>
                <dd>{note.created_by_name}</dd>
              </>
            ) : null}
          </dl>
        </Card>
        <Card className="p-4">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm text-muted-foreground">{t('returns.total')}</span>
            <Money paise={note.total_paise} className="text-lg font-bold" />
          </div>
          <div className="mt-2 text-sm font-medium">{t(`settlement.${note.settlement}`)}</div>
          {note.settlement === 'adjust_due' ? (
            <p className="text-xs text-muted-foreground">
              {!note.bill_id
                ? t('returns.adjusted_free_form')
                : note.adjusted_paise >= note.supplier_amount_paise
                  ? t('returns.adjusted_all', { adjusted: formatMoney(note.adjusted_paise) })
                  : t('returns.adjusted_detail', {
                      adjusted: formatMoney(note.adjusted_paise),
                      advance: formatMoney(
                        Math.max(0, note.supplier_amount_paise - note.adjusted_paise),
                      ),
                    })}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {livePayments.length > 0
                ? t('returns.refund_received', {
                    amount: formatMoney(livePayments.reduce((s, p) => s + p.amount_paise, 0)),
                  })
                : t('returns.refund_pending')}
            </p>
          )}
        </Card>
      </div>

      <section aria-labelledby="dn-lines" className="mb-4 grid gap-2">
        <h2 id="dn-lines" className="text-base font-semibold">
          {t('lines.title')}{' '}
          <span className="text-sm font-normal text-muted-foreground">({note.lines.length})</span>
        </h2>
        <DataTable
          label={t('lines.title')}
          columns={columns}
          data={note.lines}
          getRowId={(l) => l.id}
          density="compact"
        />
      </section>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)]">
        <div className="grid content-start gap-4">
          {note.payments.length > 0 ? (
            <Card className="p-4">
              <h2 className="mb-2 text-sm font-semibold">{t('returns.refunds')}</h2>
              <ul className="grid gap-2">
                {note.payments.map((p) => (
                  <li
                    key={p.payment_id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border p-2.5 text-sm"
                  >
                    <div className="min-w-0">
                      <Link
                        to={`/payments?id=${p.payment_id}`}
                        className="font-medium text-primary underline-offset-4 hover:underline"
                      >
                        {p.number ?? t('detail.payment')}
                      </Link>
                      <div className="text-xs text-muted-foreground">
                        {[
                          formatDate(p.payment_date),
                          bilingual(PAYMENT_METHOD_LABELS[p.method]),
                          p.reference,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                    </div>
                    <Money
                      paise={p.amount_paise}
                      className={p.status === 'cancelled' ? 'line-through' : 'font-medium'}
                    />
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
          <Card className="p-4 text-sm">
            <h2 className="mb-1 font-semibold">{t('editor.notes')}</h2>
            <p className="whitespace-pre-wrap text-muted-foreground">{note.notes || '—'}</p>
          </Card>
        </div>
        <Card className="content-start p-4">
          <h2 className="mb-2 text-base font-semibold">{t('totals.title')}</h2>
          <TotalsBlock totals={note} interstate={note.is_interstate} />
          {note.tax_breakup.length > 0 ? (
            <details className="mt-3 rounded-lg border border-border px-3 py-2" open>
              <summary className="cursor-pointer text-sm font-medium">
                {t('totals.tax_split')}
              </summary>
              <TaxBreakupTable
                rows={note.tax_breakup}
                interstate={note.is_interstate}
                className="mt-2"
              />
            </details>
          ) : null}
        </Card>
      </div>

      <ReasonDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title={t('returns.cancel_title', { number: note.number })}
        description={t('returns.cancel_description')}
        confirmLabel={t('returns.cancel_confirm')}
        onConfirm={(reason) =>
          cancel.mutateAsync({ params: { id: note.id }, body: { reason } }).then(
            () => notify.success(t('returns.cancelled', { number: note.number })),
            (error: unknown) => {
              notifyPurchasesError(error)
              throw error
            },
          )
        }
      />
    </div>
  )
}
