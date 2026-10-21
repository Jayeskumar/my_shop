/**
 * Documents tabs of the party pages, read through the owning modules' contracts:
 *  - CustomerInvoices — sales bills (GET /sales/invoices?customer_id=, sales.read), rows open
 *    the sales invoice page;
 *  - SupplierBills — purchase bills (GET /purchase-bills?supplier_id=, purchases.read + feature
 *    purchases);
 *  - PartyPayments — receipts / vouchers (GET /payments?party_type=&party_id=, payments.read).
 * Without the permission (or plan feature) the tab explains why instead of failing.
 */
import { FileText, Lock, ReceiptIndianRupee, Wallet } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { journalSourcePath } from '@kadai/shared/api/accounting'
import { PAYMENT_METHOD_LABELS, type Payment } from '@kadai/shared/api/payments'
import type { PurchaseBillListRow } from '@kadai/shared/api/purchases'
import type { SalesInvoiceListRow } from '@kadai/shared/api/sales'
import type { PartyType } from '@kadai/shared/enums'
import {
  Badge,
  DataTable,
  type DataTableColumn,
  EmptyState,
  Money,
  statusTone,
  Switch,
} from '@/components/ui'
import { useCan, useFeature } from '@/lib/auth'
import { formatDate, formatMoney } from '@/lib/format'
import { usePartyBills, usePartyInvoices, usePartyPayments } from '../api'
import { pickLabel } from '../lib/labels'

const PAGE = { offset: 0, limit: 20 }

function NoAccess({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-surface">
      <EmptyState compact icon={<Lock />} title={text} />
    </div>
  )
}

function Totals({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-2 rounded-lg bg-surface-2 px-4 py-2.5 text-sm">
      {items.map((i) => (
        <div key={i.label} className="flex items-baseline gap-2">
          <dt className="text-muted-foreground">{i.label}</dt>
          <dd className="font-semibold tabular-nums">{i.value}</dd>
        </div>
      ))}
    </dl>
  )
}

// ---- customer invoices ------------------------------------------------------------------------

export function CustomerInvoices({ customerId }: { customerId: string }) {
  const { t } = useTranslation(['parties', 'common'])
  const canRead = useCan('sales.read')
  const navigate = useNavigate()
  const [page, setPage] = useState(PAGE)
  const [unpaid, setUnpaid] = useState(false)
  const list = usePartyInvoices(
    { customer_id: customerId, ...page, ...(unpaid ? { has_due: true } : {}), sort: '-invoice_at' },
    { enabled: canRead },
  )

  const columns = useMemo<DataTableColumn<SalesInvoiceListRow>[]>(
    () => [
      {
        id: 'number',
        header: t('docs.col_bill'),
        meta: { mobile: 'title' },
        cell: ({ row }) => (
          <span className="font-mono text-sm font-medium">
            {row.original.number ?? t('docs.draft')}
          </span>
        ),
      },
      {
        id: 'invoice_date',
        header: t('docs.col_date'),
        meta: { mobile: 'subtitle' },
        cell: ({ row }) => (
          <span className="tabular-nums">{formatDate(row.original.invoice_date)}</span>
        ),
      },
      {
        id: 'total_paise',
        header: t('docs.col_total'),
        meta: { align: 'right', label: t('docs.col_total') },
        cell: ({ row }) => <Money paise={row.original.total_paise} />,
      },
      {
        id: 'due_paise',
        header: t('docs.col_due'),
        meta: { align: 'right', label: t('docs.col_due') },
        cell: ({ row }) =>
          row.original.due_paise > 0 ? (
            <span className="font-semibold tabular-nums text-danger">
              {formatMoney(row.original.due_paise)}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: 'status',
        header: t('docs.col_status'),
        meta: { label: t('docs.col_status') },
        cell: ({ row }) => (
          <Badge
            size="sm"
            tone={statusTone(
              row.original.status === 'completed'
                ? row.original.payment_status
                : row.original.status,
            )}
          >
            {row.original.status === 'completed'
              ? t(`common:status.${row.original.payment_status}`)
              : t(`common:status.${row.original.status}`)}
          </Badge>
        ),
      },
    ],
    [t],
  )

  if (!canRead) return <NoAccess text={t('docs.no_sales_access')} />
  const summary = list.data?.summary
  return (
    <div className="grid gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {summary ? (
          <Totals
            items={[
              { label: t('docs.bills_count'), value: summary.count },
              { label: t('docs.bills_total'), value: formatMoney(summary.total_paise) },
              { label: t('docs.bills_due'), value: formatMoney(Math.max(0, summary.due_paise)) },
            ]}
          />
        ) : (
          <span />
        )}
        <Switch
          checked={unpaid}
          onCheckedChange={(v) => {
            setUnpaid(v)
            setPage(PAGE)
          }}
          label={t('docs.unpaid_only')}
        />
      </div>
      <DataTable
        label={t('khata.tab_invoices')}
        columns={columns}
        data={list.data?.data ?? []}
        getRowId={(r) => r.id}
        loading={list.isFetching}
        error={list.error}
        onRetry={() => void list.refetch()}
        onRowClick={(r) => navigate(`/sales/invoices/${r.id}`)}
        pagination={list.data ? { ...list.data.page, onChange: setPage } : undefined}
        empty={
          <EmptyState
            compact
            icon={<ReceiptIndianRupee />}
            title={unpaid ? t('docs.no_unpaid_bills') : t('docs.no_bills')}
            description={t('docs.no_bills_hint')}
          />
        }
      />
    </div>
  )
}

// ---- supplier bills ---------------------------------------------------------------------------

export function SupplierBills({ supplierId }: { supplierId: string }) {
  const { t } = useTranslation(['parties', 'common'])
  const canRead = useCan('purchases.read')
  const hasPurchases = useFeature('purchases')
  const navigate = useNavigate()
  const [page, setPage] = useState(PAGE)
  const [unpaid, setUnpaid] = useState(false)
  const enabled = canRead && hasPurchases
  const list = usePartyBills(
    {
      supplier_id: supplierId,
      ...page,
      ...(unpaid ? { has_due: true } : {}),
      sort: '-received_date',
    },
    { enabled },
  )

  const columns = useMemo<DataTableColumn<PurchaseBillListRow>[]>(
    () => [
      {
        id: 'supplier_invoice_no',
        header: t('docs.col_supplier_bill'),
        meta: { mobile: 'title' },
        cell: ({ row }) => (
          <div className="min-w-0">
            <div className="font-mono text-sm font-medium">{row.original.supplier_invoice_no}</div>
            {row.original.number ? (
              <div className="font-mono text-xs text-muted-foreground">{row.original.number}</div>
            ) : null}
          </div>
        ),
      },
      {
        id: 'received_date',
        header: t('docs.col_received'),
        meta: { mobile: 'subtitle' },
        cell: ({ row }) => (
          <span className="tabular-nums">{formatDate(row.original.received_date)}</span>
        ),
      },
      {
        id: 'total_paise',
        header: t('docs.col_total'),
        meta: { align: 'right', label: t('docs.col_total') },
        cell: ({ row }) => <Money paise={row.original.total_paise} />,
      },
      {
        id: 'due_paise',
        header: t('docs.col_due'),
        meta: { align: 'right', label: t('docs.col_due') },
        cell: ({ row }) =>
          row.original.due_paise > 0 ? (
            <div className="flex flex-col items-end">
              <span
                className={
                  row.original.overdue
                    ? 'font-semibold tabular-nums text-danger'
                    : 'font-semibold tabular-nums'
                }
              >
                {formatMoney(row.original.due_paise)}
              </span>
              {row.original.due_date ? (
                <span className="text-xs text-muted-foreground">
                  {row.original.overdue
                    ? t('docs.overdue_days', { count: row.original.days_overdue ?? 0 })
                    : t('docs.due_on', { date: formatDate(row.original.due_date) })}
                </span>
              ) : null}
            </div>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: 'status',
        header: t('docs.col_status'),
        meta: { label: t('docs.col_status') },
        cell: ({ row }) => {
          const s =
            row.original.status === 'posted' ? row.original.payment_status : row.original.status
          return (
            <Badge size="sm" tone={statusTone(s)}>
              {t(`common:status.${s}`)}
            </Badge>
          )
        },
      },
    ],
    [t],
  )

  if (!hasPurchases) return <NoAccess text={t('docs.no_purchases_feature')} />
  if (!canRead) return <NoAccess text={t('docs.no_purchases_access')} />
  const summary = list.data?.summary
  return (
    <div className="grid gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {summary ? (
          <Totals
            items={[
              { label: t('docs.bills_count'), value: summary.count },
              { label: t('docs.bills_total'), value: formatMoney(summary.total_paise) },
              { label: t('docs.bills_due'), value: formatMoney(Math.max(0, summary.due_paise)) },
            ]}
          />
        ) : (
          <span />
        )}
        <Switch
          checked={unpaid}
          onCheckedChange={(v) => {
            setUnpaid(v)
            setPage(PAGE)
          }}
          label={t('docs.unpaid_only')}
        />
      </div>
      <DataTable
        label={t('supplier.tab_bills')}
        columns={columns}
        data={list.data?.data ?? []}
        getRowId={(r) => r.id}
        loading={list.isFetching}
        error={list.error}
        onRetry={() => void list.refetch()}
        onRowClick={(r) => navigate(`/purchases/bills/${r.id}`)}
        pagination={list.data ? { ...list.data.page, onChange: setPage } : undefined}
        empty={
          <EmptyState
            compact
            icon={<FileText />}
            title={unpaid ? t('docs.no_unpaid_bills') : t('docs.no_purchase_bills')}
            description={t('docs.no_purchase_bills_hint')}
          />
        }
      />
    </div>
  )
}

// ---- payments ---------------------------------------------------------------------------------

export function PartyPayments({ partyType, partyId }: { partyType: PartyType; partyId: string }) {
  const { t, i18n } = useTranslation(['parties', 'common'])
  const canRead = useCan('payments.read')
  const navigate = useNavigate()
  const [page, setPage] = useState(PAGE)
  const list = usePartyPayments(
    { party_type: partyType, party_id: partyId, ...page, sort: '-paid_at' },
    { enabled: canRead },
  )

  const columns = useMemo<DataTableColumn<Payment>[]>(
    () => [
      {
        id: 'number',
        header: t('docs.col_receipt'),
        meta: { mobile: 'title' },
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-medium">{row.original.number ?? '—'}</span>
            <Badge size="sm" tone={row.original.direction === 'in' ? 'success' : 'info'}>
              {row.original.direction === 'in' ? t('docs.received') : t('docs.paid')}
            </Badge>
          </div>
        ),
      },
      {
        id: 'payment_date',
        header: t('docs.col_date'),
        meta: { mobile: 'subtitle' },
        cell: ({ row }) => (
          <span className="tabular-nums">{formatDate(row.original.payment_date)}</span>
        ),
      },
      {
        id: 'method',
        header: t('docs.col_method'),
        meta: { label: t('docs.col_method') },
        cell: ({ row }) => (
          <div className="min-w-0">
            <div>{pickLabel(PAYMENT_METHOD_LABELS[row.original.method], i18n.language)}</div>
            {row.original.reference ? (
              <div className="truncate font-mono text-xs text-muted-foreground">
                {row.original.reference}
              </div>
            ) : null}
          </div>
        ),
      },
      {
        id: 'amount_paise',
        header: t('docs.col_amount'),
        meta: { align: 'right', label: t('docs.col_amount') },
        cell: ({ row }) => (
          <div className="flex flex-col items-end">
            <Money paise={row.original.amount_paise} className="font-semibold" />
            {row.original.unallocated_paise > 0 ? (
              <span className="text-xs text-muted-foreground">
                {t('docs.advance_part', { amount: formatMoney(row.original.unallocated_paise) })}
              </span>
            ) : null}
          </div>
        ),
      },
      {
        id: 'status',
        header: t('docs.col_status'),
        meta: { label: t('docs.col_status') },
        cell: ({ row }) => (
          <Badge size="sm" tone={statusTone(row.original.status)}>
            {t(`common:status.${row.original.status}`)}
          </Badge>
        ),
      },
    ],
    [t, i18n.language],
  )

  if (!canRead) return <NoAccess text={t('docs.no_payments_access')} />
  const summary = list.data?.summary
  return (
    <div className="grid gap-3">
      {summary ? (
        <Totals
          items={[
            { label: t('docs.payments_count'), value: summary.count },
            ...(summary.in_paise > 0
              ? [{ label: t('docs.total_received'), value: formatMoney(summary.in_paise) }]
              : []),
            ...(summary.out_paise > 0
              ? [{ label: t('docs.total_paid'), value: formatMoney(summary.out_paise) }]
              : []),
          ]}
        />
      ) : null}
      <DataTable
        label={t('khata.tab_payments')}
        columns={columns}
        data={list.data?.data ?? []}
        getRowId={(r) => r.id}
        loading={list.isFetching}
        error={list.error}
        onRetry={() => void list.refetch()}
        onRowClick={(r) => {
          const path = journalSourcePath('payment', r.id)
          if (path) navigate(path)
        }}
        pagination={list.data ? { ...list.data.page, onChange: setPage } : undefined}
        empty={
          <EmptyState
            compact
            icon={<Wallet />}
            title={t('docs.no_payments')}
            description={
              partyType === 'customer'
                ? t('docs.no_payments_customer')
                : t('docs.no_payments_supplier')
            }
          />
        }
      />
    </div>
  )
}
