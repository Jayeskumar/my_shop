/** PageHeader of a settings screen with the "Settings ›" breadcrumb. */
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { PageHeader } from '@/components/ui'

export function SettingsPageHeader({
  title,
  description,
  actions,
  meta,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  meta?: ReactNode
}) {
  const { t } = useTranslation('nav')
  return (
    <PageHeader
      title={title}
      description={description}
      actions={actions}
      meta={meta}
      breadcrumbs={[{ label: t('titles.settings'), to: '/settings' }, { label: title }]}
    />
  )
}
