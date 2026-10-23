/**
 * Bill discount (F6) as a percentage or a flat amount, with the cashier's limit
 * (settings.pos.max_discount_bp_without_override): above it the bill needs a manager
 * (sales.discount_override — switch cashier with the PIN).
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { discountBpOf } from '@kadai/shared/api/sales'
import { Button, Dialog, MoneyInput, NumberInput } from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatBp, formatMoney } from '@/lib/format'
import { usePos } from '../state/pos-context'

type Mode = 'percent' | 'amount'

export function BillDiscountDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('pos')
  const pos = usePos()
  const cart = pos.cart
  const [mode, setMode] = useState<Mode>(cart.bill_discount_paise > 0 ? 'amount' : 'percent')
  const [bp, setBp] = useState<number | null>(cart.bill_discount_bp || null)
  const [paise, setPaise] = useState<number | null>(cart.bill_discount_paise || null)
  const limitBp = pos.context?.settings.pos.max_discount_bp_without_override ?? 1000
  // Σ line net after item discounts (incl. offers): what the bill discount applies to.
  const base = Math.max(0, pos.pricing.result.gross_paise - pos.pricing.result.item_discount_paise)
  const discount = mode === 'percent' ? Math.round((base * (bp ?? 0)) / 10_000) : (paise ?? 0)
  const asBp = discountBpOf(base, discount)
  const overLimit = asBp > limitBp && !pos.perms.discountOverride
  const tooMuch = discount > base

  const apply = (): void => {
    pos.dispatch({
      type: 'set_bill_discount',
      discount_bp: mode === 'percent' ? (bp ?? 0) : 0,
      discount_paise: mode === 'amount' ? (paise ?? 0) : 0,
    })
    onClose()
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('discount.title')}
      description={t('discount.description', { limit: formatBp(limitBp) })}
      size="sm"
      footer={
        <>
          {cart.bill_discount_bp || cart.bill_discount_paise ? (
            <Button
              variant="ghost"
              onClick={() => {
                pos.dispatch({ type: 'set_bill_discount', discount_bp: 0, discount_paise: 0 })
                onClose()
              }}
            >
              {t('discount.remove')}
            </Button>
          ) : null}
          <Button variant="outline" onClick={onClose}>
            {t('discount.cancel')}
          </Button>
          <Button onClick={apply} disabled={tooMuch}>
            {t('discount.apply')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 pb-2">
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-surface-2 p-1" role="tablist">
          {(['percent', 'amount'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={cn(
                'rounded-md py-2 text-sm font-semibold',
                mode === m ? 'bg-surface shadow-card' : 'text-muted-foreground',
              )}
            >
              {m === 'percent' ? t('discount.percent') : t('discount.amount')}
            </button>
          ))}
        </div>
        {mode === 'percent' ? (
          <>
            <NumberInput
              value={bp}
              onChange={setBp}
              scale={100}
              decimals={2}
              min={0}
              max={10_000}
              suffix="%"
              size="xl"
              autoFocus
              aria-label={t('discount.percent')}
              onKeyDown={(e) => e.key === 'Enter' && !tooMuch && apply()}
            />
            <div className="flex flex-wrap gap-2">
              {[250, 500, 1000, 1500].map((v) => (
                <Button key={v} variant="outline" onClick={() => setBp(v)}>
                  {formatBp(v)}
                </Button>
              ))}
            </div>
          </>
        ) : (
          <MoneyInput
            value={paise}
            onChange={setPaise}
            size="xl"
            autoFocus
            aria-label={t('discount.amount')}
            onKeyDown={(e) => e.key === 'Enter' && !tooMuch && apply()}
          />
        )}
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">
            {t('discount.discount_of', { base: formatMoney(base) })}
          </span>
          <span className="font-semibold tabular-nums">
            −{formatMoney(Math.min(discount, base))} ({formatBp(asBp)})
          </span>
        </div>
        {overLimit ? (
          <p
            className="rounded-md bg-warning-soft p-2 text-sm text-warning-soft-foreground"
            role="alert"
          >
            {t('discount.over_limit')}
          </p>
        ) : null}
      </div>
    </Dialog>
  )
}
