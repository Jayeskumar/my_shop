/**
 * Sales issues (quote / create errors, SALES_ISSUE_CODES of the contract) → the cashier's
 * language, with amounts, quantities and dates formatted (pos:issues.<code>).
 */
import { type SalesIssue, SalesIssueSchema, type SalesIssueCode } from '@kadai/shared/api/sales'
import { isApiError } from '@/lib/api'
import { formatDate, formatMoney, formatNumber } from '@/lib/format'
import { translate } from '@/lib/i18n'

function formatParams(params: SalesIssue['params']): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined) continue
    if (typeof v === 'number' && k.endsWith('_paise')) out[k] = formatMoney(v)
    else if (typeof v === 'number' && k.endsWith('_milli')) out[k] = formatNumber(v / 1000, 3)
    else if (typeof v === 'number' && k.endsWith('_bp')) out[k] = `${formatNumber(v / 100, 2)}%`
    else if (typeof v === 'string' && k.endsWith('_date')) out[k] = formatDate(v)
    else out[k] = typeof v === 'boolean' ? String(v) : v
  }
  return out
}

export function issueMessage(issue: SalesIssue, lineName?: string | null): string {
  const key = `pos:issues.${issue.code}` as const satisfies `pos:issues.${SalesIssueCode}`
  const text = translate(key, formatParams(issue.params))
  return lineName ? `${lineName}: ${text}` : text
}

/** Blocking issues carried by a create / complete error (details.issues), if any. */
export function issuesOfError(error: unknown): SalesIssue[] {
  if (!isApiError(error)) return []
  const raw = error.details?.['issues']
  if (!Array.isArray(raw)) return []
  return raw.flatMap((i) => {
    const parsed = SalesIssueSchema.safeParse(i)
    return parsed.success ? [parsed.data] : []
  })
}
