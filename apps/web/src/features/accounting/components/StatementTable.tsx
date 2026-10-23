/**
 * Statement layout shared by the P&L and the balance sheet: sections of account lines (indented
 * under their parent account when both are listed), section totals, highlighted result rows
 * (gross profit, net profit, totals), an optional comparison column with the change, and links
 * from every account to its ledger for the same period.
 */
import type { StatementLine } from '@kadai/shared/api/accounting'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { cn } from '@/lib/cn'
import { formatChangeBp, formatMoney } from '@/lib/format'
import { accountName } from '../lib/labels'
import { changeOf } from '../lib/statements'

export type StatementItem =
  | { kind: 'heading'; label: string }
  | { kind: 'lines'; lines: readonly StatementLine[] }
  | {
      kind: 'total' | 'result'
      label: ReactNode
      amount: number
      compare?: number | null
      /** Signed amount for the change column when `amount` is shown unsigned (net loss). */
      changeFrom?: number
      /** e.g. "Margin 18.5%". */
      note?: string | null
      tone?: 'good' | 'bad' | null
    }

/** Depth of each line inside its section (parents listed in the same section). */
function depths(lines: readonly StatementLine[]): Map<string, number> {
  const byId = new Map(lines.map((l) => [l.account_id, l]))
  const out = new Map<string, number>()
  for (const l of lines) {
    let d = 0
    let p = l.parent_id
    const seen = new Set<string>()
    while (p && byId.has(p) && !seen.has(p) && d < 6) {
      seen.add(p)
      d++
      p = byId.get(p)!.parent_id
    }
    out.set(l.account_id, d)
  }
  return out
}

export function StatementTable({
  items,
  comparing,
  ledgerLink,
  label,
}: {
  items: readonly StatementItem[]
  comparing: boolean
  /** Ledger path of an account for the statement's period. */
  ledgerLink: (accountId: string) => string
  label: string
}) {
  const { t } = useTranslation('accounting')
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-surface">
      <table className="w-full min-w-[20rem] text-sm" aria-label={label}>
        <thead className="sr-only sm:not-sr-only">
          <tr className="border-b border-border text-xs text-muted-foreground">
            <th className="px-4 py-2 text-start font-medium">{t('statements.particulars')}</th>
            <th className="px-4 py-2 text-end font-medium">{t('statements.amount')}</th>
            {comparing ? (
              <>
                <th className="hidden px-4 py-2 text-end font-medium sm:table-cell">
                  {t('statements.compare')}
                </th>
                <th className="hidden px-4 py-2 text-end font-medium sm:table-cell">
                  {t('statements.change')}
                </th>
              </>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {items.map((item, i) => {
            if (item.kind === 'heading') {
              return (
                <tr key={`h-${i}`} className="bg-surface-2/70">
                  <th
                    scope="rowgroup"
                    colSpan={comparing ? 4 : 2}
                    className="px-4 py-2 text-start text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                  >
                    {item.label}
                  </th>
                </tr>
              )
            }
            if (item.kind === 'lines') {
              const depth = depths(item.lines)
              if (!item.lines.length) {
                return (
                  <tr key={`l-${i}`}>
                    <td colSpan={comparing ? 4 : 2} className="px-4 py-2 text-muted-foreground">
                      {t('statements.no_lines')}
                    </td>
                  </tr>
                )
              }
              return item.lines.map((l) => {
                const change = changeOf(l.amount_paise, l.compare_paise)
                return (
                  <tr key={l.account_id} className="border-b border-border/60 last:border-0">
                    <td
                      className="px-4 py-1.5"
                      style={{
                        paddingInlineStart: `${1 + (depth.get(l.account_id) ?? 0) * 1.25}rem`,
                      }}
                    >
                      <Link
                        to={ledgerLink(l.account_id)}
                        className="underline-offset-4 hover:text-primary hover:underline"
                      >
                        {accountName(l)}
                      </Link>
                      <span className="ms-2 text-xs text-muted-foreground tabular-nums">
                        {l.code}
                      </span>
                    </td>
                    <td
                      className={cn(
                        'whitespace-nowrap px-4 py-1.5 text-end tabular-nums',
                        l.amount_paise < 0 && 'text-danger',
                      )}
                    >
                      {formatMoney(l.amount_paise)}
                    </td>
                    {comparing ? (
                      <>
                        <td className="hidden whitespace-nowrap px-4 py-1.5 text-end tabular-nums text-muted-foreground sm:table-cell">
                          {l.compare_paise === null ? '—' : formatMoney(l.compare_paise)}
                        </td>
                        <td className="hidden whitespace-nowrap px-4 py-1.5 text-end text-xs tabular-nums text-muted-foreground sm:table-cell">
                          {change === null ? '—' : formatChangeBp(change)}
                        </td>
                      </>
                    ) : null}
                  </tr>
                )
              })
            }
            const change = changeOf(item.changeFrom ?? item.amount, item.compare)
            const result = item.kind === 'result'
            return (
              <tr
                key={`t-${i}`}
                className={cn(
                  'border-b border-border font-semibold',
                  result && 'bg-primary-soft/50 text-base',
                  result && item.tone === 'bad' && 'bg-danger-soft/60',
                )}
              >
                <td className="px-4 py-2">
                  {item.label}
                  {item.note ? (
                    <span className="ms-2 text-xs font-normal text-muted-foreground">
                      {item.note}
                    </span>
                  ) : null}
                </td>
                <td
                  className={cn(
                    'whitespace-nowrap px-4 py-2 text-end tabular-nums',
                    result && item.tone === 'bad' && 'text-danger',
                    result && item.tone === 'good' && 'text-success',
                  )}
                >
                  {formatMoney(item.amount)}
                </td>
                {comparing ? (
                  <>
                    <td className="hidden whitespace-nowrap px-4 py-2 text-end tabular-nums text-muted-foreground sm:table-cell">
                      {item.compare == null ? '—' : formatMoney(item.compare)}
                    </td>
                    <td className="hidden whitespace-nowrap px-4 py-2 text-end text-xs tabular-nums text-muted-foreground sm:table-cell">
                      {change === null ? '—' : formatChangeBp(change)}
                    </td>
                  </>
                ) : null}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
