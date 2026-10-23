/**
 * Receive a dispatched transfer at the destination store (POST /stock-transfers/:id/receive):
 * received quantity per line (default: everything sent), the received date and — when anything
 * is short — the reason. The shortfall is written off at the source store as damage.
 */
import {
  type StockTransferDetail,
  type TransferReceive,
  TransferReceiveSchema,
  inventoryRoutes,
  stockValuePaise,
  transferShortfall,
} from '@kadai/shared/api/inventory'
import { newId } from '@kadai/shared/ids'
import { PackageCheck } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  DatePicker,
  Dialog,
  FormField,
  Money,
  Qty,
  QtyInput,
  notify,
} from '@/components/ui'
import { Textarea } from '@/components/ui/textarea'
import { useRouteMutation } from '@/lib/query'
import { useToday } from '../lib/access'
import { notifyInventoryError, validationText } from '../lib/errors'
import { STOCK_ROUTES } from '../lib/invalidate'
import { packUnitFor } from '../lib/labels'
import { ProductName } from './ProductName'

export function ReceiveTransferDialog({
  transfer,
  open,
  onOpenChange,
}: {
  transfer: StockTransferDetail
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation(['inventory', 'common'])
  const today = useToday()
  const [received, setReceived] = useState<Record<string, number | null>>({})
  const [date, setDate] = useState<string | null>(today)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const key = useRef(newId())

  useEffect(() => {
    if (!open) return
    setReceived(Object.fromEntries(transfer.lines.map((l) => [l.id, l.qty_milli])))
    setDate(today < transfer.transfer_date ? transfer.transfer_date : today)
    setReason('')
    setError(null)
    key.current = newId()
  }, [open, transfer, today])

  const receive = useRouteMutation(inventoryRoutes.receiveTransfer, {
    invalidates: STOCK_ROUTES,
    onError: () => {},
  })

  const shortfall = useMemo(
    () =>
      transfer.lines.reduce((sum, l) => {
        const short = transferShortfall(l.qty_milli, received[l.id] ?? 0)
        return sum + stockValuePaise(l.unit_cost_paise, short, l.pack_size)
      }, 0),
    [transfer.lines, received],
  )
  const anyShort = transfer.lines.some((l) => (received[l.id] ?? 0) < l.qty_milli)

  const submit = async (): Promise<void> => {
    setError(null)
    if (anyShort && !reason.trim()) {
      setError(t('transfers.shortfall_reason_required'))
      return
    }
    const body: TransferReceive = {
      lines: transfer.lines.map((l) => ({
        line_id: l.id,
        received_qty_milli: received[l.id] ?? 0,
      })),
      ...(date ? { received_date: date } : {}),
      shortfall_reason: anyShort ? reason.trim() : null,
    }
    const over = transfer.lines.find((l) => (received[l.id] ?? 0) > l.qty_milli)
    if (over) {
      setError(validationText('received_exceeds_dispatched') ?? null)
      return
    }
    const parsed = TransferReceiveSchema.safeParse(body)
    if (!parsed.success) {
      setError(validationText(parsed.error.issues[0]?.message) ?? null)
      return
    }
    try {
      await receive.mutateAsync({ params: { id: transfer.id }, body, idempotencyKey: key.current })
      notify.success(t('transfers.received_toast', { number: transfer.number ?? '' }))
      onOpenChange(false)
    } catch (e) {
      notifyInventoryError(e)
      key.current = newId()
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={t('transfers.receive_title', { number: transfer.number ?? '' })}
      description={t('transfers.receive_description')}
      bodyClassName="grid grid-cols-1 gap-4"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common:actions.cancel')}
          </Button>
          <Button
            leftIcon={<PackageCheck />}
            loading={receive.isPending}
            onClick={() => void submit()}
          >
            {t('transfers.receive_confirm')}
          </Button>
        </>
      }
    >
      <ul className="grid grid-cols-1 gap-2">
        {transfer.lines.map((l, i) => {
          const value = received[l.id] ?? null
          const short = transferShortfall(l.qty_milli, value ?? 0)
          return (
            <li
              key={l.id}
              className="grid grid-cols-1 gap-2 rounded-lg border border-border p-3 sm:grid-cols-[minmax(0,1fr)_9rem] sm:items-center"
            >
              <div className="grid gap-0.5">
                <ProductName
                  name={l.product_name}
                  nameTa={l.product_name_ta}
                  sku={l.sku}
                  extra={[l.batch_no ? `${t('lines.batch')} ${l.batch_no}` : null]}
                />
                <span className="text-xs text-muted-foreground">
                  {t('transfers.sent')}:{' '}
                  <Qty
                    milli={l.qty_milli}
                    unit={l.unit}
                    packSize={l.pack_size}
                    packUnit={packUnitFor(l.unit)}
                  />
                  {short > 0 ? (
                    <span className="ms-2 font-medium text-danger">
                      {t('transfers.short_by')}{' '}
                      <Qty
                        milli={short}
                        unit={l.unit}
                        packSize={l.pack_size}
                        packUnit={packUnitFor(l.unit)}
                      />
                    </span>
                  ) : null}
                </span>
              </div>
              <QtyInput
                aria-label={t('transfers.received_of', { n: i + 1 })}
                unit={l.unit}
                value={value}
                max={l.qty_milli}
                onChange={(v) => setReceived((r) => ({ ...r, [l.id]: v }))}
              />
            </li>
          )
        })}
      </ul>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[12rem_1fr]">
        <FormField label={t('transfers.received_date')}>
          <DatePicker value={date} onChange={setDate} min={transfer.transfer_date} max={today} />
        </FormField>
        {anyShort ? (
          <FormField label={t('transfers.shortfall_reason')} required error={error}>
            <Textarea
              rows={2}
              maxLength={200}
              value={reason}
              placeholder={t('transfers.shortfall_placeholder')}
              onChange={(e) => {
                setReason(e.target.value)
                setError(null)
              }}
            />
          </FormField>
        ) : error ? (
          <p className="text-sm text-danger">{error}</p>
        ) : null}
      </div>
      {anyShort ? (
        <p
          role="status"
          className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning-soft-foreground"
        >
          {t('transfers.shortfall_note')} <Money paise={shortfall} className="font-semibold" />
        </p>
      ) : null}
    </Dialog>
  )
}
