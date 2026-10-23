/**
 * Counters & devices (/settings/registers): whether THIS computer is a registered counter (and
 * registering it), the billing counters of each store with their printing / hardware settings,
 * and the trusted computers with last-seen times and revoke. `?store=` preselects a store (links
 * from the stores page).
 */
import { MonitorSmartphone, Plus, Printer } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router'
import type { Register } from '@kadai/shared/api/identity'
import { Badge, Button, DataTable, type DataTableColumn, EmptyState, Select } from '@/components/ui'
import { getDeviceCredentials, useAuth, useCan, type DeviceCredentials } from '@/lib/auth'
import { formatDateTime, formatRelative } from '@/lib/format'
import { localizedName } from '@/lib/i18n'
import { useRegisters } from '../api'
import { DevicesSection } from '../components/DevicesSection'
import { RegisterDeviceDialog } from '../components/RegisterDeviceDialog'
import { RegisterFormDialog } from '../components/RegisterFormDialog'
import { SettingsPageHeader } from '../components/SettingsPageHeader'
import { ThisComputerCard } from '../components/ThisComputerCard'
import { UpgradeHint } from '../components/UpgradeHint'
import type { PlanBlock } from '../lib/messages'

const ALL = 'all'

export default function RegistersPage() {
  const { t } = useTranslation(['settings', 'common', 'nav'])
  const me = useAuth((s) => s.me)
  const canManage = useCan('settings.manage')
  const [params, setParams] = useSearchParams()
  const stores = useMemo(() => me?.stores ?? [], [me])
  const paramStore = params.get('store')
  const storeId = paramStore && stores.some((s) => s.id === paramStore) ? paramStore : ALL
  const setStoreId = (id: string): void =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (id === ALL) next.delete('store')
        else next.set('store', id)
        return next
      },
      { replace: true },
    )

  const [credentials, setCredentials] = useState<DeviceCredentials | null>(() =>
    getDeviceCredentials(),
  )
  const [registerOpen, setRegisterOpen] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Register | null>(null)

  const list = useRegisters({ limit: 200 })
  const all = useMemo(
    () =>
      [...(list.data?.data ?? [])].sort(
        (a, b) =>
          a.store_code.localeCompare(b.store_code) ||
          Number(b.is_active) - Number(a.is_active) ||
          a.code.localeCompare(b.code),
      ),
    [list.data],
  )
  const rows = storeId === ALL ? all : all.filter((r) => r.store_id === storeId)
  const activeCount = all.filter((r) => r.is_active).length
  const limit = me?.entitlements.limits.registers ?? null
  const block: PlanBlock | null =
    list.data && limit !== null && activeCount >= limit
      ? { kind: 'limit', metric: 'registers', limit }
      : null

  const defaultStoreId =
    storeId !== ALL ? storeId : (stores.find((s) => s.is_active)?.id ?? stores[0]?.id ?? '')

  const columns = useMemo<DataTableColumn<Register>[]>(
    () => [
      {
        id: 'name',
        header: t('registers.col_counter'),
        meta: { mobile: 'title' },
        cell: ({ row }) => {
          const r = row.original
          return (
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft font-mono text-sm font-semibold text-primary">
                {r.code}
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{r.name}</span>
                  {!r.is_active ? <Badge size="sm">{t('common:status.inactive')}</Badge> : null}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {r.store_code} · {r.store_name}
                </div>
              </div>
            </div>
          )
        },
      },
      {
        id: 'printing',
        header: t('registers.col_printing'),
        meta: { label: t('registers.col_printing'), mobile: 'subtitle' },
        cell: ({ row }) => {
          const s = row.original.settings
          return (
            <span className="flex flex-col items-start gap-1 text-sm">
              <span className="inline-flex items-center gap-1.5">
                <Printer className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                {s.print_format
                  ? t(`print_format_short.${s.print_format}`)
                  : t('registers.print_default_short')}
              </span>
              {s.auto_print || s.scale.enabled ? (
                <span className="flex flex-wrap gap-1">
                  {s.auto_print ? (
                    <Badge size="sm" tone="info">
                      {t('registers.auto_print_badge')}
                    </Badge>
                  ) : null}
                  {s.scale.enabled ? (
                    <Badge size="sm" tone="primary">
                      {t('registers.scale_badge')}
                    </Badge>
                  ) : null}
                </span>
              ) : null}
            </span>
          )
        },
      },
      {
        id: 'devices',
        header: t('registers.col_devices'),
        meta: { label: t('registers.col_devices'), align: 'right' },
        cell: ({ row }) => (
          <span className="tabular-nums">
            {t('registers.devices_count', { count: row.original.device_count })}
          </span>
        ),
      },
      {
        id: 'last_seen',
        header: t('registers.col_last_seen'),
        meta: { label: t('registers.col_last_seen') },
        cell: ({ row }) =>
          row.original.last_seen_at ? (
            <span className="text-sm" title={formatDateTime(row.original.last_seen_at)}>
              {formatRelative(row.original.last_seen_at)}
            </span>
          ) : (
            <span className="text-sm text-muted-foreground">{t('devices.never_seen')}</span>
          ),
      },
    ],
    [t],
  )

  const storeOptions = [
    { value: ALL, label: t('common:misc.all_stores') },
    ...stores.map((s) => ({
      value: s.id,
      label: `${s.code} · ${localizedName(s.name, s.name_ta)}`,
    })),
  ]

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div>
        <SettingsPageHeader
          title={t('nav:titles.settings_registers')}
          description={t('registers.description')}
          actions={
            stores.length > 1 ? (
              <Select
                value={storeId}
                onValueChange={setStoreId}
                options={storeOptions}
                className="w-full sm:w-64"
              />
            ) : null
          }
        />
        <ThisComputerCard
          credentials={credentials}
          canRegister={canManage}
          onRegister={() => setRegisterOpen(true)}
          onForgotten={() => setCredentials(null)}
        />
      </div>

      <section id="counters" aria-labelledby="counters-title" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="counters-title" className="text-lg font-semibold">
              {t('registers.title')}
            </h2>
            <p className="text-sm text-muted-foreground">{t('registers.list_description')}</p>
          </div>
          {canManage ? (
            <Button
              leftIcon={<Plus />}
              variant="outline"
              disabled={Boolean(block) || stores.length === 0}
              onClick={() => {
                setEditing(null)
                setFormOpen(true)
              }}
            >
              {t('registers.add')}
            </Button>
          ) : null}
        </div>
        {block ? <UpgradeHint block={block} /> : null}
        <DataTable
          label={t('registers.title')}
          columns={columns}
          data={rows}
          getRowId={(r) => r.id}
          loading={list.isLoading}
          error={list.error}
          onRetry={() => void list.refetch()}
          onRowClick={(r) => {
            if (!canManage) return
            setEditing(r)
            setFormOpen(true)
          }}
          skeletonRows={3}
          empty={
            <EmptyState
              compact
              icon={<MonitorSmartphone />}
              title={t('registers.empty_title')}
              description={t('registers.empty_description')}
            />
          }
        />
      </section>

      <DevicesSection
        storeId={storeId === ALL ? null : storeId}
        credentials={credentials}
        onCredentialsCleared={() => setCredentials(null)}
      />

      <RegisterFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        register={editing}
        defaultStoreId={defaultStoreId}
      />
      <RegisterDeviceDialog
        open={registerOpen}
        onOpenChange={setRegisterOpen}
        defaultStoreId={storeId === ALL ? (me?.device?.store_id ?? null) : storeId}
        onRegistered={() => setCredentials(getDeviceCredentials())}
      />
    </div>
  )
}
