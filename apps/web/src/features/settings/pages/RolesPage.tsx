/**
 * Roles & permissions (/settings/roles): the built-in roles (read-only — owner, manager,
 * cashier, accountant, inventory clerk, pharmacist) and the shop's custom roles, each with its
 * member count and permission count. Custom roles (plan feature custom_roles) are created from
 * scratch or by copying a role, and edited with the permission matrix.
 */
import { Plus, ShieldCheck, Users } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Role } from '@kadai/shared/api/identity'
import { Badge, Button, EmptyState, Skeleton } from '@/components/ui'
import { useFeature } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { useRoles } from '../api'
import { RoleEditorDialog, type RoleEditorTarget } from '../components/RoleEditorDialog'
import { ReadOnlyNotice } from '../components/SettingsCard'
import { SettingsPageHeader } from '../components/SettingsPageHeader'
import { UpgradeHint } from '../components/UpgradeHint'
import { useBusinessWideEdit } from '../lib/access'
import { roleDescription, roleLabel } from '../lib/members'
import { settingsErrorDisplay } from '../lib/messages'

function RoleCard({ role, onOpen }: { role: Role; onOpen: () => void }) {
  const { t } = useTranslation('settings')
  const primary = roleLabel(role.name, role.name_ta)
  const secondary =
    role.name_ta && role.name_ta !== role.name
      ? primary === role.name
        ? role.name_ta
        : role.name
      : null
  const description = roleDescription(role)
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'flex h-full w-full flex-col gap-3 rounded-xl border border-border bg-surface p-4 text-start shadow-card transition-colors',
        'hover:border-primary/40 hover:bg-surface-2/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'flex size-10 shrink-0 items-center justify-center rounded-lg',
            role.is_system
              ? 'bg-info-soft text-info'
              : 'bg-accent-soft text-accent-soft-foreground',
          )}
        >
          <ShieldCheck className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-semibold leading-snug [overflow-wrap:anywhere]">{primary}</div>
          {secondary ? (
            <div className="truncate text-xs text-muted-foreground">{secondary}</div>
          ) : null}
        </div>
      </div>
      {description ? (
        <p className="line-clamp-2 text-sm text-muted-foreground">{description}</p>
      ) : null}
      <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Users className="size-4" aria-hidden />
          {t('roles.members_count', { count: role.member_count })}
        </span>
        <span>{t('roles.permission_count', { count: role.effective_permissions.length })}</span>
        <Badge size="sm" tone={role.is_system ? 'info' : 'accent'} className="ms-auto">
          {role.is_system ? t('roles.system_badge') : t('roles.custom_badge')}
        </Badge>
      </div>
    </button>
  )
}

export default function RolesPage() {
  const { t } = useTranslation(['settings', 'common', 'nav'])
  const list = useRoles({ limit: 200 })
  const { canEdit, storeScoped } = useBusinessWideEdit('users.manage')
  const customRoles = useFeature('custom_roles')
  const canCreate = canEdit && customRoles
  const [target, setTarget] = useState<RoleEditorTarget | null>(null)
  const [open, setOpen] = useState(false)

  const { system, custom } = useMemo(() => {
    const roles = list.data?.data ?? []
    return {
      system: roles.filter((r) => r.is_system),
      custom: roles.filter((r) => !r.is_system).sort((a, b) => a.name.localeCompare(b.name)),
    }
  }, [list.data])

  const show = (next: RoleEditorTarget): void => {
    setTarget(next)
    setOpen(true)
  }

  const errorPanel = list.error && !list.data ? settingsErrorDisplay(list.error) : null

  return (
    <div className="max-w-6xl">
      <SettingsPageHeader
        title={t('nav:titles.settings_roles')}
        description={t('roles.description')}
        actions={
          canCreate ? (
            <Button leftIcon={<Plus />} onClick={() => show({ kind: 'new', from: null })}>
              {t('roles.new')}
            </Button>
          ) : null
        }
      />
      {storeScoped ? <ReadOnlyNotice>{t('common.store_scoped_readonly')}</ReadOnlyNotice> : null}
      {canEdit && !customRoles ? (
        <UpgradeHint block={{ kind: 'feature', feature: 'custom_roles' }} className="mb-5" />
      ) : null}

      {errorPanel ? (
        <EmptyState
          icon={<ShieldCheck />}
          title={errorPanel.title}
          description={errorPanel.description}
          action={
            <Button variant="outline" onClick={() => void list.refetch()}>
              {t('common:actions.retry')}
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-8">
          <section aria-labelledby="roles-system">
            <h2 id="roles-system" className="mb-1 text-lg font-semibold">
              {t('roles.system_title')}
            </h2>
            <p className="mb-3 text-sm text-muted-foreground">{t('roles.system_hint')}</p>
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {list.isLoading
                ? [0, 1, 2, 3, 4, 5].map((i) => (
                    <li key={i}>
                      <Skeleton className="h-36 rounded-xl" />
                    </li>
                  ))
                : system.map((r) => (
                    <li key={r.id}>
                      <RoleCard role={r} onOpen={() => show({ kind: 'view', role: r })} />
                    </li>
                  ))}
            </ul>
          </section>
          <section aria-labelledby="roles-custom">
            <h2 id="roles-custom" className="mb-1 text-lg font-semibold">
              {t('roles.custom_title')}
            </h2>
            <p className="mb-3 text-sm text-muted-foreground">{t('roles.custom_hint')}</p>
            {!list.isLoading && custom.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border bg-surface">
                <EmptyState
                  compact
                  icon={<ShieldCheck />}
                  title={t('roles.custom_empty_title')}
                  description={t('roles.custom_empty_description')}
                  action={
                    canCreate ? (
                      <Button
                        variant="outline"
                        leftIcon={<Plus />}
                        onClick={() => show({ kind: 'new', from: null })}
                      >
                        {t('roles.new')}
                      </Button>
                    ) : undefined
                  }
                />
              </div>
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {custom.map((r) => (
                  <li key={r.id}>
                    <RoleCard role={r} onOpen={() => show({ kind: 'view', role: r })} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
      <RoleEditorDialog
        open={open}
        onOpenChange={setOpen}
        target={target}
        canEdit={canEdit}
        canCreate={canCreate}
        onCopy={(role) => show({ kind: 'new', from: role })}
      />
    </div>
  )
}
