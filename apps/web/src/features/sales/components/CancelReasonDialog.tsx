/**
 * Destructive confirmation with a reason (cancel an invoice / a credit note): lists what will
 * happen, offers one-tap common reasons, validates the reason with the contract (zReason,
 * 3–500 characters) and shows a server refusal in place.
 */
import { AlertTriangle } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { zReason } from '@kadai/shared/api/common'
import { Button, Dialog, FormField } from '@/components/ui'
import { Textarea } from '@/components/ui/textarea'
import { useValidationText } from '../lib/forms'

export interface CancelReasonDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  /** What cancelling does (stock back, payments reversed…). */
  consequences: readonly ReactNode[]
  quickReasons: readonly string[]
  confirmLabel: ReactNode
  pending: boolean
  /** Server refusal to show in the dialog. */
  error?: string | null
  onConfirm: (reason: string) => void
}

export function CancelReasonDialog(props: CancelReasonDialogProps) {
  return props.open ? <CancelBody {...props} /> : null
}

function CancelBody({
  onOpenChange,
  title,
  description,
  consequences,
  quickReasons,
  confirmLabel,
  pending,
  error,
  onConfirm,
}: CancelReasonDialogProps) {
  const { t } = useTranslation(['sales', 'common'])
  const vt = useValidationText()
  const [reason, setReason] = useState('')
  const [reasonError, setReasonError] = useState<string | null>(null)

  const submit = (): void => {
    const parsed = zReason.safeParse(reason)
    if (!parsed.success) {
      setReasonError(vt(parsed.error.issues[0]?.message) ?? t('validation.reason_required'))
      return
    }
    setReasonError(null)
    onConfirm(parsed.data)
  }

  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      dismissible={!pending}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            {t('cancel.keep')}
          </Button>
          <Button variant="danger" onClick={submit} loading={pending}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <div className="rounded-lg border border-warning/50 bg-warning-soft p-3 text-sm text-warning-soft-foreground">
          <div className="mb-1 flex items-center gap-2 font-semibold">
            <AlertTriangle className="size-4" aria-hidden />
            {t('cancel.what_happens')}
          </div>
          <ul className="list-disc space-y-1 ps-5">
            {consequences.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
        <FormField label={t('cancel.reason')} required error={reasonError}>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            rows={2}
            autoFocus
          />
        </FormField>
        <div className="flex flex-wrap gap-2" aria-label={t('cancel.quick_reasons')}>
          {quickReasons.map((r) => (
            <Button
              key={r}
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setReason(r)}
            >
              {r}
            </Button>
          ))}
        </div>
        {error ? (
          <p
            role="alert"
            className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-soft-foreground"
          >
            {error}
          </p>
        ) : null}
      </form>
    </Dialog>
  )
}
