/**
 * /settings — every settings section the member may open, as large cards grouped like the
 * sub-nav (the main entry point on phones). Plan-locked sections are marked.
 */
import { ChevronRight, Lock, Settings2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Badge, EmptyState, PageHeader } from '@/components/ui'
import { translate } from '@/lib/i18n'
import { SETTINGS_GROUPS, type VisibleSection } from '../lib/sections'

export function SettingsHome({ sections }: { sections: readonly VisibleSection[] }) {
  const { t } = useTranslation(['settings', 'nav'])
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title={t('nav:titles.settings')} description={t('home.description')} />
      {sections.length === 0 ? (
        <EmptyState
          icon={<Settings2 />}
          title={t('home.empty_title')}
          description={t('home.empty_description')}
        />
      ) : (
        <div className="flex flex-col gap-8">
          {SETTINGS_GROUPS.map((group) => {
            const items = sections.filter((s) => s.group === group.id)
            if (items.length === 0) return null
            return (
              <section key={group.id} aria-labelledby={`settings-group-${group.id}`}>
                <h2
                  id={`settings-group-${group.id}`}
                  className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  {translate(group.label)}
                </h2>
                <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {items.map((s) => {
                    const Icon = s.icon
                    return (
                      <li key={s.id}>
                        <Link
                          to={s.to}
                          className="group flex h-full items-start gap-3 rounded-xl border border-border bg-surface p-4 shadow-card transition-colors hover:border-primary/40 hover:bg-surface-2/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        >
                          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
                            <Icon className="size-5" aria-hidden />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-2 font-semibold leading-snug">
                              {translate(s.label)}
                              {s.locked ? (
                                <Badge tone="accent" size="sm" icon={<Lock />}>
                                  {t('nav.upgrade_badge')}
                                </Badge>
                              ) : null}
                            </span>
                            <span className="mt-1 block text-sm leading-relaxed text-muted-foreground">
                              {translate(s.description)}
                            </span>
                          </span>
                          <ChevronRight
                            className="mt-2 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 rtl:rotate-180"
                            aria-hidden
                          />
                        </Link>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}
