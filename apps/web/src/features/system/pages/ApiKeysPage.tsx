/**
 * API keys (/settings/api-keys, permission settings.manage + feature api_access):
 *  - List active / expired / revoked keys with search
 *  - Create a new API key (subset of the caller's permissions) and show the raw key once
 *  - Revoke an active key with confirmation
 */
import type { Permission } from '@kadai/shared'
import { type ApiKey, platformRoutes } from '@kadai/shared/api/platform'
import { Copy, KeyRound, Plus, ShieldAlert, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Badge,
  Button,
  Card,
  CardContent,
  Checkbox,
  Dialog,
  EmptyState,
  Input,
  PageHeader,
  SearchInput,
  Skeleton,
  notify,
  useConfirm,
} from '@/components/ui'
import { useAuth } from '@/lib/auth'
import { describeError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { useRouteMutation, useRouteQuery } from '@/lib/query'

const STATE_TONE = {
  active: 'success',
  expired: 'warning',
  revoked: 'neutral',
} as const

export default function ApiKeysPage() {
  const { t } = useTranslation(['system', 'common', 'nav'])
  const confirm = useConfirm()
  const heldSet = useAuth((s) => s.permissions)
  const heldPermissions = useMemo(() => [...heldSet].sort(), [heldSet])

  const [q, setQ] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [selectedPerms, setSelectedPerms] = useState<Set<Permission>>(
    () => new Set(['catalog.read', 'sales.read', 'inventory.read'] as Permission[]),
  )
  const [createdKey, setCreatedKey] = useState<string | null>(null)

  const list = useRouteQuery(platformRoutes.listApiKeys, {
    query: { limit: 100, offset: 0, ...(q ? { q } : {}) },
  })
  const createMutation = useRouteMutation(platformRoutes.createApiKey, {
    invalidates: [platformRoutes.listApiKeys],
  })
  const revokeMutation = useRouteMutation(platformRoutes.revokeApiKey, {
    invalidates: [platformRoutes.listApiKeys],
  })

  const keys = list.data?.data ?? []

  const handleCreate = async () => {
    const trimmed = name.trim()
    const perms = [...selectedPerms].filter((p) => heldSet.has(p))
    if (!trimmed || perms.length === 0) return
    try {
      const res = await createMutation.mutateAsync({
        body: {
          name: trimmed,
          permissions: perms,
          store_ids: null,
          expires_at: null,
        },
      })
      setCreatedKey(res.data.key)
      setName('')
    } catch (err) {
      notify.error(describeError(err).title)
    }
  }

  const handleRevoke = async (k: ApiKey) => {
    const ok = await confirm({
      title: t('api_keys.revoke_confirm_title', { name: k.name }),
      description: t('api_keys.revoke_confirm_desc', { prefix: k.key_prefix }),
      tone: 'danger',
      confirmLabel: t('api_keys.revoke'),
    })
    if (!ok) return
    try {
      await revokeMutation.mutateAsync({ params: { id: k.id }, body: {} })
      notify.success(t('api_keys.revoked_toast'))
    } catch (err) {
      notify.error(describeError(err).title)
    }
  }

  const togglePerm = (p: Permission, checked: boolean) => {
    setSelectedPerms((prev) => {
      const next = new Set(prev)
      if (checked) next.add(p)
      else next.delete(p)
      return next
    })
  }

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6 pb-8">
      <PageHeader
        title={t('api_keys.title')}
        description={t('api_keys.description')}
        backTo="/settings"
        actions={
          <Button
            leftIcon={<Plus />}
            onClick={() => {
              setCreatedKey(null)
              setCreateOpen(true)
            }}
          >
            {t('api_keys.create')}
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          value={q}
          onChange={setQ}
          placeholder={t('api_keys.search_placeholder')}
          aria-label={t('api_keys.search_placeholder')}
          wrapperClassName="w-full sm:max-w-sm"
        />
      </div>

      {list.isPending ? (
        <div className="grid gap-3" aria-busy="true">
          <Skeleton className="h-20 rounded-xl" />
          <Skeleton className="h-20 rounded-xl" />
        </div>
      ) : list.error && !list.data ? (
        <EmptyState
          title={t('api_keys.load_error')}
          description={describeError(list.error).title}
          action={
            <Button variant="outline" onClick={() => void list.refetch()}>
              {t('common:actions.retry')}
            </Button>
          }
        />
      ) : keys.length === 0 ? (
        <Card>
          <EmptyState
            icon={<KeyRound />}
            title={t('api_keys.empty_title')}
            description={t('api_keys.empty_desc')}
            action={
              <Button
                leftIcon={<Plus />}
                onClick={() => {
                  setCreatedKey(null)
                  setCreateOpen(true)
                }}
              >
                {t('api_keys.create')}
              </Button>
            }
          />
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-xs text-muted-foreground">
                    <th className="px-4 py-3 text-start">{t('api_keys.col_name')}</th>
                    <th className="px-4 py-3 text-start">{t('api_keys.col_prefix')}</th>
                    <th className="px-4 py-3 text-start">{t('api_keys.col_permissions')}</th>
                    <th className="px-4 py-3 text-start">{t('api_keys.col_stores')}</th>
                    <th className="px-4 py-3 text-start">{t('api_keys.col_last_used')}</th>
                    <th className="px-4 py-3 text-start">{t('api_keys.col_status')}</th>
                    <th className="px-4 py-3 text-end" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {keys.map((k) => (
                    <tr key={k.id}>
                      <td className="px-4 py-3 font-medium">{k.name}</td>
                      <td className="px-4 py-3 font-mono text-xs">{k.key_prefix}…</td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {t('api_keys.perms_count', { count: k.permissions.length })}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {k.store_ids === null
                          ? t('api_keys.all_stores')
                          : t('api_keys.stores_count', { count: k.store_ids.length })}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {k.last_used_at ? formatDateTime(k.last_used_at) : t('api_keys.never_used')}
                      </td>
                      <td className="px-4 py-3">
                        <Badge size="sm" tone={STATE_TONE[k.state]}>
                          {t(`api_keys.state.${k.state}`)}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-end">
                        {k.state === 'active' ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            leftIcon={<Trash2 className="size-4 text-danger" />}
                            onClick={() => void handleRevoke(k)}
                          >
                            {t('api_keys.revoke')}
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open)
          if (!open) setCreatedKey(null)
        }}
        title={createdKey ? t('api_keys.dialog.created_title') : t('api_keys.dialog.title')}
        description={
          createdKey ? undefined : t('api_keys.dialog.description')
        }
        size="lg"
        footer={
          createdKey ? (
            <Button
              onClick={() => {
                setCreateOpen(false)
                setCreatedKey(null)
              }}
            >
              {t('api_keys.dialog.done')}
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => setCreateOpen(false)}>
                {t('common:actions.cancel')}
              </Button>
              <Button
                loading={createMutation.isPending}
                disabled={!name.trim() || selectedPerms.size === 0}
                onClick={() => void handleCreate()}
              >
                {t('api_keys.dialog.submit')}
              </Button>
            </>
          )
        }
      >
        {createdKey ? (
          <div className="grid gap-4">
            <div className="flex items-start gap-2.5 rounded-lg border border-warning/40 bg-warning-soft p-3 text-sm text-warning-soft-foreground">
              <ShieldAlert className="mt-0.5 size-5 shrink-0" aria-hidden />
              <span>{t('api_keys.dialog.created_warning')}</span>
            </div>
            <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface-2 p-3 font-mono text-sm break-all">
              <span>{createdKey}</span>
              <Button
                size="sm"
                variant="outline"
                leftIcon={<Copy className="size-4" />}
                onClick={() => {
                  void navigator.clipboard?.writeText(createdKey)
                  notify.success(t('api_keys.dialog.copied'))
                }}
              >
                {t('api_keys.dialog.copy')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <label htmlFor="api-key-name" className="text-sm font-medium">
                {t('api_keys.dialog.name_label')}
              </label>
              <Input
                id="api-key-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('api_keys.dialog.name_placeholder')}
                maxLength={80}
                autoFocus
              />
            </div>
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">
                  {t('api_keys.dialog.permissions_label')} ({selectedPerms.size})
                </span>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setSelectedPerms(new Set(heldPermissions))}
                  >
                    {t('api_keys.dialog.select_all')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setSelectedPerms(new Set())}
                  >
                    {t('api_keys.dialog.clear_all')}
                  </Button>
                </div>
              </div>
              <div className="grid max-h-64 grid-cols-1 gap-2 overflow-y-auto rounded-lg border border-border p-3 sm:grid-cols-2">
                {heldPermissions.map((perm) => (
                  <Checkbox
                    key={perm}
                    checked={selectedPerms.has(perm)}
                    onCheckedChange={(c) => togglePerm(perm, c === true)}
                    label={<span className="font-mono text-xs">{perm}</span>}
                  />
                ))}
              </div>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  )
}
