/**
 * Confirm dialog with a required reason (cancelling a posted adjustment or a transfer). The
 * reason is kept on the document and in the audit log.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ConfirmDialog, FormField } from '@/components/ui'
import { Textarea } from '@/components/ui/textarea'

export interface ReasonDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel: string
  /** Called with the trimmed reason; reject to keep the dialog open. */
  onConfirm: (reason: string) => Promise<unknown>
}

export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
}: ReasonDialogProps) {
  const { t } = useTranslation('inventory')
  const [reason, setReason] = useState('')
  useEffect(() => {
    if (open) setReason('')
  }, [open])
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      tone="danger"
      title={title}
      description={description}
      confirmLabel={confirmLabel}
      confirmDisabled={reason.trim().length === 0}
      onConfirm={() => onConfirm(reason.trim())}
    >
      <FormField label={t('cancel.reason')} required hint={t('cancel.reason_hint')}>
        <Textarea
          rows={3}
          maxLength={200}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t('cancel.reason_placeholder')}
        />
      </FormField>
    </ConfirmDialog>
  )
}
