/**
 * Cashier switch on a trusted counter (ARCHITECTURE.md §7.4): pick your name, enter your PIN on
 * the large keypad → POST /auth/pin-login → the session switches to that cashier (bound to the
 * device's register). Exported for the POS screen; also available from the user menu.
 */
import { ArrowLeft, MonitorX } from 'lucide-react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PinUser } from '@kadai/shared/api/auth'
import { Avatar, Button, Dialog, EmptyState, Skeleton, notify } from '@/components/ui'
import { isApiError } from '@/lib/api'
import { getDeviceCredentials, pinLogin, type AuthStatus } from '@/lib/auth'
import { describeError } from '@/lib/errors'
import { localizedName } from '@/lib/i18n'
import { usePinUsers } from '../api'
import { PinPad } from './PinPad'

export interface PinSwitchDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after a successful switch. */
  onSwitched?: (status: AuthStatus, user: PinUser) => void
}

export function PinSwitchDialog({ open, onOpenChange, onSwitched }: PinSwitchDialogProps) {
  const { t } = useTranslation(['auth', 'common'])
  const device = getDeviceCredentials()
  const users = usePinUsers(open)
  const [selected, setSelected] = useState<PinUser | null>(null)
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reset = (): void => {
    setSelected(null)
    setPin('')
    setError(null)
  }

  const submit = useCallback(async () => {
    if (!selected || pin.length < 4 || busy) return
    setBusy(true)
    setError(null)
    try {
      const status = await pinLogin({ user_id: selected.user_id, pin })
      notify.success(t('pin.switched', { name: selected.full_name }))
      onSwitched?.(status, selected)
      reset()
      onOpenChange(false)
    } catch (e) {
      setPin('')
      setError(describeError(e).title)
      if (isApiError(e) && e.code === 'DEVICE_NOT_TRUSTED') void users.refetch()
    } finally {
      setBusy(false)
    }
  }, [selected, pin, busy, onSwitched, onOpenChange, t, users])

  const notTrusted =
    !device ||
    (isApiError(users.error) &&
      (users.error.code === 'DEVICE_NOT_TRUSTED' || users.error.status === 403))

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset()
        onOpenChange(o)
      }}
      title={selected ? t('pin.enter_pin', { name: selected.full_name }) : t('pin.title')}
      description={selected ? undefined : t('pin.choose_user')}
      size="md"
    >
      {notTrusted ? (
        <EmptyState compact icon={<MonitorX />} title={t('pin.not_trusted')} />
      ) : selected ? (
        <div className="flex flex-col items-center gap-4 pb-4">
          <Avatar name={selected.full_name} size="lg" />
          <p className="text-sm text-muted-foreground">
            {localizedName(selected.role_name, selected.role_name_ta)}
          </p>
          <PinPad
            value={pin}
            onChange={(v) => {
              setPin(v)
              setError(null)
            }}
            onSubmit={() => void submit()}
            disabled={busy}
            error={Boolean(error)}
          />
          {error ? (
            <p role="alert" className="text-sm font-medium text-danger">
              {error}
            </p>
          ) : null}
          <div className="flex w-full max-w-xs gap-2">
            <Button
              variant="outline"
              size="lg"
              className="flex-1"
              onClick={reset}
              leftIcon={<ArrowLeft />}
              disabled={busy}
            >
              {t('pin.back')}
            </Button>
            <Button
              size="lg"
              className="flex-1"
              disabled={pin.length < 4}
              loading={busy}
              onClick={() => void submit()}
            >
              {t('pin.submit')}
            </Button>
          </div>
        </div>
      ) : users.isLoading ? (
        <div className="grid grid-cols-2 gap-3 pb-4 sm:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
      ) : users.error ? (
        <EmptyState
          compact
          title={describeError(users.error).title}
          action={
            <Button variant="outline" onClick={() => void users.refetch()}>
              {t('common:actions.retry')}
            </Button>
          }
        />
      ) : (users.data ?? []).length === 0 ? (
        <EmptyState compact title={t('pin.no_users')} />
      ) : (
        <ul className="grid grid-cols-2 gap-3 pb-4 sm:grid-cols-3">
          {(users.data ?? []).map((u) => (
            <li key={u.user_id}>
              <button
                type="button"
                onClick={() => setSelected(u)}
                className="flex h-28 w-full flex-col items-center justify-center gap-2 rounded-xl border border-border bg-surface p-3 text-center shadow-card transition-colors hover:border-primary hover:bg-primary-soft/50 focus-visible:outline-2 focus-visible:outline-ring"
              >
                <Avatar name={u.full_name} size="lg" />
                <span className="line-clamp-1 text-sm font-semibold">{u.full_name}</span>
                <span className="line-clamp-1 text-xs text-muted-foreground">
                  {localizedName(u.role_name, u.role_name_ta)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  )
}
