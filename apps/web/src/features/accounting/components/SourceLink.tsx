/**
 * The document behind a journal entry / ledger row: its type ("Sale bill", "Expense"…) and number,
 * linked to the document page (journalSourcePath / JOURNAL_SOURCE_ROUTES — invoices, bills,
 * shifts, the expense or journal drawer). Shown as plain text when there is no page.
 */
import type { JournalSourceType } from '@kadai/shared'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { cn } from '@/lib/cn'
import { sourceTypeLabel } from '../lib/labels'

export function SourceLink({
  type,
  number,
  path,
  showType = true,
  stacked = false,
  className,
}: {
  type: JournalSourceType
  number: string | null
  path: string | null
  showType?: boolean
  /** Type on its own small line above the number (narrow table columns). */
  stacked?: boolean
  className?: string
}) {
  useTranslation('accounting')
  const label = sourceTypeLabel(type)
  const text = number ?? (showType ? null : label)
  const content = stacked ? (
    <>
      {showType ? <span className="block text-xs text-muted-foreground">{label}</span> : null}
      {text ? (
        <span className="block whitespace-nowrap font-medium tabular-nums">{text}</span>
      ) : null}
    </>
  ) : (
    <>
      {showType ? <span className="text-muted-foreground">{label}</span> : null}
      {showType && text ? <span className="text-muted-foreground"> · </span> : null}
      {text ? <span className="font-medium tabular-nums">{text}</span> : null}
    </>
  )
  if (!path) return <span className={cn('text-sm', stacked && 'block', className)}>{content}</span>
  return (
    <Link
      to={path}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        'text-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring [&_.font-medium]:text-primary',
        stacked && 'block',
        className,
      )}
    >
      {content}
    </Link>
  )
}
