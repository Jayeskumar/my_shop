/**
 * Shows a generated temporary password ONCE (invite / admin reset): large and easy to read
 * aloud, with copy and "send on WhatsApp". It is never stored or shown again.
 */
import { KeyRound, MessageCircle, TriangleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button, CopyButton, Dialog } from '@/components/ui'
import { formatPhone } from '@/lib/format'
import { whatsappShareUrl } from '../lib/members'

export function TemporaryPasswordDialog({
  open,
  onOpenChange,
  password,
  name,
  phone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  password: string
  name: string
  phone: string | null
}) {
  const { t } = useTranslation(['settings', 'common'])
  const message = t('temp_password.whatsapp_text', {
    name,
    phone: formatPhone(phone),
    password,
    url: typeof location === 'undefined' ? '' : location.origin,
  })
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('temp_password.title')}
      description={t('temp_password.description', { name })}
      dismissible={false}
      footer={
        <>
          {phone ? (
            <Button asChild variant="outline">
              <a href={whatsappShareUrl(phone, message)} target="_blank" rel="noopener noreferrer">
                <MessageCircle />
                {t('temp_password.whatsapp')}
              </a>
            </Button>
          ) : null}
          <Button onClick={() => onOpenChange(false)}>{t('temp_password.done')}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3 rounded-xl border border-primary/30 bg-primary-soft px-4 py-4">
          <KeyRound className="size-5 shrink-0 text-primary" aria-hidden />
          <code
            className="min-w-0 flex-1 break-all font-mono text-2xl font-semibold tracking-wider text-foreground"
            data-testid="temporary-password"
          >
            {password}
          </code>
          <CopyButton value={password} label={t('temp_password.copy')} />
        </div>
        <p className="flex items-start gap-2 text-sm text-warning-soft-foreground">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          {t('temp_password.once')}
        </p>
        {phone ? (
          <p className="text-sm text-muted-foreground">
            {t('temp_password.sign_in_with', { phone: formatPhone(phone) })}
          </p>
        ) : null}
      </div>
    </Dialog>
  )
}
