/**
 * A posted (or cancelled) stock adjustment: header with number, kind and status, value impact
 * (gain / loss / net), the lines (system vs counted for stock takes) and the stock movements it
 * posted (and their reversal after a cancel). Posted adjustments can be cancelled once, with a
 * reason, which reverses the stock and the journal.
 */
import {
  ADJUSTMENT_KIND_LABELS,
  type AdjustmentLine,
  MOVEMENT_TYPE_LABELS,
  type MovementRow,
  type StockAdjustmentDetail,
  inventoryRoutes,
} from '@kadai/shared/api/inventory'
import { Ban, BookOpen } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
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
import { useCan } from '@/lib/auth'
import { formatDate, formatDateTime } from '@/lib/format'
import { useRouteMutation } from '@/lib/query'
import { useInventoryAccess } from '../lib/access'
import { notifyInventoryError } from '../lib/errors'
import { STOCK_ROUTES } from '../lib/invalidate'
import {
  ADJUSTMENT_KIND_TONE,
  movementTone,
  packUnitFor,
  pickLabel,
  reasonLabel,
} from '../lib/labels'
import { ProductName } from './ProductName'
import { ReasonDialog } from './ReasonDialog'
import { QtyChange } from './StockBadge'

export function AdjustmentDetailView({ doc }: { doc: StockAdjustmentDetail }) {
  const { t, i18n } = useTranslation(['inventory', 'common'])
  const access = useInventoryAccess()
  const canAccounts = useCan('accounting.read')
  const [cancelOpen, setCancelOpen] = useState(false)
  const cancel = useRouteMutation(inventoryRoutes.cancelAdjustment, {
    invalidates: STOCK_ROUTES,
    onError: () => {},
  })
  const kindLabel = pickLabel(ADJUSTMENT_KIND_LABELS[doc.kind], i18n.language)
  const take = doc.kind === 'stock_take'

  const lineColumns = useMemo<DataTableColumn<AdjustmentLine>[]>(() => {
    const cols: DataTableColumn<AdjustmentLine>[] = [
      {
        id: 'product',
        header: t('lines.product'),
        meta: { mobile: 'title' },
        cell: ({ row }) => (
          <ProductName
            name={row.original.product_name}
            nameTa={row.original.product_name_ta}
            sku={row.original.sku}
            extra={[row.original.batch_no ? `${t('lines.batch')} ${row.original.batch_no}` : null]}
          />
        ),
      },
    ]
    if (take)
      cols.push(
        {
          id: 'system',
          header: t('lines.system_qty'),
          meta: { align: 'right', label: t('lines.system_qty') },
          cell: ({ row }) => (
            <Qty
              milli={row.original.system_qty_milli}
              unit={row.original.unit}
              packSize={row.original.pack_size}
              packUnit={packUnitFor(row.original.unit)}
            />
          ),
        },
        {
          id: 'counted',
          header: t('lines.counted_qty'),
          meta: { align: 'right', label: t('lines.counted_qty') },
          cell: ({ row }) => (
            <Qty
              milli={row.original.counted_qty_milli}
              unit={row.original.unit}
              packSize={row.original.pack_size}
              packUnit={packUnitFor(row.original.unit)}
            />
          ),
        },
      )
    cols.push(
      {
        id: 'change',
        header: take ? t('lines.difference') : t('lines.change'),
        meta: { align: 'right', label: take ? t('lines.difference') : t('lines.change') },
        cell: ({ row }) =>
          row.original.qty_delta_milli === 0 ? (
            <span className="text-muted-foreground">{t('lines.matches')}</span>
          ) : (
            <QtyChange
              milli={row.original.qty_delta_milli}
              unit={row.original.unit}
              packSize={row.original.pack_size}
            />
          ),
      },
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
        cell: ({ row }) => <Money paise={row.original.value_paise} colorize />,
      },
      {
        id: 'reason',
        header: t('lines.reason'),
        meta: { label: t('lines.reason') },
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {reasonLabel(row.original.reason, i18n.language) ?? '—'}
          </span>
        ),
      },
    )
    return cols
  }, [t, i18n.language, take])

  const movementColumns = useMemo<DataTableColumn<MovementRow>[]>(
    () => [
      {
        id: 'at',
        header: t('movements.col_date'),
        meta: { mobile: 'subtitle', label: t('movements.col_date') },
        cell: ({ row }) => (
          <span className="tabular-nums">{formatDateTime(row.original.created_at)}</span>
        ),
      },
      {
        id: 'product',
        header: t('movements.col_product'),
        meta: { mobile: 'title' },
        cell: ({ row }) => (
          <ProductName
            name={row.original.product_name}
            nameTa={row.original.product_name_ta}
            sku={row.original.sku}
            extra={[row.original.batch_no]}
          />
        ),
      },
      {
        id: 'type',
        header: t('movements.col_type'),
        meta: { label: t('movements.col_type') },
        cell: ({ row }) => (
          <Badge tone={movementTone(row.original.movement_type)} size="sm">
            {pickLabel(MOVEMENT_TYPE_LABELS[row.original.movement_type], i18n.language)}
          </Badge>
        ),
      },
      {
        id: 'qty',
        header: t('movements.col_qty'),
        meta: { align: 'right', label: t('movements.col_qty') },
        cell: ({ row }) => (
          <QtyChange
            milli={row.original.qty_milli}
            unit={row.original.unit}
            packSize={row.original.pack_size}
          />
        ),
      },
      {
        id: 'balance',
        header: t('movements.col_balance'),
        meta: { align: 'right', label: t('movements.col_balance') },
        cell: ({ row }) => (
          <Qty
            milli={row.original.balance_after_milli}
            unit={row.original.unit}
            packSize={row.original.pack_size}
            packUnit={packUnitFor(row.original.unit)}
            colorize
          />
        ),
      },
    ],
    [t, i18n.language],
  )

  return (
    <div>
      <PageHeader
        title={doc.number ?? kindLabel}
        backTo="/inventory/adjustments"
        meta={
          <>
            <Badge tone={ADJUSTMENT_KIND_TONE[doc.kind]}>{kindLabel}</Badge>
            <Badge tone={statusTone(doc.status)} appearance="solid">
              {t(`common:status.${doc.status}`)}
            </Badge>
          </>
        }
        description={`${doc.store_code} · ${doc.store_name} · ${formatDate(doc.adjustment_date)}`}
        actions={
          <>
            {doc.journal_entry_id && canAccounts ? (
              <Button asChild variant="outline" leftIcon={<BookOpen />}>
                <Link to={`/accounting/journal?id=${doc.journal_entry_id}`}>
                  {t('adjustments.view_journal')}
                </Link>
              </Button>
            ) : null}
            {doc.status === 'posted' && access.adjust && doc.kind !== 'opening' ? (
              <Button variant="danger" leftIcon={<Ban />} onClick={() => setCancelOpen(true)}>
                {t('adjustments.cancel')}
              </Button>
            ) : null}
          </>
        }
      />

      {doc.status === 'cancelled' ? (
        <div
          role="status"
          className="mb-4 rounded-xl border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger-soft-foreground"
        >
          {t('adjustments.cancelled_note', {
            by: doc.cancelled_by_name ?? '—',
            at: doc.cancelled_at ? formatDateTime(doc.cancelled_at) : '—',
          })}
          {doc.cancel_reason ? (
            <span className="mt-1 block font-medium">
              {t('adjustments.cancel_reason_was', { reason: doc.cancel_reason })}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Card className="p-4">
          <div className="text-xs text-muted-foreground">{t('adjustments.gain')}</div>
          <div className="text-xl font-bold text-success">
            <Money paise={doc.gain_value_paise} />
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted-foreground">{t('adjustments.loss')}</div>
          <div className="text-xl font-bold text-danger">
            <Money paise={doc.loss_value_paise} />
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted-foreground">{t('adjustments.net')}</div>
          <div className="text-xl font-bold">
            <Money paise={doc.total_value_paise} colorize />
          </div>
        </Card>
      </div>

      <Card className="mb-4 grid gap-3 p-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <Info label={t('adjustments.posted_by')}>
          {doc.posted_by_name ?? '—'}
          {doc.posted_at ? (
            <span className="block text-xs text-muted-foreground">
              {formatDateTime(doc.posted_at)}
            </span>
          ) : null}
        </Info>
        <Info label={t('adjustments.created_by')}>
          {doc.created_by_name ?? '—'}
          <span className="block text-xs text-muted-foreground">
            {formatDateTime(doc.created_at)}
          </span>
        </Info>
        <Info label={t('adjustments.lines_count')}>{doc.line_count}</Info>
        <Info label={t('common:fields.notes')}>{doc.notes ?? '—'}</Info>
      </Card>

      <section className="mb-6 grid gap-2">
        <h2 className="text-base font-semibold">{t('adjustments.lines_title')}</h2>
        <DataTable
          label={t('adjustments.lines_title')}
          columns={lineColumns}
          data={doc.lines}
          getRowId={(l) => l.id}
          density="compact"
        />
      </section>

      <section className="grid grid-cols-1 gap-2">
        <h2 className="text-base font-semibold">{t('adjustments.movements_title')}</h2>
        <DataTable
          label={t('adjustments.movements_title')}
          columns={movementColumns}
          data={doc.movements}
          getRowId={(m) => m.id}
          density="compact"
          empty={
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              {t('adjustments.no_movements')}
            </p>
          }
        />
      </section>

      <ReasonDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title={t('adjustments.cancel_title', { number: doc.number ?? kindLabel })}
        description={t('adjustments.cancel_description')}
        confirmLabel={t('adjustments.cancel')}
        onConfirm={async (reason) => {
          try {
            await cancel.mutateAsync({ params: { id: doc.id }, body: { reason } })
            notify.success(t('adjustments.cancelled'))
          } catch (error) {
            notifyInventoryError(error)
            throw error
          }
        }}
      />
    </div>
  )
}

function Info({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-medium">{children}</span>
    </div>
  )
}
