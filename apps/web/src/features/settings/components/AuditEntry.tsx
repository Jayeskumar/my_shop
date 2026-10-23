/**
 * One audit-log entry: time, who, what (area + action), the summary, a link to the record and an
 * expandable "what changed" view (before → after per field, or the raw details) with the
 * request's IP, device and request id for support.
 */
import { ArrowRight, ChevronDown, ExternalLink } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { documentPath, type AuditLog } from '@kadai/shared/api/identity'
import { Avatar, Badge } from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatTime } from '@/lib/format'
import { auditActionLabel, diffRows, displayValue } from '../lib/audit'

export function DiffView({ changes }: { changes: unknown }) {
  const { t } = useTranslation('settings')
  const rows = diffRows(changes)
  if (rows === null) {
    return (
      <pre className="max-h-64 overflow-auto rounded-lg bg-surface-2 p-3 text-xs leading-relaxed">
        {JSON.stringify(changes, null, 2)}
      </pre>
    )
  }
  if (rows.length === 0)
    return <p className="text-sm text-muted-foreground">{t('audit.no_field_changes')}</p>
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="bg-surface-2 text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-start font-medium">{t('audit.field')}</th>
            <th className="px-3 py-2 text-start font-medium">{t('audit.before')}</th>
            <th className="w-6" aria-hidden />
            <th className="px-3 py-2 text-start font-medium">{t('audit.after')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.path} className="border-t border-border align-top">
              <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{r.path}</td>
              <td className="px-3 py-2">
                <span className="rounded bg-danger-soft px-1.5 py-0.5 text-danger-soft-foreground [overflow-wrap:anywhere]">
                  {displayValue(r.before)}
                </span>
              </td>
              <td className="py-2 text-muted-foreground" aria-hidden>
                <ArrowRight className="size-3.5 rtl:rotate-180" />
              </td>
              <td className="px-3 py-2">
                <span className="rounded bg-success-soft px-1.5 py-0.5 text-success-soft-foreground [overflow-wrap:anywhere]">
                  {displayValue(r.after)}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function AuditEntry({ entry }: { entry: AuditLog }) {
  const { t } = useTranslation('settings')
  const [open, setOpen] = useState(false)
  const label = auditActionLabel(entry.action)
  const link = documentPath(entry.entity_type, entry.entity_id)
  const hasDetails = entry.changes !== null && entry.changes !== undefined
  const detailsId = `audit-${entry.id}-details`
  return (
    <li className="relative flex gap-3 ps-1">
      <div className="flex flex-col items-center">
        <Avatar name={entry.user_name ?? t('audit.system_user')} size="sm" />
        <span className="mt-1 w-px flex-1 bg-border" aria-hidden />
      </div>
      <div className="min-w-0 flex-1 pb-5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium">{entry.user_name ?? t('audit.system_user')}</span>
          <Badge size="sm" tone="primary" appearance="soft">
            {label.area}
          </Badge>
          {label.verb ? <span className="text-sm">{label.verb}</span> : null}
          <time
            dateTime={entry.created_at}
            className="ms-auto text-xs tabular-nums text-muted-foreground"
          >
            {formatTime(entry.created_at)}
          </time>
        </div>
        {entry.summary ? (
          <p className="mt-0.5 text-sm text-muted-foreground [overflow-wrap:anywhere]">
            {entry.summary}
          </p>
        ) : null}
        <div className="mt-1.5 flex flex-wrap items-center gap-3 text-sm">
          {link ? (
            <Link to={link} className="inline-flex items-center gap-1 text-primary hover:underline">
              <ExternalLink className="size-3.5" aria-hidden />
              {t('audit.open_record')}
            </Link>
          ) : null}
          <button
            type="button"
            aria-expanded={open}
            aria-controls={detailsId}
            onClick={() => setOpen((o) => !o)}
            className="inline-flex min-h-8 items-center gap-1 rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            <ChevronDown
              className={cn('size-4 transition-transform', open && 'rotate-180')}
              aria-hidden
            />
            {hasDetails ? t('audit.show_changes') : t('audit.show_details')}
          </button>
        </div>
        {open ? (
          <div id={detailsId} className="mt-2 flex flex-col gap-2">
            {hasDetails ? <DiffView changes={entry.changes} /> : null}
            <dl className="grid gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-[auto_minmax(0,1fr)]">
              <dt className="font-medium">{t('audit.action_code')}</dt>
              <dd className="font-mono">{entry.action}</dd>
              {entry.ip ? (
                <>
                  <dt className="font-medium">{t('audit.ip')}</dt>
                  <dd className="font-mono">{entry.ip}</dd>
                </>
              ) : null}
              {entry.user_agent ? (
                <>
                  <dt className="font-medium">{t('audit.device')}</dt>
                  <dd className="truncate" title={entry.user_agent}>
                    {entry.user_agent}
                  </dd>
                </>
              ) : null}
              {entry.request_id ? (
                <>
                  <dt className="font-medium">{t('audit.request_id')}</dt>
                  <dd className="font-mono">{entry.request_id}</dd>
                </>
              ) : null}
            </dl>
          </div>
        ) : null}
      </div>
    </li>
  )
}
