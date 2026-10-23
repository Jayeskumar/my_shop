/**
 * Public invoice page (/i/:token, no app chrome, no sign-in) — the link a customer gets on
 * WhatsApp / SMS. Mobile first: shop branding, the bill (items, taxes, totals, amount in words,
 * payments), and when something is due a "Pay ₹x by UPI" button (upi:// deep link that opens the
 * customer's UPI app) plus a QR for desktop screens. The customer picks Tamil or English; the page
 * language never touches the shop app's saved language. "Download / print" prints the A4 tax
 * invoice (Save as PDF on phones). Data: GET /public/v1/invoices/:shareToken (print model, no
 * internal ids or costs).
 */
import { Download, FileX2, IndianRupee, Phone, Smartphone } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router'
import { SHARE_TOKEN_RE, type PublicInvoice } from '@kadai/shared/api/sales'
import { formatDateDisplay } from '@kadai/shared/fy'
import { formatINR } from '@kadai/shared/money'
import { formatPhoneDisplay } from '@kadai/shared/phone'
import { Button, Skeleton, notify } from '@/components/ui'
import { printSalesModel, qrSvg } from '@/features/pos/print'
import { isApiError } from '@/lib/api'
import { cn } from '@/lib/cn'
import { getLanguage, type Language } from '@/lib/i18n'
import { useBreakpoint } from '@/lib/use-media-query'
import { usePublicInvoice } from '../api'

const pct = (bp: number): string => {
  const v = bp / 100
  return `${Number.isInteger(v) ? v : Number(v.toFixed(3))}%`
}

export default function PublicInvoicePage() {
  const { token = '' } = useParams()
  const valid = SHARE_TOKEN_RE.test(token)
  const query = usePublicInvoice(token, { enabled: valid })
  const [lang, setLang] = useState<Language | null>(null)
  const language: Language = lang ?? query.data?.data.document.locale.primary ?? getLanguage()

  if (!valid || query.error) {
    const missing =
      !valid ||
      (isApiError(query.error) && (query.error.status === 404 || query.error.status === 400))
    return (
      <Shell lang={language} onLang={setLang}>
        <NotAvailable lang={language} missing={missing} onRetry={() => void query.refetch()} />
      </Shell>
    )
  }
  if (!query.data) {
    return (
      <Shell lang={language} onLang={setLang}>
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-24 w-full rounded-2xl" />
          <Skeleton className="h-64 w-full rounded-2xl" />
          <Skeleton className="h-32 w-full rounded-2xl" />
        </div>
      </Shell>
    )
  }
  return (
    <Shell lang={language} onLang={setLang}>
      <InvoiceView data={query.data.data} lang={language} />
    </Shell>
  )
}

function useT(lang: Language) {
  const { i18n } = useTranslation('sales')
  return useMemo(() => i18n.getFixedT(lang, 'sales'), [i18n, lang])
}

function Shell({
  lang,
  onLang,
  children,
}: {
  lang: Language
  onLang: (lang: Language) => void
  children: ReactNode
}) {
  const t = useT(lang)
  return (
    <div lang={lang} className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col px-4 pb-10 pt-4">
      <div className="mb-3 flex justify-end">
        <div
          role="group"
          aria-label={t('public.language')}
          className="inline-flex rounded-full border border-border bg-surface p-0.5 text-sm shadow-card"
        >
          {(['ta', 'en'] as const).map((l) => (
            <button
              key={l}
              type="button"
              aria-pressed={lang === l}
              onClick={() => onLang(l)}
              className={cn(
                'h-9 min-w-20 rounded-full px-3 font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring',
                lang === l ? 'bg-primary text-primary-foreground' : 'text-muted-foreground',
              )}
            >
              {l === 'ta' ? 'தமிழ்' : 'English'}
            </button>
          ))}
        </div>
      </div>
      <main className="flex-1">{children}</main>
      <p className="mt-8 text-center text-xs text-muted-foreground">{t('public.powered_by')}</p>
    </div>
  )
}

function NotAvailable({
  lang,
  missing,
  onRetry,
}: {
  lang: Language
  missing: boolean
  onRetry: () => void
}) {
  const t = useT(lang)
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-border bg-surface px-6 py-14 text-center shadow-card">
      <span className="flex size-16 items-center justify-center rounded-2xl bg-primary-soft text-primary-soft-foreground">
        <FileX2 className="size-8" aria-hidden />
      </span>
      <h1 className="text-lg font-semibold">
        {missing ? t('public.not_found') : t('public.load_failed')}
      </h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        {missing ? t('public.not_found_hint') : t('public.load_failed_hint')}
      </p>
      {!missing ? <Button onClick={onRetry}>{t('public.retry')}</Button> : null}
    </div>
  )
}

function pick(text: { en: string; ta: string }, lang: Language): string {
  return lang === 'ta' ? text.ta || text.en : text.en || text.ta
}

function names(
  name: string,
  nameTa: string | null,
  lang: Language,
): { primary: string; secondary: string | null } {
  if (!nameTa || nameTa === name) return { primary: name, secondary: null }
  return lang === 'ta' ? { primary: nameTa, secondary: name } : { primary: name, secondary: nameTa }
}

function InvoiceView({ data, lang }: { data: PublicInvoice; lang: Language }) {
  const t = useT(lang)
  const doc = data.document
  const desktop = useBreakpoint('md')
  const [printing, setPrinting] = useState(false)
  const seller = names(doc.seller.name, doc.seller.name_ta, lang)
  // The logo of the print model is an authenticated app path; a public visitor cannot load it.
  const logo =
    doc.seller.logo_url && !doc.seller.logo_url.startsWith('/api/') ? doc.seller.logo_url : null
  const pay = data.pay
  const payQr = useMemo(
    () =>
      pay ? qrSvg(pay.upi_uri, { size: '100%', margin: 2, title: t('public.scan_to_pay') }) : null,
    [pay, t],
  )

  const download = async (): Promise<void> => {
    setPrinting(true)
    try {
      await printSalesModel(
        {
          ...doc,
          seller: { ...doc.seller, logo_url: logo },
          locale: { ...doc.locale, primary: lang },
        },
        { format: 'a4' },
      )
    } catch (error) {
      notify.error(error)
    } finally {
      setPrinting(false)
    }
  }

  const tot = doc.totals
  const taxRows: { label: string; paise: number }[] = [
    { label: 'CGST', paise: tot.cgst_paise },
    { label: doc.tax_labels.sgst, paise: tot.sgst_paise },
    { label: 'IGST', paise: tot.igst_paise },
    { label: t('totals.cess'), paise: tot.cess_paise },
  ].filter((r) => r.paise > 0)

  return (
    <div className="flex flex-col gap-4">
      {/* shop */}
      <header className="flex items-center gap-3 rounded-2xl border border-border bg-surface p-4 shadow-card">
        {logo ? (
          <img src={logo} alt="" className="size-14 rounded-xl object-contain" />
        ) : (
          <span
            aria-hidden
            className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-primary text-xl font-bold text-primary-foreground"
          >
            {Array.from(seller.primary)[0] ?? 'க'}
          </span>
        )}
        <div className="min-w-0">
          <h1 className="text-lg font-bold leading-tight">{seller.primary}</h1>
          {seller.secondary ? (
            <div className="text-sm text-muted-foreground">{seller.secondary}</div>
          ) : null}
          <div className="text-xs text-muted-foreground">{doc.seller.address_lines.join(', ')}</div>
          <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
            {doc.seller.phone ? (
              <a
                href={`tel:${doc.seller.phone}`}
                className="inline-flex items-center gap-1 text-primary"
              >
                <Phone className="size-3" aria-hidden />
                {formatPhoneDisplay(doc.seller.phone)}
              </a>
            ) : null}
            {doc.seller.gstin ? <span>GSTIN {doc.seller.gstin}</span> : null}
          </div>
        </div>
      </header>

      {/* pay */}
      {pay && !doc.document.cancelled ? (
        <section
          className="flex flex-col items-center gap-3 rounded-2xl border-2 border-primary/40 bg-primary-soft/40 p-4 text-center shadow-card"
          aria-label={t('public.pay_title')}
        >
          <div className="text-sm text-muted-foreground">{t('public.pay_title')}</div>
          <div className="text-3xl font-bold tabular-nums">{formatINR(pay.amount_paise)}</div>
          <Button
            asChild
            size="xl"
            fullWidth
            leftIcon={<Smartphone />}
            className="h-auto min-h-14 max-w-sm whitespace-normal py-3 text-center leading-snug"
          >
            <a href={pay.upi_uri}>{t('public.pay_upi', { amount: formatINR(pay.amount_paise) })}</a>
          </Button>
          {pay.short_url ? (
            <Button asChild variant="outline" leftIcon={<IndianRupee />}>
              <a href={pay.short_url} target="_blank" rel="noopener noreferrer">
                {t('public.pay_online')}
              </a>
            </Button>
          ) : null}
          {desktop && payQr ? (
            <div className="mt-2 flex flex-col items-center gap-2">
              <div
                className="size-52 rounded-xl border border-border bg-white p-2"
                dangerouslySetInnerHTML={{ __html: payQr }}
              />
              <div className="text-sm text-muted-foreground">{t('public.scan_to_pay')}</div>
            </div>
          ) : null}
          <div className="text-xs text-muted-foreground">
            {t('public.pay_to', { name: pay.payee_name, vpa: pay.vpa })}
          </div>
        </section>
      ) : null}

      {/* document */}
      <section
        className="rounded-2xl border border-border bg-surface p-4 shadow-card"
        aria-labelledby="doc-title"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 id="doc-title" className="text-base font-semibold">
              {pick(doc.title, lang)}
            </h2>
            <div className="text-sm text-muted-foreground">
              {doc.document.number ? `${doc.document.number} · ` : ''}
              {formatDateDisplay(doc.document.date)} {doc.document.time}
            </div>
            {doc.buyer ? (
              <div className="mt-1 text-sm">
                {t('public.billed_to', { name: doc.buyer.name })}
                {doc.buyer.gstin ? (
                  <span className="text-muted-foreground"> · GSTIN {doc.buyer.gstin}</span>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="text-end">
            <div className="text-xs text-muted-foreground">{t('public.total')}</div>
            <div className="text-2xl font-bold tabular-nums">{formatINR(tot.total_paise)}</div>
          </div>
        </div>
        {doc.document.cancelled ? (
          <p
            role="alert"
            className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-sm font-medium text-danger-soft-foreground"
          >
            {t('public.cancelled')}
          </p>
        ) : null}

        <ul
          className="mt-3 divide-y divide-border border-t border-border"
          aria-label={t('public.items')}
        >
          {doc.lines.map((line) => {
            const n = names(line.name, line.name_ta, lang)
            return (
              <li key={line.line_no} className="flex items-start justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="font-medium">{n.primary}</div>
                  {n.secondary ? (
                    <div className="text-xs text-muted-foreground">{n.secondary}</div>
                  ) : null}
                  {line.variant_text ? (
                    <div className="text-xs text-muted-foreground">{line.variant_text}</div>
                  ) : null}
                  <div className="text-sm text-muted-foreground tabular-nums">
                    {pick(line.qty_display, lang)} × {formatINR(line.rate_paise)}
                    {line.mrp_paise && line.mrp_paise > line.rate_paise ? (
                      <span className="ms-2 text-xs line-through">
                        {t('lines.mrp')} {formatINR(line.mrp_paise)}
                      </span>
                    ) : null}
                  </div>
                  {line.gst_rate_bp > 0 ? (
                    <div className="text-xs text-muted-foreground">
                      {t('lines.gst_at', { rate: pct(line.gst_rate_bp) })}
                      {line.hsn_code ? ` · HSN ${line.hsn_code}` : ''}
                    </div>
                  ) : null}
                </div>
                <div className="text-end font-semibold tabular-nums">
                  {formatINR(line.total_paise)}
                </div>
              </li>
            )
          })}
        </ul>

        <dl className="mt-2 border-t border-border pt-3 text-sm">
          {tot.discount_paise > 0 ? (
            <Row
              label={t('public.discount')}
              value={`−${formatINR(tot.discount_paise)}`}
              tone="success"
            />
          ) : null}
          {taxRows.length > 0 ? (
            <Row label={t('totals.taxable')} value={formatINR(tot.taxable_paise)} />
          ) : null}
          {taxRows.map((r) => (
            <Row key={r.label} label={r.label} value={formatINR(r.paise)} muted />
          ))}
          {tot.round_off_paise !== 0 ? (
            <Row
              label={t('totals.round_off')}
              value={`${tot.round_off_paise > 0 ? '+' : '−'}${formatINR(Math.abs(tot.round_off_paise))}`}
              muted
            />
          ) : null}
          <div className="mt-1 flex items-baseline justify-between border-t border-border pt-2 text-base font-bold">
            <dt>{t('totals.total')}</dt>
            <dd className="tabular-nums">{formatINR(tot.total_paise)}</dd>
          </div>
          {doc.paid_paise > 0 ? (
            <Row label={t('totals.paid')} value={formatINR(doc.paid_paise)} tone="success" />
          ) : null}
          {doc.returned_paise > 0 ? (
            <Row label={t('totals.returned')} value={formatINR(doc.returned_paise)} muted />
          ) : null}
          {doc.due_paise > 0 && !doc.document.cancelled ? (
            <Row label={t('totals.due')} value={formatINR(doc.due_paise)} tone="danger" strong />
          ) : null}
        </dl>
        <p className="mt-2 text-xs text-muted-foreground">{pick(doc.amount_in_words, lang)}</p>
        {doc.savings && doc.savings.total_paise > 0 ? (
          <p className="mt-3 rounded-lg bg-success-soft px-3 py-2 text-sm font-medium text-success-soft-foreground">
            {t('totals.you_saved', {
              amount: formatINR(doc.savings.total_paise, { decimals: 'auto' }),
            })}
          </p>
        ) : null}
        {doc.payments.length > 0 ? (
          <div className="mt-3 text-sm">
            <div className="mb-1 font-medium">{t('public.payments')}</div>
            <ul className="space-y-0.5 text-muted-foreground">
              {doc.payments.map((p, i) => (
                <li key={i} className="flex justify-between gap-2">
                  <span>
                    {pick(p.label, lang)}
                    {p.reference ? ` · ${p.reference}` : ''}
                  </span>
                  <span className="tabular-nums">{formatINR(p.amount_paise)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {doc.composition_declaration ? (
          <p className="mt-3 text-xs text-muted-foreground">
            {pick(doc.composition_declaration, lang)}
          </p>
        ) : null}
      </section>

      <div className="flex flex-col items-center gap-2">
        <Button
          variant="outline"
          size="lg"
          leftIcon={<Download />}
          onClick={() => void download()}
          loading={printing}
        >
          {t('public.download')}
        </Button>
        <p className="text-center text-xs text-muted-foreground">{t('public.download_hint')}</p>
      </div>

      <footer className="text-center text-sm text-muted-foreground">
        <p>
          {lang === 'ta'
            ? doc.footer.text_ta || doc.footer.text_en
            : doc.footer.text_en || doc.footer.text_ta}
        </p>
        {doc.footer.terms ? (
          <p className="mt-1 whitespace-pre-line text-xs">{doc.footer.terms}</p>
        ) : null}
      </footer>
    </div>
  )
}

function Row({
  label,
  value,
  muted,
  tone,
  strong,
}: {
  label: string
  value: string
  muted?: boolean
  tone?: 'success' | 'danger'
  strong?: boolean
}) {
  return (
    <div
      className={cn(
        'flex justify-between py-0.5',
        muted && 'text-muted-foreground',
        tone === 'success' && 'text-success',
        tone === 'danger' && 'text-danger',
        strong && 'text-base font-bold',
      )}
    >
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  )
}
