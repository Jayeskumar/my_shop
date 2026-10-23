/**
 * Users (/settings/users): the shop's team — role, store access, status, PIN, last sign-in —
 * with search, role / status / store filters, sorting and paging (kept in the URL). Invite by
 * mobile number (temporary password shown once), edit role and stores, disable / enable, reset
 * PIN or password. Actions the caller may not take (on themselves, on owners when not an owner)
 * are hidden or disabled.
 */
import {
  Ban,
  KeyRound,
  MoreVertical,
  Pencil,
  ShieldCheck,
  UserCheck,
  UserPlus,
  Users as UsersIcon,
} from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Member, MemberCreateResult, MemberListQuery } from '@kadai/shared/api/identity'
import { MEMBERSHIP_STATUS_LABELS } from '@kadai/shared/api/identity'
import type { MembershipStatus } from '@kadai/shared/enums'
import {
  Avatar,
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  type DataTableColumn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  FormField,
  IconButton,
  Input,
  Kbd,
  SearchInput,
  Select,
  notify,
} from '@/components/ui'
import { useAuth } from '@/lib/auth'
import { formatDateTime, formatPhone, formatRelative } from '@/lib/format'
import { useHotkeys } from '@/lib/hotkeys'
import { getLanguage, localizedName } from '@/lib/i18n'
import { useDisableMember, useEnableMember, useMembers, useRoles } from '../api'
import { MemberFormDialog } from '../components/MemberFormDialog'
import { ResetPasswordDialog, ResetPinDialog } from '../components/MemberSecurityDialogs'
import { SettingsPageHeader } from '../components/SettingsPageHeader'
import { TemporaryPasswordDialog } from '../components/TemporaryPasswordDialog'
import { UpgradeHint } from '../components/UpgradeHint'
import { useListParams } from '../lib/list-params'
import { roleLabel, storeCodes } from '../lib/members'
import { notifySettingsError, planBlockOf, type PlanBlock } from '../lib/messages'

const PAGE_SIZE = 50
const ALL = 'all'
const SORT_RE = /^-?(full_name|last_login_at|created_at)$/

const STATUS_TONE: Record<MembershipStatus, 'success' | 'warning' | 'neutral'> = {
  active: 'success',
  invited: 'warning',
  disabled: 'neutral',
}

type Dialogs =
  | { kind: 'none' }
  | { kind: 'invite' }
  | { kind: 'edit'; member: Member }
  | { kind: 'pin'; member: Member }
  | { kind: 'password'; member: Member }
  | { kind: 'disable'; member: Member }

export default function UsersPage() {
  const { t } = useTranslation(['settings', 'common', 'nav'])
  const me = useAuth((s) => s.me)
  const iAmOwner = me?.membership.role_code === 'owner'
  const stores = useMemo(() => me?.stores ?? [], [me])
  const searchRef = useRef<HTMLInputElement>(null)
  const [state, setState] = useListParams({
    q: '',
    role: ALL,
    status: ALL,
    store: ALL,
    sort: 'full_name',
  })
  const sort = SORT_RE.test(state.sort) ? state.sort : 'full_name'
  const query: MemberListQuery = {
    limit: PAGE_SIZE,
    offset: state.offset,
    sort,
    ...(state.q ? { q: state.q } : {}),
    ...(state.role !== ALL ? { role_id: state.role } : {}),
    ...(state.status !== ALL ? { status: state.status as MembershipStatus } : {}),
    ...(state.store !== ALL ? { store_id: state.store } : {}),
  }
  const list = useMembers(query)
  const roles = useRoles({ limit: 200 })
  // Seats in use (plan limit `users`): active + invited members.
  const activeCount = useMembers({ limit: 1, status: 'active' }).data?.page.total
  const invitedCount = useMembers({ limit: 1, status: 'invited' }).data?.page.total
  const disable = useDisableMember()
  const enable = useEnableMember()
  const [dialog, setDialog] = useState<Dialogs>({ kind: 'none' })
  // Kept while dialogs animate closed.
  const [lastMember, setLastMember] = useState<Member | null>(null)
  const [formMember, setFormMember] = useState<Member | null>(null)
  const [reason, setReason] = useState('')
  const [tempPassword, setTempPassword] = useState<{
    password: string
    name: string
    phone: string | null
  } | null>(null)
  const [enableBlock, setEnableBlock] = useState<PlanBlock | null>(null)

  const limit = me?.entitlements.limits.users ?? null
  const seats =
    activeCount !== undefined && invitedCount !== undefined ? activeCount + invitedCount : null
  const seatBlock: PlanBlock | null =
    limit !== null && seats !== null && seats >= limit
      ? { kind: 'limit', metric: 'users', limit }
      : null

  const open = (d: Dialogs): void => {
    if ('member' in d) setLastMember(d.member)
    if (d.kind === 'invite') setFormMember(null)
    if (d.kind === 'edit') setFormMember(d.member)
    setDialog(d)
  }
  const close = (): void => setDialog({ kind: 'none' })

  useHotkeys({
    'alt+n': () => {
      if (!seatBlock) open({ kind: 'invite' })
    },
    '/': () => searchRef.current?.focus(),
  })

  const managesOwner = (m: Member): boolean => m.is_owner && !iAmOwner

  const doEnable = async (m: Member): Promise<void> => {
    try {
      await enable.mutateAsync({ params: { id: m.id } })
      notify.success(t('users.enabled', { name: m.full_name }))
    } catch (error) {
      const plan = planBlockOf(error)
      if (plan) {
        setEnableBlock(plan)
        return
      }
      notifySettingsError(error)
    }
  }

  const renderMember = (m: Member) => (
    <div className="flex min-w-0 items-center gap-3">
      <Avatar name={m.full_name} size="sm" />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate font-medium">{m.full_name}</span>
          {m.is_self ? (
            <Badge size="sm" tone="primary">
              {t('users.you')}
            </Badge>
          ) : null}
        </div>
        <div className="truncate text-xs text-muted-foreground tabular-nums">
          {formatPhone(m.phone) || m.email || '—'}
        </div>
      </div>
    </div>
  )

  const renderRole = (m: Member) => (
    <div className="min-w-0">
      <span className="inline-flex items-center gap-1.5 text-sm text-foreground">
        {m.is_owner ? <ShieldCheck className="size-3.5 text-accent" aria-hidden /> : null}
        {roleLabel(m.role_name, m.role_name_ta)}
      </span>
      {m.store_ids === null ? (
        <div className="text-xs text-muted-foreground">{t('common:misc.all_stores')}</div>
      ) : (
        <div className="mt-0.5 flex flex-wrap gap-1">
          {storeCodes(m.store_ids, stores).map((code) => (
            <Badge key={code} size="sm" appearance="outline" className="font-mono">
              {code}
            </Badge>
          ))}
        </div>
      )}
    </div>
  )

  const renderStatus = (m: Member) => {
    const locked = m.pin_locked_until !== null && new Date(m.pin_locked_until) > new Date()
    return (
      <span className="flex flex-wrap items-center gap-1">
        <Badge size="sm" tone={STATUS_TONE[m.status]} dot>
          {MEMBERSHIP_STATUS_LABELS[m.status][getLanguage()]}
        </Badge>
        {locked ? (
          <Badge size="sm" tone="danger">
            {t('users.pin_locked')}
          </Badge>
        ) : m.has_pin ? (
          <Badge size="sm" tone="info" appearance="outline">
            {t('users.pin_badge')}
          </Badge>
        ) : null}
      </span>
    )
  }

  const renderLastLogin = (m: Member) =>
    m.last_login_at ? (
      <span className="text-sm" title={formatDateTime(m.last_login_at)}>
        {formatRelative(m.last_login_at)}
      </span>
    ) : (
      <span className="text-sm text-muted-foreground">{t('users.never_signed_in')}</span>
    )

  const renderActions = (m: Member) => {
    const ownerLocked = managesOwner(m)
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton
            icon={<MoreVertical />}
            label={t('users.actions_for', { name: m.full_name })}
            variant="ghost"
            onClick={(e) => e.stopPropagation()}
            // Enter opens the menu, not the row's edit dialog.
            onKeyDown={(e) => e.stopPropagation()}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
          <DropdownMenuItem
            icon={<Pencil />}
            disabled={ownerLocked}
            onSelect={() => open({ kind: 'edit', member: m })}
          >
            {t('users.action_edit')}
          </DropdownMenuItem>
          <DropdownMenuItem
            icon={<KeyRound />}
            disabled={ownerLocked || m.status === 'disabled'}
            onSelect={() => open({ kind: 'pin', member: m })}
          >
            {t('users.action_pin')}
          </DropdownMenuItem>
          {!m.is_self ? (
            <DropdownMenuItem
              icon={<KeyRound />}
              disabled={ownerLocked || m.status === 'disabled'}
              onSelect={() => open({ kind: 'password', member: m })}
            >
              {t('users.action_password')}
            </DropdownMenuItem>
          ) : null}
          {!m.is_self ? (
            <>
              <DropdownMenuSeparator />
              {m.status === 'disabled' ? (
                <DropdownMenuItem
                  icon={<UserCheck />}
                  disabled={ownerLocked}
                  onSelect={() => void doEnable(m)}
                >
                  {t('users.action_enable')}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  icon={<Ban />}
                  tone="danger"
                  disabled={ownerLocked}
                  onSelect={() => {
                    setReason('')
                    open({ kind: 'disable', member: m })
                  }}
                >
                  {t('users.action_disable')}
                </DropdownMenuItem>
              )}
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  /** Phone card: everything about a member at a glance, actions at the top right. */
  const renderCard = (m: Member) => (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1 space-y-2">
        {renderMember(m)}
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 ps-11">
          {renderRole(m)}
          {renderStatus(m)}
        </div>
        <div className="ps-11 text-xs text-muted-foreground [&_span]:text-xs">
          {t('users.col_last_login')}: {renderLastLogin(m)}
        </div>
      </div>
      <div className="-me-1 -mt-1 shrink-0">{renderActions(m)}</div>
    </div>
  )

  const columns = useMemo<DataTableColumn<Member>[]>(
    () => [
      {
        id: 'full_name',
        accessorKey: 'full_name',
        header: t('users.col_member'),
        enableSorting: true,
        cell: ({ row }) => renderMember(row.original),
      },
      {
        id: 'role',
        header: t('users.col_role_stores'),
        cell: ({ row }) => renderRole(row.original),
      },
      {
        id: 'status',
        header: t('common:fields.status'),
        cell: ({ row }) => renderStatus(row.original),
      },
      {
        id: 'last_login_at',
        accessorKey: 'last_login_at',
        header: t('users.col_last_login'),
        enableSorting: true,
        cell: ({ row }) => renderLastLogin(row.original),
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">{t('common:actions.more')}</span>,
        meta: { align: 'right', className: 'w-12' },
        cell: ({ row }) => renderActions(row.original),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- renderers only read t, stores and the owner flag
    [t, stores, iAmOwner],
  )

  const roleOptions = [
    { value: ALL, label: t('users.filter_all_roles') },
    ...(roles.data?.data ?? []).map((r) => ({ value: r.id, label: roleLabel(r.name, r.name_ta) })),
  ]
  const statusOptions = [
    { value: ALL, label: t('users.filter_all_status') },
    ...(['active', 'invited', 'disabled'] as const).map((s) => ({
      value: s,
      label: MEMBERSHIP_STATUS_LABELS[s][getLanguage()],
    })),
  ]
  const storeOptions = [
    { value: ALL, label: t('common:misc.all_stores') },
    ...stores.map((s) => ({
      value: s.id,
      label: `${s.code} · ${localizedName(s.name, s.name_ta)}`,
    })),
  ]
  const filtered =
    Boolean(state.q) || state.role !== ALL || state.status !== ALL || state.store !== ALL
  const page = list.data?.page

  const onInvited = (result: MemberCreateResult): void => {
    const name = result.member.full_name
    if (result.temporary_password) {
      setTempPassword({ password: result.temporary_password, name, phone: result.member.phone })
    } else if (result.existing_user) {
      notify.success(t('users.invited_existing', { name }))
    } else if (result.otp_sent) {
      notify.success(t('users.invited_otp', { name }))
    } else {
      notify.success(t('users.invited', { name }))
    }
  }

  const member = 'member' in dialog ? dialog.member : lastMember

  return (
    <div className="max-w-6xl">
      <SettingsPageHeader
        title={t('nav:titles.settings_users')}
        description={t('users.description')}
        meta={
          limit !== null && seats !== null ? (
            <span className="text-xs text-muted-foreground">
              {t('users.seats', { used: seats, limit })}
            </span>
          ) : null
        }
        actions={
          <Button
            leftIcon={<UserPlus />}
            onClick={() => open({ kind: 'invite' })}
            disabled={Boolean(seatBlock)}
          >
            {t('users.invite')}
            <Kbd
              combo="alt+n"
              className="ms-1 hidden border-primary-foreground/30 bg-primary-foreground/15 text-primary-foreground lg:inline-flex"
            />
          </Button>
        }
      />
      {seatBlock ? <UpgradeHint block={seatBlock} className="mb-4" /> : null}
      {enableBlock ? <UpgradeHint block={enableBlock} className="mb-4" /> : null}
      <div className="mb-4 grid gap-2 sm:grid-cols-3 2xl:grid-cols-[minmax(0,1fr)_12rem_10rem_12rem]">
        <SearchInput
          ref={searchRef}
          value={state.q}
          onChange={(q) => setState({ q })}
          placeholder={t('users.search_placeholder')}
          aria-label={t('users.search_placeholder')}
          wrapperClassName="sm:col-span-3 2xl:col-span-1"
        />
        <Select
          value={state.role}
          onValueChange={(role) => setState({ role })}
          options={roleOptions}
        />
        <Select
          value={state.status}
          onValueChange={(status) => setState({ status })}
          options={statusOptions}
        />
        {stores.length > 1 ? (
          <Select
            value={state.store}
            onValueChange={(store) => setState({ store })}
            options={storeOptions}
          />
        ) : null}
      </div>
      <DataTable
        label={t('nav:titles.settings_users')}
        columns={columns}
        data={list.data?.data ?? []}
        getRowId={(m) => m.id}
        loading={list.isFetching}
        error={list.error}
        onRetry={() => void list.refetch()}
        sort={sort}
        onSortChange={(s) => setState({ sort: s ?? 'full_name' })}
        onRowClick={(m) => {
          if (!managesOwner(m)) open({ kind: 'edit', member: m })
        }}
        renderCard={renderCard}
        pagination={
          page
            ? {
                offset: page.offset,
                limit: page.limit,
                total: page.total,
                onChange: (next) => setState({ offset: next.offset }),
              }
            : undefined
        }
        empty={
          filtered ? undefined : (
            <EmptyState
              compact
              icon={<UsersIcon />}
              title={t('users.empty_title')}
              description={t('users.empty_description')}
              action={
                <Button leftIcon={<UserPlus />} onClick={() => open({ kind: 'invite' })}>
                  {t('users.invite')}
                </Button>
              }
            />
          )
        }
      />

      <MemberFormDialog
        open={dialog.kind === 'invite' || dialog.kind === 'edit'}
        onOpenChange={(o) => {
          if (!o) close()
        }}
        member={formMember}
        onInvited={onInvited}
      />
      <ResetPinDialog
        open={dialog.kind === 'pin'}
        onOpenChange={(o) => {
          if (!o) close()
        }}
        member={member}
      />
      <ResetPasswordDialog
        open={dialog.kind === 'password'}
        onOpenChange={(o) => {
          if (!o) close()
        }}
        member={member}
        onDone={(res) => {
          if (res.temporary_password && member)
            setTempPassword({
              password: res.temporary_password,
              name: member.full_name,
              phone: member.phone,
            })
        }}
      />
      <ConfirmDialog
        open={dialog.kind === 'disable'}
        onOpenChange={(o) => {
          if (!o) close()
        }}
        tone="danger"
        title={t('users.disable_title', { name: member?.full_name ?? '' })}
        description={t('users.disable_description')}
        confirmLabel={t('users.action_disable')}
        onConfirm={async () => {
          if (!member) return
          try {
            await disable.mutateAsync({
              params: { id: member.id },
              body: { reason: reason.trim() || null },
            })
            notify.success(t('users.disabled', { name: member.full_name }))
          } catch (error) {
            notifySettingsError(error)
            throw error
          }
        }}
      >
        <FormField label={t('users.disable_reason')} optional>
          <Input
            value={reason}
            maxLength={200}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('users.disable_reason_placeholder')}
          />
        </FormField>
      </ConfirmDialog>
      {tempPassword ? (
        <TemporaryPasswordDialog
          open
          onOpenChange={(o) => {
            if (!o) setTempPassword(null)
          }}
          password={tempPassword.password}
          name={tempPassword.name}
          phone={tempPassword.phone}
        />
      ) : null}
    </div>
  )
}
