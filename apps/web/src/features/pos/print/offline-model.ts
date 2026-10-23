/**
 * Print model of a bill made on this counter without the server (offline bills print at once,
 * ARCHITECTURE.md §12). Built from the priced cart, the tenders and the cached bootstrap context
 * with the same rules as the server's print model, so an offline receipt looks like any other —
 * marked provisional when the number is assigned at sync.
 */
import {
  AUTHORISED_SIGNATORY,
  COMPOSITION_DECLARATION,
  INVOICE_COPY_LABELS,
  SALES_DOC_TITLES,
  type SalesPrintModel,
  allocateTenders,
} from '@kadai/shared/api/sales'
import { PAYMENT_METHOD_LABELS } from '@kadai/shared/api/payments'
import { loyaltyPointsForAmount } from '@kadai/shared/api/parties'
import { getState, halfRateBp, stateTaxLabel } from '@kadai/shared/gst'
import type { PrintFormat } from '@kadai/shared/settings'
import { formatPacksAndLoose, uqcFor } from '@kadai/shared/units'
import { amountInWords } from '@kadai/shared/words'
import type { TenderInput } from '@kadai/shared/api/sales'
import type { CartState } from '../lib/cart'
import type { CartPricing } from '../lib/pricing'
import type { PosContext } from '../lib/types'
import { staticUpiProvider, staticUpiUri } from '../lib/upi'

type Model = SalesPrintModel

function addressLines(a: PosContext['store']['address']): string[] {
  const state = a.state_code ? getState(a.state_code)?.name_en : undefined
  return [
    a.line1,
    a.line2,
    [a.city, a.pincode].filter(Boolean).join(' - '),
    a.district,
    state,
  ].filter((x): x is string => typeof x === 'string' && x.trim() !== '')
}

function timeIn(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d)
}

export interface OfflineModelInput {
  context: PosContext
  cart: CartState
  pricing: CartPricing
  tenders: readonly TenderInput[]
  number: string | null
  invoice_date: string
  created_at: string
  cashier_name: string | null
  locale: 'ta' | 'en'
  format?: PrintFormat
}

export function buildOfflinePrintModel(input: OfflineModelInput): Model {
  const { context, cart, pricing } = input
  const settings = context.settings
  const result = pricing.result
  const docType = context.doc_type
  const format: PrintFormat =
    input.format ?? context.register?.settings.print_format ?? settings.invoice.print_format
  const store = context.store
  const tenant = context.tenant
  const pos = store.state_code
  const alloc = allocateTenders(result.total_paise, input.tenders)

  const lines: Model['lines'] = cart.lines.map((l, i) => {
    const r = result.lines[i]
    const variant = Object.values(l.product.variant_attributes)
    const priced = pricing.lines[i]
    const schedule = l.product.attributes['schedule']
    return {
      line_no: i + 1,
      name: l.product.name,
      name_ta: l.product.name_ta,
      variant_text: variant.length ? variant.join(' / ') : null,
      note: l.note,
      hsn_code: l.product.hsn_code,
      batch_no: l.batch?.batch_no ?? null,
      expiry_date: l.batch?.expiry_date ?? null,
      schedule:
        typeof schedule === 'string' && ['OTC', 'G', 'H', 'H1', 'X'].includes(schedule)
          ? (schedule as 'OTC' | 'G' | 'H' | 'H1' | 'X')
          : null,
      serial_numbers: l.serial_numbers,
      qty_milli: l.qty_milli,
      unit: l.product.unit,
      uqc: uqcFor(l.product.unit),
      qty_display: {
        en: formatPacksAndLoose(l.qty_milli, l.product.pack_size, l.product.unit, 'PACK', 'en'),
        ta: formatPacksAndLoose(l.qty_milli, l.product.pack_size, l.product.unit, 'PACK', 'ta'),
      },
      pack_size: l.product.pack_size,
      mrp_paise: priced?.price.mrp_paise ?? null,
      rate_paise: priced?.price.unit_price_paise ?? l.product.sale_price_paise,
      price_includes_tax: l.product.price_includes_tax,
      discount_paise: r?.discount_paise ?? 0,
      taxable_paise: r?.taxable_paise ?? 0,
      gst_rate_bp: r?.gst_rate_bp ?? 0,
      cgst_paise: r?.cgst_paise ?? 0,
      sgst_paise: r?.sgst_paise ?? 0,
      igst_paise: r?.igst_paise ?? 0,
      cess_rate_bp: r?.cess_rate_bp ?? 0,
      cess_paise: r?.cess_paise ?? 0,
      total_paise: r?.total_paise ?? 0,
    }
  })

  const hsn = new Map<string, Model['hsn_summary'][number]>()
  for (const l of lines) {
    const key = `${l.hsn_code ?? ''}|${l.gst_rate_bp}`
    const h = hsn.get(key) ?? {
      hsn_code: l.hsn_code,
      gst_rate_bp: l.gst_rate_bp,
      taxable_paise: 0,
      cgst_paise: 0,
      sgst_paise: 0,
      igst_paise: 0,
      cess_paise: 0,
      tax_paise: 0,
    }
    h.taxable_paise += l.taxable_paise
    h.cgst_paise += l.cgst_paise
    h.sgst_paise += l.sgst_paise
    h.igst_paise += l.igst_paise
    h.cess_paise += l.cess_paise
    h.tax_paise += l.cgst_paise + l.sgst_paise + l.igst_paise + l.cess_paise
    hsn.set(key, h)
  }

  const discount = result.item_discount_paise + result.bill_discount_paise
  const due = alloc.due_paise
  const customer = cart.customer
  const loyaltyOn = context.features.includes('loyalty') && settings.loyalty.enabled
  const earned =
    customer && loyaltyOn ? loyaltyPointsForAmount(result.total_paise, settings.loyalty) : 0
  const redeemed = result.loyalty_points_redeemed
  const upiAcct =
    settings.invoice.upi_qr_on_invoice && due > 0
      ? staticUpiProvider(context.payment_providers, store.id)
      : null
  const upiUri = upiAcct
    ? staticUpiUri(upiAcct, { payee: tenant.name, amount_paise: due, note: input.number ?? '' })
    : null
  const title = SALES_DOC_TITLES[docType]
  const copyCount = Math.max(1, Math.min(INVOICE_COPY_LABELS.length, settings.invoice.copies))
  const issued = new Date(input.created_at)

  return {
    kind: 'invoice',
    doc_type: docType,
    format,
    locale: { primary: input.locale, bilingual: settings.invoice.bilingual },
    title: { en: title.en, ta: title.ta },
    copies:
      format === 'a4' && docType === 'tax_invoice'
        ? INVOICE_COPY_LABELS.slice(0, copyCount).map((c) => ({ en: c.en, ta: c.ta }))
        : [],
    seller: {
      name: tenant.name,
      name_ta: tenant.name_ta,
      legal_name: tenant.legal_name,
      gstin: store.gstin ?? tenant.gstin,
      pan: null,
      state_code: store.state_code,
      state_name: getState(store.state_code)?.name_en ?? store.state_code,
      address_lines: addressLines(store.address),
      phone: store.phone,
      email: null,
      logo_url: tenant.logo_url,
      drug_license_numbers: store.drug_license_numbers,
      fssai_number: store.fssai_number,
      store_code: store.code,
      store_name: store.name,
      store_name_ta: store.name_ta,
    },
    document: {
      number: input.number,
      date: input.invoice_date,
      time: timeIn(issued, tenant.timezone),
      issued_at: issued.toISOString(),
      status: 'completed',
      cancelled: false,
      place_of_supply: pos,
      place_of_supply_name: getState(pos)?.name_en ?? pos,
      is_interstate: false,
      reverse_charge: false,
      register_code: context.register?.code ?? null,
      cashier_name: input.cashier_name,
      salesperson_name: null,
      due_date: null,
      valid_until: null,
      original_invoice: null,
      reason: null,
    },
    buyer: customer
      ? {
          name: customer.name,
          phone: customer.phone,
          gstin: customer.gstin,
          address_lines: [],
          state_code: customer.state_code,
          state_name: customer.state_code ? (getState(customer.state_code)?.name_en ?? null) : null,
        }
      : null,
    lines,
    tax_breakup: result.tax_breakup.map((r) => ({
      gst_rate_bp: r.gst_rate_bp,
      taxable_paise: r.taxable_paise,
      cgst_paise: r.cgst_paise,
      sgst_paise: r.sgst_paise,
      igst_paise: r.igst_paise,
      cess_paise: r.cess_paise,
      cgst_rate_bp: halfRateBp(r.gst_rate_bp),
      sgst_rate_bp: halfRateBp(r.gst_rate_bp),
      igst_rate_bp: 0,
      tax_paise: r.cgst_paise + r.sgst_paise + r.igst_paise + r.cess_paise,
    })),
    hsn_summary: [...hsn.values()].sort(
      (a, b) => (a.hsn_code ?? '').localeCompare(b.hsn_code ?? '') || a.gst_rate_bp - b.gst_rate_bp,
    ),
    tax_labels: { cgst: 'CGST', sgst: stateTaxLabel(pos), igst: 'IGST' },
    totals: {
      item_count: cart.lines.length,
      gross_paise: result.gross_paise,
      item_discount_paise: result.item_discount_paise,
      bill_discount_paise: result.bill_discount_paise,
      taxable_paise: result.taxable_paise,
      cgst_paise: result.cgst_paise,
      sgst_paise: result.sgst_paise,
      igst_paise: result.igst_paise,
      cess_paise: result.cess_paise,
      tax_paise: result.tax_paise,
      round_off_paise: result.round_off_paise,
      total_paise: result.total_paise,
      loyalty_redeem_paise: result.loyalty_redeem_paise,
      discount_paise: discount,
      mrp_savings_paise: result.mrp_savings_paise,
    },
    amount_in_words: {
      en: amountInWords(result.total_paise, 'en'),
      ta: amountInWords(result.total_paise, 'ta'),
    },
    payments: alloc.lines
      .filter((l) => l.applied_paise > 0)
      .map((l) => ({
        method: l.method,
        label: { ...PAYMENT_METHOD_LABELS[l.method] },
        amount_paise: l.applied_paise,
        reference: input.tenders[l.index]?.reference ?? null,
      })),
    paid_paise: alloc.paid_paise,
    change_paise: alloc.change_paise,
    due_paise: due,
    returned_paise: 0,
    customer_balance_paise: customer ? customer.balance_paise + due : null,
    savings:
      settings.invoice.show_mrp_savings && pricing.savings_paise > 0
        ? {
            mrp_savings_paise: result.mrp_savings_paise,
            discount_paise: discount,
            total_paise: pricing.savings_paise,
          }
        : null,
    loyalty:
      customer && (earned > 0 || redeemed > 0)
        ? {
            points_earned: earned,
            points_redeemed: redeemed,
            redeem_paise: result.loyalty_redeem_paise,
            balance_points: Math.max(0, customer.loyalty_points - redeemed + earned),
          }
        : null,
    upi:
      upiAcct && upiUri && upiAcct.vpa
        ? {
            uri: upiUri,
            amount_paise: due,
            vpa: upiAcct.vpa,
            payee_name: upiAcct.payee_name?.trim() || tenant.name,
          }
        : null,
    settlement: null,
    composition_declaration:
      tenant.gst_scheme === 'composition' ? { ...COMPOSITION_DECLARATION } : null,
    footer: {
      text_en: settings.invoice.footer_text,
      text_ta: settings.invoice.footer_text_ta,
      terms: settings.invoice.terms,
    },
    signatory: { label: { ...AUTHORISED_SIGNATORY }, for_name: tenant.legal_name ?? tenant.name },
    rx: cart.rx
      ? {
          doctor_name: cart.rx.doctor_name,
          doctor_reg_no: cart.rx.doctor_reg_no ?? null,
          patient_name: cart.rx.patient_name,
          patient_age: cart.rx.patient_age ?? null,
          patient_address: cart.rx.patient_address ?? null,
          rx_date: cart.rx.rx_date ?? null,
        }
      : null,
    flags: {
      show_hsn: settings.invoice.show_hsn,
      show_mrp: lines.some((l) => l.mrp_paise !== null),
      show_mrp_savings: settings.invoice.show_mrp_savings,
      bilingual: settings.invoice.bilingual,
    },
    share_url: null,
    generated_at: new Date().toISOString(),
  }
}
