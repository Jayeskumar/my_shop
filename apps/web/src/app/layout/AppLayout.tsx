/**
 * Back-office shell: collapsible sidebar (lg+), drawer navigation (below lg), top bar with
 * store/counter switcher, connectivity, New bill (F2), language and user menu, and phone
 * bottom quick-actions. Pages render in <Outlet/> inside an error boundary that resets on
 * navigation.
 */
import {
  AlertTriangle,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  ShoppingCart,
  WifiOff,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, Outlet, useLocation, useNavigate, useNavigation } from 'react-router'
import { Button, Drawer, ErrorBoundary, IconButton, Kbd, ScrollArea } from '@/components/ui'
import { revalidateOfflineSession, useAuth, useFeature } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { useHotkeys } from '@/lib/hotkeys'
import { useOnline } from '@/lib/online'
import { usePermission } from '@/lib/permissions'
import { storage, isBoolean } from '@/lib/storage'
import { visibleNav } from '../nav'
import { BottomNav } from './BottomNav'
import { BrandMark } from './BrandMark'
import { LanguageToggle } from './LanguageToggle'
import { NavList, NavRail } from './NavList'
import { OnlineIndicator } from './OnlineIndicator'
import { StoreSwitcher } from './StoreSwitcher'
import { UserMenu } from './UserMenu'

const COLLAPSED_KEY = 'sidebar.collapsed'

function RouteProgress() {
  const navigation = useNavigation()
  if (navigation.state === 'idle') return null
  return (
    <div
      className="fixed inset-x-0 top-0 z-[60] h-0.5 overflow-hidden"
      role="progressbar"
      aria-busy
    >
      <div className="h-full w-1/3 animate-[slide-in-right_1s_ease-in-out_infinite] bg-accent" />
    </div>
  )
}

function Banners() {
  const { t } = useTranslation(['common', 'nav'])
  const status = useOnline()
  const me = useAuth((s) => s.me)
  const offline = !status.online
  return (
    <>
      {me?.tenant.status === 'suspended' ? (
        <div
          role="alert"
          className="flex items-center gap-2 bg-danger px-4 py-2 text-sm font-medium text-danger-foreground"
        >
          <AlertTriangle className="size-4 shrink-0" />
          {t('nav:shell.suspended_banner_generic')}
        </div>
      ) : null}
      {offline ? (
        <div
          role="status"
          className="flex items-center gap-2 bg-warning-soft px-4 py-1.5 text-sm text-warning-soft-foreground"
        >
          <WifiOff className="size-4 shrink-0" />
          <span className="truncate">
            {status.browserOnline
              ? t('common:network.server_down_hint')
              : t('common:network.offline_hint')}
          </span>
        </div>
      ) : null}
    </>
  )
}

export function AppLayout() {
  const { t } = useTranslation(['nav', 'common'])
  const navigate = useNavigate()
  const location = useLocation()
  const state = useAuth((s) => s)
  const groups = useMemo(() => visibleNav(state), [state])
  const [collapsed, setCollapsed] = useState(() => storage.get(COLLAPSED_KEY, false, isBoolean))
  const [drawerOpen, setDrawerOpen] = useState(false)
  const canPosPermission = usePermission('pos.use')
  const posFeature = useFeature('pos')
  const canPos = canPosPermission && posFeature && Boolean(state.me)
  const online = useOnline().online

  // Close the mobile drawer on navigation.
  useEffect(() => setDrawerOpen(false), [location.pathname])

  // After an offline start, re-validate the session as soon as the server answers.
  useEffect(() => {
    if (online && state.offline) void revalidateOfflineSession()
  }, [online, state.offline])

  useHotkeys({ F2: () => canPos && void navigate('/pos') }, { enabled: canPos })

  const toggleCollapsed = (): void => {
    setCollapsed((c) => {
      storage.set(COLLAPSED_KEY, !c)
      return !c
    })
  }

  return (
    <div className="min-h-dvh bg-background">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:start-3 focus:top-3 focus:z-[70] focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground"
      >
        {t('common:a11y.skip_to_content')}
      </a>
      <RouteProgress />

      {/* Desktop sidebar */}
      <aside
        aria-label={t('common:a11y.main_navigation')}
        className={cn(
          'no-print fixed inset-y-0 start-0 z-30 hidden flex-col border-e border-border bg-sidebar transition-[width] duration-200 lg:flex',
          collapsed ? 'w-[72px]' : 'w-64',
        )}
      >
        <div
          className={cn(
            'flex h-16 shrink-0 items-center border-b border-border',
            collapsed ? 'justify-center' : 'px-5',
          )}
        >
          <Link
            to="/"
            aria-label="Kadai"
            className="rounded-md focus-visible:outline-2 focus-visible:outline-ring"
          >
            <BrandMark size="sm" withName={!collapsed} />
          </Link>
        </div>
        <ScrollArea
          className="min-h-0 flex-1"
          viewportClassName={cn('py-3', collapsed ? 'px-2' : 'px-3')}
        >
          {collapsed ? <NavRail groups={groups} /> : <NavList groups={groups} />}
        </ScrollArea>
        <div
          className={cn(
            'flex shrink-0 border-t border-border p-2',
            collapsed ? 'justify-center' : 'justify-end',
          )}
        >
          <IconButton
            size="sm"
            label={collapsed ? t('shell.expand_sidebar') : t('shell.collapse_sidebar')}
            icon={
              collapsed ? (
                <PanelLeftOpen className="rtl:rotate-180" />
              ) : (
                <PanelLeftClose className="rtl:rotate-180" />
              )
            }
            onClick={toggleCollapsed}
          />
        </div>
      </aside>

      {/* Mobile / tablet navigation drawer */}
      <Drawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        side="left"
        title={t('shell.menu')}
        hideHeader
        bodyClassName="px-3 py-3"
      >
        <div className="mb-3 flex items-center justify-between px-2">
          <BrandMark size="sm" />
          <LanguageToggle compact />
        </div>
        {state.me ? <StoreSwitcher className="mb-3 w-full max-w-none" /> : null}
        <NavList groups={groups} onNavigate={() => setDrawerOpen(false)} />
      </Drawer>

      <div
        className={cn(
          'flex min-h-dvh flex-col transition-[padding] duration-200',
          collapsed ? 'lg:ps-[72px]' : 'lg:ps-64',
        )}
      >
        <header className="no-print sticky top-0 z-20 border-b border-border bg-surface/90 pt-safe backdrop-blur supports-[backdrop-filter]:bg-surface/75">
          <div className="flex h-16 items-center gap-2 px-3 sm:px-5">
            <IconButton
              className="lg:hidden"
              label={t('shell.menu')}
              icon={<Menu />}
              onClick={() => setDrawerOpen(true)}
            />
            <Link to="/" className="me-1 lg:hidden" aria-label="Kadai">
              <BrandMark size="sm" withName={false} />
            </Link>
            <div className="hidden min-w-0 md:block">
              <StoreSwitcher />
            </div>
            <div className="ms-auto flex items-center gap-1.5 sm:gap-2">
              <OnlineIndicator />
              {canPos ? (
                <Button asChild variant="accent" className="hidden sm:inline-flex">
                  <Link to="/pos">
                    <ShoppingCart />
                    {t('shell.new_bill')}
                    <Kbd className="border-accent-700/20 bg-accent-600/15 text-accent-950">F2</Kbd>
                  </Link>
                </Button>
              ) : null}
              <LanguageToggle className="hidden sm:inline-flex" />
              <UserMenu />
            </div>
          </div>
        </header>
        <Banners />
        <main
          id="main"
          tabIndex={-1}
          className="flex-1 px-4 pb-24 pt-5 outline-none sm:px-6 md:pb-10 lg:px-8"
        >
          <div className="mx-auto w-full max-w-[1600px]">
            <ErrorBoundary resetKeys={[location.pathname]}>
              <Outlet />
            </ErrorBoundary>
          </div>
        </main>
      </div>

      <BottomNav onMenu={() => setDrawerOpen(true)} />
    </div>
  )
}

/** Minimal frame for public pages (shared invoice link, customer display). */
export function PublicLayout() {
  return (
    <div className="min-h-dvh bg-background">
      <ErrorBoundary>
        <Outlet />
      </ErrorBoundary>
    </div>
  )
}

/** Full-screen signed-in pages (POS counter): no shell, own chrome. */
export function FullscreenLayout() {
  const location = useLocation()
  return (
    <div className="min-h-dvh bg-background">
      <ErrorBoundary resetKeys={[location.pathname]}>
        <Outlet />
      </ErrorBoundary>
    </div>
  )
}
