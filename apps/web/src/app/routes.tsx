/**
 * Route tree (ARCHITECTURE.md §16): composes every feature's `routes` under the right guard
 * and layout. Feature modules never edit this file — they edit their own routes.tsx.
 *
 *   public      → PublicLayout                        (/i/:token, /pos/display)
 *   guest       → GuestOnly                           (/login, /signup, /otp, /forgot-password, /setup)
 *   session     → RequireSession                      (/select-business)
 *   admin       → RequireSession → AppLayout          (/platform/*; RouteAccess checks platformAdmin)
 *   fullscreen  → RequireSession → RequireTenant      (/pos)
 *   app         → RequireSession → RequireTenant → AppLayout (everything else, 404 inside the shell)
 */
import type { RouteObject } from 'react-router'
import { routes as accounting } from '@/features/accounting/routes'
import { routes as auth } from '@/features/auth/routes'
import { routes as billing } from '@/features/billing/routes'
import { routes as catalog } from '@/features/catalog/routes'
import { routes as dashboard } from '@/features/dashboard/routes'
import { routes as inventory } from '@/features/inventory/routes'
import { routes as notifications } from '@/features/notifications/routes'
import { routes as parties } from '@/features/parties/routes'
import { routes as payments } from '@/features/payments/routes'
import { routes as platform } from '@/features/platform/routes'
import { routes as pos } from '@/features/pos/routes'
import { routes as purchases } from '@/features/purchases/routes'
import { routes as reports } from '@/features/reports/routes'
import { routes as sales } from '@/features/sales/routes'
import { routes as settings } from '@/features/settings/routes'
import { routes as system } from '@/features/system/routes'
import { GuestOnly, RequireSession, RequireTenant, RouteAccess } from './guards'
import { AppLayout, FullscreenLayout, PublicLayout } from './layout/AppLayout'
import { NotFoundPage, RouteErrorPage } from './pages/StatusPages'
import { RootLayout } from './RootLayout'
import type { FeatureRoutes, KadaiRoute } from './route-types'

/** Every feature module, in navigation order. */
export const FEATURES: Record<string, FeatureRoutes> = {
  auth,
  dashboard,
  pos,
  sales,
  catalog,
  inventory,
  purchases,
  parties,
  payments,
  accounting,
  reports,
  notifications,
  settings,
  billing,
  system,
  platform,
}

function collect(group: keyof FeatureRoutes): KadaiRoute[] {
  return Object.values(FEATURES).flatMap((f) => f[group] ?? [])
}

export function buildRoutes(): RouteObject[] {
  return [
    {
      element: <RootLayout />,
      errorElement: <RouteErrorPage />,
      children: [
        { element: <PublicLayout />, children: collect('public') },
        { element: <GuestOnly />, children: collect('guest') },
        {
          element: <RequireSession />,
          children: [
            ...collect('session'),
            {
              element: <AppLayout />,
              children: [{ element: <RouteAccess />, children: collect('admin') }],
            },
            {
              element: <RequireTenant />,
              children: [
                {
                  element: <FullscreenLayout />,
                  children: [{ element: <RouteAccess />, children: collect('fullscreen') }],
                },
                {
                  element: <AppLayout />,
                  children: [
                    { element: <RouteAccess />, children: collect('app') },
                    { path: '*', element: <NotFoundPage /> },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ]
}
