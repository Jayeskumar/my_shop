import {
  Building2,
  KeyRound,
  LogOut,
  Monitor,
  Moon,
  Sun,
  UserCircle2,
  UserRoundCog,
  Users,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import {
  Avatar,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  notify,
} from '@/components/ui'
import { ChangePasswordDialog } from '@/features/auth/components/ChangePasswordDialog'
import { PinSwitchDialog } from '@/features/auth/components/PinSwitchDialog'
import { ProfileDialog } from '@/features/auth/components/ProfileDialog'
import { getDeviceCredentials, logout, useAuth } from '@/lib/auth'
import { getLanguage } from '@/lib/i18n'
import { setThemePreference, useThemePreference, type ThemePreference } from '@/lib/theme'

export function UserMenu() {
  const { t } = useTranslation(['nav', 'common', 'auth'])
  const navigate = useNavigate()
  const session = useAuth((s) => s.session)
  const me = useAuth((s) => s.me)
  const theme = useThemePreference()
  const [dialog, setDialog] = useState<'profile' | 'password' | 'pin' | null>(null)
  const user = me?.user ?? session?.user
  if (!user) return null
  const memberships = session?.memberships ?? []
  const hasDevice = getDeviceCredentials() !== null && Boolean(me)
  const business = me
    ? getLanguage() === 'ta' && me.tenant.name_ta
      ? me.tenant.name_ta
      : me.tenant.name
    : null

  const signOut = async (all: boolean): Promise<void> => {
    await logout({ all })
    notify.info(t('auth:logout.done'))
    void navigate('/login', { replace: true })
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          className="flex items-center gap-2 rounded-full p-0.5 pe-2 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring sm:rounded-lg"
          aria-label={t('shell.account')}
        >
          <Avatar name={user.full_name} size="sm" />
          <span className="hidden max-w-36 flex-col text-start leading-tight xl:flex">
            <span className="truncate text-sm font-semibold">{user.full_name}</span>
            {me ? (
              <span className="truncate text-xs text-muted-foreground">
                {me.membership.role_name}
              </span>
            ) : null}
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel className="flex flex-col gap-0.5 normal-case">
            <span className="text-sm font-semibold text-foreground">{user.full_name}</span>
            {business ? <span className="font-normal">{business}</span> : null}
            {user.is_platform_admin ? (
              <span className="font-normal text-primary">{t('shell.platform_admin')}</span>
            ) : null}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem icon={<UserCircle2 />} onSelect={() => setDialog('profile')}>
            {t('shell.profile')}
          </DropdownMenuItem>
          <DropdownMenuItem icon={<KeyRound />} onSelect={() => setDialog('password')}>
            {t('shell.change_password')}
          </DropdownMenuItem>
          {hasDevice ? (
            <DropdownMenuItem icon={<UserRoundCog />} onSelect={() => setDialog('pin')}>
              {t('shell.switch_user')}
            </DropdownMenuItem>
          ) : null}
          {memberships.length > 1 ? (
            <DropdownMenuItem
              icon={<Building2 />}
              onSelect={() => void navigate('/select-business')}
            >
              {t('shell.switch_business')}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger
              icon={theme === 'dark' ? <Moon /> : theme === 'light' ? <Sun /> : <Monitor />}
            >
              {t('common:theme.label')}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup
                value={theme}
                onValueChange={(v) => setThemePreference(v as ThemePreference)}
              >
                <DropdownMenuRadioItem value="light">
                  {t('common:theme.light')}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="dark">{t('common:theme.dark')}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="system">
                  {t('common:theme.system')}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem icon={<LogOut />} tone="danger" onSelect={() => void signOut(false)}>
            {t('shell.logout')}
          </DropdownMenuItem>
          <DropdownMenuItem icon={<Users />} tone="danger" onSelect={() => void signOut(true)}>
            {t('shell.logout_all')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ProfileDialog
        open={dialog === 'profile'}
        onOpenChange={(o) => setDialog(o ? 'profile' : null)}
      />
      <ChangePasswordDialog
        open={dialog === 'password'}
        onOpenChange={(o) => setDialog(o ? 'password' : null)}
      />
      {hasDevice ? (
        <PinSwitchDialog
          open={dialog === 'pin'}
          onOpenChange={(o) => setDialog(o ? 'pin' : null)}
        />
      ) : null}
    </>
  )
}
