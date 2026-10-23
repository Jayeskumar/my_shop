/**
 * Quantity of weighed / measured goods (loose rice, vegetables, sweets, fabric by metre): kg / g
 * quick buttons, decimal entry, and — when the register has a Web Serial scale — the live weight
 * with a "use weight" button (works offline; the port is remembered per counter).
 */
import { Scale, Usb } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isDecimalUnit } from '@kadai/shared/units'
import { Badge, Button, Dialog, QtyInput } from '@/components/ui'
import { formatMoney, formatQty } from '@/lib/format'
import { weightToQtyMilli } from '../hardware/scale'
import { amountForQty } from '@kadai/shared/units'
import type { PosProduct } from '../lib/types'
import { type AddOptions, usePos } from '../state/pos-context'
import { productNames } from '../lib/names'

/** Quick quantities per unit family (milli of the product's unit). */
function quickQuantities(unit: string): number[] {
  const u = unit.toUpperCase()
  if (u === 'KG') return [100, 250, 500, 750, 1000, 2000, 5000]
  if (u === 'G') return [50_000, 100_000, 250_000, 500_000]
  if (u === 'L') return [250, 500, 1000, 2000, 5000]
  if (u === 'M') return [500, 1000, 1500, 2000, 2500, 5000]
  return [500, 1000, 2000, 5000]
}

/** Quick button label: below 1 kg / 1 L in grams / ml ("250 கிராம்", not "0.25 கிலோ"). */
function quickLabel(qtyMilli: number, unit: string): string {
  const u = unit.toUpperCase()
  if (qtyMilli < 1000 && u === 'KG') return formatQty(qtyMilli * 1000, 'G')
  if (qtyMilli < 1000 && u === 'L') return formatQty(qtyMilli * 1000, 'ML')
  return formatQty(qtyMilli, unit)
}

export function WeighDialog({
  product,
  options,
  onClose,
}: {
  product: PosProduct
  options: AddOptions
  onClose: () => void
}) {
  const { t } = useTranslation('pos')
  const pos = usePos()
  const scale = pos.scale
  const [qty, setQty] = useState<number | null>(null)
  const names = productNames(product)
  const weighable = weightToQtyMilli(1000, product.unit) !== null
  const live =
    scale.reading && weighable ? weightToQtyMilli(scale.reading.kg_milli, product.unit) : null
  const decimal = product.decimal_qty || isDecimalUnit(product.unit)
  const rate = product.sale_price_paise

  // A stable reading pre-fills an empty field.
  useEffect(() => {
    if (qty === null && live !== null && live > 0 && scale.reading?.stable) setQty(live)
  }, [live, qty, scale.reading?.stable])

  const confirm = (value: number | null): void => {
    if (!value || value <= 0) return
    void pos.addProduct(product, { ...options, qty_milli: value, confirmed: true })
    onClose()
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('weigh.title', { name: names.primary })}
      description={t('weigh.rate', {
        amount: formatMoney(rate),
        unit: formatQty(1000, product.unit),
      })}
      size="md"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('weigh.cancel')}
          </Button>
          <Button size="lg" onClick={() => confirm(qty)} disabled={!qty}>
            {t('weigh.add', {
              amount: formatMoney(amountForQty(rate, qty ?? 0, product.pack_size)),
            })}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 pb-2">
        {scale.enabled && weighable ? (
          <div className="rounded-xl border border-border bg-surface-2 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-sm font-medium">
                <Scale className="size-4" aria-hidden /> {t('weigh.scale')}
              </span>
              {scale.status === 'connected' ? (
                <Badge tone={scale.reading?.stable ? 'success' : 'warning'} dot>
                  {scale.reading?.stable ? t('weigh.stable') : t('weigh.settling')}
                </Badge>
              ) : scale.status === 'unsupported' ? (
                <Badge tone="neutral">{t('weigh.unsupported')}</Badge>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  leftIcon={<Usb />}
                  onClick={() => void scale.connect()}
                  loading={scale.status === 'connecting'}
                >
                  {t('weigh.connect')}
                </Button>
              )}
            </div>
            {scale.status === 'connected' ? (
              <div className="mt-2 flex items-center justify-between gap-3">
                <span className="text-4xl font-extrabold tabular-nums" aria-live="polite">
                  {live !== null ? formatQty(live, product.unit) : '—'}
                </span>
                <Button
                  size="lg"
                  variant="success"
                  disabled={live === null || live <= 0}
                  onClick={() => confirm(live)}
                >
                  {t('weigh.use_weight')}
                </Button>
              </div>
            ) : scale.status === 'error' ? (
              <p className="mt-2 text-sm text-danger">{t('weigh.scale_error')}</p>
            ) : null}
          </div>
        ) : null}
        <QtyInput
          value={qty}
          onChange={setQty}
          unit={product.unit}
          allowDecimal={decimal}
          step={product.unit.toUpperCase() === 'G' ? 50_000 : 250}
          min={1}
          size="xl"
          autoFocus
          aria-label={t('weigh.qty')}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              confirm(qty)
            }
          }}
        />
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {quickQuantities(product.unit).map((q) => (
            <Button
              key={q}
              variant="outline"
              size="lg"
              className="whitespace-nowrap px-2"
              onClick={() => setQty(q)}
            >
              {quickLabel(q, product.unit)}
            </Button>
          ))}
        </div>
      </div>
    </Dialog>
  )
}
