/**
 * Printable / shareable party statements (khata). The print language is chosen per print (a
 * Tamil statement for the customer even when the cashier uses English), so texts come from a
 * fixed-language translator, not the UI language.
 */
import i18next from 'i18next'
import type { MeTenant } from '@kadai/shared/api/auth'
import { LEDGER_SOURCE_LABELS, type PartyLedger } from '@kadai/shared/api/parties'
import type { PartyType } from '@kadai/shared/enums'
import { formatINR } from '@kadai/shared/money'
import { amountInWords, formatDate, formatDateTime, formatPhone } from '@/lib/format'
import type { Language } from '@/lib/i18n'
import { formatAddress } from './labels'

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}
const esc = (text: string | null | undefined): string =>
  (text ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c)

function fixedT(lang: Language) {
  return i18next.getFixedT(lang, 'parties')
}

/** Balance as "₹1,250.00 due" / "₹300.00 advance" in the statement language. */
function balanceText(partyType: PartyType, paise: number, lang: Language): string {
  const t = fixedT(lang)
  if (paise === 0) return t('balance.settled')
  const word =
    paise > 0
      ? t(partyType === 'customer' ? 'balance.due' : 'balance.to_pay')
      : t('balance.advance')
  return `${formatINR(Math.abs(paise))} ${word}`
}

function partyName(ledger: PartyLedger, lang: Language): string {
  return lang === 'ta' && ledger.party.name_ta ? ledger.party.name_ta : ledger.party.name
}

function shopName(tenant: MeTenant, lang: Language): string {
  return lang === 'ta' && tenant.name_ta ? tenant.name_ta : tenant.name
}

export const STATEMENT_CSS = `
  .st { font-size: 12px; }
  .st header { text-align: center; border-bottom: 1.5px solid #000; padding-bottom: 6px; margin-bottom: 8px; }
  .st header .shop { font-size: 18px; font-weight: 700; }
  .st header .sub { font-size: 11px; color: #333; }
  .st h1 { font-size: 15px; text-align: center; margin: 6px 0 10px; letter-spacing: .03em; }
  .st .meta { margin-bottom: 10px; }
  .st .meta td { padding: 2px 0; vertical-align: top; }
  .st .meta td.k { color: #444; width: 26%; }
  .st table.rows th, .st table.rows td { border: 1px solid #999; padding: 4px 6px; }
  .st table.rows th { background: #eee; font-weight: 700; text-align: left; }
  .st table.rows th.num { text-align: right; }
  .st table.rows tr.strong td { font-weight: 700; background: #f5f5f5; }
  .st .doc { font-family: monospace; font-size: 11px; color: #333; }
  .st .desc { color: #555; font-size: 11px; }
  .st .closing { margin-top: 10px; font-size: 14px; font-weight: 700; }
  .st .words { font-size: 11px; color: #333; margin-top: 2px; }
  .st footer { margin-top: 18px; font-size: 10px; color: #555; text-align: center; }
`

export interface StatementInput {
  ledger: PartyLedger
  partyType: PartyType
  lang: Language
  tenant: MeTenant
  generatedAt?: Date
}

/** Body HTML of an A4 statement (print with printHtml(…, { paper: 'a4', css: STATEMENT_CSS })). */
export function statementHtml({
  ledger,
  partyType,
  lang,
  tenant,
  generatedAt = new Date(),
}: StatementInput): string {
  const t = fixedT(lang)
  const debitHead =
    partyType === 'customer' ? t('ledger.col_debit_customer') : t('ledger.col_debit_supplier')
  const creditHead =
    partyType === 'customer' ? t('ledger.col_credit_customer') : t('ledger.col_credit_supplier')
  const period = ledger.from
    ? `${formatDate(ledger.from)} – ${formatDate(ledger.to)}`
    : t('statement.upto', { date: formatDate(ledger.to) })
  const address = formatAddress(tenant.address, lang)
  const shopSub = [
    address,
    tenant.phone ? `${t('statement.phone')}: ${formatPhone(tenant.phone)}` : '',
    tenant.gstin ? `GSTIN: ${tenant.gstin}` : '',
  ]
    .filter(Boolean)
    .map(esc)
    .join(' · ')

  const rows = ledger.rows
    .map((r) => {
      const label = LEDGER_SOURCE_LABELS[r.source_type][lang]
      return `<tr>
  <td>${esc(formatDate(r.date))}</td>
  <td>${esc(label)}${r.document_number ? ` <span class="doc">${esc(r.document_number)}</span>` : ''}${
    r.description ? `<div class="desc">${esc(r.description)}</div>` : ''
  }</td>
  <td class="num">${r.debit_paise ? esc(formatINR(r.debit_paise)) : ''}</td>
  <td class="num">${r.credit_paise ? esc(formatINR(r.credit_paise)) : ''}</td>
  <td class="num">${esc(balanceText(partyType, r.balance_paise, lang))}</td>
</tr>`
    })
    .join('\n')

  const opening =
    ledger.from !== null || ledger.opening_balance_paise !== 0
      ? `<tr class="strong"><td>${esc(ledger.from ? formatDate(ledger.from) : '')}</td><td>${esc(
          t('ledger.opening_balance'),
        )}</td><td></td><td></td><td class="num">${esc(
          balanceText(partyType, ledger.opening_balance_paise, lang),
        )}</td></tr>`
      : ''

  const closing = ledger.closing_balance_paise
  const words =
    closing !== 0
      ? `<div class="words">${esc(t('statement.in_words', { words: amountInWords(Math.abs(closing), lang) }))}</div>`
      : ''

  return `<div class="st">
<header>
  <div class="shop">${esc(shopName(tenant, lang))}</div>
  ${shopSub ? `<div class="sub">${shopSub}</div>` : ''}
</header>
<h1>${esc(t(partyType === 'customer' ? 'statement.title_customer' : 'statement.title_supplier'))}</h1>
<table class="meta">
  <tr><td class="k">${esc(t(partyType === 'customer' ? 'statement.customer' : 'statement.supplier'))}</td><td><b>${esc(
    partyName(ledger, lang),
  )}</b>${ledger.party.phone ? ` · ${esc(formatPhone(ledger.party.phone))}` : ''}</td></tr>
  <tr><td class="k">${esc(t('statement.period'))}</td><td>${esc(period)}</td></tr>
  <tr><td class="k">${esc(t('statement.generated'))}</td><td>${esc(formatDateTime(generatedAt))}</td></tr>
</table>
<table class="rows">
  <thead><tr>
    <th>${esc(t('ledger.col_date'))}</th>
    <th>${esc(t('ledger.col_particulars'))}</th>
    <th class="num">${esc(debitHead)}</th>
    <th class="num">${esc(creditHead)}</th>
    <th class="num">${esc(t('ledger.col_balance'))}</th>
  </tr></thead>
  <tbody>
${opening}
${rows}
<tr class="strong"><td></td><td>${esc(t('statement.totals'))}</td><td class="num">${esc(
    formatINR(ledger.total_debit_paise),
  )}</td><td class="num">${esc(formatINR(ledger.total_credit_paise))}</td><td></td></tr>
  </tbody>
</table>
<div class="closing">${esc(t('ledger.closing_balance'))}: ${esc(balanceText(partyType, closing, lang))}</div>
${words}
${ledger.truncated ? `<div class="desc">${esc(t('ledger.truncated'))}</div>` : ''}
<footer>${esc(t('statement.footer'))}</footer>
</div>`
}

/** Short WhatsApp / SMS text summarising the statement. */
export function statementShareText({
  ledger,
  partyType,
  lang,
  tenant,
}: Omit<StatementInput, 'generatedAt'>): string {
  const t = fixedT(lang)
  const period = ledger.from
    ? `${formatDate(ledger.from)} – ${formatDate(ledger.to)}`
    : t('statement.upto', { date: formatDate(ledger.to) })
  return t(partyType === 'customer' ? 'statement.share_customer' : 'statement.share_supplier', {
    name: partyName(ledger, lang),
    shop: shopName(tenant, lang),
    period,
    debit: formatINR(ledger.total_debit_paise),
    credit: formatINR(ledger.total_credit_paise),
    balance: balanceText(partyType, ledger.closing_balance_paise, lang),
  })
}
