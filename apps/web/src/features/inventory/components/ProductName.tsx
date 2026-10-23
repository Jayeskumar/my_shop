/**
 * Product cell of inventory tables: the name in the UI language, the other-language name and
 * the SKU / batch below. Document references link to the source document page.
 */
import { documentPath } from '@kadai/shared/api/identity'
import { FileText } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { cn } from '@/lib/cn'
import { productNames } from '../lib/labels'

export function ProductName({
  name,
  nameTa,
  sku,
  extra,
  wrap = false,
  className,
}: {
  name: string
  nameTa: string | null
  sku?: string | null
  /** Extra subtitle parts (batch number, category …). */
  extra?: Array<string | null | undefined | false>
  /** Let long names wrap to two lines (cards) instead of truncating. */
  wrap?: boolean
  className?: string
}) {
  const { i18n } = useTranslation()
  const names = productNames(name, nameTa, i18n.language)
  const subtitle = [names.secondary, sku, ...(extra ?? [])]
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .join(' · ')
  return (
    <div className={cn('min-w-0', className)}>
      <div className={cn('font-medium text-foreground', wrap ? 'line-clamp-2' : 'truncate')}>
        {names.primary}
      </div>
      {subtitle ? (
        <div className={cn('text-xs text-muted-foreground', wrap ? 'line-clamp-2' : 'truncate')}>
          {subtitle}
        </div>
      ) : null}
    </div>
  )
}

/** Link to the document a movement came from (invoice, bill, adjustment, transfer …). */
export function DocumentLink({
  refType,
  refId,
  number,
  fallback,
}: {
  refType: string | null
  refId: string | null
  number: string | null
  /** Text when the document has no number (e.g. its type label). */
  fallback?: string
}) {
  const to = documentPath(refType, refId)
  const text = number ?? fallback ?? null
  if (!text) return <span className="text-muted-foreground">—</span>
  if (!to) return <span className="tabular-nums">{text}</span>
  return (
    <Link
      to={to}
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
    >
      <FileText className="size-3.5 shrink-0" aria-hidden />
      <span className="tabular-nums">{text}</span>
    </Link>
  )
}
