/**
 * Test helpers: render the real route tree (guards, layouts, placeholders) at a path inside the
 * app providers, and sign in through the real auth store with MSW-served session + /me.
 */
import { QueryClient } from '@tanstack/react-query'
import { render, type RenderResult } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import type { ReactElement } from 'react'
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router'
import type { MeResponse, SessionResponse } from '@kadai/shared/api/auth'
import { AppProviders } from '@/app/providers'
import { buildRoutes } from '@/app/routes'
import { acceptSession, bootstrap } from '@/lib/auth'
import { makeMe, makeSession } from './fixtures'
import { apiPath, server } from './msw'

export function testQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  })
}

export function renderApp(
  path: string,
): RenderResult & { router: ReturnType<typeof createMemoryRouter> } {
  const router = createMemoryRouter(buildRoutes(), { initialEntries: [path] })
  const result = render(
    <AppProviders queryClient={testQueryClient()} bootstrapAuth={false}>
      <RouterProvider router={router} />
    </AppProviders>,
  )
  return Object.assign(result, { router })
}

/** Renders a component with providers and a memory router (no route tree). */
export function renderWithProviders(
  ui: ReactElement,
  { path = '/' }: { path?: string } = {},
): RenderResult {
  return render(
    <AppProviders queryClient={testQueryClient()} bootstrapAuth={false}>
      <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
    </AppProviders>,
  )
}

/** Signs in as an owner (or with the given profile) through the real auth store. */
export async function signIn(
  me: MeResponse = makeMe(),
  session: SessionResponse = makeSession(),
): Promise<void> {
  server.use(http.get(apiPath('/me'), () => HttpResponse.json({ data: me })))
  await acceptSession(session)
}

/** Boots the auth store as signed out (default MSW refresh handler answers 401). */
export async function signOutState(): Promise<void> {
  await bootstrap()
}
