/**
 * Status of THIS browser as a trusted counter: registered (which store / counter, since when,
 * with "forget") or not yet (explains what registering gives and offers it).
 */
import { Laptop, MonitorCheck, MonitorSmartphone } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge, Button, useConfirm } from '@/components/ui'
import { clearDeviceCredentials, useMe, type DeviceCredentials } from '@/lib/auth'
import { formatDate } from '@/lib/format'
import { localizedName } from '@/lib/i18n'

export function ThisComputerCard({
  credentials,
  onRegister,
  onForgotten,
  canRegister,
}: {
  credentials: DeviceCredentials | null
  onRegister: () => void
  onForgotten: () => void
  canRegister: boolean
}) {
  const { t } = useTranslation('settings')
  const me = useMe()
  const confirm = useConfirm()
  const mine = credentials && me && credentials.tenant_id === me.tenant.id ? credentials : null
  const otherBusiness = credentials !== null && mine === null

  if (mine) {
    const store = me?.stores.find((s) => s.id === mine.store_id)
    const register = me?.registers.find((r) => r.id === mine.register_id)
    return (
      <section className="flex flex-col gap-4 rounded-xl border border-success/30 bg-success-soft/50 p-4 sm:flex-row sm:items-center sm:p-5">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-success text-success-foreground">
          <MonitorCheck className="size-6" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-semibold">{t('devices.this_registered')}</h2>
            <Badge tone="success" size="sm">
              {mine.name}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {register
              ? t('devices.this_counter', {
                  register: register.name,
                  code: register.code,
                  store: store ? localizedName(store.name, store.name_ta) : '',
                })
              : t('devices.this_store_only', {
                  store: store ? localizedName(store.name, store.name_ta) : '',
                })}{' '}
            {mine.registered_at
              ? t('devices.this_since', { date: formatDate(mine.registered_at) })
              : null}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            void confirm({
              title: t('devices.forget_title'),
              description: t('devices.forget_description'),
              confirmLabel: t('devices.forget_action'),
              tone: 'danger',
            }).then((ok) => {
              if (!ok) return
              clearDeviceCredentials()
              onForgotten()
            })
          }
        >
          {t('devices.forget_action')}
        </Button>
      </section>
    )
  }

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-dashed border-primary/40 bg-primary-soft/40 p-4 sm:flex-row sm:items-center sm:p-5">
      <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
        <Laptop className="size-6" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="font-semibold">{t('devices.this_not_registered')}</h2>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          {otherBusiness ? t('devices.this_other_business') : t('devices.this_benefits')}
        </p>
      </div>
      {canRegister ? (
        <Button
          leftIcon={<MonitorSmartphone />}
          onClick={onRegister}
          className="self-start sm:self-center"
        >
          {t('devices.register_action')}
        </Button>
      ) : null}
    </section>
  )
}
