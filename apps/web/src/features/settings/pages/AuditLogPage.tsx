/**
 * Audit log (/settings/audit-log, permission audit.read + plan feature audit_log): who did what
 * and when, newest first, as a day-grouped timeline. Filters (in the URL): member, area (action
 * prefix), date range, and a specific record (?entity_type=&entity_id=, used by "history" links
 * from other screens). Each entry links to its record and expands to a before → after diff.
 */
import { History, X } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { AuditLog, AuditLogListQuery } from '@kadai/shared/api/identity'
import { addDays, isDateStr, todayIn, toDateStr } from '@kadai/shared/fy'
import { UserPicker } from '@/components/pickers'
import {
  Badge,
  Button,
  DateRangePicker,
  EmptyState,
  Pagination,
  Select,
  Skeleton,
} from '@/components/ui'
import { formatDate } from '@/lib/format'
import { useAuth } from '@/lib/auth'
import { useAuditLogs } from '../api'
import { AuditEntry } from '../components/AuditEntry'
import { SettingsPageHeader } from '../components/SettingsPageHeader'
import { AUDIT_AREAS, auditActionLabel } from '../lib/audit'
import { useListParams } from '../lib/list-params'
import { settingsErrorDisplay } from '../lib/messages'

const PAGE_SIZE = 50
const ALL = 'all'
const ID_RE = /^[0-9a-f-]{36}$/i
const ENTITY_RE = /^[a-z0-9_]{1,60}$/

export default function AuditLogPage() {
  const { t } = useTranslation(['settings', 'common', 'nav'])
  const tz = useAuth((s) => s.me?.tenant.timezone)
  const [state, setState] = useListParams({
    user: '',
    area: ALL,
    from: '',
    to: '',
    entity_type: '',
    entity_id: '',
  })
  const query: AuditLogListQuery = {
    limit: PAGE_SIZE,
    offset: state.offset,
    ...(ID_RE.test(state.user) ? { user_id: state.user } : {}),
    ...((AUDIT_AREAS as readonly string[]).includes(state.area) ? { action: state.area } : {}),
    ...(isDateStr(state.from) ? { from: state.from } : {}),
    ...(isDateStr(state.to) ? { to: state.to } : {}),
    ...(ENTITY_RE.test(state.entity_type) ? { entity_type: state.entity_type } : {}),
    ...(ID_RE.test(state.entity_id) ? { entity_id: state.entity_id } : {}),
  }
  const list = useAuditLogs(query)
  const entries = useMemo(() => list.data?.data ?? [], [list.data])
  const page = list.data?.page

  const today = todayIn(tz)
  const groups = useMemo(() => {
    const out: { day: string; items: AuditLog[] }[] = []
    for (const e of entries) {
      const day = toDateStr(new Date(e.created_at), tz)
      const last = out[out.length - 1]
      if (last && last.day === day) last.items.push(e)
      else out.push({ day, items: [e] })
    }
    return out
  }, [entries, tz])
  const dayLabel = (day: string): string =>
    day === today
      ? t('common:dates.today')
      : day === addDays(today, -1)
        ? t('common:dates.yesterday')
        : formatDate(day)

  const filtered =
    Boolean(query.user_id) ||
    Boolean(query.action) ||
    Boolean(query.from) ||
    Boolean(query.to) ||
    Boolean(query.entity_type) ||
    Boolean(query.entity_id)
  const areaOptions = [
    { value: ALL, label: t('audit.all_areas') },
    ...AUDIT_AREAS.map((a) => ({ value: a, label: auditActionLabel(`${a}.x`).area })),
  ]
  const error = list.error && !list.data ? settingsErrorDisplay(list.error) : null

  return (
    <div className="max-w-4xl">
      <SettingsPageHeader
        title={t('nav:titles.settings_audit_log')}
        description={t('audit.description')}
      />
      <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_12rem_minmax(0,1fr)]">
        <UserPicker
          value={ID_RE.test(state.user) ? state.user : null}
          onChange={(id) => setState({ user: id ?? '' })}
          includeDisabled
          placeholder={t('audit.all_members')}
          aria-label={t('audit.member_filter')}
        />
        <Select
          value={state.area}
          onValueChange={(area) => setState({ area })}
          options={areaOptions}
        />
        <DateRangePicker
          value={query.from && query.to ? { from: query.from, to: query.to } : null}
          onChange={(r) => setState({ from: r.from, to: r.to })}
          max={today}
          align="end"
        />
      </div>
      {query.entity_type || query.entity_id || filtered ? (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {query.entity_type ? (
            <Badge tone="info">
              {t('audit.record_filter', {
                type: auditActionLabel(`${query.entity_type}.x`).area,
              })}
            </Badge>
          ) : null}
          {filtered ? (
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<X />}
              onClick={() =>
                setState({ user: '', area: ALL, from: '', to: '', entity_type: '', entity_id: '' })
              }
            >
              {t('common:actions.clear_filters')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <EmptyState
          icon={<History />}
          title={error.title}
          description={error.description}
          action={
            <Button variant="outline" onClick={() => void list.refetch()}>
              {t('common:actions.retry')}
            </Button>
          }
        />
      ) : list.isLoading ? (
        <div className="flex flex-col gap-4" aria-busy>
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex gap-3">
              <Skeleton className="size-8 rounded-full" />
              <div className="flex-1">
                <Skeleton className="mb-2 h-4 w-1/2" />
                <Skeleton className="h-3 w-3/4" />
              </div>
            </div>
          ))}
        </div>
      ) : entries.length === 0 ? (
        <EmptyState
          icon={<History />}
          title={filtered ? t('common:empty.no_results') : t('audit.empty_title')}
          description={filtered ? t('common:empty.no_results_hint') : t('audit.empty_description')}
        />
      ) : (
        <div className={list.isFetching ? 'opacity-60 transition-opacity' : undefined}>
          {groups.map((g) => (
            <section key={g.day} aria-label={dayLabel(g.day)} className="mb-2">
              <h2 className="sticky top-16 z-10 mb-3 bg-background/95 py-1.5 text-sm font-semibold text-muted-foreground backdrop-blur">
                {dayLabel(g.day)}
              </h2>
              <ol className="flex flex-col">
                {g.items.map((e) => (
                  <AuditEntry key={e.id} entry={e} />
                ))}
              </ol>
            </section>
          ))}
          {page && page.total > PAGE_SIZE ? (
            <Pagination
              offset={page.offset}
              limit={page.limit}
              total={page.total}
              hidePageSize
              onChange={(next) => {
                setState({ offset: next.offset })
                window.scrollTo({ top: 0 })
              }}
              className="mt-4"
            />
          ) : null}
        </div>
      )}
    </div>
  )
}
