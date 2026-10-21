/**
 * Batch of a line (pharmacy): FEFO is the default (earliest expiry with stock); the cashier can
 * pick another batch — e.g. the strip the customer brought to the counter. Expiry is coloured
 * (expired / within settings.inventory.expiry_warning_days) and expired batches are blocked when
 * settings.inventory.block_expired_sale. Reads the offline catalogue's batches.
 */
import { CheckCircle2, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { batchExpiryStatus } from '@kadai/shared/api/sales'
import { Badge, Dialog, EmptyState, Skeleton } from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatDate, formatMoney, formatQty } from '@/lib/format'
import { getBatches, pickFefoBatch } from '../lib/catalog'
import type { PosBatch } from '../lib/types'
import { usePos } from '../state/pos-context'
import { productNames } from '../lib/names'

export function BatchDialog({ lineKey, onClose }: { lineKey: string; onClose: () => void }) {
  const { t } = useTranslation('pos')
  const pos = usePos()
  const line = pos.cart.lines.find((l) => l.key === lineKey)
  const [batches, setBatches] = useState<PosBatch[] | null>(null)
  const tenantId = pos.scope?.tenantId
  const productId = line?.product.id
  const warning = pos.context?.settings.inventory.expiry_warning_days ?? 90
  const block = pos.context?.settings.inventory.block_expired_sale ?? true

  useEffect(() => {
    if (!tenantId || !productId) return
    void getBatches(tenantId, productId).then(setBatches)
  }, [tenantId, productId])

  if (!line) return null
  const names = productNames(line.product)
  const fefo = batches ? pickFefoBatch(batches, pos.today) : null

  const choose = (batch: PosBatch | null, auto: boolean): void => {
    pos.dispatch({ type: 'set_batch', key: line.key, batch, auto })
    onClose()
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('batch.title', { name: names.primary })}
      size="lg"
    >
      {batches === null ? (
        <div className="flex flex-col gap-2 pb-2">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-14 rounded-lg" />
          ))}
        </div>
      ) : batches.length === 0 ? (
        <EmptyState compact title={t('batch.none')} description={t('batch.none_hint')} />
      ) : (
        <ul
          className="flex flex-col gap-2 pb-2"
          role="listbox"
          aria-label={t('batch.title', { name: names.primary })}
        >
          <li>
            <button
              type="button"
              onClick={() => choose(fefo, true)}
              className={cn(
                'flex w-full items-center gap-3 rounded-lg border p-3 text-start',
                line.batch_auto
                  ? 'border-primary bg-primary-soft'
                  : 'border-border hover:bg-surface-2',
              )}
            >
              <Sparkles className="size-5 text-primary" aria-hidden />
              <div className="flex-1">
                <div className="font-semibold">{t('batch.auto')}</div>
                <div className="text-sm text-muted-foreground">{t('batch.auto_hint')}</div>
              </div>
              {line.batch_auto ? (
                <CheckCircle2 className="size-5 text-primary" aria-hidden />
              ) : null}
            </button>
          </li>
          {batches.map((b) => {
            const status = batchExpiryStatus(b.expiry_date, pos.today, warning)
            const disabled = status === 'expired' && block
            const selected = !line.batch_auto && line.batch?.id === b.id
            return (
              <li key={b.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  disabled={disabled}
                  onClick={() => choose(b, false)}
                  className={cn(
                    'flex w-full flex-wrap items-center gap-3 rounded-lg border p-3 text-start disabled:cursor-not-allowed disabled:opacity-60',
                    selected
                      ? 'border-primary bg-primary-soft'
                      : 'border-border hover:bg-surface-2',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-mono font-semibold">{b.batch_no}</div>
                    <div className="text-sm text-muted-foreground">
                      {b.mrp_paise !== null
                        ? t('batch.mrp', { amount: formatMoney(b.mrp_paise) })
                        : null}
                      {b.sale_price_paise !== null
                        ? ` · ${t('batch.price', { amount: formatMoney(b.sale_price_paise) })}`
                        : ''}
                    </div>
                  </div>
                  <Badge
                    tone={
                      status === 'expired'
                        ? 'danger'
                        : status === 'near_expiry'
                          ? 'warning'
                          : 'success'
                    }
                  >
                    {b.expiry_date
                      ? status === 'expired'
                        ? t('batch.expired', { date: formatDate(b.expiry_date) })
                        : t('batch.expires', { date: formatDate(b.expiry_date) })
                      : t('batch.no_expiry')}
                  </Badge>
                  <span
                    className={cn(
                      'w-28 text-end text-sm tabular-nums',
                      b.qty_milli <= 0 ? 'text-danger' : '',
                    )}
                  >
                    {t('batch.stock', { qty: formatQty(b.qty_milli, line.product.unit) })}
                  </span>
                  {fefo?.id === b.id ? (
                    <Badge tone="primary" size="sm">
                      {t('batch.fefo')}
                    </Badge>
                  ) : null}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </Dialog>
  )
}
