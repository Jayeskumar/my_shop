/**
 * A purchase order: status and receipt progress, the ordered / received / pending quantities per
 * line with today's stock, the bills received against it, notes and terms — and the actions its
 * status allows (purchaseOrderActions): edit, send to the supplier (WhatsApp / SMS / share),
 * print (bilingual), receive (a draft bill with the pending quantities), close, cancel, delete.
 */
import {
  type PurchaseOrderDetail,
  type PurchaseOrderLine,
  purchaseOrderActions,
  purchasesRoutes,
} from '@kadai/shared/api/purchases'
import { useQueryClient } from '@tanstack/react-query'
import { Ban, CheckCheck, PackageCheck, Pencil, Printer, Send, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation, useNavigate } from 'react-router'
import {
  Button,
  Card,
  DataTable,
  type DataTableColumn,
  Money,
  PageHeader,
  Qty,
  notify,
  useConfirm,
} from '@/components/ui'
import { useCan, useMe } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { formatBp, formatDate, formatDateTime, formatPhone } from '@/lib/format'
import { localizedName } from '@/lib/i18n'
import { routeQueryKey } from '@/lib/query'
import { useBillFromOrder, useCancelOrder, useCloseOrder, useDeleteOrder } from '../api'
import { notifyPurchasesError } from '../lib/errors'
import { packUnitFor } from '../lib/labels'
import { printPurchaseDocument, purchaseOrderHtml } from '../lib/print-docs'
import type { OrderLocationState } from './OrderEditor'
import { ReasonDialog } from './ReasonDialog'
import { SendOrderDialog } from './SendOrderDialog'
import { BillStatusBadge, OrderStatusBadge } from './StatusBadges'

export function OrderDetail({ order, onEdit }: { order: PurchaseOrderDetail; onEdit: () => void }) {
  const { t } = useTranslation(['purchases', 'common'])
  const me = useMe()
  const navigate = useNavigate()
  const location = useLocation()
  const confirm = useConfirm()
  const queryClient = useQueryClient()
  const canWrite = useCan('purchases.write')
  const actions = purchaseOrderActions(order.status)
  const [sendOpen, setSendOpen] = useState(false)
  const [statusDialog, setStatusDialog] = useState<'cancel' | 'close' | null>(null)
  const receive = useBillFromOrder()
  const cancel = useCancelOrder()
  const close = useCloseOrder()
  const remove = useDeleteOrder()

  // "Save & send" in the editor lands here with { send: true }.
  useEffect(() => {
    const state = location.state as OrderLocationState | null
    if (state?.send && actions.send && canWrite) {
      setSendOpen(true)
      navigate(location.pathname, { replace: true, state: null })
    }
    // only on arrival
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state])

  const startReceive = (): void => {
    receive.mutate(
      { params: { orderId: order.id }, body: {} },
      {
        onSuccess: (res) => {
          queryClient.setQueryData(
            routeQueryKey(purchasesRoutes.getBill, { params: { id: res.data.id } }),
            {
              data: res.data,
            },
          )
          notify.success(t('orders.receive_started', { number: order.number }), {
            description: t('orders.receive_started_hint'),
          })
          navigate(`/purchases/bills/${res.data.id}`)
        },
        onError: notifyPurchasesError,
      },
    )
  }

  const deleteOrder = async (): Promise<void> => {
    const ok = await confirm({
      title: t('orders.delete_title', { number: order.number }),
      description: t('orders.delete_description'),
      confirmLabel: t('orders.delete_confirm'),
      tone: 'danger',
    })
    if (!ok) return
    remove.mutate(
      { params: { id: order.id } },
      {
        onSuccess: () => {
          notify.success(t('orders.deleted', { number: order.number }))
          navigate('/purchases/orders', { replace: true })
        },
        onError: notifyPurchasesError,
      },
    )
  }

  const print = (): void => {
    void printPurchaseDocument(purchaseOrderHtml(order, me), order.number).catch((e: unknown) =>
      notify.error(e),
    )
  }

  const columns = useMemo<DataTableColumn<PurchaseOrderLine>[]>(
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
              {row.original.product.sku}
              {row.original.notes ? ` · ${row.original.notes}` : ''}
            </div>
          </div>
        ),
      },
      {
        id: 'qty',
        size: 110,
        header: t('orders.col_ordered'),
        meta: { align: 'right', label: t('orders.col_ordered') },
        cell: ({ row }) => <LineQty line={row.original} milli={row.original.qty_milli} />,
      },
      {
        id: 'received',
        size: 110,
        header: t('orders.col_received'),
        meta: { align: 'right', label: t('orders.col_received') },
        cell: ({ row }) => (
          <span
            className={
              row.original.received_qty_milli > 0 ? 'text-success' : 'text-muted-foreground'
            }
          >
            <LineQty line={row.original} milli={row.original.received_qty_milli} />
          </span>
        ),
      },
      {
        id: 'pending',
        size: 110,
        header: t('orders.col_pending'),
        meta: { align: 'right', mobile: 'subtitle', label: t('orders.col_pending') },
        cell: ({ row }) =>
          row.original.pending_qty_milli > 0 ? (
            <span className="font-medium text-warning">
              <LineQty line={row.original} milli={row.original.pending_qty_milli} />
            </span>
          ) : (
            <span className="text-success">{t('orders.line_done')}</span>
          ),
      },
      {
        id: 'stock',
        size: 110,
        header: t('orders.col_stock'),
        meta: { align: 'right', label: t('orders.col_stock') },
        cell: ({ row }) =>
          row.original.current_stock_milli === null ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            <LineQty line={row.original} milli={row.original.current_stock_milli} />
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
        id: 'total',
        size: 120,
        header: t('lines.amount'),
        meta: { align: 'right', mobile: 'value', label: t('lines.amount') },
        cell: ({ row }) => <Money paise={row.original.total_paise} className="font-semibold" />,
      },
    ],
    [t],
  )

  const progress = Math.min(100, Math.round(order.received_bp / 100))
  return (
    <div className="pb-6">
      <PageHeader
        backTo="/purchases/orders"
        title={order.number}
        description={order.supplier_name}
        meta={<OrderStatusBadge status={order.status} size="md" />}
        actions={
          <>
            <Button variant="outline" leftIcon={<Printer />} onClick={print}>
              {t('common:actions.print')}
            </Button>
            {canWrite && actions.edit ? (
              <Button variant="outline" leftIcon={<Pencil />} onClick={onEdit}>
                {t('common:actions.edit')}
              </Button>
            ) : null}
            {canWrite && actions.send ? (
              <Button variant="outline" leftIcon={<Send />} onClick={() => setSendOpen(true)}>
                {order.status === 'sent' ? t('orders.send_again') : t('orders.send')}
              </Button>
            ) : null}
            {canWrite && actions.receive ? (
              <Button
                leftIcon={<PackageCheck />}
                loading={receive.isPending}
                onClick={startReceive}
              >
                {t('orders.receive')}
              </Button>
            ) : null}
          </>
        }
      />

      <div className="mb-4 grid gap-3 md:grid-cols-3">
        <Card className="p-4">
          <div className="text-xs font-medium text-muted-foreground">{t('detail.supplier')}</div>
          <div className="mt-1 text-base font-semibold">{order.supplier.name}</div>
          <div className="text-xs text-muted-foreground">
            {order.supplier.gstin ?? t('supplier.unregistered')}
          </div>
          {order.supplier.phone ? (
            <div className="text-xs text-muted-foreground">{formatPhone(order.supplier.phone)}</div>
          ) : null}
        </Card>
        <Card className="p-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">{t('orders.order_date')}</dt>
            <dd className="tabular-nums">{formatDate(order.order_date)}</dd>
            <dt className="text-muted-foreground">{t('orders.expected_date')}</dt>
            <dd className="tabular-nums">
              {order.expected_date ? formatDate(order.expected_date) : '—'}
            </dd>
            <dt className="text-muted-foreground">{t('orders.sent_at')}</dt>
            <dd>{order.sent_at ? formatDateTime(order.sent_at) : t('orders.not_sent')}</dd>
            {order.created_by_name ? (
              <>
                <dt className="text-muted-foreground">{t('orders.created_by')}</dt>
                <dd>{order.created_by_name}</dd>
              </>
            ) : null}
          </dl>
        </Card>
        <Card className="p-4">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm text-muted-foreground">{t('totals.total')}</span>
            <Money paise={order.total_paise} className="text-lg font-bold" />
          </div>
          <div className="mt-3">
            <div className="mb-1 flex justify-between text-xs text-muted-foreground">
              <span>{t('orders.received_progress')}</span>
              <span className="tabular-nums">{progress}%</span>
            </div>
            <div
              className="h-2 overflow-hidden rounded-full bg-surface-2"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress}
              aria-label={t('orders.received_progress')}
            >
              <div
                className={cn('h-full rounded-full', progress >= 100 ? 'bg-success' : 'bg-primary')}
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        </Card>
      </div>

      <section aria-labelledby="po-lines" className="mb-4 grid gap-2">
        <h2 id="po-lines" className="text-base font-semibold">
          {t('lines.title')}{' '}
          <span className="text-sm font-normal text-muted-foreground">({order.lines.length})</span>
        </h2>
        <DataTable
          label={t('lines.title')}
          columns={columns}
          data={order.lines}
          getRowId={(l) => l.id}
          density="compact"
        />
        <div className="flex justify-end text-sm">
          <dl className="grid min-w-64 grid-cols-[1fr_auto] gap-x-6 gap-y-1">
            <dt className="text-muted-foreground">{t('totals.taxable')}</dt>
            <dd className="text-end">
              <Money paise={order.taxable_paise} />
            </dd>
            <dt className="text-muted-foreground">
              {order.is_interstate ? t('totals.igst') : t('orders.gst_total')}
            </dt>
            <dd className="text-end">
              <Money paise={order.tax_paise} />
            </dd>
            <dt className="font-semibold">{t('totals.total')}</dt>
            <dd className="text-end font-semibold">
              <Money paise={order.total_paise} />
            </dd>
          </dl>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <h2 className="mb-2 text-sm font-semibold">{t('orders.bills_received')}</h2>
          {order.bills.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('orders.no_bills_yet')}</p>
          ) : (
            <ul className="grid gap-2">
              {order.bills.map((b) => (
                <li key={b.id}>
                  <Link
                    to={`/purchases/bills/${b.id}`}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border p-2.5 text-sm hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{b.number ?? t('bills.draft_number')}</span>
                        <BillStatusBadge status={b.status} />
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {t('bills.invoice_ref', {
                          no: b.supplier_invoice_no || '—',
                          date: formatDate(b.received_date),
                        })}
                      </div>
                    </div>
                    <Money paise={b.total_paise} className="shrink-0 font-medium" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="grid gap-3 p-4 text-sm">
          <div>
            <h2 className="mb-1 font-semibold">{t('orders.notes')}</h2>
            <p className="whitespace-pre-wrap text-muted-foreground">{order.notes || '—'}</p>
          </div>
          <div>
            <h2 className="mb-1 font-semibold">{t('orders.terms')}</h2>
            <p className="whitespace-pre-wrap text-muted-foreground">{order.terms || '—'}</p>
          </div>
        </Card>
      </div>

      {canWrite && (actions.close || actions.cancel || actions.delete) ? (
        <div className="mt-6 flex flex-wrap justify-end gap-2 border-t border-border pt-4">
          {actions.close ? (
            <Button
              variant="outline"
              leftIcon={<CheckCheck />}
              onClick={() => setStatusDialog('close')}
            >
              {t('orders.close')}
            </Button>
          ) : null}
          {actions.cancel ? (
            <Button
              variant="ghost"
              className="text-danger"
              leftIcon={<Ban />}
              onClick={() => setStatusDialog('cancel')}
            >
              {t('orders.cancel')}
            </Button>
          ) : null}
          {actions.delete ? (
            <Button
              variant="ghost"
              className="text-danger"
              leftIcon={<Trash2 />}
              loading={remove.isPending}
              onClick={() => void deleteOrder()}
            >
              {t('orders.delete')}
            </Button>
          ) : null}
        </div>
      ) : null}

      <SendOrderDialog order={order} open={sendOpen} onOpenChange={setSendOpen} />
      <ReasonDialog
        open={statusDialog !== null}
        onOpenChange={(o) => !o && setStatusDialog(null)}
        optional
        tone={statusDialog === 'close' ? 'primary' : 'danger'}
        title={
          statusDialog === 'close'
            ? t('orders.close_title', { number: order.number })
            : t('orders.cancel_title', { number: order.number })
        }
        description={
          statusDialog === 'close' ? t('orders.close_description') : t('orders.cancel_description')
        }
        confirmLabel={statusDialog === 'close' ? t('orders.close') : t('orders.cancel_confirm')}
        onConfirm={(reason) => {
          const mutation = statusDialog === 'close' ? close : cancel
          return mutation
            .mutateAsync({ params: { id: order.id }, body: reason ? { reason } : {} })
            .then(
              () =>
                notify.success(
                  statusDialog === 'close'
                    ? t('orders.closed', { number: order.number })
                    : t('orders.cancelled', { number: order.number }),
                ),
              (error: unknown) => {
                notifyPurchasesError(error)
                throw error
              },
            )
        }}
      />
    </div>
  )
}

function LineQty({ line, milli }: { line: PurchaseOrderLine; milli: number }) {
  return (
    <Qty
      milli={milli}
      unit={line.product.unit}
      packSize={line.product.pack_size}
      packUnit={packUnitFor(line.product.unit)}
    />
  )
}
