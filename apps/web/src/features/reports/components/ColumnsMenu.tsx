/** "Columns" menu of the report viewer: show / hide optional columns (remembered per report). */
import type { ReportColumnDef } from '@kadai/shared/api/reports'
import { Columns3 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui'
import { pick, useLang } from '../lib/labels'

export interface ColumnsMenuProps {
  columns: readonly ReportColumnDef[]
  isShown: (column: ReportColumnDef) => boolean
  onToggle: (column: ReportColumnDef, shown: boolean) => void
  onReset: () => void
  compact?: boolean
}

export function ColumnsMenu({ columns, isShown, onToggle, onReset, compact }: ColumnsMenuProps) {
  const { t } = useTranslation('reports')
  const lng = useLang()
  // The first column identifies the row and always stays.
  const optional = columns.slice(1)
  if (!optional.length) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" leftIcon={<Columns3 />} aria-label={t('viewer.columns')}>
          {compact ? null : t('viewer.columns')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[70vh] w-64 overflow-y-auto">
        <DropdownMenuLabel>{t('viewer.columns_hint')}</DropdownMenuLabel>
        {optional.map((c) => (
          <DropdownMenuCheckboxItem
            key={c.key}
            checked={isShown(c)}
            onCheckedChange={(v) => onToggle(c, v === true)}
            onSelect={(e) => e.preventDefault()}
          >
            {pick(c.label, lng)}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onReset}>{t('viewer.columns_reset')}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
