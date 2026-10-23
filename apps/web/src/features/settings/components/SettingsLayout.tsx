/**
 * Frame of every settings screen this module owns: a sticky left sub-nav on desktop (lg+) and a
 * horizontally scrolling strip of sections on phones/tablets, with the page in the remaining
 * column. Sections the plan does not include are marked with a lock (the route shows the upgrade
 * page); sections owned by other modules are plain links to their routes. At /settings itself
 * (no child route) it renders the overview of all sections instead.
 */
import { Lock } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { NavLink, useLocation, useOutlet } from 'react-router'
import { useAuth } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { translate } from '@/lib/i18n'
import { SETTINGS_GROUPS, visibleSections, type VisibleSection } from '../lib/sections'
import { SettingsHome } from './SettingsHome'

function isActive(pathname: string, to: string): boolean {
  return pathname === to || pathname.startsWith(`${to}/`)
}

function SideLink({ section, active }: { section: VisibleSection; active: boolean }) {
  const { t } = useTranslation('settings')
  const Icon = section.icon
  return (
    <NavLink
      to={section.to}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group flex min-h-10 items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        active
          ? 'bg-primary-soft text-primary-soft-foreground'
          : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground',
      )}
    >
      <Icon className={cn('size-4 shrink-0', active ? 'text-primary' : 'opacity-80')} aria-hidden />
      <span className="min-w-0 flex-1 leading-snug [overflow-wrap:anywhere]">
        {translate(section.label)}
      </span>
      {section.locked ? (
        <Lock className="size-3.5 shrink-0 text-accent" aria-label={t('nav.locked')} />
      ) : null}
    </NavLink>
  )
}

export function SettingsSubNav({ sections }: { sections: readonly VisibleSection[] }) {
  const { t } = useTranslation('settings')
  const { pathname } = useLocation()
  return (
    <nav aria-label={t('nav.label')} className="flex flex-col gap-5">
      {SETTINGS_GROUPS.map((group) => {
        const items = sections.filter((s) => s.group === group.id)
        if (items.length === 0) return null
        return (
          <div key={group.id}>
            <h2 className="mb-1.5 px-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {translate(group.label)}
            </h2>
            <div className="flex flex-col gap-0.5">
              {items.map((s) => (
                <SideLink key={s.id} section={s} active={isActive(pathname, s.to)} />
              ))}
            </div>
          </div>
        )
      })}
    </nav>
  )
}

function MobileStrip({ sections }: { sections: readonly VisibleSection[] }) {
  const { t } = useTranslation('settings')
  const { pathname } = useLocation()
  const navRef = useRef<HTMLElement | null>(null)
  const activeRef = useRef<HTMLAnchorElement | null>(null)
  useEffect(() => {
    // Centre the current section in the strip (only the strip scrolls, never the page). Tamil
    // labels change width once the web font loads, so centre again then.
    let live = true
    const centre = () => {
      const nav = navRef.current
      const el = activeRef.current
      if (!live || !nav || !el) return
      nav.scrollLeft = el.offsetLeft - (nav.clientWidth - el.offsetWidth) / 2
    }
    centre()
    if ('fonts' in document) void document.fonts.ready.then(centre)
    return () => {
      live = false
    }
  }, [pathname])
  return (
    <nav
      ref={navRef}
      aria-label={t('nav.label')}
      className="scrollbar-thin relative -mx-4 mb-4 flex gap-2 overflow-x-auto border-b border-border px-4 pb-3 sm:-mx-6 sm:px-6 lg:hidden"
    >
      {sections.map((s) => {
        const active = isActive(pathname, s.to)
        const Icon = s.icon
        return (
          <NavLink
            key={s.id}
            to={s.to}
            ref={active ? activeRef : undefined}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'inline-flex h-10 shrink-0 items-center gap-2 rounded-full border px-3.5 text-sm font-medium',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
              active
                ? 'border-primary bg-primary text-primary-foreground shadow-card'
                : 'border-border bg-surface text-foreground hover:bg-surface-2',
            )}
          >
            <Icon className="size-4" aria-hidden />
            {translate(s.label)}
            {s.locked ? (
              <Lock className="size-3.5 opacity-80" aria-label={t('nav.locked')} />
            ) : null}
          </NavLink>
        )
      })}
    </nav>
  )
}

export default function SettingsLayout() {
  const state = useAuth((s) => s)
  const sections = useMemo(() => visibleSections(state), [state])
  const outlet = useOutlet()
  // /settings itself: the overview of every section (no sub-nav next to it).
  if (!outlet) return <SettingsHome sections={sections} />
  return (
    <div className="lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-8 xl:gap-10">
      <aside className="hidden lg:block">
        <div className="sticky top-20 max-h-[calc(100dvh-6rem)] overflow-y-auto pb-6">
          <SettingsSubNav sections={sections} />
        </div>
      </aside>
      <MobileStrip sections={sections} />
      <div className="min-w-0">{outlet}</div>
    </div>
  )
}
