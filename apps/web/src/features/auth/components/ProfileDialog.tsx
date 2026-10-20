import { useTranslation } from 'react-i18next'
import { Avatar, Dialog } from '@/components/ui'
import { useAuth } from '@/lib/auth'
import { formatPhone } from '@/lib/format'
import { getLanguage } from '@/lib/i18n'

export function ProfileDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation(['auth', 'common'])
  const session = useAuth((s) => s.session)
  const me = useAuth((s) => s.me)
  const user = me?.user ?? session?.user
  if (!user) return null
  const business = me ? (getLanguage() === 'ta' && me.tenant.name_ta ? me.tenant.name_ta : me.tenant.name) : null
  const rows: [string, string | null][] = [
    [t('profile.phone'), user.phone ? formatPhone(user.phone, true) : null],
    [t('profile.email'), user.email],
    [t('profile.role'), me?.membership.role_name ?? null],
    [t('profile.business'), business],
  ]
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t('profile.title')} size="sm">
      <div className="flex flex-col items-center gap-2 pb-4 pt-1">
        <Avatar name={user.full_name} size="xl" />
        <p className="text-lg font-semibold">{user.full_name}</p>
      </div>
      <dl className="grid gap-3 pb-4">
        {rows.map(([label, value]) =>
          value ? (
            <div key={label} className="flex items-center justify-between gap-4 border-b border-border pb-2 text-sm last:border-0">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="text-end font-medium">{value}</dd>
            </div>
          ) : null,
        )}
        <div className="pt-2 text-center text-xs text-muted-foreground">{t('common:app.version', { version: __APP_VERSION__ })}</div>
      </dl>
    </Dialog>
  )
}
