import { ChevronDown } from 'lucide-react'
import { useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  Kbd,
  Tooltip,
} from '@/components/ui'
import { cn } from '@/lib/cn'
import { translate } from '@/lib/i18n'
import { storage } from '@/lib/storage'
import type { NavGroup, NavItem } from '../nav'

const OPEN_KEY = 'sidebar.groups'
const DEFAULT_OPEN = ['home', 'billing', 'catalog', 'inventory', 'customers', 'platform']

function isActive(item: NavItem, pathname: string): boolean {
  if (item.end) return pathname === item.to
  return pathname === item.to || pathname.startsWith(`${item.to}/`)
}

function ItemLink({ item, onNavigate }: { item: NavItem; onNavigate?: () => void }) {
  const Icon = item.icon
  return (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onNavigate}
      className={({ isActive: active }) =>
        cn(
          'group flex min-h-10 items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
          'focus-visible:outline-2 focus-visible:outline-ring',
          active
            ? 'bg-sidebar-active text-sidebar-active-foreground'
            : 'text-sidebar-foreground hover:bg-surface-2 hover:text-foreground',
        )
      }
    >
      <Icon className="size-[18px] shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{translate(item.label)}</span>
      {item.hotkey ? <Kbd className="hidden lg:inline-flex">{item.hotkey}</Kbd> : null}
    </NavLink>
  )
}

/** Expanded navigation: collapsible groups (state remembered), active group always open. */
export function NavList({ groups, onNavigate }: { groups: NavGroup[]; onNavigate?: () => void }) {
  const { pathname } = useLocation()
  const [open, setOpen] = useState<string[]>(() =>
    storage.get<string[]>(
      OPEN_KEY,
      DEFAULT_OPEN,
      (v): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string'),
    ),
  )
  const toggle = (id: string): void => {
    const next = open.includes(id) ? open.filter((g) => g !== id) : [...open, id]
    setOpen(next)
    storage.set(OPEN_KEY, next)
  }

  return (
    <nav className="flex flex-col gap-1">
      {groups.map((group) => {
        const containsActive = group.items.some((i) => isActive(i, pathname))
        // Single-item groups (Home) render the item directly.
        if (group.items.length === 1 && group.id === 'home') {
          return <ItemLink key={group.id} item={group.items[0]!} onNavigate={onNavigate} />
        }
        const expanded = containsActive || open.includes(group.id)
        const panelId = `nav-group-${group.id}`
        return (
          <div key={group.id} className="flex flex-col">
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={panelId}
              onClick={() => toggle(group.id)}
              className="mt-2 flex h-8 items-center justify-between rounded-md px-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
            >
              {translate(group.label)}
              <ChevronDown
                className={cn('size-3.5 transition-transform', !expanded && '-rotate-90')}
                aria-hidden
              />
            </button>
            {expanded ? (
              <div id={panelId} className="flex flex-col gap-0.5">
                {group.items.map((item) => (
                  <ItemLink key={item.id} item={item} onNavigate={onNavigate} />
                ))}
              </div>
            ) : null}
          </div>
        )
      })}
    </nav>
  )
}

/** Collapsed (icon rail) navigation: each group opens a fly-out menu. */
export function NavRail({ groups }: { groups: NavGroup[] }) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  return (
    <nav className="flex flex-col items-center gap-1">
      {groups.map((group) => {
        const active = group.items.some((i) => isActive(i, pathname))
        const Icon = group.icon
        const cls = cn(
          'flex size-11 items-center justify-center rounded-lg transition-colors focus-visible:outline-2 focus-visible:outline-ring',
          active
            ? 'bg-sidebar-active text-sidebar-active-foreground'
            : 'text-sidebar-foreground hover:bg-surface-2',
        )
        if (group.items.length === 1) {
          const item = group.items[0]!
          const ItemIcon = item.icon
          return (
            <Tooltip key={group.id} content={translate(item.label)} side="right">
              <NavLink
                to={item.to}
                end={item.end}
                className={cls}
                aria-label={translate(item.label)}
              >
                <ItemIcon className="size-5" />
              </NavLink>
            </Tooltip>
          )
        }
        return (
          <DropdownMenu key={group.id}>
            <Tooltip content={translate(group.label)} side="right">
              <DropdownMenuTrigger className={cls} aria-label={translate(group.label)}>
                <Icon className="size-5" />
              </DropdownMenuTrigger>
            </Tooltip>
            <DropdownMenuContent side="right" align="start" className="w-60">
              <DropdownMenuLabel>{translate(group.label)}</DropdownMenuLabel>
              {group.items.map((item) => {
                const ItemIcon = item.icon
                return (
                  <DropdownMenuItem
                    key={item.id}
                    icon={<ItemIcon />}
                    shortcut={item.hotkey}
                    className={cn(isActive(item, pathname) && 'font-semibold text-primary')}
                    onSelect={() => void navigate(item.to)}
                  >
                    {translate(item.label)}
                  </DropdownMenuItem>
                )
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )
      })}
    </nav>
  )
}
