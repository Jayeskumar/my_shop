/**
 * Confirm dialog with a required reason (cancelling a posted bill, a purchase order or a debit
 * note). The reason is kept on the document and in the audit log.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ConfirmDialog, FormField } from '@/components/ui'
import { Textarea } from '@/components/ui/textarea'

export interface ReasonDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: ReactNode
  confirmLabel: string
  /** A reason is optional (purchase order cancel / close); default required. */
  optional?: boolean
  tone?: 'danger' | 'primary'
  /** Called with the trimmed reason; reject to keep the dialog open. */
  onConfirm: (reason: string) => Promise<unknown>
}

export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  optional = false,
  tone = 'danger',
  onConfirm,
}: ReasonDialogProps) {
  const { t } = useTranslation('purchases')
  const [reason, setReason] = useState('')
  useEffect(() => {
    if (open) setReason('')
  }, [open])
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      tone={tone}
      title={title}
      description={description}
      confirmLabel={confirmLabel}
      confirmDisabled={!optional && reason.trim().length === 0}
      onConfirm={() => onConfirm(reason.trim())}
    >
      <FormField
        label={t('cancel.reason')}
        required={!optional}
        optional={optional}
        hint={t('cancel.reason_hint')}
      >
        <Textarea
          rows={3}
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t('cancel.reason_placeholder')}
        />
      </FormField>
    </ConfirmDialog>
  )
}
