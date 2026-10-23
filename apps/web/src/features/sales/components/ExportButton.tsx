/**
 * CSV export of a list with its current filters (`?format=csv` on the same catalogued list
 * route, via downloadRoute). Shown only to users who may export (data.export or reports.read —
 * the server checks the same and audits the export).
 */
import { Download } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, notify } from '@/components/ui'
import { useCan } from '@/lib/auth'

export function ExportButton({ download }: { download: () => Promise<string> }) {
  const { t } = useTranslation(['sales', 'common'])
  const canExport = useCan(['data.export', 'reports.read'])
  const [busy, setBusy] = useState(false)
  if (!canExport) return null

  const run = async (): Promise<void> => {
    setBusy(true)
    try {
      const name = await download()
      notify.success(t('export.done', { file: name }))
    } catch (error) {
      notify.error(error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button
      variant="outline"
      leftIcon={<Download />}
      loading={busy}
      onClick={() => void run()}
      aria-label={t('common:actions.export_csv')}
    >
      <span className="hidden sm:inline">{t('common:actions.export_csv')}</span>
    </Button>
  )
}
