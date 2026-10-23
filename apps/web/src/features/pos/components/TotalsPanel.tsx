/**
 * Bill totals: items, gross, discounts (manual / offers / loyalty), "நீங்கள் சேமித்தது ₹x", GST,
 * round off and the big grand total. After a bill is saved the panel shows the change to hand
 * back (huge), the bill number and print / WhatsApp actions until the next item is scanned.
 */
import { CheckCircle2, CloudOff, MessageCircle, Printer, Tag } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { salesRoutes } from '@kadai/shared/api/sales'
import { toWhatsAppNumber } from '@kadai/shared/phone'
import { Badge, Button, notify } from '@/components/ui'
import { callRoute } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatMoney } from '@/lib/format'
import { getLanguage } from '@/lib/i18n'
import { usePos } from '../state/pos-context'

function Line({
  label,
  value,
  tone,
  strong,
}: {
  label: string
  value: string
  tone?: 'success' | 'muted'
  strong?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5 text-sm">
      <dt className={cn(tone === 'muted' ? 'text-muted-foreground' : '')}>{label}</dt>
      <dd
        className={cn(
          'tabular-nums',
          tone === 'success' && 'font-semibold text-success',
          strong && 'font-semibold',
        )}
      >
        {value}
      </dd>
    </div>
  )
}

export function LastSaleCard({ className }: { className?: string }) {
  const { t } = useTranslation('pos')
  const pos = usePos()
  const sale = pos.lastSale
  const [sharing, setSharing] = useState(false)
  if (!sale) return null

  const share = async (): Promise<void> => {
    if (!sale.invoice_id) return
    setSharing(true)
    try {
      const res = await callRoute(salesRoutes.shareInvoice, {
        params: { id: sale.invoice_id },
        body: { channel: 'whatsapp', locale: getLanguage() },
      })
      if (res.data.wa_me_url) window.open(res.data.wa_me_url, '_blank', 'noopener')
      else notify.success(t('done.shared'))
    } catch (e) {
      // Without WhatsApp setup the link can still be sent from the cashier's phone.
      const number = sale.customer_phone ? toWhatsAppNumber(sale.customer_phone) : null
      if (number) {
        window.open(`https://wa.me/${number}`, '_blank', 'noopener')
      } else {
        notify.error(e)
      }
    } finally {
      setSharing(false)
    }
  }

  return (
    <section
      className={cn(
        'rounded-xl border-2 border-success bg-success-soft p-4 text-success-soft-foreground',
        className,
      )}
      aria-live="polite"
      aria-label={t('done.title')}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-semibold">
        {sale.mode === 'offline' ? (
          <CloudOff className="size-5" aria-hidden />
        ) : (
          <CheckCircle2 className="size-5" aria-hidden />
        )}
        {sale.mode === 'offline' ? t('done.saved_offline') : t('done.saved')}
        {sale.number ? (
          <span className="ms-auto whitespace-nowrap font-mono text-sm">{sale.number}</span>
        ) : null}
      </div>
      {sale.change_paise > 0 ? (
        <div className="mt-3 text-center">
          <div className="text-sm font-medium">{t('done.give_change')}</div>
          <div className="text-5xl font-extrabold tabular-nums tracking-tight">
            {formatMoney(sale.change_paise)}
          </div>
        </div>
      ) : (
        <div className="mt-2 text-sm">
          {t('done.paid', { amount: formatMoney(sale.paid_paise) })}
        </div>
      )}
      {sale.due_paise > 0 ? (
        <div className="mt-2 text-sm font-semibold">
          {t('done.on_credit', {
            amount: formatMoney(sale.due_paise),
            name: sale.customer_name ?? '',
          })}
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          leftIcon={<Printer />}
          onClick={() => void pos.printLast()}
        >
          {t('done.print_again')}
        </Button>
        {sale.invoice_id && pos.online ? (
          <Button
            variant="outline"
            size="sm"
            leftIcon={<MessageCircle />}
            loading={sharing}
            onClick={() => void share()}
          >
            {t('done.whatsapp')}
          </Button>
        ) : null}
        <Button
          size="sm"
          className="ms-auto"
          onClick={() => {
            pos.dismissLastSale()
            pos.focusSearch()
          }}
        >
          {t('done.new_bill')}
        </Button>
      </div>
    </section>
  )
}

export function TotalsPanel({ className, compact }: { className?: string; compact?: boolean }) {
  const { t } = useTranslation('pos')
  const pos = usePos()
  const r = pos.pricing.result
  const discount = r.item_discount_paise + r.bill_discount_paise
  const empty = pos.cart.lines.length === 0
  return (
    <section
      className={cn('rounded-xl border border-border bg-surface p-4 shadow-card', className)}
      aria-label={t('totals.title')}
    >
      {!compact ? (
        <dl>
          <Line
            label={t('totals.items', { count: pos.pricing.item_count })}
            value={formatMoney(r.gross_paise)}
            tone="muted"
          />
          {r.item_discount_paise > 0 ? (
            <Line
              label={t('totals.item_discount')}
              value={`−${formatMoney(r.item_discount_paise)}`}
            />
          ) : null}
          {r.manual_bill_discount_paise > 0 ? (
            <Line
              label={t('totals.bill_discount')}
              value={`−${formatMoney(r.manual_bill_discount_paise)}`}
            />
          ) : null}
          {r.promotion_bill_discount_paise > 0 ? (
            <Line
              label={t('totals.offer_discount')}
              value={`−${formatMoney(r.promotion_bill_discount_paise)}`}
            />
          ) : null}
          {r.loyalty_redeem_paise > 0 ? (
            <Line
              label={t('totals.loyalty', { points: r.loyalty_points_redeemed })}
              value={`−${formatMoney(r.loyalty_redeem_paise)}`}
            />
          ) : null}
          {r.tax_paise > 0 ? (
            <Line label={t('totals.gst')} value={formatMoney(r.tax_paise)} tone="muted" />
          ) : null}
          {r.round_off_paise !== 0 ? (
            <Line
              label={t('totals.round_off')}
              value={formatMoney(r.round_off_paise)}
              tone="muted"
            />
          ) : null}
        </dl>
      ) : null}
      {r.applied_promotions.length > 0 && !compact ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {r.applied_promotions.map((p) => (
            <Badge key={p.promotion_id} tone="success" size="sm" icon={<Tag />}>
              {p.name}
            </Badge>
          ))}
        </div>
      ) : null}
      {pos.pricing.savings_paise > 0 && pos.context?.settings.invoice.show_mrp_savings !== false ? (
        <div className="mt-2 rounded-lg bg-success-soft px-3 py-1.5 text-center text-sm font-semibold text-success-soft-foreground">
          {t('totals.you_saved', { amount: formatMoney(pos.pricing.savings_paise) })}
        </div>
      ) : null}
      <div
        className={cn(
          'flex items-end justify-between gap-3',
          compact ? '' : 'mt-3 border-t border-border pt-3',
        )}
      >
        <span className="text-sm font-medium text-muted-foreground">{t('totals.grand_total')}</span>
        <span
          className={cn(
            'font-extrabold tabular-nums tracking-tight',
            compact ? 'text-3xl' : 'text-5xl',
            empty ? 'text-muted-foreground' : 'text-foreground',
          )}
          data-testid="pos-grand-total"
        >
          {formatMoney(r.total_paise)}
        </span>
      </div>
      {discount > 0 && compact ? (
        <div className="text-end text-xs text-success">
          {t('totals.discount_included', { amount: formatMoney(discount) })}
        </div>
      ) : null}
      {pos.pricing.error ? (
        <p className="mt-2 text-sm text-danger">
          {t('errors.pricing', { error: pos.pricing.error })}
        </p>
      ) : null}
    </section>
  )
}
