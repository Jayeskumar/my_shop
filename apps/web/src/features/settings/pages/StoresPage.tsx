/**
 * Stores (/settings/stores): every branch with its code (part of bill numbers), GSTIN, state,
 * counters and status. Adding a store is plan-aware — a second store needs the multi-store
 * feature and the plan's store limit applies; the page explains that up front instead of
 * failing on save.
 */
import { MonitorSmartphone, Plus, Store as StoreIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import type { Store } from '@kadai/shared/api/identity'
import {
  Badge,
  Button,
  DataTable,
  type DataTableColumn,
  EmptyState,
  PhoneLink,
} from '@/components/ui'
import { useAuth, useFeature } from '@/lib/auth'
import { localizedName } from '@/lib/i18n'
import { useStores } from '../api'
import { SettingsPageHeader } from '../components/SettingsPageHeader'
import { StoreFormDialog } from '../components/StoreFormDialog'
import { UpgradeHint } from '../components/UpgradeHint'
import { useBusinessWideEdit } from '../lib/access'
import type { PlanBlock } from '../lib/messages'
import { stateName } from '../lib/states'

export default function StoresPage() {
  const { t } = useTranslation(['settings', 'common', 'nav'])
  const me = useAuth((s) => s.me)
  const myStores = useAuth((s) => s.me?.membership.store_ids ?? null)
  const multiStore = useFeature('multi_store')
  const { canEdit: canAdd } = useBusinessWideEdit()
  const canEditAny = useAuth((s) => s.permissions.has('settings.manage'))
  const list = useStores({ limit: 200 })
  const stores = useMemo(
    () =>
      [...(list.data?.data ?? [])].sort(
        (a, b) => Number(b.is_active) - Number(a.is_active) || a.code.localeCompare(b.code),
      ),
    [list.data],
  )
  // The edited store stays set while the dialog animates closed.
  const [editing, setEditing] = useState<Store | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [adding, setAdding] = useState(false)

  const activeCount = stores.filter((s) => s.is_active).length
  const limit = me?.entitlements.limits.stores ?? null
  const block: PlanBlock | null =
    !list.data || !canAdd
      ? null
      : !multiStore && activeCount >= 1
        ? { kind: 'feature', feature: 'multi_store' }
        : limit !== null && activeCount >= limit
          ? { kind: 'limit', metric: 'stores', limit }
          : null

  const canEditStore = (s: Store): boolean =>
    canEditAny && (myStores === null || myStores.includes(s.id))

  const columns = useMemo<DataTableColumn<Store>[]>(
    () => [
      {
        id: 'name',
        header: t('stores.col_store'),
        meta: { mobile: 'title' },
        cell: ({ row }) => {
          const s = row.original
          return (
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex h-9 min-w-12 shrink-0 items-center justify-center rounded-lg bg-primary-soft px-2 font-mono text-sm font-semibold text-primary">
                {s.code}
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{localizedName(s.name, s.name_ta)}</span>
                  {!s.is_active ? <Badge size="sm">{t('common:status.inactive')}</Badge> : null}
                </div>
                {s.address.city || s.address.district ? (
                  <div className="truncate text-xs text-muted-foreground">
                    {[s.address.city, s.address.district].filter(Boolean).join(', ')}
                  </div>
                ) : null}
              </div>
            </div>
          )
        },
      },
      {
        id: 'gstin',
        header: t('stores.col_gst'),
        meta: { label: t('stores.col_gst'), mobile: 'subtitle' },
        cell: ({ row }) => (
          <div className="min-w-0">
            {row.original.gstin ? (
              <div className="font-mono text-sm">{row.original.gstin}</div>
            ) : (
              <div className="text-sm text-muted-foreground">{t('stores.uses_business_gstin')}</div>
            )}
            <div className="text-xs text-muted-foreground">
              {stateName(row.original.state_code)}
            </div>
          </div>
        ),
      },
      {
        id: 'registers',
        header: t('stores.col_registers'),
        meta: { label: t('stores.col_registers'), align: 'right' },
        cell: ({ row }) => (
          <Link
            to={`/settings/registers?store=${row.original.id}`}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm tabular-nums text-primary hover:underline"
          >
            <MonitorSmartphone className="size-4" aria-hidden />
            {t('stores.registers_count', { count: row.original.register_count })}
          </Link>
        ),
      },
      {
        id: 'phone',
        header: t('common:fields.phone'),
        meta: { label: t('common:fields.phone') },
        cell: ({ row }) =>
          row.original.phone ? (
            <PhoneLink phone={row.original.phone} />
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
    ],
    [t],
  )

  const businessType = me?.tenant.business_type ?? 'general_store'
  const stateCode = me?.tenant.state_code ?? '33'

  return (
    <div className="max-w-5xl">
      <SettingsPageHeader
        title={t('nav:titles.settings_stores')}
        description={t('stores.description')}
        actions={
          canAdd ? (
            <Button leftIcon={<Plus />} onClick={() => setAdding(true)} disabled={Boolean(block)}>
              {t('stores.add')}
            </Button>
          ) : null
        }
      />
      {block ? <UpgradeHint block={block} className="mb-4" /> : null}
      <DataTable
        label={t('nav:titles.settings_stores')}
        columns={columns}
        data={stores}
        getRowId={(s) => s.id}
        loading={list.isLoading}
        error={list.error}
        onRetry={() => void list.refetch()}
        onRowClick={(s) => {
          if (!canEditStore(s)) return
          setEditing(s)
          setEditOpen(true)
        }}
        skeletonRows={3}
        empty={
          <EmptyState
            compact
            icon={<StoreIcon />}
            title={t('stores.empty_title')}
            description={t('stores.empty_description')}
          />
        }
      />
      <p className="mt-3 text-xs text-muted-foreground">{t('stores.code_note')}</p>
      <StoreFormDialog
        open={adding}
        onOpenChange={setAdding}
        store={null}
        businessType={businessType}
        defaultStateCode={stateCode}
      />
      <StoreFormDialog
        open={editOpen && editing !== null}
        onOpenChange={setEditOpen}
        store={editing}
        businessType={businessType}
        defaultStateCode={stateCode}
      />
    </div>
  )
}
