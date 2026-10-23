/**
 * Print / download actions of a book or statement: "Print" (A4 through lib/print) and
 * "Download CSV" (the same route with ?format=csv — the server streams the whole filtered range
 * and audits the export; the route's own read permission is all it needs).
 */
import { Download, Printer } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, notify } from '@/components/ui'

export function ExportMenu({
  onPrint,
  onCsv,
  disabled,
}: {
  onPrint?: () => void | Promise<void>
  onCsv?: () => Promise<unknown>
  disabled?: boolean
}) {
  const { t } = useTranslation(['accounting', 'common'])
  const [busy, setBusy] = useState<'print' | 'csv' | null>(null)
  const run = async (kind: 'print' | 'csv', work: () => unknown): Promise<void> => {
    setBusy(kind)
    try {
      await work()
    } catch (error) {
      notify.error(error)
    } finally {
      setBusy(null)
    }
  }
  return (
    <>
      {onPrint ? (
        <Button
          variant="outline"
          leftIcon={<Printer />}
          disabled={disabled}
          loading={busy === 'print'}
          onClick={() => void run('print', onPrint)}
        >
          {t('common:actions.print')}
        </Button>
      ) : null}
      {onCsv ? (
        <Button
          variant="outline"
          leftIcon={<Download />}
          disabled={disabled}
          loading={busy === 'csv'}
          onClick={() => void run('csv', onCsv)}
        >
          {t('common:actions.export_csv')}
        </Button>
      ) : null}
    </>
  )
}
