/**
 * Edit one bill line: quantity (unit-aware; strips + loose tablets for pack-priced medicines),
 * rate (only with sales.price_override or settings.pos.allow_price_edit; never below the
 * minimum price without the permission), line discount (% or ₹, cashier limit), note
 * (alteration / remark, printed), serial numbers, batch.
 */
import { Layers, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { discountBpOf, discountLimitBp } from '@kadai/shared/api/sales'
import { getUnit } from '@kadai/shared/units'
import {
  Button,
  Dialog,
  FormField,
  Input,
  MoneyInput,
  NumberInput,
  QtyInput,
} from '@/components/ui'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/cn'
import { formatBp, formatMoney } from '@/lib/format'
import { getLanguage } from '@/lib/i18n'
import { allowsDecimalQty, packUnitOf, qtyStepMilli } from '../lib/cart'
import { linePrice } from '../lib/pricing'
import { usePos } from '../state/pos-context'
import { ProductLabel } from '../components/ProductLabel'

export function LineEditDialog({
  lineKey,
  focus,
  onClose,
}: {
  lineKey: string
  focus?: 'qty' | 'price' | 'discount'
  onClose: () => void
}) {
  const { t } = useTranslation('pos')
  const pos = usePos()
  const line = pos.cart.lines.find((l) => l.key === lineKey)
  const product = line?.product
  const price = line ? linePrice(line, pos.cart.customer?.price_tier ?? 'retail') : null
  const [qty, setQty] = useState<number | null>(line?.qty_milli ?? null)
  const packSize = product?.pack_size ?? 1
  const [packs, setPacks] = useState<number | null>(
    line ? Math.floor(line.qty_milli / (packSize * 1000)) : null,
  )
  const [loose, setLoose] = useState<number | null>(
    line ? Math.round((line.qty_milli % (packSize * 1000)) / 1000) : null,
  )
  const [rate, setRate] = useState<number | null>(price?.unit_price_paise ?? null)
  const [discMode, setDiscMode] = useState<'percent' | 'amount'>(
    line && line.discount_paise > 0 ? 'amount' : 'percent',
  )
  const [discBp, setDiscBp] = useState<number | null>(line?.discount_bp || null)
  const [discPaise, setDiscPaise] = useState<number | null>(line?.discount_paise || null)
  const [note, setNote] = useState(line?.note ?? '')
  const [serials, setSerials] = useState((line?.serial_numbers ?? []).join('\n'))

  if (!line || !product || !price) return null

  const loosePacks = packSize > 1 && product.allow_loose
  const qtyMilli = loosePacks ? ((packs ?? 0) * packSize + (loose ?? 0)) * 1000 : (qty ?? 0)
  const gross = Math.round(((rate ?? price.unit_price_paise) * qtyMilli) / (packSize * 1000))
  const discount =
    discMode === 'percent' ? Math.round((gross * (discBp ?? 0)) / 10_000) : (discPaise ?? 0)
  const limit = discountLimitBp(
    pos.context?.settings.pos.max_discount_bp_without_override ?? 1000,
    product.max_discount_bp,
  )
  const discountBp = discountBpOf(gross, discount)
  const discountOverLimit = discountBp > limit && !pos.perms.discountOverride
  const belowMin =
    rate !== null &&
    product.min_sale_price_paise !== null &&
    rate < product.min_sale_price_paise &&
    !pos.perms.priceOverride
  const serialTracked = product.attributes['serial_tracked'] === true
  const serialList = serials
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  const unitDef = getUnit(product.unit)
  const unitLabel = unitDef
    ? getLanguage() === 'ta'
      ? unitDef.symbol_ta
      : unitDef.symbol_en_plural
    : product.unit
  const packDef = getUnit(packUnitOf(product))
  const packLabel = packDef
    ? getLanguage() === 'ta'
      ? packDef.symbol_ta
      : packDef.symbol_en_plural
    : ''
  const valid = qtyMilli > 0 && !belowMin && discount <= gross

  const save = (): void => {
    if (!valid) return
    pos.dispatch({ type: 'set_qty', key: line.key, qty_milli: qtyMilli })
    if (pos.perms.editPrice && rate !== null) {
      pos.dispatch({
        type: 'set_price',
        key: line.key,
        price_paise: rate === price.resolved_price_paise ? null : rate,
      })
    }
    pos.dispatch({
      type: 'set_discount',
      key: line.key,
      discount_bp: discMode === 'percent' ? (discBp ?? 0) : 0,
      discount_paise: discMode === 'amount' ? (discPaise ?? 0) : 0,
    })
    pos.dispatch({ type: 'set_note', key: line.key, note })
    if (serialTracked)
      pos.dispatch({ type: 'set_serials', key: line.key, serial_numbers: serialList })
    onClose()
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('line.title')}
      size="md"
      footer={
        <>
          <Button
            variant="ghost"
            className="text-danger sm:me-auto"
            leftIcon={<Trash2 />}
            onClick={() => {
              pos.dispatch({ type: 'remove', key: line.key })
              onClose()
            }}
          >
            {t('line.remove')}
          </Button>
          <Button variant="outline" onClick={onClose}>
            {t('line.cancel')}
          </Button>
          <Button onClick={save} disabled={!valid}>
            {t('line.save')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4 pb-2"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <ProductLabel
          product={product}
          batch={line.batch}
          today={pos.today}
          warningDays={pos.context?.settings.inventory.expiry_warning_days ?? 90}
        />
        {loosePacks ? (
          <div className="grid grid-cols-2 gap-3">
            <FormField label={t('line.packs', { unit: packLabel })}>
              <NumberInput
                value={packs}
                onChange={setPacks}
                min={0}
                size="lg"
                autoFocus={focus === 'qty' || !focus}
              />
            </FormField>
            <FormField
              label={t('line.loose', { unit: unitLabel })}
              hint={t('line.pack_of', { count: packSize, unit: unitLabel })}
            >
              <NumberInput value={loose} onChange={setLoose} min={0} max={packSize - 1} size="lg" />
            </FormField>
          </div>
        ) : (
          <FormField label={t('line.qty')}>
            <QtyInput
              value={qty}
              onChange={setQty}
              unit={product.unit}
              allowDecimal={allowsDecimalQty(product)}
              step={qtyStepMilli(product)}
              min={1}
              size="lg"
              autoFocus={focus === 'qty' || !focus}
            />
          </FormField>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField
            label={t('line.rate')}
            hint={
              price.mrp_paise !== null
                ? t('line.mrp', { amount: formatMoney(price.mrp_paise) })
                : undefined
            }
            error={
              belowMin
                ? t('line.below_min', { amount: formatMoney(product.min_sale_price_paise ?? 0) })
                : undefined
            }
          >
            <MoneyInput
              value={rate}
              onChange={setRate}
              size="lg"
              disabled={!pos.perms.editPrice}
              autoFocus={focus === 'price'}
            />
          </FormField>
          <FormField
            label={t('line.discount')}
            hint={t('line.discount_limit', { limit: formatBp(limit) })}
          >
            <div className="flex gap-1">
              <div className="flex shrink-0 rounded-md bg-surface-2 p-0.5">
                {(['percent', 'amount'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setDiscMode(m)}
                    aria-pressed={discMode === m}
                    className={cn(
                      'rounded px-2.5 text-sm font-semibold',
                      discMode === m ? 'bg-surface shadow-card' : 'text-muted-foreground',
                    )}
                  >
                    {m === 'percent' ? '%' : '₹'}
                  </button>
                ))}
              </div>
              {discMode === 'percent' ? (
                <NumberInput
                  value={discBp}
                  onChange={setDiscBp}
                  scale={100}
                  decimals={2}
                  min={0}
                  max={10_000}
                  suffix="%"
                  size="lg"
                  autoFocus={focus === 'discount'}
                  aria-label={t('line.discount')}
                />
              ) : (
                <MoneyInput
                  value={discPaise}
                  onChange={setDiscPaise}
                  size="lg"
                  autoFocus={focus === 'discount'}
                  aria-label={t('line.discount')}
                />
              )}
            </div>
          </FormField>
        </div>
        {discountOverLimit ? (
          <p
            className="rounded-md bg-warning-soft p-2 text-sm text-warning-soft-foreground"
            role="alert"
          >
            {t('line.discount_over_limit', { limit: formatBp(limit) })}
          </p>
        ) : null}
        <div className="flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2 text-sm">
          <span>{t('line.amount')}</span>
          <span className="text-lg font-bold tabular-nums">
            {formatMoney(Math.max(0, gross - discount))}
          </span>
        </div>
        {product.track_batches ? (
          <Button
            variant="outline"
            leftIcon={<Layers />}
            onClick={() => pos.openDialog({ name: 'batch', key: line.key })}
          >
            {line.batch
              ? t('line.change_batch', { batch: line.batch.batch_no })
              : t('line.choose_batch')}
          </Button>
        ) : null}
        {serialTracked ? (
          <FormField
            label={t('line.serials')}
            hint={t('line.serials_hint', { count: Math.floor(qtyMilli / 1000) })}
          >
            <Textarea value={serials} onChange={(e) => setSerials(e.target.value)} rows={3} />
          </FormField>
        ) : null}
        <FormField label={t('line.note')} optional>
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={200}
            placeholder={t('line.note_placeholder')}
          />
        </FormField>
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  )
}
