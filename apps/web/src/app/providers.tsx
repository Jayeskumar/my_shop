import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { useEffect, useState, type ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'
import { ConfirmProvider, ErrorBoundary, Toaster, TooltipProvider, notify } from '@/components/ui'
import { bootstrap, onAuthLifecycle } from '@/lib/auth'
import { initI18n } from '@/lib/i18n'
import { createQueryClient } from '@/lib/query'

const i18n = initI18n()

export interface AppProvidersProps {
  children: ReactNode
  /** Tests pass their own client (no retries). */
  queryClient?: QueryClient
  /** Restore the session on mount (default true). */
  bootstrapAuth?: boolean
}

/** Every app-wide provider: i18n, TanStack Query, tooltips, confirm dialogs, toasts, auth boot. */
export function AppProviders({ children, queryClient, bootstrapAuth = true }: AppProvidersProps) {
  const [client] = useState(
    () => queryClient ?? createQueryClient({ onError: (error) => notify.error(error) }),
  )

  useEffect(() => {
    // Server state of one business must never be shown in another (or after sign-out).
    return onAuthLifecycle((event) => {
      if (event === 'signed_out' || event === 'tenant_changed') client.clear()
    })
  }, [client])

  useEffect(() => {
    if (bootstrapAuth) void bootstrap()
  }, [bootstrapAuth])

  return (
    <ErrorBoundary>
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={client}>
          <TooltipProvider delayDuration={300}>
            <ConfirmProvider>
              {children}
              <Toaster />
            </ConfirmProvider>
          </TooltipProvider>
        </QueryClientProvider>
      </I18nextProvider>
    </ErrorBoundary>
  )
}
