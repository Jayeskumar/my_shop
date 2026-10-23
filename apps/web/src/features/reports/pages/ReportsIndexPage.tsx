/**
 * Reports home (/reports): the REPORTS catalogue grouped as Sales · Stock · Customers & suppliers
 * · GST · Pharmacy (pharmacy shops only) · Shifts & controls, with a Tamil / English description on
 * every card and a quick search ("/" focuses it). Reports the member may not open are hidden;
 * reports outside the plan stay visible with an upgrade badge (the viewer explains the upgrade).
 */
import { FEATURE_LABELS } from '@kadai/shared/features'
import { REPORT_GROUPS, REPORTS, type ReportDef, type ReportGroup } from '@kadai/shared/api/reports'
import {
  Boxes,
  ChevronRight,
  Landmark,
  Lock,
  Pill,
  SearchX,
  ShieldCheck,
  TrendingUp,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Badge, EmptyState, PageHeader, SearchInput } from '@/components/ui'
import { useAuth } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { useHotkeys } from '@/lib/hotkeys'
import { checkAccess } from '@/lib/permissions'
import { pick, snakeKey, useLang } from '../lib/labels'

const GROUP_ICONS: Record<ReportGroup, LucideIcon> = {
  sales: TrendingUp,
  stock: Boxes,
  parties: Users,
  gst: Landmark,
  pharmacy: Pill,
  controls: ShieldCheck,
}

interface CardItem {
  key: string
  to: string
  title: string
  description: string
  locked: string | null
  advanced: boolean
}

export default function ReportsIndexPage() {
  const { t } = useTranslation(['reports', 'common'])
  const lng = useLang()
  const state = useAuth((s) => s)
  const businessType = state.me?.tenant.business_type
  const [q, setQ] = useState('')
  const search = useRef<HTMLInputElement>(null)
  useHotkeys({ '/': () => search.current?.focus() })

  const groups = useMemo(() => {
    const needle = q.trim().toLocaleLowerCase()
    const matches = (item: CardItem, extra: string[]): boolean =>
      !needle ||
      [item.title, item.description, ...extra].some((s) => s.toLocaleLowerCase().includes(needle))
    return REPORT_GROUPS.filter(
      (g) => !g.business_types || (businessType && g.business_types.includes(businessType)),
    )
      .map((g) => {
        const items: CardItem[] = []
        for (const link of g.links ?? []) {
          const access = checkAccess({ permission: link.permission, feature: link.feature }, state)
          if (access === 'forbidden') continue
          const item: CardItem = {
            key: link.key,
            to: link.path,
            title:
              link.key === 'gst-returns'
                ? t('reports:links.gst_returns.title')
                : pick(link.title, lng),
            description:
              link.key === 'gst-returns'
                ? t('reports:links.gst_returns.description')
                : pick(link.description, lng),
            locked: access === 'feature' ? FEATURE_LABELS[link.feature][lng] : null,
            advanced: false,
          }
          if (matches(item, [link.title.en, link.title.ta])) items.push(item)
        }
        for (const def of REPORTS.filter((r: ReportDef) => r.group === g.key)) {
          if (def.business_types && !(businessType && def.business_types.includes(businessType)))
            continue
          const access = checkAccess({ permission: def.permission, feature: def.feature }, state)
          if (access === 'forbidden' || access === 'business_type') continue
          const item: CardItem = {
            key: def.key,
            to: `/reports/${def.key}`,
            title: t(`reports:titles.${snakeKey(def.key)}`),
            description: t(`reports:descriptions.${snakeKey(def.key)}`),
            locked: access === 'feature' ? FEATURE_LABELS[def.feature][lng] : null,
            advanced: def.feature === 'advanced_reports',
          }
          if (matches(item, [def.title.en, def.title.ta, def.key])) items.push(item)
        }
        return { group: g.key, items }
      })
      .filter((g) => g.items.length > 0)
  }, [q, state, businessType, t, lng])

  return (
    <div className="min-w-0">
      <PageHeader
        title={t('reports:index.title')}
        description={t('reports:index.description')}
        actions={
          <SearchInput
            ref={search}
            value={q}
            onChange={setQ}
            placeholder={t('reports:index.search_placeholder')}
            wrapperClassName="w-full sm:w-72"
          />
        }
      />
      {groups.length === 0 ? (
        <EmptyState
          icon={<SearchX />}
          title={t('reports:index.no_match_title')}
          description={t('reports:index.no_match_hint')}
        />
      ) : (
        <div className="grid grid-cols-1 gap-8">
          {groups.map(({ group, items }) => {
            const Icon = GROUP_ICONS[group]
            return (
              <section key={group} aria-labelledby={`group-${group}`}>
                <div className="mb-3 flex items-start gap-3">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary-soft-foreground">
                    <Icon className="size-5" aria-hidden />
                  </span>
                  <div className="min-w-0">
                    <h2 id={`group-${group}`} className="text-lg font-semibold leading-tight">
                      {t(`reports:groups.${group}.title`)}
                    </h2>
                    <p className="text-sm text-muted-foreground">
                      {t(`reports:groups.${group}.description`)}
                    </p>
                  </div>
                </div>
                <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {items.map((item) => (
                    <li key={item.key}>
                      <Link
                        to={item.to}
                        className={cn(
                          'group flex h-full min-h-20 items-start gap-3 rounded-xl border border-border bg-surface p-4 shadow-card transition-shadow',
                          'hover:border-primary/40 hover:shadow-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                        )}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="font-semibold leading-snug text-foreground">
                              {item.title}
                            </h3>
                            {item.locked ? (
                              <Badge tone="accent" size="sm" icon={<Lock />}>
                                {t('reports:index.upgrade')}
                              </Badge>
                            ) : item.advanced ? (
                              <Badge tone="info" size="sm">
                                {t('reports:index.advanced')}
                              </Badge>
                            ) : null}
                          </div>
                          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                            {item.description}
                          </p>
                        </div>
                        <ChevronRight
                          className="mt-1 size-5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 rtl:rotate-180"
                          aria-hidden
                        />
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}
