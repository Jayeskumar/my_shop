/**
 * Khata / payable statement table for a PartyLedger (GET /customers/:id/ledger,
 * /suppliers/:id/ledger): opening balance row, entries with a running balance, totals and the
 * closing balance. Document numbers link to the source document. Below md the rows become a
 * compact list (date + particulars, amount, balance after). Exported for other modules.
 */
import { CloudOff, ScrollText } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { journalSourcePath } from '@kadai/shared/api/accounting'
import {
  LEDGER_SOURCE_LABELS,
  type PartyLedger,
  type PartyLedgerRow,
} from '@kadai/shared/api/parties'
import type { PartyType } from '@kadai/shared/enums'
import {
  EmptyState,
  RetryButton,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui'
import { cn } from '@/lib/cn'
import { describeError } from '@/lib/errors'
import { formatDate, formatMoney } from '@/lib/format'
import { useBreakpoint } from '@/lib/use-media-query'
import { pickLabel } from '../lib/labels'
import { BalanceAmount } from './BalanceAmount'

export interface PartyLedgerTableProps {
  partyType: PartyType
  ledger: PartyLedger | undefined
  loading?: boolean
  error?: unknown
  onRetry?: () => void
  /** Link document numbers to their pages (default true). */
  linkDocuments?: boolean
  className?: string
}

export function PartyLedgerTable({
  partyType,
  ledger,
  loading = false,
  error,
  onRetry,
  linkDocuments = true,
  className,
}: PartyLedgerTableProps) {
  const { t } = useTranslation('parties')
  const desktop = useBreakpoint('md')
  const wrap = (body: ReactNode) => (
    <div
      className={cn(
        'overflow-hidden rounded-xl border border-border bg-surface shadow-card',
        className,
      )}
    >
      {loading && ledger ? (
        <div className="h-0.5 w-full animate-shimmer bg-primary" aria-hidden />
      ) : null}
      {body}
    </div>
  )

  if (error && !loading) {
    const d = describeError(error)
    return wrap(
      <EmptyState
        compact
        icon={<CloudOff />}
        title={d.title}
        description={d.description}
        action={onRetry ? <RetryButton onRetry={onRetry} /> : undefined}
      />,
    )
  }
  if (!ledger) {
    return wrap(
      <div className="grid gap-3 p-4" aria-busy>
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-5 w-full" />
        ))}
      </div>,
    )
  }

  // Column titles in the party's own terms (bills vs. money received / paid).
  const headers =
    partyType === 'customer'
      ? { debit: t('ledger.col_debit_customer'), credit: t('ledger.col_credit_customer') }
      : { debit: t('ledger.col_debit_supplier'), credit: t('ledger.col_credit_supplier') }
  const showOpening = ledger.from !== null || ledger.opening_balance_paise !== 0

  if (ledger.rows.length === 0 && !showOpening) {
    return wrap(
      <EmptyState
        compact
        icon={<ScrollText />}
        title={t('ledger.empty_title')}
        description={t('ledger.empty_description')}
      />,
    )
  }

  if (!desktop) {
    return wrap(
      <ul
        className={cn('divide-y divide-border', loading && 'opacity-60')}
        aria-label={t('ledger.title')}
      >
        {showOpening ? (
          <li className="flex items-center justify-between gap-3 bg-surface-2/60 px-4 py-3 text-sm">
            <span className="font-medium">{t('ledger.opening_balance')}</span>
            <BalanceAmount
              partyType={partyType}
              balancePaise={ledger.opening_balance_paise}
              size="sm"
            />
          </li>
        ) : null}
        {ledger.rows.map((row) => (
          <MobileRow key={row.entry_id} row={row} partyType={partyType} link={linkDocuments} />
        ))}
        <li className="grid gap-1 bg-surface-2/60 px-4 py-3 text-sm">
          <div className="flex justify-between gap-3 text-muted-foreground">
            <span>{headers.debit}</span>
            <span className="tabular-nums">{formatMoney(ledger.total_debit_paise)}</span>
          </div>
          <div className="flex justify-between gap-3 text-muted-foreground">
            <span>{headers.credit}</span>
            <span className="tabular-nums">{formatMoney(ledger.total_credit_paise)}</span>
          </div>
          <div className="flex items-center justify-between gap-3 font-semibold">
            <span>{t('ledger.closing_balance')}</span>
            <BalanceAmount partyType={partyType} balancePaise={ledger.closing_balance_paise} />
          </div>
        </li>
      </ul>,
    )
  }

  return wrap(
    <Table aria-label={t('ledger.title')} aria-busy={loading || undefined}>
      <TableHeader>
        <TableRow>
          <TableHead className="w-32">{t('ledger.col_date')}</TableHead>
          <TableHead>{t('ledger.col_particulars')}</TableHead>
          <TableHead className="text-end">{headers.debit}</TableHead>
          <TableHead className="text-end">{headers.credit}</TableHead>
          <TableHead className="text-end">{t('ledger.col_balance')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody className={cn(loading && 'opacity-60 transition-opacity')}>
        {showOpening ? (
          <TableRow className="bg-surface-2/50">
            <TableCell className="whitespace-nowrap py-2.5 tabular-nums text-muted-foreground">
              {ledger.from ? formatDate(ledger.from) : ''}
            </TableCell>
            <TableCell className="py-2.5 font-medium">{t('ledger.opening_balance')}</TableCell>
            <TableCell className="py-2.5" />
            <TableCell className="py-2.5" />
            <TableCell className="py-2.5 text-end">
              <BalanceAmount
                partyType={partyType}
                balancePaise={ledger.opening_balance_paise}
                size="sm"
              />
            </TableCell>
          </TableRow>
        ) : null}
        {ledger.rows.map((row) => (
          <TableRow key={row.entry_id}>
            <TableCell className="whitespace-nowrap py-2.5 tabular-nums">
              {formatDate(row.date)}
            </TableCell>
            <TableCell className="py-2.5">
              <Particulars row={row} link={linkDocuments} />
            </TableCell>
            <TableCell className="py-2.5 text-end tabular-nums">
              {row.debit_paise ? formatMoney(row.debit_paise) : ''}
            </TableCell>
            <TableCell className="py-2.5 text-end tabular-nums">
              {row.credit_paise ? formatMoney(row.credit_paise) : ''}
            </TableCell>
            <TableCell className="py-2.5 text-end">
              <BalanceAmount partyType={partyType} balancePaise={row.balance_paise} size="sm" />
            </TableCell>
          </TableRow>
        ))}
        <TableRow className="bg-surface-2/50 font-semibold hover:bg-surface-2/50">
          <TableCell className="py-3" />
          <TableCell className="py-3">{t('ledger.closing_balance')}</TableCell>
          <TableCell className="py-3 text-end tabular-nums">
            {formatMoney(ledger.total_debit_paise)}
          </TableCell>
          <TableCell className="py-3 text-end tabular-nums">
            {formatMoney(ledger.total_credit_paise)}
          </TableCell>
          <TableCell className="py-3 text-end">
            <BalanceAmount partyType={partyType} balancePaise={ledger.closing_balance_paise} />
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>,
  )
}

function Particulars({ row, link }: { row: PartyLedgerRow; link: boolean }) {
  const { i18n } = useTranslation()
  const label = pickLabel(LEDGER_SOURCE_LABELS[row.source_type], i18n.language)
  const path = link ? journalSourcePath(row.source_type, row.source_id) : null
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium">{label}</span>
        {row.document_number ? (
          path ? (
            <Link
              to={path}
              className="font-mono text-xs text-primary hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {row.document_number}
            </Link>
          ) : (
            <span className="font-mono text-xs text-muted-foreground">{row.document_number}</span>
          )
        ) : null}
      </div>
      {row.description ? (
        <div className="truncate text-xs text-muted-foreground">{row.description}</div>
      ) : null}
    </div>
  )
}

function MobileRow({
  row,
  partyType,
  link,
}: {
  row: PartyLedgerRow
  partyType: PartyType
  link: boolean
}) {
  const debit = row.debit_paise > 0
  // Customers: debit = goods on credit (due goes up). Suppliers: credit = bill (payable goes up).
  const increases = partyType === 'customer' ? debit : !debit
  const amount = debit ? row.debit_paise : row.credit_paise
  return (
    <li className="flex items-start justify-between gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-xs tabular-nums text-muted-foreground">{formatDate(row.date)}</div>
        <Particulars row={row} link={link} />
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        <span
          className={cn(
            'text-sm font-semibold tabular-nums',
            increases ? 'text-foreground' : 'text-success',
          )}
        >
          {increases ? '+' : '−'}
          {formatMoney(amount)}
        </span>
        <BalanceAmount partyType={partyType} balancePaise={row.balance_paise} size="sm" />
      </div>
    </li>
  )
}
