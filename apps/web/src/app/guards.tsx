/**
 * Route guards (layout routes rendering <Outlet/>):
 *
 *  - RequireSession: signed in (any status but booting/unauthenticated) → else /login?next=…
 *  - RequireTenant:  signed in to a business (GET /me loaded) → else /select-business, or
 *                    /platform for a platform admin without a business.
 *  - GuestOnly:      signed-out pages; signed-in users go to `next` or home.
 *  - RouteAccess:    enforces the matched routes' handle rules: permission → 403 page,
 *                    feature → upgrade page, mode/business type → not available.
 */
import { Navigate, Outlet, useLocation, useSearchParams } from 'react-router'
import { useAuth } from '@/lib/auth'
import { checkAccess } from '@/lib/permissions'
import { SplashScreen } from './pages/SplashScreen'
import { ForbiddenPage, ModeUnavailablePage, NotFoundPage, UpgradePage } from './pages/StatusPages'
import { useRouteHandles } from './route-handles'

/** Only same-app relative paths are accepted as ?next= (no open redirects). */
export function safeNext(next: string | null | undefined, fallback = '/'): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback
  return next
}

export function RequireSession() {
  const status = useAuth((s) => s.status)
  const location = useLocation()
  if (status === 'booting') return <SplashScreen />
  if (status === 'unauthenticated') {
    const next = `${location.pathname}${location.search}`
    const target = next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`
    return <Navigate to={target} replace />
  }
  return <Outlet />
}

export function RequireTenant() {
  const status = useAuth((s) => s.status)
  const me = useAuth((s) => s.me)
  const isPlatformAdmin = useAuth((s) => s.session?.user.is_platform_admin ?? false)
  const location = useLocation()
  if (status === 'needs_tenant') {
    const next = `${location.pathname}${location.search}`
    return <Navigate to={`/select-business?next=${encodeURIComponent(next)}`} replace />
  }
  if (!me) {
    return <Navigate to={isPlatformAdmin ? '/platform' : '/select-business'} replace />
  }
  return <Outlet />
}

export function GuestOnly() {
  const status = useAuth((s) => s.status)
  const [params] = useSearchParams()
  if (status === 'booting') return <SplashScreen />
  if (status === 'authenticated') return <Navigate to={safeNext(params.get('next'))} replace />
  if (status === 'needs_tenant') {
    const next = params.get('next')
    return <Navigate to={next ? `/select-business?next=${encodeURIComponent(next)}` : '/select-business'} replace />
  }
  return <Outlet />
}

export function RouteAccess() {
  const handles = useRouteHandles()
  const state = useAuth((s) => s)
  for (const { handle } of handles) {
    const result = checkAccess(handle, state)
    if (result === 'forbidden') return <ForbiddenPage />
    if (result === 'feature' && handle.feature) return <UpgradePage feature={handle.feature} />
    if (result === 'mode') return <ModeUnavailablePage />
    if (result === 'business_type') return <NotFoundPage />
  }
  return <Outlet />
}
