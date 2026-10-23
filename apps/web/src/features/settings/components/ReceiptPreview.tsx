/**
 * Live preview of a sample bill with the invoice settings being edited: paper (58 / 80 mm thermal
 * or A4), bilingual names and labels, HSN, MRP savings, round-off, UPI QR, footer, terms and the
 * number of copies. Prices come from the shared pricing engine for the shop's GST scheme. The
 * preview is a picture of paper, so it stays white in dark mode.
 */
import QRCode from 'qrcode'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatSeriesNumber } from '@kadai/shared/api/identity'
import {
  COMPOSITION_DECLARATION,
  INVOICE_COPY_LABELS,
  SALES_DOC_TITLES,
  SAVINGS_LABEL,
} from '@kadai/shared/api/sales'
import { formatDateDisplay, fyOf, fyShort, todayIn } from '@kadai/shared/fy'
import { formatINR } from '@kadai/shared/money'
import type { TenantSettings } from '@kadai/shared/settings'
import { buildUpiUri } from '@kadai/shared/upi'
import { amountInWords as words } from '@kadai/shared/words'
import { useAuth, useCurrentStore } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { SAMPLE_ITEMS, sampleBill } from '../lib/receipt-sample'

type Invoice = TenantSettings['invoice']
type ReceiptLabel =
  'item' | 'qty' | 'rate' | 'amount' | 'taxable' | 'round_off' | 'total' | 'scan_pay'

const SAMPLE_VPA = 'kadai.sample@upi'

function useQrSvg(text: string | null): string | null {
  const [svg, setSvg] = useState<string | null>(null)
  useEffect(() => {
    if (!text) {
      setSvg(null)
      return
    }
    let cancelled = false
    QRCode.toString(text, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' })
      .then((s) => {
        if (!cancelled) setSvg(s)
      })
      .catch(() => {
        if (!cancelled) setSvg(null)
      })
    return () => {
      cancelled = true
    }
  }, [text])
  return svg
}

export function ReceiptPreview({ invoice }: { invoice: Invoice }) {
  const { t } = useTranslation('settings')
  // Printed labels follow the bill's languages, not the screen language.
  const printed = (key: ReceiptLabel) => ({
    en: t(`receipt.${key}`, { lng: 'en' }),
    ta: t(`receipt.${key}`, { lng: 'ta' }),
  })
  const tenant = useAuth((s) => s.me?.tenant ?? null)
  const store = useCurrentStore()
  const scheme = tenant?.gst_scheme ?? 'regular'
  const bill = useMemo(() => sampleBill(scheme, invoice), [scheme, invoice])
  const primaryTa = (tenant?.default_locale ?? 'ta') === 'ta'
  const both = invoice.bilingual
  const r = bill.result
  const today = todayIn(tenant?.timezone)
  const number = formatSeriesNumber(
    `${store?.code ?? 'S1'}-A/${fyShort(fyOf(today, tenant?.fy_start_month ?? 4))}/`,
    42,
    5,
  )
  const upiText = useMemo(() => {
    if (!invoice.upi_qr_on_invoice) return null
    try {
      return buildUpiUri({
        vpa: SAMPLE_VPA,
        payee_name: tenant?.name ?? 'StockSense',
        amount_paise: r.total_paise,
        note: number,
      })
    } catch {
      return null
    }
  }, [invoice.upi_qr_on_invoice, tenant?.name, r.total_paise, number])
  const qr = useQrSvg(upiText)

  const label = (b: { en: string; ta: string }): string =>
    both ? (primaryTa ? `${b.ta} / ${b.en}` : `${b.en} / ${b.ta}`) : primaryTa ? b.ta : b.en
  const itemName = (i: (typeof SAMPLE_ITEMS)[number]): { main: string; sub: string | null } => {
    const en = t(`receipt.items.${i.key}`, { lng: 'en' })
    const ta = t(`receipt.items.${i.key}`, { lng: 'ta' })
    return both
      ? primaryTa
        ? { main: ta, sub: en }
        : { main: en, sub: ta }
      : { main: primaryTa ? ta : en, sub: null }
  }
  const shopMain = primaryTa && tenant?.name_ta ? tenant.name_ta : (tenant?.name ?? 'StockSense')
  const shopSub = both && tenant?.name_ta ? (primaryTa ? tenant.name : tenant.name_ta) : null
  const address = [tenant?.address.line1, tenant?.address.city, tenant?.address.pincode]
    .filter(Boolean)
    .join(', ')
  const gstin = store?.gstin ?? tenant?.gstin ?? null
  const a4 = invoice.print_format === 'a4'
  const width =
    invoice.print_format === 'thermal_58'
      ? 'max-w-[15rem]'
      : invoice.print_format === 'thermal_80'
        ? 'max-w-[19rem]'
        : 'max-w-full'
  const money = (p: number) => formatINR(p, { symbol: false })
  const qtyText = (milli: number) => String(milli / 1000)
  const copies = Math.min(Math.max(invoice.copies, 1), INVOICE_COPY_LABELS.length)

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="font-semibold uppercase tracking-wide">{t('invoice.preview')}</span>
        <span>{t('invoice.preview_copies', { count: invoice.copies })}</span>
      </div>
      <div className="rounded-xl border border-border bg-surface-2 p-3 sm:p-4">
        <div
          role="img"
          aria-label={t('invoice.preview_alt')}
          className={cn(
            'mx-auto w-full bg-white text-neutral-900 shadow-raised',
            a4
              ? 'rounded-sm p-4 font-sans text-[10px] leading-snug'
              : 'p-3 font-mono text-[10.5px] leading-snug',
            width,
          )}
        >
          {a4 && copies > 1 ? (
            <div className="mb-1 text-end text-[9px] uppercase text-neutral-500">
              {label(INVOICE_COPY_LABELS[0]!)}
            </div>
          ) : null}
          <div className={cn(a4 ? 'flex items-start justify-between gap-3' : 'text-center')}>
            <div className={cn(!a4 && 'text-center')}>
              <div className={cn('font-bold', a4 ? 'text-sm' : 'text-[12px]')}>{shopMain}</div>
              {shopSub ? <div className="text-neutral-600">{shopSub}</div> : null}
              {address ? <div className="text-neutral-600">{address}</div> : null}
              {tenant?.phone ? <div className="text-neutral-600">{tenant.phone}</div> : null}
              {gstin && scheme !== 'unregistered' ? <div>GSTIN: {gstin}</div> : null}
            </div>
            {a4 ? (
              <div className="text-end">
                <div className="text-sm font-bold uppercase">
                  {label(SALES_DOC_TITLES[bill.docType])}
                </div>
                <div>{number}</div>
                <div>{formatDateDisplay(today)}</div>
              </div>
            ) : null}
          </div>
          {!a4 ? (
            <>
              <div className="my-1.5 border-t border-dashed border-neutral-400" />
              <div className="text-center font-bold uppercase">
                {label(SALES_DOC_TITLES[bill.docType])}
              </div>
              <div className="flex justify-between">
                <span>{number}</span>
                <span>{formatDateDisplay(today)}</span>
              </div>
            </>
          ) : null}
          <div className="my-1.5 border-t border-dashed border-neutral-400" />
          <table className="w-full border-collapse">
            <thead>
              <tr className="text-start text-neutral-600">
                <th className="py-0.5 text-start font-semibold">{label(printed('item'))}</th>
                {invoice.show_hsn && a4 ? <th className="text-start font-semibold">HSN</th> : null}
                <th className="text-end font-semibold">{label(printed('qty'))}</th>
                <th className="text-end font-semibold">{label(printed('rate'))}</th>
                <th className="text-end font-semibold">{label(printed('amount'))}</th>
              </tr>
            </thead>
            <tbody>
              {SAMPLE_ITEMS.map((item, i) => {
                const name = itemName(item)
                const line = r.lines[i]
                return (
                  <tr key={item.key} className="align-top">
                    <td className="py-0.5 pe-1">
                      <div>{name.main}</div>
                      {name.sub ? <div className="text-neutral-500">{name.sub}</div> : null}
                      {invoice.show_hsn && !a4 ? (
                        <div className="text-neutral-500">
                          HSN {item.hsn}
                          {scheme === 'regular' ? ` · GST ${item.gst_rate_bp / 100}%` : ''}
                        </div>
                      ) : null}
                    </td>
                    {invoice.show_hsn && a4 ? <td className="pe-1">{item.hsn}</td> : null}
                    <td className="text-end tabular-nums">{qtyText(item.qty_milli)}</td>
                    <td className="text-end tabular-nums">{money(item.unit_price_paise)}</td>
                    <td className="text-end tabular-nums">{money(line?.total_paise ?? 0)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div className="my-1.5 border-t border-dashed border-neutral-400" />
          <dl className="flex flex-col gap-0.5">
            {scheme === 'regular' ? (
              <>
                <div className="flex justify-between">
                  <dt>{label(printed('taxable'))}</dt>
                  <dd className="tabular-nums">{money(r.taxable_paise)}</dd>
                </div>
                {r.tax_breakup.map((row) => (
                  <div key={row.gst_rate_bp} className="flex justify-between text-neutral-600">
                    <dt>
                      CGST {row.gst_rate_bp / 200}% + SGST {row.gst_rate_bp / 200}%
                    </dt>
                    <dd className="tabular-nums">{money(row.cgst_paise + row.sgst_paise)}</dd>
                  </div>
                ))}
              </>
            ) : null}
            {invoice.round_off === 'nearest_rupee' && r.round_off_paise !== 0 ? (
              <div className="flex justify-between text-neutral-600">
                <dt>{label(printed('round_off'))}</dt>
                <dd className="tabular-nums">{money(r.round_off_paise)}</dd>
              </div>
            ) : null}
            <div className={cn('flex justify-between font-bold', a4 ? 'text-xs' : 'text-[12px]')}>
              <dt>{label(printed('total'))}</dt>
              <dd className="tabular-nums">{formatINR(r.total_paise)}</dd>
            </div>
          </dl>
          <div className="mt-1 text-neutral-600">
            {primaryTa || both ? <div>{words(r.total_paise, 'ta')}</div> : null}
            {!primaryTa || both ? <div>{words(r.total_paise, 'en')}</div> : null}
          </div>
          {invoice.show_mrp_savings && r.mrp_savings_paise > 0 ? (
            <div className="mt-1.5 rounded-sm border border-neutral-300 px-1.5 py-1 text-center font-semibold">
              {label(SAVINGS_LABEL)} {formatINR(r.mrp_savings_paise)}
            </div>
          ) : null}
          {scheme === 'composition' ? (
            <div className="mt-1.5 text-center text-[9px] text-neutral-600">
              {label(COMPOSITION_DECLARATION)}
            </div>
          ) : null}
          {invoice.upi_qr_on_invoice ? (
            <div className="mt-2 flex flex-col items-center gap-1">
              {qr ? (
                <div
                  className="size-20 [&_svg]:size-full"
                  // Generated locally by the qrcode library from our own UPI link.
                  dangerouslySetInnerHTML={{ __html: qr }}
                />
              ) : (
                <div className="size-20 bg-neutral-100" />
              )}
              <div className="text-center text-neutral-600">{label(printed('scan_pay'))}</div>
            </div>
          ) : null}
          {invoice.footer_text || (both && invoice.footer_text_ta) ? (
            <>
              <div className="my-1.5 border-t border-dashed border-neutral-400" />
              <div className="text-center">
                {primaryTa || both ? (
                  invoice.footer_text_ta ? (
                    <div className="whitespace-pre-line">{invoice.footer_text_ta}</div>
                  ) : null
                ) : null}
                {!primaryTa || both ? (
                  invoice.footer_text ? (
                    <div className="whitespace-pre-line">{invoice.footer_text}</div>
                  ) : null
                ) : null}
              </div>
            </>
          ) : null}
          {invoice.terms ? (
            <div className="mt-1.5 whitespace-pre-line text-[9px] text-neutral-500">
              {invoice.terms}
            </div>
          ) : null}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t('invoice.preview_note')}</p>
    </div>
  )
}
