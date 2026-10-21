/**
 * Trial balance (சோதனை இருப்பு) as of a date: every account's net debit or credit balance, grouped
 * by account type, with the totals that must agree. Accounts with no balance are hidden unless
 * asked for. Tenant-wide like the balance sheet.
 */
import { CheckCircle2, ShieldAlert, TriangleAlert } from 'lucide-react'
import { Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { AccountTypeSchema } from '@kadai/shared/enums'
import {
  ACCOUNTING_TITLES,
  STATEMENT_LINE_LABELS,
  type TrialBalanceQuery,
  accountingRoutes,
} from '@kadai/shared/api/accounting'
import { DatePicker, EmptyState, ErrorFallback, Skeleton, Switch } from '@/components/ui'
import { downloadRoute } from '@/lib/api'
import { formatDate, formatMoney } from '@/lib/format'
import { useTrialBalance } from '../api'
import { errorReason } from '../lib/errors'
import { accountName, accountTypeLabel, bi } from '../lib/labels'
import { type PrintRow, printTable } from '../lib/print'
import { useTenantInfo } from '../lib/tenant'
import { useUrlState } from '../lib/url-state'
import { ExportMenu } from './ExportMenu'

export function TrialBalancePanel() {
  const { t } = useTranslation(['accounting', 'common'])
  const tenant = useTenantInfo()
  const url = useUrlState()
  const asOf = url.date('as_of', tenant.today)
  const includeZero = url.get('zero') === '1'
  const query: TrialBalanceQuery = { as_of: asOf, ...(includeZero ? { include_zero: true } : {}) }
  const tb = useTrialBalance(query, { enabled: !tenant.storeScoped })
  const data = tb.data?.data
  const groups = AccountTypeSchema.options.map((type) => ({
    type,
    rows: (data?.rows ?? []).filter((r) => r.type === type),
  }))

  const csv = () =>
    downloadRoute(accountingRoutes.trialBalance, {
      query: { ...query, format: 'csv' },
      filename: `trial-balance-${asOf}.csv`,
    })
  const print = () => {
    if (!data) return
    const rows: PrintRow[] = []
    for (const g of groups) {
      if (!g.rows.length) continue
      rows.push({ kind: 'section', cells: [accountTypeLabel(g.type), '', '', ''] })
      for (const r of g.rows)
        rows.push({
          cells: [
            r.code,
            accountName(r),
            r.debit_paise ? formatMoney(r.debit_paise) : '',
            r.credit_paise ? formatMoney(r.credit_paise) : '',
          ],
        })
    }
    rows.push({
      kind: 'total',
      cells: [
        '',
        t('statements.tb.total'),
        formatMoney(data.total_debit_paise),
        formatMoney(data.total_credit_paise),
      ],
    })
    return printTable({
      title: bi(ACCOUNTING_TITLES.trial_balance),
      subtitle: t('statements.as_of', { date: formatDate(data.as_of) }),
      columns: [
        { label: t('common:fields.code') },
        { label: t('journal.fields.account') },
        { label: bi(STATEMENT_LINE_LABELS.debit), align: 'right' },
        { label: bi(STATEMENT_LINE_LABELS.credit), align: 'right' },
      ],
      rows,
    })
  }

  if (tenant.storeScoped || errorReason(tb.error) === 'all_stores_required') {
    return (
      <div className="rounded-xl border border-dashed border-border bg-surface">
        <EmptyState
          icon={<ShieldAlert />}
          title={t('errors.all_stores_required')}
          description={t('statements.all_stores_hint')}
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          {t('statements.as_of_label')}
          <DatePicker
            value={asOf}
            onChange={(d) => url.set({ as_of: d && d !== tenant.today ? d : null })}
            max={tenant.today}
            className="w-44"
          />
        </label>
        <Switch
          checked={includeZero}
          onCheckedChange={(v) => url.set({ zero: v ? '1' : null })}
          label={t('statements.tb.include_zero')}
          className="sm:mb-2"
        />
        <div className="flex gap-2 sm:ms-auto">
          <ExportMenu onPrint={print} onCsv={csv} disabled={!data} />
        </div>
      </div>

      {tb.error ? (
        <ErrorFallback error={tb.error} reset={() => void tb.refetch()} />
      ) : !data ? (
        <Skeleton className="h-96 w-full rounded-xl" aria-busy />
      ) : (
        <>
          {data.balanced ? (
            <p className="flex items-center gap-2 text-sm text-success">
              <CheckCircle2 className="size-4" aria-hidden />
              {t('statements.tb.balanced')}
            </p>
          ) : (
            <p
              role="alert"
              className="flex items-center gap-2 rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning-soft-foreground"
            >
              <TriangleAlert className="size-4" aria-hidden />
              {t('statements.tb.not_balanced', {
                amount: formatMoney(Math.abs(data.difference_paise)),
              })}
            </p>
          )}
          <div className="overflow-x-auto rounded-xl border border-border bg-surface">
            <table
              className="w-full min-w-[22rem] text-sm"
              aria-label={bi(ACCOUNTING_TITLES.trial_balance)}
            >
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th className="px-4 py-2 text-start font-medium">
                    {t('journal.fields.account')}
                  </th>
                  <th className="px-4 py-2 text-end font-medium">
                    {bi(STATEMENT_LINE_LABELS.debit)}
                  </th>
                  <th className="px-4 py-2 text-end font-medium">
                    {bi(STATEMENT_LINE_LABELS.credit)}
                  </th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) =>
                  g.rows.length ? (
                    <Fragment key={g.type}>
                      <tr className="bg-surface-2/70">
                        <th
                          scope="rowgroup"
                          colSpan={3}
                          className="px-4 py-2 text-start text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                        >
                          {accountTypeLabel(g.type)}
                        </th>
                      </tr>
                      {g.rows.map((r) => (
                        <tr key={r.account_id} className="border-b border-border/60">
                          <td className="px-4 py-1.5">
                            <Link
                              to={`/accounting/ledgers?account=${r.account_id}&from=${tenant.fyStart}&to=${asOf}`}
                              className="underline-offset-4 hover:text-primary hover:underline"
                            >
                              {accountName(r)}
                            </Link>
                            <span className="ms-2 text-xs tabular-nums text-muted-foreground">
                              {r.code}
                            </span>
                          </td>
                          <td className="whitespace-nowrap px-4 py-1.5 text-end tabular-nums">
                            {r.debit_paise ? formatMoney(r.debit_paise) : ''}
                          </td>
                          <td className="whitespace-nowrap px-4 py-1.5 text-end tabular-nums">
                            {r.credit_paise ? formatMoney(r.credit_paise) : ''}
                          </td>
                        </tr>
                      ))}
                    </Fragment>
                  ) : null,
                )}
                {data.rows.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-4 py-6 text-center text-muted-foreground">
                      {t('statements.no_lines')}
                    </td>
                  </tr>
                ) : null}
              </tbody>
              <tfoot>
                <tr className="bg-primary-soft/50 text-base font-semibold">
                  <td className="px-4 py-2">{t('statements.tb.total')}</td>
                  <td className="whitespace-nowrap px-4 py-2 text-end tabular-nums">
                    {formatMoney(data.total_debit_paise)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-end tabular-nums">
                    {formatMoney(data.total_credit_paise)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
