/**
 * Ledgers (/accounting/ledgers): the cash book by default, or the ledger of any account — pick it
 * or use the shortcuts (cash, each bank account, customers' dues, suppliers' dues). Receivable /
 * payable ledgers can be narrowed to one customer / supplier. Opening balance, every entry with
 * the other side ("particulars"), the voucher link and the running balance (Dr / Cr), the closing
 * balance; date presets, store filter, print and CSV. State lives in the URL (?account=&from=&to=).
 */
import { BookMarked, ListTree } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import type { AccountType, PartyType } from '@kadai/shared'
import {
  type AccountLedgerResponse,
  type AccountLedgerRow,
  LEDGER_PAGE_MAX,
  type LedgerQuery,
  accountingRoutes,
} from '@kadai/shared/api/accounting'
import { AccountPicker, CustomerPicker, StorePicker, SupplierPicker } from '@/components/pickers'
import {
  Button,
  Card,
  DataTable,
  type DataTableColumn,
  DateRangePicker,
  EmptyState,
  PageHeader,
} from '@/components/ui'
import { downloadRoute } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatDate, formatMoney } from '@/lib/format'
import { useAccountLedger, useCashBook, useChartOfAccounts } from '../api'
import { ExportMenu } from '../components/ExportMenu'
import { SourceLink } from '../components/SourceLink'
import { accountLabel, accountName, crLabel, drCrText, drLabel } from '../lib/labels'
import { type PrintRow, printTable } from '../lib/print'
import { useTenantInfo } from '../lib/tenant'
import { useUrlState } from '../lib/url-state'

const PAGE_SIZE = 200

type Row =
  | { kind: 'opening'; id: string; balance: number }
  | { kind: 'closing'; id: string; balance: number }
  | { kind: 'row'; id: string; row: AccountLedgerRow }

export default function LedgersPage() {
  const { t } = useTranslation(['accounting', 'common'])
  const tenant = useTenantInfo()
  const url = useUrlState()
  const accountId = url.id('account')
  const isCashBook = !accountId || url.get('book') === 'cash'
  const month = tenant.range('this_month')
  const from = url.date('from', month.from)
  const to = url.date('to', month.to)
  const storeId = url.id('store')
  const partyTypeRaw = url.oneOf('party_type', ['customer', 'supplier', 'none'] as const, 'none')
  const partyType: PartyType | null = partyTypeRaw === 'none' ? null : partyTypeRaw
  const partyId = url.id('party')
  const partyName = url.get('party_name')
  const offset = url.int('offset', 0)

  const chart = useChartOfAccounts({ balances: false })
  const accounts = useMemo(() => chart.data?.data.accounts ?? [], [chart.data])
  const selected = accountId ? accounts.find((a) => a.id === accountId) : undefined
  const partyNeeded =
    selected?.subtype === 'receivable'
      ? 'customer'
      : selected?.subtype === 'payable'
        ? 'supplier'
        : null

  const query: LedgerQuery = {
    from,
    to,
    limit: PAGE_SIZE,
    offset,
    ...(storeId ? { store_id: storeId } : {}),
    ...(partyType && partyId && partyNeeded === partyType
      ? { party_type: partyType, party_id: partyId }
      : {}),
  }
  const cash = useCashBook(
    { ...query, ...(accountId ? { account_id: accountId } : {}) },
    { enabled: isCashBook },
  )
  const ledger = useAccountLedger(accountId, query, { enabled: !isCashBook })
  const active = isCashBook ? cash : ledger
  const data: AccountLedgerResponse | undefined = active.data
  const meta = data?.ledger
  const type: AccountType = meta?.account.type ?? selected?.type ?? 'asset'

  const shortcuts = useMemo(() => {
    const out: Array<{ key: string; label: string; accountId: string | null; book?: 'cash' }> = [
      { key: 'cash', label: t('ledgers.cash_book'), accountId: null, book: 'cash' },
    ]
    for (const a of accounts) {
      if (!a.is_active) continue
      if (a.money_kind === 'bank')
        out.push({ key: a.id, label: accountName(a), accountId: a.id, book: 'cash' })
    }
    const receivable = accounts.find((a) => a.subtype === 'receivable')
    const payable = accounts.find((a) => a.subtype === 'payable')
    if (receivable)
      out.push({ key: 'receivable', label: t('ledgers.receivable'), accountId: receivable.id })
    if (payable) out.push({ key: 'payable', label: t('ledgers.payable'), accountId: payable.id })
    return out
  }, [accounts, t])

  const page = data?.page
  const isFirstPage = (page?.offset ?? 0) === 0
  const isLastPage = page ? page.offset + page.limit >= page.total : true
  const tableRows = useMemo<Row[]>(() => {
    if (!data) return []
    const rows: Row[] = data.data.map((row) => ({ kind: 'row', id: row.line_id, row }))
    if (isFirstPage)
      rows.unshift({ kind: 'opening', id: 'opening', balance: data.ledger.opening_balance_paise })
    if (isLastPage)
      rows.push({ kind: 'closing', id: 'closing', balance: data.ledger.closing_balance_paise })
    return rows
  }, [data, isFirstPage, isLastPage])

  const columns = useMemo<DataTableColumn<Row>[]>(
    () => [
      {
        id: 'date',
        header: t('common:fields.date'),
        meta: { mobile: 'subtitle', label: t('common:fields.date') },
        cell: ({ row }) =>
          row.original.kind === 'row' ? (
            <span className="whitespace-nowrap tabular-nums">
              {formatDate(row.original.row.date)}
            </span>
          ) : (
            <span className="whitespace-nowrap tabular-nums text-muted-foreground">
              {formatDate(row.original.kind === 'opening' ? from : to)}
            </span>
          ),
      },
      {
        id: 'particulars',
        header: t('journal.fields.particulars'),
        meta: { mobile: 'title' },
        cell: ({ row }) => {
          const r = row.original
          if (r.kind !== 'row') {
            return (
              <span className="font-semibold">
                {r.kind === 'opening' ? t('ledgers.opening') : t('ledgers.closing')}
              </span>
            )
          }
          return (
            <div className="min-w-0 max-w-md">
              <div className="truncate font-medium">
                {r.row.counter_accounts.join(', ') || r.row.party_name || '—'}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {[
                  r.row.party_name && r.row.counter_accounts.length ? r.row.party_name : null,
                  r.row.memo ?? r.row.narration,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            </div>
          )
        },
      },
      {
        id: 'voucher',
        header: t('journal.fields.voucher'),
        meta: { label: t('journal.fields.voucher') },
        cell: ({ row }) =>
          row.original.kind === 'row' ? (
            <SourceLink
              type={row.original.row.source_type}
              number={row.original.row.source_number}
              path={row.original.row.source_path}
              stacked
            />
          ) : null,
      },
      {
        id: 'debit',
        header: t('journal.fields.debit'),
        meta: { align: 'right', label: t('journal.fields.debit') },
        cell: ({ row }) =>
          row.original.kind === 'row' && row.original.row.debit_paise ? (
            <span className="tabular-nums">{formatMoney(row.original.row.debit_paise)}</span>
          ) : null,
      },
      {
        id: 'credit',
        header: t('journal.fields.credit'),
        meta: { align: 'right', label: t('journal.fields.credit') },
        cell: ({ row }) =>
          row.original.kind === 'row' && row.original.row.credit_paise ? (
            <span className="tabular-nums">{formatMoney(row.original.row.credit_paise)}</span>
          ) : null,
      },
      {
        id: 'balance',
        header: t('fields.balance'),
        meta: { align: 'right', mobile: 'value', label: t('fields.balance') },
        cell: ({ row }) => {
          const r = row.original
          const balance = r.kind === 'row' ? r.row.balance_paise : r.balance
          return (
            <span
              className={cn('whitespace-nowrap tabular-nums', r.kind !== 'row' && 'font-semibold')}
            >
              {drCrText(type, balance)}
            </span>
          )
        },
      },
    ],
    [t, type, from, to],
  )

  const selectAccount = (id: string | null, book?: 'cash') =>
    url.set({ account: id, book: book ?? null, party_type: null, party: null, party_name: null })

  const csv = () =>
    isCashBook
      ? downloadRoute(accountingRoutes.cashBook, {
          query: {
            ...query,
            ...(accountId ? { account_id: accountId } : {}),
            format: 'csv',
            limit: undefined,
            offset: undefined,
          },
          filename: `cash-book-${from}-${to}.csv`,
        })
      : downloadRoute(accountingRoutes.accountLedger, {
          params: { accountId: accountId ?? '' },
          query: { ...query, format: 'csv', limit: undefined, offset: undefined },
          filename: `ledger-${meta?.account.code ?? ''}-${from}-${to}.csv`,
        })

  const print = () => {
    if (!data || !meta) return
    const rows: PrintRow[] = tableRows.map((r) =>
      r.kind === 'row'
        ? {
            cells: [
              formatDate(r.row.date),
              [r.row.counter_accounts.join(', '), r.row.party_name, r.row.memo ?? r.row.narration]
                .filter(Boolean)
                .join(' · '),
              [r.row.source_number].filter(Boolean).join(''),
              r.row.debit_paise ? formatMoney(r.row.debit_paise) : '',
              r.row.credit_paise ? formatMoney(r.row.credit_paise) : '',
              drCrText(type, r.row.balance_paise),
            ],
          }
        : {
            kind: 'total',
            cells: [
              formatDate(r.kind === 'opening' ? from : to),
              r.kind === 'opening' ? t('ledgers.opening') : t('ledgers.closing'),
              '',
              '',
              '',
              drCrText(type, r.balance),
            ],
          },
    )
    return printTable({
      title: `${t('ledgers.ledger_of')} ${accountLabel(meta.account)}`,
      subtitle: [
        t('print.period', { from: formatDate(meta.from), to: formatDate(meta.to) }),
        meta.party?.name,
      ]
        .filter(Boolean)
        .join(' · '),
      facts: [
        [t('ledgers.opening'), drCrText(type, meta.opening_balance_paise)],
        [t('ledgers.total_debit'), formatMoney(meta.total_debit_paise)],
        [t('ledgers.total_credit'), formatMoney(meta.total_credit_paise)],
        [t('ledgers.closing'), drCrText(type, meta.closing_balance_paise)],
      ],
      columns: [
        { label: t('common:fields.date') },
        { label: t('journal.fields.particulars') },
        { label: t('journal.fields.voucher') },
        { label: t('journal.fields.debit'), align: 'right' },
        { label: t('journal.fields.credit'), align: 'right' },
        { label: t('fields.balance'), align: 'right' },
      ],
      rows,
    })
  }

  const title = meta
    ? accountLabel(meta.account)
    : isCashBook
      ? t('ledgers.cash_book')
      : t('ledgers.title')

  return (
    <div>
      <PageHeader
        title={t('ledgers.title')}
        description={t('ledgers.description')}
        actions={
          <>
            <Button asChild variant="ghost">
              <Link to="/accounting/accounts">
                <ListTree aria-hidden />
                {t('accounts.title')}
              </Link>
            </Button>
            <ExportMenu onPrint={print} onCsv={csv} disabled={!data || !meta} />
          </>
        }
      />

      <div
        role="group"
        aria-label={t('ledgers.shortcuts')}
        className="scrollbar-thin -mx-1 mb-3 flex gap-2 overflow-x-auto px-1 pb-1"
      >
        {shortcuts.map((s) => {
          const activeChip =
            s.key === 'cash'
              ? isCashBook && !accountId
              : s.accountId === accountId && (s.book === 'cash') === isCashBook
          return (
            <button
              key={s.key}
              type="button"
              aria-pressed={activeChip}
              onClick={() => selectAccount(s.accountId, s.book)}
              className={cn(
                'inline-flex h-10 shrink-0 items-center rounded-full border px-3.5 text-sm font-medium transition-colors',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                activeChip
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-surface hover:bg-surface-2',
              )}
            >
              {s.label}
            </button>
          )
        })}
      </div>

      <div className="flex flex-col gap-2 pb-4 sm:flex-row sm:flex-wrap sm:items-center">
        <AccountPicker
          value={accountId}
          onChange={(id, account) => selectAccount(id, account?.money_kind ? 'cash' : undefined)}
          includeInactive
          placeholder={t('ledgers.pick_account')}
          aria-label={t('ledgers.pick_account')}
          className="sm:w-72"
        />
        {partyNeeded === 'customer' ? (
          <CustomerPicker
            value={partyId && partyName ? { id: partyId, name: partyName } : null}
            onChange={(c) =>
              url.set({
                party_type: c ? 'customer' : null,
                party: c?.id ?? null,
                party_name: c?.name ?? null,
              })
            }
            placeholder={t('ledgers.all_customers')}
            aria-label={t('ledgers.customer')}
            className="sm:w-64"
          />
        ) : partyNeeded === 'supplier' ? (
          <SupplierPicker
            value={partyId && partyName ? { id: partyId, name: partyName } : null}
            onChange={(s) =>
              url.set({
                party_type: s ? 'supplier' : null,
                party: s?.id ?? null,
                party_name: s?.name ?? null,
              })
            }
            placeholder={t('ledgers.all_suppliers')}
            aria-label={t('ledgers.supplier')}
            className="sm:w-64"
          />
        ) : null}
        <DateRangePicker
          value={{ from, to }}
          onChange={(r) => url.set({ from: r.from, to: r.to })}
          presets={[
            'today',
            'yesterday',
            'this_week',
            'this_month',
            'last_month',
            'last_30_days',
            'this_fy',
            'last_fy',
          ]}
          max={tenant.today}
        />
        {tenant.multiStore ? (
          <StorePicker
            value={storeId ?? 'all'}
            onChange={(id) => url.set({ store: id && id !== 'all' ? id : null })}
            allowAll
            clearable={false}
            className="sm:w-52"
            aria-label={t('common:fields.store')}
          />
        ) : null}
      </div>

      <>
        <Card className="mb-4 p-4">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-base font-semibold">{title}</h2>
            {meta?.party ? (
              <span className="text-sm text-muted-foreground">{meta.party.name}</span>
            ) : null}
          </div>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              [t('ledgers.opening'), meta ? drCrText(type, meta.opening_balance_paise) : '—'],
              [t('ledgers.total_debit'), meta ? formatMoney(meta.total_debit_paise) : '—'],
              [t('ledgers.total_credit'), meta ? formatMoney(meta.total_credit_paise) : '—'],
              [t('ledgers.closing'), meta ? drCrText(type, meta.closing_balance_paise) : '—'],
            ].map(([label, value], i) => (
              <div key={label}>
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd
                  className={cn('tabular-nums', i === 3 ? 'text-lg font-semibold' : 'font-medium')}
                >
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        </Card>
        <DataTable
          label={title}
          columns={columns}
          data={tableRows}
          getRowId={(r) => r.id}
          loading={active.isFetching}
          error={active.error}
          onRetry={() => void active.refetch()}
          density="compact"
          pagination={
            page && page.total > PAGE_SIZE
              ? {
                  ...page,
                  pageSizeOptions: [PAGE_SIZE, LEDGER_PAGE_MAX],
                  onChange: (next) => url.set({ offset: next.offset || null }),
                }
              : undefined
          }
          renderCard={(r) =>
            r.kind === 'row' ? (
              <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="line-clamp-1 break-words font-medium">
                    {r.row.counter_accounts.join(', ') || r.row.party_name || '—'}
                  </div>
                  <div className="line-clamp-1 break-words text-xs text-muted-foreground">
                    {formatDate(r.row.date)}
                    {r.row.source_number ? ` · ${r.row.source_number}` : ''}
                    {r.row.narration ? ` · ${r.row.narration}` : ''}
                  </div>
                </div>
                <div className="shrink-0 text-end text-sm">
                  <div className="font-semibold tabular-nums">
                    {r.row.debit_paise
                      ? `${formatMoney(r.row.debit_paise)} ${drLabel()}`
                      : `${formatMoney(r.row.credit_paise)} ${crLabel()}`}
                  </div>
                  <div className="text-xs tabular-nums text-muted-foreground">
                    {drCrText(type, r.row.balance_paise)}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-3 font-semibold">
                <span>{r.kind === 'opening' ? t('ledgers.opening') : t('ledgers.closing')}</span>
                <span className="tabular-nums">{drCrText(type, r.balance)}</span>
              </div>
            )
          }
          empty={<EmptyState compact icon={<BookMarked />} title={t('ledgers.no_entries')} />}
        />
      </>
    </div>
  )
}
