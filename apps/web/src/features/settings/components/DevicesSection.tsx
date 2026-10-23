/**
 * Trusted counter computers: name, store / counter, who approved it, when it was last seen and
 * its status, with revoke (also ends every session on that computer). Revoking this very
 * computer also forgets its saved credentials.
 */
import { Ban, MonitorSmartphone } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Device, DeviceListQuery } from '@kadai/shared/api/identity'
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  type DataTableColumn,
  EmptyState,
  FormField,
  Input,
  notify,
} from '@/components/ui'
import { clearDeviceCredentials, type DeviceCredentials } from '@/lib/auth'
import { formatDateTime, formatRelative } from '@/lib/format'
import { useDevices, useRevokeDevice } from '../api'
import { notifySettingsError } from '../lib/messages'
import { FilterChips } from './FilterChips'

type StatusFilter = NonNullable<DeviceListQuery['status']>

const PAGE_SIZE = 50

export function DevicesSection({
  storeId,
  credentials,
  onCredentialsCleared,
}: {
  storeId: string | null
  credentials: DeviceCredentials | null
  onCredentialsCleared: () => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const [status, setStatus] = useState<StatusFilter>('active')
  const [offset, setOffset] = useState(0)
  const [revoking, setRevoking] = useState<Device | null>(null)
  const [reason, setReason] = useState('')
  const list = useDevices({
    status,
    limit: PAGE_SIZE,
    offset,
    ...(storeId ? { store_id: storeId } : {}),
  })
  const revoke = useRevokeDevice()
  const rows = list.data?.data ?? []
  const page = list.data?.page

  const columns = useMemo<DataTableColumn<Device>[]>(
    () => [
      {
        id: 'name',
        header: t('devices.col_device'),
        meta: { mobile: 'title' },
        cell: ({ row }) => (
          <div className="flex min-w-0 items-center gap-2">
            <MonitorSmartphone className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate font-medium">{row.original.name}</span>
            {credentials?.device_id === row.original.id ? (
              <Badge tone="success" size="sm">
                {t('devices.this_badge')}
              </Badge>
            ) : null}
          </div>
        ),
      },
      {
        id: 'where',
        header: t('devices.col_where'),
        meta: { mobile: 'subtitle', label: t('devices.col_where') },
        cell: ({ row }) => (
          <span className="text-sm">
            <span className="font-mono">{row.original.store_code}</span>
            {row.original.register_code ? (
              <>
                {' · '}
                {row.original.register_code} {row.original.register_name}
              </>
            ) : (
              <span className="text-muted-foreground"> · {t('devices.no_register')}</span>
            )}
          </span>
        ),
      },
      {
        id: 'last_seen',
        header: t('devices.col_last_seen'),
        meta: { label: t('devices.col_last_seen') },
        cell: ({ row }) =>
          row.original.last_seen_at ? (
            <span className="text-sm" title={formatDateTime(row.original.last_seen_at)}>
              {formatRelative(row.original.last_seen_at)}
            </span>
          ) : (
            <span className="text-sm text-muted-foreground">{t('devices.never_seen')}</span>
          ),
      },
      {
        id: 'approved_by',
        header: t('devices.col_approved_by'),
        meta: { label: t('devices.col_approved_by') },
        cell: ({ row }) => (
          <span className="text-sm">
            {row.original.approved_by_name ?? '—'}
            <span className="block text-xs text-muted-foreground">
              {formatDateTime(row.original.created_at)}
            </span>
          </span>
        ),
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">{t('common:actions.more')}</span>,
        meta: { align: 'right', mobile: 'value', label: t('common:fields.status') },
        cell: ({ row }) =>
          row.original.status === 'active' ? (
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<Ban />}
              className="text-danger hover:bg-danger-soft"
              onClick={(e) => {
                e.stopPropagation()
                setReason('')
                setRevoking(row.original)
              }}
            >
              {t('devices.revoke')}
            </Button>
          ) : (
            <Badge tone="danger" size="sm">
              {t('devices.revoked_on', { date: formatDateTime(row.original.revoked_at) })}
            </Badge>
          ),
      },
    ],
    [t, credentials],
  )

  const chips = (['active', 'revoked', 'all'] as const).map((key) => ({
    key,
    label: t(`devices.filter_${key}`),
  }))

  return (
    <section aria-labelledby="devices-title" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="devices-title" className="text-lg font-semibold">
            {t('devices.title')}
          </h2>
          <p className="text-sm text-muted-foreground">{t('devices.description')}</p>
        </div>
        <FilterChips
          chips={chips}
          value={status}
          onChange={(s) => {
            setStatus(s)
            setOffset(0)
          }}
          label={t('devices.filter_label')}
        />
      </div>
      <DataTable
        label={t('devices.title')}
        columns={columns}
        data={rows}
        getRowId={(d) => d.id}
        loading={list.isLoading}
        error={list.error}
        onRetry={() => void list.refetch()}
        skeletonRows={3}
        pagination={
          page && page.total > PAGE_SIZE
            ? {
                offset: page.offset,
                limit: page.limit,
                total: page.total,
                onChange: (next) => setOffset(next.offset),
              }
            : undefined
        }
        empty={
          <EmptyState
            compact
            icon={<MonitorSmartphone />}
            title={status === 'revoked' ? t('devices.empty_revoked') : t('devices.empty_title')}
            description={status === 'revoked' ? undefined : t('devices.empty_description')}
          />
        }
      />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(o) => {
          if (!o) setRevoking(null)
        }}
        tone="danger"
        title={t('devices.revoke_title', { name: revoking?.name ?? '' })}
        description={
          revoking && credentials?.device_id === revoking.id
            ? t('devices.revoke_this_description')
            : t('devices.revoke_description')
        }
        confirmLabel={t('devices.revoke')}
        onConfirm={async () => {
          if (!revoking) return
          try {
            await revoke.mutateAsync({
              params: { id: revoking.id },
              body: { reason: reason.trim() || null },
            })
            if (credentials?.device_id === revoking.id) {
              clearDeviceCredentials()
              onCredentialsCleared()
            }
            notify.success(t('devices.revoked_toast', { name: revoking.name }))
          } catch (error) {
            notifySettingsError(error)
            throw error
          }
        }}
      >
        <FormField label={t('devices.revoke_reason')} optional>
          <Input
            value={reason}
            maxLength={200}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('devices.revoke_reason_placeholder')}
          />
        </FormField>
      </ConfirmDialog>
    </section>
  )
}
