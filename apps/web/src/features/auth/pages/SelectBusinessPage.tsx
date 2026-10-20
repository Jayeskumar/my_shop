/** Choose which business to open when the account belongs to several (POST /auth/select-tenant). */
import { ChevronRight, LogOut, Store } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router'
import { getBusinessType } from '@kadai/shared/verticals'
import { safeNext } from '@/app/guards'
import { Button, EmptyState, Spinner, notify } from '@/components/ui'
import { logout, selectTenant, useAuth } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { getLanguage } from '@/lib/i18n'
import { AuthLayout } from '../components/AuthLayout'

export default function SelectBusinessPage() {
  const { t } = useTranslation(['auth', 'errors'])
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const session = useAuth((s) => s.session)
  const memberships = session?.memberships ?? []
  const currentTenant = useAuth((s) => s.me?.tenant.id ?? null)
  const [pending, setPending] = useState<string | null>(null)
  const ta = getLanguage() === 'ta'

  const open = async (tenantId: string): Promise<void> => {
    if (pending) return
    setPending(tenantId)
    try {
      await selectTenant(tenantId)
      void navigate(safeNext(params.get('next')), { replace: true })
    } catch (error) {
      notify.error(error)
    } finally {
      setPending(null)
    }
  }

  return (
    <AuthLayout
      title={t('select_business.title')}
      subtitle={memberships.length > 0 ? t('select_business.subtitle') : undefined}
      footer={
        <Button
          variant="ghost"
          leftIcon={<LogOut />}
          onClick={async () => {
            await logout()
            void navigate('/login', { replace: true })
          }}
        >
          {t('select_business.logout')}
        </Button>
      }
    >
      {memberships.length === 0 ? (
        <EmptyState compact title={t('errors:pages.no_business_title')} description={t('errors:pages.no_business_description')} />
      ) : (
        <ul className="grid gap-3">
          {memberships.map((m) => {
            const type = getBusinessType(m.business_type)
            const isCurrent = m.tenant_id === currentTenant
            return (
              <li key={m.tenant_id}>
                <button
                  type="button"
                  disabled={pending !== null}
                  onClick={() => void open(m.tenant_id)}
                  className={cn(
                    'flex w-full items-center gap-4 rounded-xl border bg-surface p-4 text-start shadow-card transition-colors',
                    'hover:border-primary hover:bg-primary-soft/40 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-70',
                    isCurrent ? 'border-primary' : 'border-border',
                  )}
                >
                  <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary-soft-foreground">
                    <Store className="size-6" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-base font-semibold">{m.tenant_name}</span>
                    <span className="truncate text-sm text-muted-foreground">
                      {ta ? type.name_ta : type.name_en} · {t('select_business.role', { role: m.role_code })}
                    </span>
                  </span>
                  {pending === m.tenant_id ? (
                    <Spinner size="sm" label="" />
                  ) : (
                    <ChevronRight className="size-5 text-muted-foreground rtl:rotate-180" />
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </AuthLayout>
  )
}
