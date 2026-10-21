/**
 * A dispatched / received / cancelled stock transfer: from → to, status timeline, lines with
 * sent, received and short quantities, and the actions the member may take — receive (at the
 * destination store), cancel a dispatched transfer (at the source store, stock goes back) and
 * print the transfer note.
 */
import { identityRoutes } from '@kadai/shared/api/identity'
import {
  type StockTransferDetail,
  TRANSFER_STATUS_LABELS,
  type TransferLine,
  inventoryRoutes,
} from '@kadai/shared/api/inventory'
import {
  ArrowRight,
  Ban,
  CheckCircle2,
  CircleDot,
  PackageCheck,
  Printer,
  Truck,
  XCircle,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
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
  statusTone,
} from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatDate, formatDateTime } from '@/lib/format'
import { printHtml } from '@/lib/print'
import { useRouteMutation, useRouteQuery } from '@/lib/query'
import { useTransferActionAllowed } from '../lib/access'
import { notifyInventoryError } from '../lib/errors'
import { STOCK_ROUTES } from '../lib/invalidate'
import { langOf, packUnitFor, pickLabel } from '../lib/labels'
import { TRANSFER_NOTE_CSS, type TransferStoreInfo, buildTransferNote } from '../lib/print-transfer'
import { ProductName } from './ProductName'
import { ReasonDialog } from './ReasonDialog'
import { ReceiveTransferDialog } from './ReceiveTransferDialog'

const EVENT_ICON = {
  created: CircleDot,
  dispatched: Truck,
  received: CheckCircle2,
  cancelled: XCircle,
} as const

export function TransferDetailView({ doc }: { doc: StockTransferDetail }) {
  const { t, i18n } = useTranslation(['inventory', 'common'])
  const allowed = useTransferActionAllowed()
  const [receiveOpen, setReceiveOpen] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)
  const [printing, setPrinting] = useState(false)
  const stores = useRouteQuery(
    identityRoutes.listStores,
    { query: { limit: 200 } },
    { staleTime: 5 * 60_000, meta: { errorToast: false } },
  )
  const cancel = useRouteMutation(inventoryRoutes.cancelTransfer, {
    invalidates: STOCK_ROUTES,
    onError: () => {},
  })
  const statusLabel = pickLabel(TRANSFER_STATUS_LABELS[doc.status], i18n.language)
  const received = doc.status === 'received'
  const canReceive = doc.status === 'dispatched' && allowed('receive', doc)
  const canCancel = doc.status === 'dispatched' && allowed('cancel', doc)

  const storeInfo = (id: string, code: string, name: string): TransferStoreInfo => {
    const s = stores.data?.data.find((x) => x.id === id)
    if (!s) return { code, name }
    const a = s.address
    return {
      code: s.code,
      name: s.name,
      name_ta: s.name_ta,
      gstin: s.gstin,
      phone: s.phone,
      address: [a.line1, a.line2, a.city, a.pincode].filter(Boolean).join(', ') || null,
    }
  }

  const print = async (): Promise<void> => {
    setPrinting(true)
    try {
      const html = buildTransferNote(
        doc,
        {
          from: storeInfo(doc.from_store_id, doc.from_store_code, doc.from_store_name),
          to: storeInfo(doc.to_store_id, doc.to_store_code, doc.to_store_name),
        },
        {
          title: t('print.title'),
          number: t('print.number'),
          date: t('print.date'),
          status: t('print.status'),
          from: t('transfers.from_store'),
          to: t('transfers.to_store'),
          sno: t('print.sno'),
          product: t('lines.product'),
          batch: t('lines.batch'),
          expiry: t('lines.expiry'),
          qty: t('transfers.sent'),
          received: t('transfers.received_qty'),
          rate: t('print.rate'),
          value: t('lines.value'),
          total: t('print.total'),
          shortfall: t('transfers.shortfall_value'),
          notes: t('common:fields.notes'),
          dispatched_by: t('print.dispatched_by'),
          received_by: t('print.received_by'),
          not_invoice: t('print.not_invoice'),
          draft: t('common:status.draft'),
        },
        langOf(i18n.language),
        statusLabel,
      )
      await printHtml(html, {
        paper: 'a4',
        title: doc.number ?? t('print.title'),
        css: TRANSFER_NOTE_CSS,
      })
    } catch (error) {
      notify.error(error)
    } finally {
      setPrinting(false)
    }
  }

  const columns = useMemo<DataTableColumn<TransferLine>[]>(() => {
    const qty = (milli: number | null, row: TransferLine) => (
      <Qty
        milli={milli}
        unit={row.unit}
        packSize={row.pack_size}
        packUnit={packUnitFor(row.unit)}
      />
    )
    const cols: DataTableColumn<TransferLine>[] = [
      {
        id: 'product',
        header: t('lines.product'),
        meta: { mobile: 'title' },
        cell: ({ row }) => (
          <ProductName
            name={row.original.product_name}
            nameTa={row.original.product_name_ta}
            sku={row.original.sku}
            extra={[
              row.original.batch_no ? `${t('lines.batch')} ${row.original.batch_no}` : null,
              row.original.expiry_date ? formatDate(row.original.expiry_date) : null,
            ]}
          />
        ),
      },
      {
        id: 'sent',
        header: t('transfers.sent'),
        meta: { align: 'right', label: t('transfers.sent') },
        cell: ({ row }) => qty(row.original.qty_milli, row.original),
      },
    ]
    if (received)
      cols.push(
        {
          id: 'received',
          header: t('transfers.received_qty'),
          meta: { align: 'right', label: t('transfers.received_qty') },
          cell: ({ row }) => qty(row.original.received_qty_milli, row.original),
        },
        {
          id: 'short',
          header: t('transfers.shortfall'),
          meta: { align: 'right', label: t('transfers.shortfall') },
          cell: ({ row }) =>
            row.original.shortfall_qty_milli > 0 ? (
              <span className="font-medium text-danger">
                {qty(row.original.shortfall_qty_milli, row.original)}
              </span>
            ) : (
              <span className="text-muted-foreground">—</span>
            ),
        },
      )
    cols.push(
      {
        id: 'cost',
        header: t('lines.cost'),
        meta: { align: 'right', label: t('lines.cost'), mobile: 'hidden' },
        cell: ({ row }) => <Money paise={row.original.unit_cost_paise} />,
      },
      {
        id: 'value',
        header: t('lines.value'),
        meta: { align: 'right', label: t('lines.value') },
        cell: ({ row }) => <Money paise={row.original.value_paise} />,
      },
    )
    return cols
  }, [t, received])

  return (
    <div>
      <PageHeader
        title={doc.number ?? t('transfers.draft_title')}
        backTo="/inventory/transfers"
        meta={
          <Badge tone={statusTone(doc.status)} appearance="solid">
            {statusLabel}
          </Badge>
        }
        description={
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <span className="font-medium text-foreground">
              {doc.from_store_code} · {doc.from_store_name}
            </span>
            <ArrowRight className="size-4" aria-label={t('transfers.to_store')} />
            <span className="font-medium text-foreground">
              {doc.to_store_code} · {doc.to_store_name}
            </span>
            <span>· {formatDate(doc.transfer_date)}</span>
          </span>
        }
        actions={
          <>
            <Button
              variant="outline"
              leftIcon={<Printer />}
              loading={printing}
              onClick={() => void print()}
            >
              {t('transfers.print')}
            </Button>
            {canCancel ? (
              <Button variant="outline" leftIcon={<Ban />} onClick={() => setCancelOpen(true)}>
                {t('transfers.cancel')}
              </Button>
            ) : null}
            {canReceive ? (
              <Button leftIcon={<PackageCheck />} onClick={() => setReceiveOpen(true)}>
                {t('transfers.receive')}
              </Button>
            ) : null}
          </>
        }
      />

      {doc.status === 'dispatched' && !canReceive ? (
        <p
          role="status"
          className="mb-4 rounded-xl bg-info-soft px-4 py-3 text-sm text-info-soft-foreground"
        >
          {t('transfers.awaiting_receipt', {
            store: `${doc.to_store_code} · ${doc.to_store_name}`,
          })}
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start">
        <div className="grid min-w-0 grid-cols-1 gap-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Card className="p-4">
              <div className="text-xs text-muted-foreground">{t('transfers.col_lines')}</div>
              <div className="text-xl font-bold">{doc.line_count}</div>
            </Card>
            <Card className="p-4">
              <div className="text-xs text-muted-foreground">{t('transfers.col_value')}</div>
              <div className="text-xl font-bold">
                <Money paise={doc.total_value_paise} />
              </div>
            </Card>
            <Card className="col-span-2 p-4 sm:col-span-1">
              <div className="text-xs text-muted-foreground">{t('transfers.shortfall_value')}</div>
              <div
                className={cn('text-xl font-bold', doc.shortfall_value_paise > 0 && 'text-danger')}
              >
                <Money paise={doc.shortfall_value_paise} />
              </div>
            </Card>
          </div>
          <DataTable
            label={t('transfers.lines_title')}
            columns={columns}
            data={doc.lines}
            getRowId={(l) => l.id}
            density="compact"
          />
          {doc.notes ? (
            <Card className="p-4 text-sm">
              <div className="text-xs text-muted-foreground">{t('common:fields.notes')}</div>
              <p>{doc.notes}</p>
            </Card>
          ) : null}
        </div>

        <Card className="p-4">
          <h2 className="mb-3 text-sm font-semibold">{t('transfers.timeline')}</h2>
          <ol className="grid grid-cols-1 gap-4" aria-label={t('transfers.timeline')}>
            {doc.timeline.map((e, i) => {
              const Icon = EVENT_ICON[e.event]
              return (
                <li key={`${e.event}-${i}`} className="relative flex gap-3">
                  <span
                    className={cn(
                      'flex size-8 shrink-0 items-center justify-center rounded-full [&_svg]:size-4',
                      e.event === 'cancelled'
                        ? 'bg-danger-soft text-danger'
                        : e.event === 'received'
                          ? 'bg-success-soft text-success'
                          : 'bg-primary-soft text-primary',
                    )}
                  >
                    <Icon aria-hidden />
                  </span>
                  <div className="grid gap-0.5 text-sm">
                    <span className="font-medium">{t(`transfers.event_${e.event}`)}</span>
                    <span className="text-xs text-muted-foreground">
                      {formatDateTime(e.at)}
                      {e.user_name ? ` · ${e.user_name}` : ''}
                    </span>
                    {e.note ? <span className="text-xs">{e.note}</span> : null}
                  </div>
                </li>
              )
            })}
          </ol>
        </Card>
      </div>

      {canReceive ? (
        <ReceiveTransferDialog transfer={doc} open={receiveOpen} onOpenChange={setReceiveOpen} />
      ) : null}
      <ReasonDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title={t('transfers.cancel_title')}
        description={t('transfers.cancel_dispatched_description')}
        confirmLabel={t('transfers.cancel')}
        onConfirm={async (reason) => {
          try {
            await cancel.mutateAsync({ params: { id: doc.id }, body: { reason } })
            notify.success(t('transfers.cancelled'))
          } catch (error) {
            notifyInventoryError(error)
            throw error
          }
        }}
      />
    </div>
  )
}
