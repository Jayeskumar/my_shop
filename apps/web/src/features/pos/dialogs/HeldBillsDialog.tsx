/**
 * Recall (F5): bills on hold — on the server (any counter of the store, GET /sales/held) and
 * parked on this device while offline. Recall loads the bill into the cart (a bill in progress
 * is held first); delete asks for confirmation.
 */
import { CloudOff, PauseCircle, Trash2 } from 'lucide-react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useTranslation } from 'react-i18next'
import { salesRoutes } from '@kadai/shared/api/sales'
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  IconButton,
  Skeleton,
  notify,
  useConfirm,
} from '@/components/ui'
import { callRoute } from '@/lib/api'
import { formatMoney, formatRelative, formatTime } from '@/lib/format'
import { heldCarts } from '@/lib/offline/db'
import { invalidateRoutes, useRouteQuery } from '@/lib/query'
import { useQueryClient } from '@tanstack/react-query'
import type { CartState } from '../lib/cart'
import { usePos } from '../state/pos-context'

export function HeldBillsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('pos')
  const pos = usePos()
  const confirm = useConfirm()
  const queryClient = useQueryClient()
  const scope = pos.scope
  const server = useRouteQuery(
    salesRoutes.listHeld,
    { query: { store_id: scope?.storeId ?? '', status: ['held'] } },
    { enabled: Boolean(scope) && pos.online && pos.perms.createSales, meta: { errorToast: false } },
  )
  const local =
    useLiveQuery(
      async () => (scope ? heldCarts.list(scope.tenantId, scope.storeId) : []),
      [scope?.tenantId, scope?.storeId],
    ) ?? []
  // Device copies of server held bills are shown through the server list.
  const deviceOnly = local.filter(
    (h) => !(h.cart as CartState | undefined)?.held_invoice_id || !pos.online,
  )
  const serverRows = pos.online ? (server.data?.data ?? []) : []

  const removeServer = async (id: string): Promise<void> => {
    const ok = await confirm({
      title: t('held.delete_title'),
      description: t('held.delete_description'),
      tone: 'danger',
      confirmLabel: t('held.delete'),
    })
    if (!ok) return
    try {
      await callRoute(salesRoutes.deleteInvoice, { params: { id } })
      await heldCarts.remove(id)
      await invalidateRoutes(queryClient, [salesRoutes.listHeld])
      notify.success(t('held.deleted'))
    } catch (e) {
      notify.error(e)
    }
  }

  const removeLocal = async (id: string): Promise<void> => {
    const ok = await confirm({
      title: t('held.delete_title'),
      description: t('held.delete_description'),
      tone: 'danger',
      confirmLabel: t('held.delete'),
    })
    if (ok) await heldCarts.remove(id)
  }

  const empty = serverRows.length === 0 && deviceOnly.length === 0 && !server.isLoading
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('held.title')}
      description={t('held.description')}
      size="lg"
    >
      {server.isLoading && pos.online ? (
        <div className="flex flex-col gap-2 pb-2">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-16 rounded-lg" />
          ))}
        </div>
      ) : empty ? (
        <EmptyState
          compact
          icon={<PauseCircle />}
          title={t('held.empty')}
          description={t('held.empty_hint')}
        />
      ) : (
        <ul className="flex flex-col gap-2 pb-2">
          {serverRows.map((h) => (
            <li
              key={h.id}
              className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3"
            >
              <div className="min-w-[12rem] flex-1">
                <div className="flex flex-wrap items-center gap-2 font-semibold">
                  {h.customer_name ?? t('held.walk_in')}
                  {h.register_code ? (
                    <Badge size="sm">{t('held.counter', { code: h.register_code })}</Badge>
                  ) : null}
                </div>
                <div className="text-sm text-muted-foreground">
                  {formatTime(h.created_at)} · {formatRelative(h.created_at)} ·{' '}
                  {t('held.items', { count: h.item_count })}
                  {h.created_by_name ? ` · ${h.created_by_name}` : ''}
                </div>
                {h.notes ? <div className="truncate text-sm">“{h.notes}”</div> : null}
              </div>
              <div className="text-end text-lg font-bold tabular-nums">
                {formatMoney(h.total_paise)}
              </div>
              <Button onClick={() => void pos.recallServer(h.id)} loading={pos.busy === 'recall'}>
                {t('held.recall')}
              </Button>
              <IconButton
                icon={<Trash2 />}
                label={t('held.delete')}
                variant="ghost"
                onClick={() => void removeServer(h.id)}
              />
            </li>
          ))}
          {deviceOnly.map((h) => (
            <li
              key={h.id}
              className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-border p-3"
            >
              <div className="min-w-[12rem] flex-1">
                <div className="flex flex-wrap items-center gap-2 font-semibold">
                  {h.customer_name ?? t('held.walk_in')}
                  <Badge size="sm" tone="warning" icon={<CloudOff />}>
                    {t('held.on_device')}
                  </Badge>
                </div>
                <div className="text-sm text-muted-foreground">
                  {formatTime(h.updated_at)} · {formatRelative(h.updated_at)} ·{' '}
                  {t('held.items', { count: h.item_count })}
                </div>
                {h.label ? <div className="truncate text-sm">“{h.label}”</div> : null}
              </div>
              <div className="text-end text-lg font-bold tabular-nums">
                {formatMoney(h.total_paise)}
              </div>
              <Button onClick={() => void pos.recallLocal(h.id)}>{t('held.recall')}</Button>
              <IconButton
                icon={<Trash2 />}
                label={t('held.delete')}
                variant="ghost"
                onClick={() => void removeLocal(h.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  )
}
