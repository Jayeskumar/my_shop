/**
 * Confirmation before posting a bill (GRN): what will happen — stock coming in, the amount owed
 * to the supplier and its due date, and the price changes (purchase price → landed cost always;
 * MRP / selling price when "update prices" is on). Expired batches need an explicit OK.
 */
import { Boxes, IndianRupee, Tags } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Checkbox, Dialog, Money } from '@/components/ui'
import { formatDate } from '@/lib/format'
import { localizedName } from '@/lib/i18n'
import type { PlannedPriceChange } from '../lib/bill-form'

export interface PostSummary {
  supplier_name: string
  line_count: number
  stock_lines: number
  /** Batch-tracked lines (new / updated batches). */
  batch_lines: number
  payable_paise: number
  due_date: string | null
  price_changes: PlannedPriceChange[]
  has_expired: boolean
  warning_count: number
}

export interface PostBillDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  summary: PostSummary | null
  posting: boolean
  onConfirm: (opts: { update_prices: boolean; allow_past_expiry: boolean }) => void
}

const MAX_PRICE_ROWS = 8

export function PostBillDialog({ open, onOpenChange, summary, posting, onConfirm }: PostBillDialogProps) {
  const { t } = useTranslation(['purchases', 'common'])
  const [updatePrices, setUpdatePrices] = useState(true)
  const [allowExpired, setAllowExpired] = useState(false)
  useEffect(() => {
    if (open) {
      setUpdatePrices(true)
      setAllowExpired(false)
    }
  }, [open])
  if (!summary) return null
  const optional = summary.price_changes.filter((c) => c.field !== 'purchase_price_paise')
  const shown = updatePrices ? summary.price_changes : summary.price_changes.filter((c) => c.field === 'purchase_price_paise')
  const blocked = summary.has_expired && !allowExpired

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !posting && onOpenChange(o)}
      title={t('post.title')}
      description={t('post.description', { name: summary.supplier_name })}
      dismissible={!posting}
      size="lg"
      footer={
        <>
          <Button variant="outline" disabled={posting} onClick={() => onOpenChange(false)}>
            {t('post.back')}
          </Button>
          <Button
            variant="success"
            loading={posting}
            disabled={blocked}
            onClick={() => onConfirm({ update_prices: updatePrices, allow_past_expiry: allowExpired })}
          >
            {t('post.confirm')}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex items-start gap-3 rounded-lg border border-border p-3">
            <Boxes className="mt-0.5 size-5 text-primary" aria-hidden />
            <div>
              <div className="text-sm font-semibold">{t('post.stock_in')}</div>
              <div className="text-sm text-muted-foreground">
                {t('post.stock_in_detail', { count: summary.stock_lines })}
              </div>
              {summary.batch_lines > 0 ? (
                <div className="text-xs text-muted-foreground">
                  {t('post.batches', { count: summary.batch_lines })}
                </div>
              ) : null}
            </div>
          </div>
          <div className="flex items-start gap-3 rounded-lg border border-border p-3">
            <IndianRupee className="mt-0.5 size-5 text-accent" aria-hidden />
            <div>
              <div className="text-sm font-semibold">{t('post.payable')}</div>
              <Money paise={summary.payable_paise} className="text-lg font-bold" />
              <div className="text-xs text-muted-foreground">
                {summary.due_date
                  ? t('post.due_on', { date: formatDate(summary.due_date) })
                  : t('post.no_due_date')}
              </div>
            </div>
          </div>
        </div>

        <section aria-labelledby="post-prices" className="grid gap-2">
          <div className="flex items-center gap-2">
            <Tags className="size-4 text-muted-foreground" aria-hidden />
            <h3 id="post-prices" className="text-sm font-semibold">
              {t('post.price_updates')}
            </h3>
          </div>
          <Checkbox
            checked={updatePrices}
            onCheckedChange={(v) => setUpdatePrices(v === true)}
            label={t('post.update_prices')}
            description={
              optional.length > 0
                ? t('post.update_prices_hint', { count: optional.length })
                : t('post.update_prices_none')
            }
          />
          {shown.length > 0 ? (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-surface-2 text-xs text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-3 py-1.5 text-start font-medium">
                      {t('post.col_item')}
                    </th>
                    <th scope="col" className="px-3 py-1.5 text-start font-medium">
                      {t('post.col_price')}
                    </th>
                    <th scope="col" className="px-3 py-1.5 text-end font-medium">
                      {t('post.col_old')}
                    </th>
                    <th scope="col" className="px-3 py-1.5 text-end font-medium">
                      {t('post.col_new')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.slice(0, MAX_PRICE_ROWS).map((c) => (
                    <tr key={`${c.key}-${c.field}`} className="border-t border-border/70">
                      <td className="max-w-48 truncate px-3 py-1.5">
                        {localizedName(c.product.name, c.product.name_ta)}
                      </td>
                      <td className="px-3 py-1.5 text-muted-foreground">{t(`post.field.${c.field}`)}</td>
                      <td className="px-3 py-1.5 text-end">
                        <Money paise={c.old_paise} />
                      </td>
                      <td className="px-3 py-1.5 text-end font-medium">
                        <Money paise={c.new_paise} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {shown.length > MAX_PRICE_ROWS ? (
                <p className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
                  {t('post.more_changes', { count: shown.length - MAX_PRICE_ROWS })}
                </p>
              ) : null}
            </div>
          ) : null}
        </section>

        {summary.has_expired ? (
          <div className="rounded-lg border border-danger/40 bg-danger-soft/40 p-3">
            <Checkbox
              checked={allowExpired}
              onCheckedChange={(v) => setAllowExpired(v === true)}
              label={t('post.allow_expired')}
              description={t('post.allow_expired_hint')}
            />
          </div>
        ) : null}
        {summary.warning_count > 0 ? (
          <p className="text-sm text-warning">{t('post.warnings', { count: summary.warning_count })}</p>
        ) : null}
        <p className="text-xs text-muted-foreground">{t('post.final_note')}</p>
      </div>
    </Dialog>
  )
}
