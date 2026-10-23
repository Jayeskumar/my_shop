/**
 * A posted or cancelled purchase bill (GRN): supplier, invoice and amounts at a glance, the
 * received lines (batch, expiry, landed cost, returned quantity), totals with the GST split, the
 * supplier payments and debit notes against it, the invoice photo — and the actions the bill's
 * state and the user's permissions allow: pay now, create a return, print the GRN, cancel.
 */
import { PAYMENT_METHOD_LABELS } from '@kadai/shared/api/payments'
import {
  type PurchaseBillDetail,
  type PurchaseBillLine,
  purchaseBillActions,
} from '@kadai/shared/api/purchases'
import { Ban, Eye, IndianRupee, Printer, Undo2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation, useNavigate } from 'react-router'
import {
  Badge,
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
import { cn } from '@/lib/cn'
import { formatBp, formatDate, formatDateTime } from '@/lib/format'
import { localizedName } from '@/lib/i18n'
import { useCancelBill } from '../api'
import { notifyPurchasesError } from '../lib/errors'
import { bilingual, packUnitFor } from '../lib/labels'
import { goodsReceiptHtml, printPurchaseDocument } from '../lib/print-docs'
import { warningText } from '../lib/warnings'
import { AttachmentField } from './AttachmentField'
import { PayBillDialog } from './PayBillDialog'
import { ReasonDialog } from './ReasonDialog'
import { BillStatusBadge, DebitNoteStatusBadge, PaymentStatusBadge } from './StatusBadges'
import { SupplierQuickView } from './SupplierQuickView'
import { TaxBreakupTable, TotalsBlock } from './TaxBreakup'

interface DetailLocationState {
  pay?: boolean
}

export function BillDetail({ bill }: { bill: PurchaseBillDetail }) {
  const { t } = useTranslation(['purchases', 'common'])
  const me = useMe()
  const navigate = useNavigate()
  const location = useLocation()
  const canWrite = useCan('purchases.write')
  const canPay = useCan('payments.pay')
  const [payOpen, setPayOpen] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)
  const [quickView, setQuickView] = useState(false)
  const cancel = useCancelBill()
  const livePayments = bill.payments.filter((p) => p.status !== 'cancelled')
  const actions = purchaseBillActions(bill.status, {
    due_paise: bill.due_paise,
    has_live_payments: livePayments.length > 0,
  })
  const liveNotes = bill.debit_notes.filter((n) => n.status !== 'cancelled')
  // Cancelling needs the live payments and debit notes against the bill cancelled first.
  const canCancel = actions.cancel && liveNotes.length === 0

  // "Pay now" from the post toast lands here with { pay: true }.
  useEffect(() => {
    const state = location.state as DetailLocationState | null
    if (state?.pay && actions.pay && canPay) {
      setPayOpen(true)
      navigate(location.pathname, { replace: true, state: null })
    }
    // only on arrival
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const print = (): void => {
    void printPurchaseDocument(goodsReceiptHtml(bill, me), bill.number ?? 'GRN').catch(
      (e: unknown) => notify.error(e),
    )
  }

  const columns = useMemo<DataTableColumn<PurchaseBillLine>[]>(
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
              {[
                row.original.product.sku,
                row.original.hsn_code ? `HSN ${row.original.hsn_code}` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </div>
          </div>
        ),
      },
      {
        id: 'batch',
        size: 130,
        header: t('lines.batch_expiry'),
        meta: { mobile: 'subtitle', label: t('lines.batch_expiry') },
        cell: ({ row }) =>
          row.original.batch_no ? (
            <div className="text-sm">
              <span className="font-mono">{row.original.batch_no}</span>
              {row.original.expiry_date ? (
                <div className="text-xs text-muted-foreground tabular-nums">
                  {formatDate(row.original.expiry_date)}
                </div>
              ) : null}
            </div>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: 'qty',
        size: 120,
        header: t('lines.qty'),
        meta: { align: 'right', label: t('lines.qty') },
        cell: ({ row }) => {
          const l = row.original
          return (
            <div className="text-end">
              <Qty
                milli={l.qty_milli}
                unit={l.unit}
                packSize={l.pack_size}
                packUnit={packUnitFor(l.unit)}
              />
              {l.free_qty_milli > 0 ? (
                <div className="text-xs text-success">
                  +{' '}
                  <Qty
                    milli={l.free_qty_milli}
                    unit={l.unit}
                    packSize={l.pack_size}
                    packUnit={packUnitFor(l.unit)}
                  />{' '}
                  {t('lines.free')}
                </div>
              ) : null}
              {l.returned_qty_milli > 0 ? (
                <div className="text-xs text-warning">
                  {t('detail.returned_qty')}{' '}
                  <Qty
                    milli={l.returned_qty_milli}
                    unit={l.unit}
                    packSize={l.pack_size}
                    packUnit={packUnitFor(l.unit)}
                  />
                </div>
              ) : null}
            </div>
          )
        },
      },
      {
        id: 'mrp',
        size: 100,
        header: t('lines.mrp'),
        meta: { align: 'right', label: t('lines.mrp') },
        cell: ({ row }) => <Money paise={row.original.mrp_paise} empty="—" />,
      },
      {
        id: 'rate',
        size: 110,
        header: t('lines.rate'),
        meta: { align: 'right', label: t('lines.rate') },
        cell: ({ row }) => (
          <div className="text-end">
            <Money paise={row.original.unit_cost_paise} />
            {row.original.discount_bp > 0 ? (
              <div className="text-xs text-muted-foreground">
                {t('detail.discount_bp', { rate: formatBp(row.original.discount_bp) })}
              </div>
            ) : null}
          </div>
        ),
      },
      {
        id: 'gst',
        size: 70,
        header: t('lines.gst'),
        meta: { align: 'right', label: t('lines.gst') },
        cell: ({ row }) => (
          <span className="tabular-nums">{formatBp(row.original.gst_rate_bp)}</span>
        ),
      },
      {
        id: 'landed',
        size: 110,
        header: t('detail.landed_cost'),
        meta: { align: 'right', label: t('detail.landed_cost') },
        cell: ({ row }) => <Money paise={row.original.landed_unit_cost_paise} />,
      },
      {
        id: 'total',
        size: 130,
        header: t('lines.amount'),
        meta: { align: 'right', mobile: 'value', label: t('lines.amount') },
        cell: ({ row }) => (
          <div className="text-end">
            <Money paise={row.original.total_paise} className="font-semibold" />
            <div className="text-xs text-muted-foreground">
              {t('lines.taxable')} <Money paise={row.original.taxable_paise} />
            </div>
          </div>
        ),
      },
    ],
    [t],
  )

  const overdue = bill.status === 'posted' && bill.overdue
  return (
    <div className="pb-6">
      <PageHeader
        backTo="/purchases/bills"
        title={bill.number ?? t('detail.bill_title')}
        description={t('detail.bill_description', {
          name: bill.supplier_name,
          no: bill.supplier_invoice_no,
          date: formatDate(bill.supplier_invoice_date),
        })}
        meta={
          <div className="flex flex-wrap items-center gap-1.5">
            <BillStatusBadge status={bill.status} size="md" />
            {bill.status === 'posted' ? (
              <PaymentStatusBadge status={bill.payment_status} overdue={overdue} size="md" />
            ) : null}
          </div>
        }
        actions={
          <>
            {bill.status === 'posted' ? (
              <Button variant="outline" leftIcon={<Printer />} onClick={print}>
                {t('detail.print_grn')}
              </Button>
            ) : null}
            {actions.return && canWrite ? (
              <Button
                variant="outline"
                leftIcon={<Undo2 />}
                onClick={() => navigate(`/purchases/returns/new?bill_id=${bill.id}`)}
              >
                {t('detail.create_return')}
              </Button>
            ) : null}
            {canCancel && canWrite ? (
              <Button
                variant="ghost"
                className="text-danger"
                leftIcon={<Ban />}
                onClick={() => setCancelOpen(true)}
              >
                {t('detail.cancel_bill')}
              </Button>
            ) : null}
            {actions.pay && canPay ? (
              <Button variant="success" leftIcon={<IndianRupee />} onClick={() => setPayOpen(true)}>
                {t('bill.pay_now')}
              </Button>
            ) : null}
          </>
        }
      />

      {bill.status === 'cancelled' ? (
        <div
          role="status"
          className="mb-4 rounded-xl border border-danger/40 bg-danger-soft/40 p-3 text-sm"
        >
          <div className="font-semibold text-danger">{t('detail.cancelled_banner')}</div>
          <div className="text-muted-foreground">
            {[
              bill.cancel_reason,
              bill.cancelled_by_name,
              bill.cancelled_at ? formatDateTime(bill.cancelled_at) : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
      ) : null}
      {bill.status === 'posted' && canWrite && !canCancel ? (
        <p className="mb-3 text-xs text-muted-foreground">
          {livePayments.length > 0
            ? t('detail.cancel_needs_no_payments')
            : t('detail.cancel_has_notes')}
        </p>
      ) : null}

      <div className="mb-4 grid gap-3 md:grid-cols-3">
        <Card className="p-4">
          <div className="text-xs font-medium text-muted-foreground">{t('detail.supplier')}</div>
          <button
            type="button"
            onClick={() => setQuickView(true)}
            className="mt-1 flex items-center gap-1.5 text-start text-base font-semibold text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          >
            {bill.supplier.name}
            <Eye className="size-4" aria-hidden />
          </button>
          <div className="mt-1 text-xs text-muted-foreground">
            {bill.supplier.gstin ?? t('supplier.unregistered')}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {bill.is_interstate ? t('detail.interstate') : t('detail.intrastate')}
            {bill.reverse_charge ? ` · ${t('detail.reverse_charge')}` : ''}
            {!bill.itc_eligible ? ` · ${t('detail.no_itc')}` : ''}
          </div>
        </Card>
        <Card className="p-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">{t('editor.invoice_no')}</dt>
            <dd className="font-medium">{bill.supplier_invoice_no || '—'}</dd>
            <dt className="text-muted-foreground">{t('editor.invoice_date')}</dt>
            <dd className="tabular-nums">{formatDate(bill.supplier_invoice_date)}</dd>
            <dt className="text-muted-foreground">{t('editor.received_date')}</dt>
            <dd className="tabular-nums">{formatDate(bill.received_date)}</dd>
            <dt className="text-muted-foreground">{t('editor.due_date')}</dt>
            <dd className={cn('tabular-nums', overdue && 'font-semibold text-danger')}>
              {bill.due_date ? formatDate(bill.due_date) : '—'}
              {overdue ? ` · ${t('bills.days_overdue', { count: bill.days_overdue ?? 0 })}` : ''}
            </dd>
            {bill.purchase_order ? (
              <>
                <dt className="text-muted-foreground">{t('detail.order')}</dt>
                <dd>
                  <Link
                    className="text-primary underline-offset-4 hover:underline"
                    to={`/purchases/orders/${bill.purchase_order.id}`}
                  >
                    {bill.purchase_order.number}
                  </Link>
                </dd>
              </>
            ) : null}
          </dl>
        </Card>
        <Card className="p-4">
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">{t('totals.total')}</dt>
            <dd className="text-end font-semibold">
              <Money paise={bill.total_paise} />
            </dd>
            <dt className="text-muted-foreground">{t('detail.paid')}</dt>
            <dd className="text-end">
              <Money paise={bill.paid_paise} />
            </dd>
            {bill.returned_paise > 0 ? (
              <>
                <dt className="text-muted-foreground">{t('detail.returned')}</dt>
                <dd className="text-end">
                  <Money paise={bill.returned_paise} />
                </dd>
              </>
            ) : null}
            <dt className="border-t border-border pt-1 font-semibold">{t('detail.due')}</dt>
            <dd
              className={cn(
                'border-t border-border pt-1 text-end text-lg font-bold',
                bill.due_paise > 0 && (overdue ? 'text-danger' : 'text-accent'),
              )}
            >
              <Money paise={Math.max(0, bill.due_paise)} />
            </dd>
          </dl>
        </Card>
      </div>

      <section aria-labelledby="bill-lines" className="mb-4 grid gap-2">
        <h2 id="bill-lines" className="text-base font-semibold">
          {t('lines.title')}{' '}
          <span className="text-sm font-normal text-muted-foreground">({bill.lines.length})</span>
        </h2>
        <DataTable
          label={t('lines.title')}
          columns={columns}
          data={bill.lines}
          getRowId={(l) => l.id}
          density="compact"
        />
      </section>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)]">
        <div className="grid content-start gap-4">
          {bill.warnings.length > 0 && bill.status !== 'cancelled' ? (
            <Card className="border-warning/40 p-4">
              <h2 className="mb-2 text-sm font-semibold">
                {t('editor.warnings_title', { count: bill.warnings.length })}
              </h2>
              <ul className="grid gap-1 text-sm">
                {bill.warnings.map((w, i) => (
                  <li key={`${w.line_no ?? 0}-${w.code}-${i}`}>
                    {w.line_no ? <span className="font-medium">{w.line_no}. </span> : null}
                    {warningText(w)}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          <Card className="p-4">
            <h2 className="mb-2 text-sm font-semibold">{t('detail.payments')}</h2>
            {bill.payments.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {bill.status === 'posted' ? t('detail.no_payments') : '—'}
              </p>
            ) : (
              <ul className="grid gap-2">
                {bill.payments.map((p) => (
                  <li
                    key={p.payment_id}
                    className={cn(
                      'flex items-center justify-between gap-3 rounded-lg border border-border p-2.5 text-sm',
                      p.status === 'cancelled' && 'opacity-60',
                    )}
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
                    <div className="shrink-0 text-end">
                      <Money
                        paise={p.amount_paise}
                        className={p.status === 'cancelled' ? 'line-through' : 'font-medium'}
                      />
                      {p.status === 'cancelled' ? (
                        <div>
                          <Badge tone="danger" size="sm">
                            {t('common:status.cancelled')}
                          </Badge>
                        </div>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {bill.debit_notes.length > 0 ? (
            <Card className="p-4">
              <h2 className="mb-2 text-sm font-semibold">{t('detail.debit_notes')}</h2>
              <ul className="grid gap-2">
                {bill.debit_notes.map((n) => (
                  <li key={n.id}>
                    <Link
                      to={`/purchases/returns/${n.id}`}
                      className="flex items-center justify-between gap-3 rounded-lg border border-border p-2.5 text-sm hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{n.number}</span>
                          <DebitNoteStatusBadge status={n.status} />
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {formatDate(n.note_date)} · {t(`settlement.${n.settlement}`)}
                        </div>
                      </div>
                      <Money paise={n.total_paise} className="shrink-0 font-medium" />
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          <Card className="grid gap-3 p-4 sm:grid-cols-2">
            <div>
              <h2 className="mb-2 text-sm font-semibold">{t('editor.attachment')}</h2>
              <AttachmentField fileId={bill.attachment_file_id} readOnly onChange={() => {}} />
            </div>
            <div className="text-sm">
              <h2 className="mb-2 font-semibold">{t('editor.notes')}</h2>
              <p className="whitespace-pre-wrap text-muted-foreground">{bill.notes || '—'}</p>
              <p className="mt-3 text-xs text-muted-foreground">
                {[
                  bill.posted_at
                    ? t('detail.posted_by', {
                        name: bill.posted_by_name ?? '—',
                        at: formatDateTime(bill.posted_at),
                      })
                    : null,
                  bill.created_by_name
                    ? t('detail.created_by', { name: bill.created_by_name })
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            </div>
          </Card>
        </div>

        <Card className="content-start p-4">
          <h2 className="mb-2 text-base font-semibold">{t('totals.title')}</h2>
          <TotalsBlock totals={bill} interstate={bill.is_interstate} />
          {bill.tax_breakup.length > 0 ? (
            <details className="mt-3 rounded-lg border border-border px-3 py-2" open>
              <summary className="cursor-pointer text-sm font-medium">
                {t('totals.tax_split')}
              </summary>
              <TaxBreakupTable
                rows={bill.tax_breakup}
                interstate={bill.is_interstate}
                className="mt-2"
              />
            </details>
          ) : null}
        </Card>
      </div>

      <PayBillDialog bill={bill} open={payOpen} onOpenChange={setPayOpen} />
      <ReasonDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title={t('detail.cancel_title', { number: bill.number ?? '' })}
        description={t('detail.cancel_description')}
        confirmLabel={t('detail.cancel_confirm')}
        onConfirm={(reason) =>
          cancel.mutateAsync({ params: { id: bill.id }, body: { reason } }).then(
            () => notify.success(t('detail.cancelled', { number: bill.number ?? '' })),
            (error: unknown) => {
              notifyPurchasesError(error)
              throw error
            },
          )
        }
      />
      <SupplierQuickView
        supplierId={bill.supplier_id}
        fallback={bill.supplier}
        open={quickView}
        onOpenChange={setQuickView}
      />
    </div>
  )
}
