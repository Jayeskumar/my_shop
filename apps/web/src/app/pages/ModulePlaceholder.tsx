import { Construction } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation } from 'react-router'
import { Button, EmptyState, PageHeader } from '@/components/ui'
import { translate } from '@/lib/i18n'
import { useInShell } from '../layout/shell-context'
import { useCurrentHandle } from '../route-handles'

/**
 * Placeholder page for routes whose module UI is not built yet. Module agents replace the
 * route's `Component` with their page (keep the path and handle).
 */
export default function ModulePlaceholder() {
  const { t } = useTranslation()
  const handle = useCurrentHandle()
  const { pathname } = useLocation()
  const title = handle ? translate(handle.title) : ''
  // Fullscreen (POS) and public routes have no shell padding of their own.
  const inShell = useInShell()
  return (
    <div className={inShell ? undefined : 'mx-auto w-full max-w-5xl px-4 py-5 sm:px-6 lg:px-8'}>
      <PageHeader
        title={title}
        breadcrumbs={
          handle?.parent
            ? [{ label: translate(handle.parent.title), to: handle.parent.to }, { label: title }]
            : undefined
        }
      />
      <div className="rounded-xl border border-dashed border-border bg-surface">
        <EmptyState
          icon={<Construction />}
          title={t('placeholder.title')}
          description={t('placeholder.description')}
          action={
            pathname === '/' ? undefined : (
              <Button asChild variant="outline">
                <Link to="/">{t('actions.go_home')}</Link>
              </Button>
            )
          }
        />
      </div>
    </div>
  )
}
