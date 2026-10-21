/**
 * Read-only building blocks of the invoice / credit-note pages: item lines (table on desktop,
 * cards on phones), totals with amount in words, GST breakup by rate, payments / refunds and the
 * audit trail snippet.
 */
import {
  Banknote,
  CircleEllipsis,
  CreditCard,
  FileText,
  History,
  Landmark,
  Smartphone,
  Wallet,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { InvoicePayment, TaxBreakupRowOut } from '@kadai/shared/api/sales'
import type { PaymentMethod } from '@kadai/shared/enums'
import { stateTaxLabel } from '@kadai/shared/gst'
import { formatBp } from '@kadai/shared/money'
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Money,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui'
import { cn } from '@/lib/cn'
import { amountInWords, formatDate, formatDateTime, formatMoney } from '@/lib/format'
import { translate } from '@/lib/i18n'
import type { TranslationKey } from '@/lib/i18n-resources'
import { useBreakpoint } from '@/lib/use-media-query'
import { bilingual, langOf, methodLabel, qtyText } from '../lib/labels'

// ---- lines -------------------------------------------------------------------------------------

export interface DocLine {
  id: string
  line_no: number
  name: string
  name_ta: string | null
  hsn_code: string | null
  batch_no: string | null
  expiry_date: string | null
  unit: string
  pack_size: number
  qty_milli: number
  free_qty_milli?: number
  mrp_paise?: number | null
  unit_price_paise: number
  discount_paise?: number
  taxable_paise: number
  gst_rate_bp: number
  cgst_paise: number
  sgst_paise: number
  igst_paise: number
  cess_rate_bp: number
  cess_paise: number
  total_paise: number
  /** Extra chips (returned qty, promotion, restock…). */
  tags?: ReactNode
  /** Extra text lines (variant, serials, note). */
  details?: readonly string[]
}

function LineName({ line }: { line: DocLine }) {
  const { t, i18n } = useTranslation('sales')
  const names = bilingual(line.name, line.name_ta, i18n.language)
  const meta = [
    line.batch_no ? t('lines.batch', { batch: line.batch_no }) : null,
    line.expiry_date ? t('lines.expiry', { date: formatDate(line.expiry_date) }) : null,
    line.hsn_code ? t('lines.hsn', { code: line.hsn_code }) : null,
  ].filter(Boolean)
  return (
    <div className="min-w-0">
      <div className="font-medium">{names.primary}</div>
      {names.secondary ? (
        <div className="text-xs text-muted-foreground">{names.secondary}</div>
      ) : null}
      {meta.length ? <div className="text-xs text-muted-foreground">{meta.join(' · ')}</div> : null}
      {line.details?.map((d) => (
        <div key={d} className="text-xs text-muted-foreground">
          {d}
        </div>
      ))}
      {line.tags ? <div className="mt-1 flex flex-wrap gap-1">{line.tags}</div> : null}
    </div>
  )
}

function taxOf(line: DocLine): number {
  return line.cgst_paise + line.sgst_paise + line.igst_paise + line.cess_paise
}

export function LinesTable({ lines, label }: { lines: readonly DocLine[]; label: string }) {
  const { t, i18n } = useTranslation('sales')
  const desktop = useBreakpoint('md')
  const hasDiscount = lines.some((l) => (l.discount_paise ?? 0) > 0)
  if (!desktop) {
    return (
      <ul className="divide-y divide-border" aria-label={label}>
        {lines.map((line) => (
          <li key={line.id} className="flex items-start justify-between gap-3 py-3">
            <div className="min-w-0 flex-1">
              <LineName line={line} />
              <div className="mt-1 text-sm text-muted-foreground tabular-nums">
                {qtyText(line.qty_milli, line.unit, line.pack_size, i18n.language)} ×{' '}
                <Money paise={line.unit_price_paise} />
                {line.gst_rate_bp > 0
                  ? ` · ${t('lines.gst_at', { rate: formatBp(line.gst_rate_bp) })}`
                  : ''}
              </div>
            </div>
            <div className="text-end">
              <Money paise={line.total_paise} className="font-semibold" />
              {(line.discount_paise ?? 0) > 0 ? (
                <div className="text-xs text-success">
                  {t('lines.discount_short')} <Money paise={line.discount_paise ?? 0} />
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    )
  }
  return (
    <Table aria-label={label}>
      <TableHeader>
        <TableRow>
          <TableHead className="w-10">#</TableHead>
          <TableHead>{t('lines.item')}</TableHead>
          <TableHead className="text-end">{t('lines.qty')}</TableHead>
          <TableHead className="text-end">{t('lines.rate')}</TableHead>
          {hasDiscount ? <TableHead className="text-end">{t('lines.discount')}</TableHead> : null}
          <TableHead className="text-end">{t('lines.gst')}</TableHead>
          <TableHead className="text-end">{t('lines.amount')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {lines.map((line) => (
          <TableRow key={line.id}>
            <TableCell className="align-top text-muted-foreground tabular-nums">
              {line.line_no}
            </TableCell>
            <TableCell className="min-w-44 align-top">
              <LineName line={line} />
            </TableCell>
            <TableCell className="text-end align-top whitespace-nowrap tabular-nums">
              {qtyText(line.qty_milli, line.unit, line.pack_size, i18n.language)}
              {(line.free_qty_milli ?? 0) > 0 ? (
                <div className="text-xs text-success">
                  {t('lines.free', {
                    qty: qtyText(
                      line.free_qty_milli ?? 0,
                      line.unit,
                      line.pack_size,
                      i18n.language,
                    ),
                  })}
                </div>
              ) : null}
            </TableCell>
            <TableCell className="text-end align-top whitespace-nowrap">
              <Money paise={line.unit_price_paise} />
              {line.mrp_paise && line.mrp_paise > line.unit_price_paise ? (
                <div className="text-xs text-muted-foreground">
                  {t('lines.mrp')} <Money paise={line.mrp_paise} />
                </div>
              ) : null}
            </TableCell>
            {hasDiscount ? (
              <TableCell className="text-end align-top">
                {(line.discount_paise ?? 0) > 0 ? (
                  <Money paise={line.discount_paise ?? 0} className="text-success" />
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
            ) : null}
            {/* Taxable value under the tax (one column less: the Tamil table fits the card). */}
            <TableCell className="text-end align-top whitespace-nowrap">
              <Money paise={taxOf(line)} />
              <div className="text-xs text-muted-foreground">
                {formatBp(line.gst_rate_bp)}
                {line.cess_rate_bp > 0
                  ? ` + ${t('lines.cess', { rate: formatBp(line.cess_rate_bp) })}`
                  : ''}
              </div>
              <div className="text-xs text-muted-foreground">
                {t('lines.taxable')} <Money paise={line.taxable_paise} />
              </div>
            </TableCell>
            <TableCell className="text-end align-top whitespace-nowrap">
              <Money paise={line.total_paise} className="font-semibold" />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

// ---- totals ------------------------------------------------------------------------------------

export interface DocTotals {
  gross_paise?: number
  item_discount_paise?: number
  bill_discount_paise?: number
  loyalty_redeem_paise?: number
  taxable_paise: number
  cgst_paise: number
  sgst_paise: number
  igst_paise: number
  cess_paise: number
  round_off_paise: number
  total_paise: number
  mrp_savings_paise?: number
}

function Row({
  label,
  value,
  strong,
  tone,
}: {
  label: ReactNode
  value: ReactNode
  strong?: boolean
  tone?: 'success' | 'danger' | 'muted'
}) {
  return (
    <div
      className={cn(
        'flex items-baseline justify-between gap-3 py-1',
        strong && 'border-t border-border pt-2 text-base font-semibold',
        tone === 'success' && 'text-success',
        tone === 'danger' && 'text-danger',
        tone === 'muted' && 'text-muted-foreground',
      )}
    >
      <dt className="min-w-0">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  )
}

export function TotalsList({
  totals,
  placeOfSupply,
  after,
  estimate = false,
}: {
  totals: DocTotals
  placeOfSupply: string
  /** Rows after the total (paid, returned, due). */
  after?: ReactNode
  /** Estimates speak of the quoted prices, not of a bill. */
  estimate?: boolean
}) {
  const { t, i18n } = useTranslation('sales')
  const sgstLabel = stateTaxLabel(placeOfSupply)
  const discount = (totals.item_discount_paise ?? 0) + (totals.bill_discount_paise ?? 0)
  const lang = langOf(i18n.language)
  return (
    <div>
      <dl className="text-sm">
        {totals.gross_paise !== undefined && discount > 0 ? (
          <Row label={t('totals.gross')} value={<Money paise={totals.gross_paise} />} />
        ) : null}
        {(totals.item_discount_paise ?? 0) > 0 ? (
          <Row
            label={t('totals.item_discount')}
            value={
              <>
                −<Money paise={totals.item_discount_paise ?? 0} />
              </>
            }
            tone="success"
          />
        ) : null}
        {(totals.bill_discount_paise ?? 0) > 0 ? (
          <Row
            label={
              (totals.loyalty_redeem_paise ?? 0) > 0
                ? t('totals.bill_discount_loyalty', {
                    amount: formatMoneyText(totals.loyalty_redeem_paise ?? 0),
                  })
                : t('totals.bill_discount')
            }
            value={
              <>
                −<Money paise={totals.bill_discount_paise ?? 0} />
              </>
            }
            tone="success"
          />
        ) : null}
        <Row label={t('totals.taxable')} value={<Money paise={totals.taxable_paise} />} />
        {totals.cgst_paise > 0 ? (
          <Row label="CGST" value={<Money paise={totals.cgst_paise} />} tone="muted" />
        ) : null}
        {totals.sgst_paise > 0 ? (
          <Row label={sgstLabel} value={<Money paise={totals.sgst_paise} />} tone="muted" />
        ) : null}
        {totals.igst_paise > 0 ? (
          <Row label="IGST" value={<Money paise={totals.igst_paise} />} tone="muted" />
        ) : null}
        {totals.cess_paise > 0 ? (
          <Row label={t('totals.cess')} value={<Money paise={totals.cess_paise} />} tone="muted" />
        ) : null}
        {totals.round_off_paise !== 0 ? (
          <Row
            label={t('totals.round_off')}
            value={
              <>
                {totals.round_off_paise > 0 ? '+' : '−'}
                <Money paise={Math.abs(totals.round_off_paise)} />
              </>
            }
            tone="muted"
          />
        ) : null}
        <Row label={t('totals.total')} value={<Money paise={totals.total_paise} />} strong />
        {after}
      </dl>
      <p className="mt-2 text-xs text-muted-foreground">
        {amountInWords(totals.total_paise, lang)}
      </p>
      {(totals.mrp_savings_paise ?? 0) + discount > 0 ? (
        <p className="mt-2 rounded-md bg-success-soft px-3 py-2 text-sm font-medium text-success-soft-foreground">
          {t(estimate ? 'totals.you_save_estimate' : 'totals.you_saved', {
            amount: formatMoneyText((totals.mrp_savings_paise ?? 0) + discount),
          })}
        </p>
      ) : null}
    </div>
  )
}

/** Extra totals rows helper (paid / returned / due). */
export function TotalsRow(props: {
  label: ReactNode
  paise: number
  tone?: 'success' | 'danger' | 'muted'
  strong?: boolean
}) {
  return (
    <Row
      label={props.label}
      value={<Money paise={props.paise} />}
      tone={props.tone}
      strong={props.strong}
    />
  )
}

function formatMoneyText(paise: number): string {
  return formatMoney(paise, { decimals: 'auto' })
}

// ---- tax breakup -------------------------------------------------------------------------------

export function TaxBreakup({
  rows,
  placeOfSupply,
}: {
  rows: readonly TaxBreakupRowOut[]
  placeOfSupply: string
}) {
  const { t } = useTranslation('sales')
  const desktop = useBreakpoint('sm')
  if (rows.length === 0) return null
  const interstate = rows.some((r) => r.igst_paise > 0)
  const hasCess = rows.some((r) => r.cess_paise > 0)
  if (!desktop) {
    return (
      <ul className="divide-y divide-border text-sm" aria-label={t('tax.title')}>
        {rows.map((r) => (
          <li key={r.gst_rate_bp} className="py-2">
            <div className="flex justify-between font-medium">
              <span>{t('lines.gst_at', { rate: formatBp(r.gst_rate_bp) })}</span>
              <Money paise={r.cgst_paise + r.sgst_paise + r.igst_paise + r.cess_paise} />
            </div>
            <div className="text-xs text-muted-foreground">
              {[
                `${t('tax.taxable')} ${formatMoney(r.taxable_paise)}`,
                interstate
                  ? `IGST ${formatMoney(r.igst_paise)}`
                  : `CGST ${formatMoney(r.cgst_paise)} · ${stateTaxLabel(placeOfSupply)} ${formatMoney(r.sgst_paise)}`,
                r.cess_paise > 0 ? `${t('totals.cess')} ${formatMoney(r.cess_paise)}` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </div>
          </li>
        ))}
      </ul>
    )
  }
  return (
    <Table aria-label={t('tax.title')} wrapperClassName="rounded-md border border-border">
      <TableHeader>
        <TableRow>
          <TableHead>{t('tax.rate')}</TableHead>
          <TableHead className="text-end">{t('tax.taxable')}</TableHead>
          {interstate ? (
            <TableHead className="text-end">IGST</TableHead>
          ) : (
            <>
              <TableHead className="text-end">CGST</TableHead>
              <TableHead className="text-end">{stateTaxLabel(placeOfSupply)}</TableHead>
            </>
          )}
          {hasCess ? <TableHead className="text-end">{t('totals.cess')}</TableHead> : null}
          <TableHead className="text-end">{t('tax.total_tax')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.gst_rate_bp}>
            <TableCell>{formatBp(r.gst_rate_bp)}</TableCell>
            <TableCell className="text-end">
              <Money paise={r.taxable_paise} />
            </TableCell>
            {interstate ? (
              <TableCell className="text-end">
                <Money paise={r.igst_paise} />
              </TableCell>
            ) : (
              <>
                <TableCell className="text-end">
                  <Money paise={r.cgst_paise} />
                </TableCell>
                <TableCell className="text-end">
                  <Money paise={r.sgst_paise} />
                </TableCell>
              </>
            )}
            {hasCess ? (
              <TableCell className="text-end">
                <Money paise={r.cess_paise} />
              </TableCell>
            ) : null}
            <TableCell className="text-end font-medium">
              <Money paise={r.cgst_paise + r.sgst_paise + r.igst_paise + r.cess_paise} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

// ---- payments ----------------------------------------------------------------------------------

const METHOD_ICONS: Record<PaymentMethod, ReactNode> = {
  cash: <Banknote />,
  upi: <Smartphone />,
  card: <CreditCard />,
  bank_transfer: <Landmark />,
  cheque: <FileText />,
  wallet: <Wallet />,
  store_credit: <Wallet />,
  other: <CircleEllipsis />,
}

export function MethodIcon({ method }: { method: PaymentMethod }) {
  return (
    <span
      className="flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted-foreground [&_svg]:size-4"
      aria-hidden
    >
      {METHOD_ICONS[method]}
    </span>
  )
}

export function PaymentsList({
  payments,
  timezone,
  empty,
}: {
  payments: readonly InvoicePayment[]
  timezone?: string
  empty: ReactNode
}) {
  const { t, i18n } = useTranslation('sales')
  if (payments.length === 0) {
    return <p className="py-2 text-sm text-muted-foreground">{empty}</p>
  }
  return (
    <ul className="divide-y divide-border">
      {payments.map((p) => {
        const cancelled = p.status === 'cancelled'
        const refund = p.direction === 'out'
        return (
          <li key={`${p.payment_id}-${p.direction}`} className="flex items-start gap-3 py-3">
            <MethodIcon method={p.method} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{methodLabel(p.method, i18n.language)}</span>
                {refund ? (
                  <Badge tone="info" size="sm">
                    {t('payments.refund')}
                  </Badge>
                ) : null}
                {cancelled ? (
                  <Badge tone="danger" size="sm">
                    {t('payments.cancelled')}
                  </Badge>
                ) : null}
                {p.number ? (
                  <span className="text-xs text-muted-foreground">{p.number}</span>
                ) : null}
              </div>
              <div className="text-xs text-muted-foreground">
                {[
                  formatDateTime(p.paid_at, timezone),
                  p.created_by_name,
                  p.reference ? t('payments.reference', { ref: p.reference }) : null,
                  p.payer_vpa,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
              {p.change_paise && p.change_paise > 0 ? (
                <div className="text-xs text-muted-foreground">
                  {t('payments.tendered_change', {
                    tendered: formatMoneyText(p.amount_paise + p.change_paise),
                    change: formatMoneyText(p.change_paise),
                  })}
                </div>
              ) : null}
            </div>
            <Money
              paise={p.amount_paise}
              className={cn('font-semibold', cancelled && 'line-through opacity-60')}
            />
          </li>
        )
      })}
    </ul>
  )
}

// ---- audit -------------------------------------------------------------------------------------

export function AuditTrail({
  entries,
  timezone,
}: {
  entries: readonly {
    id: number
    action: string
    summary: string | null
    user_name: string | null
    created_at: string
  }[]
  timezone?: string
}) {
  const { t, i18n } = useTranslation('sales')
  if (entries.length === 0) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <History className="size-4 text-muted-foreground" aria-hidden />
          {t('audit.title')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="relative flex flex-col gap-3 border-s border-border ps-4">
          {entries.map((e) => {
            const key = `sales:audit.actions.${e.action.replace(/\./g, '_')}`
            const known = i18n.exists(key)
            const label = known ? translate(key as TranslationKey) : (e.summary ?? e.action)
            return (
              <li key={e.id} className="relative text-sm">
                <span
                  className="absolute -start-[1.3rem] top-1.5 size-2 rounded-full bg-primary"
                  aria-hidden
                />
                <div className="font-medium">{label}</div>
                <div className="text-xs text-muted-foreground">
                  {[formatDateTime(e.created_at, timezone), e.user_name]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
                {known && e.summary ? (
                  <div className="text-xs text-muted-foreground">{e.summary}</div>
                ) : null}
              </li>
            )
          })}
        </ol>
      </CardContent>
    </Card>
  )
}

// ---- section card ------------------------------------------------------------------------------

export function Section({
  title,
  action,
  children,
  className,
}: {
  title: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <Card className={className}>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">{title}</CardTitle>
        {action}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}
