/**
 * Print models (GET /sales/invoices/:id/print, GET /sales/credit-notes/:id/print), the public
 * invoice (GET /public/v1/invoices/:shareToken) and sharing (POST /sales/invoices/:id/share).
 *
 * The print model holds everything a bilingual GST document needs (thermal 58 / 80 mm or A4)
 * and no internal ids or costs, so the public invoice is the same model.
 */
import {
  type Locale,
  type PrintFormat,
  RegisterSettingsSchema,
  amountForQty,
  amountInWords,
  buildUpiUri,
  formatINR,
  formatPacksAndLoose,
  getState,
  halfRateBp,
  normalizeIndianPhone,
  stateTaxLabel,
  sumSafe,
  uqcFor,
} from '@kadai/shared'
import type { Address } from '@kadai/shared/api/common'
import {
  type NotificationParams,
  renderNotification,
  waMeUrl,
} from '@kadai/shared/api/notifications'
import { PAYMENT_METHOD_LABELS } from '@kadai/shared/api/payments'
import {
  AUTHORISED_SIGNATORY,
  COMPOSITION_DECLARATION,
  CREDIT_NOTE_REASON_LABELS,
  CREDIT_NOTE_SETTLEMENT_LABELS,
  INVOICE_COPY_LABELS,
  INVOICE_SHARE_TEMPLATE,
  type InvoiceShareResult,
  type PublicInvoice,
  RxSchema,
  SALES_DOC_TITLES,
  type SalesPrintModel,
  generateShareToken,
  parseCashTenderNotes,
} from '@kadai/shared/api/sales'
import {
  CreditNoteReasonSchema,
  CreditNoteSettlementSchema,
  PaymentMethodSchema,
} from '@kadai/shared'
import type { Tx } from '../../db/tenant'
import { audit } from '../../core/audit'
import { conflict, invalidField, notFound } from '../../core/errors'
import { assertStoreAccess } from '../../core/http'
import { enqueueNotification } from '../../core/notify'
import {
  type SalesCtx,
  type SalesEnv,
  type StoreInfo,
  addressOf,
  loadStore,
  recordOf,
  salesEnv,
  stringRecordOf,
} from './common'
import { lineMrpSavings, loadInvoiceRow, loadStoredLines, shareUrlOf } from './detail'

export interface PrintOptions {
  format?: PrintFormat | undefined
  locale?: Locale | undefined
  /** Public invoice: no logo API path, no khata balance. */
  publicView?: boolean
  publicBaseUrl: string
}

type ModelLine = SalesPrintModel['lines'][number]

function addressLines(a: Address | null): string[] {
  if (!a) return []
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

function qtyDisplay(qty: number, pack: number, unit: string): { en: string; ta: string } {
  return {
    en: formatPacksAndLoose(qty, pack, unit, 'PACK', 'en'),
    ta: formatPacksAndLoose(qty, pack, unit, 'PACK', 'ta'),
  }
}

function taxRows(
  lines: ReadonlyArray<{
    gst_rate_bp: number
    taxable_paise: number
    cgst_paise: number
    sgst_paise: number
    igst_paise: number
    cess_paise: number
    hsn_code: string | null
  }>,
  isInterstate: boolean,
): { breakup: SalesPrintModel['tax_breakup']; hsn: SalesPrintModel['hsn_summary'] } {
  const byRate = new Map<number, SalesPrintModel['tax_breakup'][number]>()
  const byHsn = new Map<string, SalesPrintModel['hsn_summary'][number]>()
  for (const l of lines) {
    const r = byRate.get(l.gst_rate_bp) ?? {
      gst_rate_bp: l.gst_rate_bp,
      taxable_paise: 0,
      cgst_paise: 0,
      sgst_paise: 0,
      igst_paise: 0,
      cess_paise: 0,
      cgst_rate_bp: isInterstate ? 0 : halfRateBp(l.gst_rate_bp),
      sgst_rate_bp: isInterstate ? 0 : halfRateBp(l.gst_rate_bp),
      igst_rate_bp: isInterstate ? l.gst_rate_bp : 0,
      tax_paise: 0,
    }
    const key = `${l.hsn_code ?? ''}|${l.gst_rate_bp}`
    const h = byHsn.get(key) ?? {
      hsn_code: l.hsn_code,
      gst_rate_bp: l.gst_rate_bp,
      taxable_paise: 0,
      cgst_paise: 0,
      sgst_paise: 0,
      igst_paise: 0,
      cess_paise: 0,
      tax_paise: 0,
    }
    const tax = l.cgst_paise + l.sgst_paise + l.igst_paise + l.cess_paise
    for (const row of [r, h]) {
      row.taxable_paise += l.taxable_paise
      row.cgst_paise += l.cgst_paise
      row.sgst_paise += l.sgst_paise
      row.igst_paise += l.igst_paise
      row.cess_paise += l.cess_paise
      row.tax_paise += tax
    }
    byRate.set(l.gst_rate_bp, r)
    byHsn.set(key, h)
  }
  const breakup = [...byRate.values()].sort((a, b) => a.gst_rate_bp - b.gst_rate_bp)
  const hsn = [...byHsn.values()].sort(
    (a, b) => (a.hsn_code ?? '').localeCompare(b.hsn_code ?? '') || a.gst_rate_bp - b.gst_rate_bp,
  )
  return { breakup, hsn }
}

/** The shop's UPI ID for a store (static VPA provider), when one exists. */
async function upiAccountFor(
  tx: Tx,
  ctx: Pick<SalesCtx, 'tenantId'>,
  storeId: string,
): Promise<{ vpa: string; payee_name: string | null; merchant_code: string | null } | null> {
  const row = await tx
    .selectFrom('payment_provider_accounts')
    .select(['vpa', 'payee_name', 'merchant_code', 'store_id', 'is_default'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('provider', '=', 'upi_vpa')
    .where('is_active', '=', true)
    .where('vpa', 'is not', null)
    .where((eb) => eb.or([eb('store_id', 'is', null), eb('store_id', '=', storeId)]))
    .execute()
  const best = row.sort(
    (a, b) =>
      Number(b.store_id === storeId) - Number(a.store_id === storeId) ||
      Number(b.is_default) - Number(a.is_default),
  )[0]
  return best?.vpa
    ? { vpa: best.vpa, payee_name: best.payee_name, merchant_code: best.merchant_code }
    : null
}

function upiFor(
  acct: { vpa: string; payee_name: string | null; merchant_code: string | null } | null,
  payee: string,
  amount: number,
  note: string,
): { uri: string; amount_paise: number; vpa: string; payee_name: string } | null {
  if (!acct || amount <= 0) return null
  const payeeName = acct.payee_name?.trim() || payee
  try {
    const uri = buildUpiUri({
      vpa: acct.vpa,
      payee_name: payeeName,
      amount_paise: amount,
      note,
      ...(acct.merchant_code ? { mcc: acct.merchant_code } : {}),
    })
    return { uri, amount_paise: amount, vpa: acct.vpa, payee_name: payeeName }
  } catch {
    return null
  }
}

function sellerOf(env: SalesEnv, store: StoreInfo, publicView: boolean): SalesPrintModel['seller'] {
  const t = env.tenant
  const state = getState(store.state_code)
  return {
    name: t.name,
    name_ta: t.name_ta,
    legal_name: t.legal_name,
    gstin: store.gstin ?? t.gstin,
    pan: t.pan,
    state_code: store.state_code,
    state_name: state?.name_en ?? store.state_code,
    address_lines: addressLines(addressOf(store.address) ?? addressOf(t.address)),
    phone: store.phone ?? t.phone,
    email: store.email ?? t.email,
    logo_url: !publicView && t.logo_file_id ? `/api/v1/files/${t.logo_file_id}/content` : null,
    drug_license_numbers: store.drug_license_numbers,
    fssai_number: store.fssai_number,
    store_code: store.code,
    store_name: store.name,
    store_name_ta: store.name_ta,
  }
}

async function userNames(tx: Tx, ids: Array<string | null>): Promise<Map<string, string>> {
  const list = ids.filter((x): x is string => x !== null)
  if (!list.length) return new Map()
  const rows = await tx
    .selectFrom('users')
    .select(['id', 'full_name'])
    .where('id', 'in', list)
    .execute()
  return new Map(rows.map((r) => [r.id, r.full_name]))
}

async function printFormatFor(
  tx: Tx,
  ctx: Pick<SalesCtx, 'tenantId'>,
  env: SalesEnv,
  registerId: string | null,
  requested: PrintFormat | undefined,
): Promise<PrintFormat> {
  if (requested) return requested
  if (registerId) {
    const reg = await tx
      .selectFrom('registers')
      .select('settings')
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', registerId)
      .executeTakeFirst()
    const parsed = RegisterSettingsSchema.safeParse(recordOf(reg?.settings))
    if (parsed.success && parsed.data.print_format) return parsed.data.print_format
  }
  return env.settings.invoice.print_format
}

// ---------------------------------------------------------------------------------------------
// Invoice / estimate
// ---------------------------------------------------------------------------------------------

export async function invoicePrintModel(
  tx: Tx,
  ctx: SalesCtx,
  id: string,
  opts: PrintOptions,
): Promise<SalesPrintModel> {
  const row = await loadInvoiceRow(tx, ctx, id)
  if (row.status === 'held' || row.status === 'draft') {
    throw conflict('Held bills and drafts cannot be printed', { reason: 'not_completed' })
  }
  const env = await salesEnv(tx, ctx)
  const settings = env.settings
  const store = await loadStore(tx, ctx, row.store_id, { requireActive: false, checkAccess: false })
  const lines = await loadStoredLines(tx, ctx, id)
  const names = await userNames(tx, [row.created_by, row.salesperson_id])
  const register = row.register_id
    ? await tx
        .selectFrom('registers')
        .select('code')
        .where('tenant_id', '=', ctx.tenantId)
        .where('id', '=', row.register_id)
        .executeTakeFirst()
    : undefined
  const payments = await tx
    .selectFrom('payment_allocations as a')
    .innerJoin('payments as p', (j) =>
      j.onRef('p.tenant_id', '=', 'a.tenant_id').onRef('p.id', '=', 'a.payment_id'),
    )
    .select(['p.method', 'a.amount_paise', 'p.reference', 'p.notes'])
    .where('a.tenant_id', '=', ctx.tenantId)
    .where('a.target_type', '=', 'sales_invoice')
    .where('a.target_id', '=', id)
    .where('p.status', '=', 'completed')
    .orderBy('p.paid_at')
    .execute()
  const customer = row.customer_id
    ? await tx
        .selectFrom('customers')
        .select(['balance_paise', 'loyalty_points'])
        .where('tenant_id', '=', ctx.tenantId)
        .where('id', '=', row.customer_id)
        .executeTakeFirst()
    : undefined
  const format = await printFormatFor(tx, ctx, env, row.register_id, opts.format)
  const docType = row.doc_type as 'tax_invoice' | 'bill_of_supply' | 'estimate'
  const isEstimate = docType === 'estimate'
  const lineModels: ModelLine[] = lines.map((l) => {
    const meta = recordOf(l.meta)
    const variant = Object.values(stringRecordOf(meta['variant']))
    return {
      line_no: l.line_no,
      name: l.name,
      name_ta: l.name_ta,
      variant_text: variant.length ? variant.join(' / ') : null,
      note: typeof meta['note'] === 'string' ? meta['note'] : null,
      hsn_code: l.hsn_code,
      batch_no: l.batch_no ?? null,
      expiry_date: l.expiry_date ?? null,
      schedule:
        typeof meta['schedule'] === 'string' &&
        ['OTC', 'G', 'H', 'H1', 'X'].includes(meta['schedule'])
          ? (meta['schedule'] as ModelLine['schedule'])
          : null,
      serial_numbers: l.serial_numbers,
      qty_milli: l.qty_milli,
      unit: l.unit,
      uqc: uqcFor(l.unit),
      qty_display: qtyDisplay(l.qty_milli, l.pack_size, l.unit),
      pack_size: l.pack_size,
      mrp_paise: l.mrp_paise,
      rate_paise: l.unit_price_paise,
      price_includes_tax:
        typeof meta['price_includes_tax'] === 'boolean'
          ? meta['price_includes_tax']
          : row.price_includes_tax,
      discount_paise: l.discount_paise,
      taxable_paise: l.taxable_paise,
      gst_rate_bp: l.gst_rate_bp,
      cgst_paise: l.cgst_paise,
      sgst_paise: l.sgst_paise,
      igst_paise: l.igst_paise,
      cess_rate_bp: l.cess_rate_bp,
      cess_paise: l.cess_paise,
      total_paise: l.total_paise,
    }
  })
  const { breakup, hsn } = taxRows(lines, row.is_interstate)
  const mrpSavings = sumSafe(lines.map(lineMrpSavings))
  const discount = row.item_discount_paise + row.bill_discount_paise
  const savingsTotal = sumSafe(
    lines.map((l) => (l.mrp_paise !== null ? lineMrpSavings(l) : l.discount_paise)),
  )
  const change = sumSafe(
    payments.map((p) =>
      p.method === 'cash' ? (parseCashTenderNotes(p.notes)?.change_paise ?? 0) : 0,
    ),
  )
  const posState = getState(row.place_of_supply)
  const buyerAddress = addressOf(row.customer_address)
  const buyerState = row.customer_state_code ? getState(row.customer_state_code) : undefined
  const rx = row.rx ? RxSchema.safeParse(row.rx) : null
  const upiAcct =
    settings.invoice.upi_qr_on_invoice &&
    row.due_paise > 0 &&
    !isEstimate &&
    row.status === 'completed'
      ? await upiAccountFor(tx, ctx, row.store_id)
      : null
  const title = SALES_DOC_TITLES[docType]
  const copyCount = Math.max(1, Math.min(INVOICE_COPY_LABELS.length, settings.invoice.copies))
  return {
    kind: 'invoice',
    doc_type: docType,
    format,
    locale: { primary: opts.locale ?? ctx.locale, bilingual: settings.invoice.bilingual },
    title: { en: title.en, ta: title.ta },
    copies:
      format === 'a4' && docType === 'tax_invoice'
        ? INVOICE_COPY_LABELS.slice(0, copyCount).map((c) => ({ en: c.en, ta: c.ta }))
        : [],
    seller: sellerOf(env, store, opts.publicView === true),
    document: {
      number: row.number,
      date: row.invoice_date,
      time: timeIn(row.invoice_at, env.timezone),
      issued_at: row.invoice_at.toISOString(),
      status: row.status as SalesPrintModel['document']['status'],
      cancelled: row.status === 'cancelled',
      place_of_supply: row.place_of_supply,
      place_of_supply_name: posState?.name_en ?? row.place_of_supply,
      is_interstate: row.is_interstate,
      reverse_charge: row.reverse_charge,
      register_code: register?.code ?? null,
      cashier_name: row.created_by ? (names.get(row.created_by) ?? null) : null,
      salesperson_name: row.salesperson_id ? (names.get(row.salesperson_id) ?? null) : null,
      due_date: isEstimate ? null : row.due_paise > 0 ? row.due_date : null,
      valid_until: isEstimate ? row.due_date : null,
      original_invoice: null,
      reason: null,
    },
    buyer: row.customer_name
      ? {
          name: row.customer_name,
          phone: row.customer_phone,
          gstin: row.customer_gstin,
          address_lines: addressLines(buyerAddress),
          state_code: row.customer_state_code,
          state_name: buyerState?.name_en ?? null,
        }
      : null,
    lines: lineModels,
    tax_breakup: breakup,
    hsn_summary: hsn,
    tax_labels: { cgst: 'CGST', sgst: stateTaxLabel(row.place_of_supply), igst: 'IGST' },
    totals: {
      item_count: row.item_count,
      gross_paise: row.gross_paise,
      item_discount_paise: row.item_discount_paise,
      bill_discount_paise: row.bill_discount_paise,
      taxable_paise: row.taxable_paise,
      cgst_paise: row.cgst_paise,
      sgst_paise: row.sgst_paise,
      igst_paise: row.igst_paise,
      cess_paise: row.cess_paise,
      tax_paise: row.cgst_paise + row.sgst_paise + row.igst_paise + row.cess_paise,
      round_off_paise: row.round_off_paise,
      total_paise: row.total_paise,
      loyalty_redeem_paise: row.loyalty_redeem_paise,
      discount_paise: discount,
      mrp_savings_paise: mrpSavings,
    },
    amount_in_words: {
      en: amountInWords(row.total_paise, 'en'),
      ta: amountInWords(row.total_paise, 'ta'),
    },
    payments: payments.map((p) => {
      const method = PaymentMethodSchema.parse(p.method)
      return {
        method,
        label: { ...PAYMENT_METHOD_LABELS[method] },
        amount_paise: p.amount_paise,
        reference: p.reference,
      }
    }),
    paid_paise: row.paid_paise,
    change_paise: change,
    due_paise: row.due_paise,
    returned_paise: row.returned_paise,
    customer_balance_paise: opts.publicView || !customer ? null : customer.balance_paise,
    savings:
      settings.invoice.show_mrp_savings && savingsTotal > 0
        ? { mrp_savings_paise: mrpSavings, discount_paise: discount, total_paise: savingsTotal }
        : null,
    loyalty:
      row.customer_id && (row.loyalty_points_earned > 0 || row.loyalty_points_redeemed > 0)
        ? {
            points_earned: row.loyalty_points_earned,
            points_redeemed: row.loyalty_points_redeemed,
            redeem_paise: row.loyalty_redeem_paise,
            balance_points: opts.publicView || !customer ? null : customer.loyalty_points,
          }
        : null,
    upi: upiFor(upiAcct, env.tenant.name, row.due_paise, row.number ?? ''),
    settlement: null,
    composition_declaration:
      env.tenant.gst_scheme === 'composition' ? { ...COMPOSITION_DECLARATION } : null,
    footer: {
      text_en: settings.invoice.footer_text,
      text_ta: settings.invoice.footer_text_ta,
      terms: settings.invoice.terms,
    },
    signatory: {
      label: { ...AUTHORISED_SIGNATORY },
      for_name: env.tenant.legal_name ?? env.tenant.name,
    },
    rx: rx?.success
      ? {
          doctor_name: rx.data.doctor_name,
          doctor_reg_no: rx.data.doctor_reg_no ?? null,
          patient_name: rx.data.patient_name,
          patient_age: rx.data.patient_age ?? null,
          patient_address: rx.data.patient_address ?? null,
          rx_date: rx.data.rx_date ?? null,
        }
      : null,
    flags: {
      show_hsn: settings.invoice.show_hsn,
      show_mrp: lines.some((l) => l.mrp_paise !== null),
      show_mrp_savings: settings.invoice.show_mrp_savings,
      bilingual: settings.invoice.bilingual,
    },
    share_url: shareUrlOf(opts.publicBaseUrl, row.share_token),
    generated_at: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------------------------
// Credit note
// ---------------------------------------------------------------------------------------------

export async function creditNotePrintModel(
  tx: Tx,
  ctx: SalesCtx,
  id: string,
  opts: PrintOptions,
): Promise<SalesPrintModel> {
  const note = await tx
    .selectFrom('credit_notes')
    .selectAll()
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .executeTakeFirst()
  if (!note) throw notFound('credit_note', id)
  assertStoreAccess(ctx, note.store_id)
  const env = await salesEnv(tx, ctx)
  const settings = env.settings
  const store = await loadStore(tx, ctx, note.store_id, {
    requireActive: false,
    checkAccess: false,
  })
  const lines = await tx
    .selectFrom('credit_note_lines as l')
    .leftJoin('batches as b', (j) =>
      j.onRef('b.tenant_id', '=', 'l.tenant_id').onRef('b.id', '=', 'l.batch_id'),
    )
    .leftJoin('sales_invoice_lines as il', (j) =>
      j.onRef('il.tenant_id', '=', 'l.tenant_id').onRef('il.id', '=', 'l.invoice_line_id'),
    )
    .selectAll('l')
    .select(['b.batch_no', 'b.expiry_date', 'il.meta as invoice_line_meta', 'il.mrp_paise'])
    .where('l.tenant_id', '=', ctx.tenantId)
    .where('l.credit_note_id', '=', id)
    .orderBy('l.line_no')
    .execute()
  const invoice = note.invoice_id
    ? await tx
        .selectFrom('sales_invoices')
        .select(['number', 'invoice_date', 'customer_address', 'price_includes_tax'])
        .where('tenant_id', '=', ctx.tenantId)
        .where('id', '=', note.invoice_id)
        .executeTakeFirst()
    : undefined
  const names = await userNames(tx, [note.created_by])
  const register = note.register_id
    ? await tx
        .selectFrom('registers')
        .select('code')
        .where('tenant_id', '=', ctx.tenantId)
        .where('id', '=', note.register_id)
        .executeTakeFirst()
    : undefined
  const format = await printFormatFor(tx, ctx, env, note.register_id, opts.format)
  const reason = CreditNoteReasonSchema.parse(note.reason)
  const settlement = CreditNoteSettlementSchema.parse(note.settlement)
  const { breakup, hsn } = taxRows(lines, note.is_interstate)
  const posState = getState(note.place_of_supply)
  const buyerState = note.customer_state_code ? getState(note.customer_state_code) : undefined
  const title = SALES_DOC_TITLES.credit_note
  const tax = note.cgst_paise + note.sgst_paise + note.igst_paise + note.cess_paise
  const lineModels: ModelLine[] = lines.map((l) => {
    const meta = recordOf(l.invoice_line_meta)
    const variant = Object.values(stringRecordOf(meta['variant']))
    return {
      line_no: l.line_no,
      name: l.name,
      name_ta: l.name_ta,
      variant_text: variant.length ? variant.join(' / ') : null,
      note: null,
      hsn_code: l.hsn_code,
      batch_no: l.batch_no ?? null,
      expiry_date: l.expiry_date ?? null,
      schedule: null,
      serial_numbers: [],
      qty_milli: l.qty_milli,
      unit: l.unit,
      uqc: uqcFor(l.unit),
      qty_display: qtyDisplay(l.qty_milli, l.pack_size, l.unit),
      pack_size: l.pack_size,
      mrp_paise: l.mrp_paise ?? null,
      rate_paise: l.unit_price_paise,
      price_includes_tax: invoice?.price_includes_tax ?? true,
      discount_paise: Math.max(
        0,
        amountForQty(l.unit_price_paise, l.qty_milli, l.pack_size) -
          (invoice?.price_includes_tax === false ? l.taxable_paise : l.total_paise),
      ),
      taxable_paise: l.taxable_paise,
      gst_rate_bp: l.gst_rate_bp,
      cgst_paise: l.cgst_paise,
      sgst_paise: l.sgst_paise,
      igst_paise: l.igst_paise,
      cess_rate_bp: l.cess_rate_bp,
      cess_paise: l.cess_paise,
      total_paise: l.total_paise,
    }
  })
  return {
    kind: 'credit_note',
    doc_type: 'credit_note',
    format,
    locale: { primary: opts.locale ?? ctx.locale, bilingual: settings.invoice.bilingual },
    title: { en: title.en, ta: title.ta },
    copies: [],
    seller: sellerOf(env, store, opts.publicView === true),
    document: {
      number: note.number,
      date: note.note_date,
      time: timeIn(note.offline_created_at ?? note.created_at, env.timezone),
      issued_at: (note.offline_created_at ?? note.created_at).toISOString(),
      status: note.status as SalesPrintModel['document']['status'],
      cancelled: note.status === 'cancelled',
      place_of_supply: note.place_of_supply,
      place_of_supply_name: posState?.name_en ?? note.place_of_supply,
      is_interstate: note.is_interstate,
      reverse_charge: false,
      register_code: register?.code ?? null,
      cashier_name: note.created_by ? (names.get(note.created_by) ?? null) : null,
      salesperson_name: null,
      due_date: null,
      valid_until: null,
      original_invoice: invoice ? { number: invoice.number, date: invoice.invoice_date } : null,
      reason: { ...CREDIT_NOTE_REASON_LABELS[reason] },
    },
    buyer: note.customer_name
      ? {
          name: note.customer_name,
          phone: note.customer_phone,
          gstin: note.customer_gstin,
          address_lines: addressLines(addressOf(invoice?.customer_address)),
          state_code: note.customer_state_code,
          state_name: buyerState?.name_en ?? null,
        }
      : null,
    lines: lineModels,
    tax_breakup: breakup,
    hsn_summary: hsn,
    tax_labels: { cgst: 'CGST', sgst: stateTaxLabel(note.place_of_supply), igst: 'IGST' },
    totals: {
      item_count: lines.length,
      gross_paise: sumSafe(lineModels.map((l) => l.total_paise + l.discount_paise)),
      item_discount_paise: 0,
      bill_discount_paise: 0,
      taxable_paise: note.taxable_paise,
      cgst_paise: note.cgst_paise,
      sgst_paise: note.sgst_paise,
      igst_paise: note.igst_paise,
      cess_paise: note.cess_paise,
      tax_paise: tax,
      round_off_paise: note.round_off_paise,
      total_paise: note.total_paise,
      loyalty_redeem_paise: 0,
      discount_paise: 0,
      mrp_savings_paise: 0,
    },
    amount_in_words: {
      en: amountInWords(note.total_paise, 'en'),
      ta: amountInWords(note.total_paise, 'ta'),
    },
    payments: [],
    paid_paise: 0,
    change_paise: 0,
    due_paise: 0,
    returned_paise: 0,
    customer_balance_paise: null,
    savings: null,
    loyalty: null,
    upi: null,
    settlement: {
      method: settlement,
      label: { ...CREDIT_NOTE_SETTLEMENT_LABELS[settlement] },
      amount_paise: note.total_paise,
    },
    composition_declaration:
      env.tenant.gst_scheme === 'composition' ? { ...COMPOSITION_DECLARATION } : null,
    footer: {
      text_en: settings.invoice.footer_text,
      text_ta: settings.invoice.footer_text_ta,
      terms: settings.invoice.terms,
    },
    signatory: {
      label: { ...AUTHORISED_SIGNATORY },
      for_name: env.tenant.legal_name ?? env.tenant.name,
    },
    rx: null,
    flags: {
      show_hsn: settings.invoice.show_hsn,
      show_mrp: lineModels.some((l) => l.mrp_paise !== null),
      show_mrp_savings: false,
      bilingual: settings.invoice.bilingual,
    },
    share_url: null,
    generated_at: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------------------------
// Public invoice
// ---------------------------------------------------------------------------------------------

export async function publicInvoice(
  tx: Tx,
  ctx: SalesCtx,
  invoiceId: string,
  publicBaseUrl: string,
): Promise<PublicInvoice> {
  const document = await invoicePrintModel(tx, ctx, invoiceId, {
    publicView: true,
    publicBaseUrl,
  })
  const row = await loadInvoiceRow(tx, ctx, invoiceId)
  let pay: PublicInvoice['pay'] = null
  if (row.status === 'completed' && row.doc_type !== 'estimate' && row.due_paise > 0) {
    const acct = await upiAccountFor(tx, ctx, row.store_id)
    const env = await salesEnv(tx, ctx)
    const upi = upiFor(acct, env.tenant.name, row.due_paise, row.number ?? '')
    if (upi) {
      pay = {
        amount_paise: upi.amount_paise,
        upi_uri: upi.uri,
        vpa: upi.vpa,
        payee_name: upi.payee_name,
        short_url: null,
      }
    }
  }
  return { document, pay }
}

// ---------------------------------------------------------------------------------------------
// Share
// ---------------------------------------------------------------------------------------------

export async function shareInvoice(
  tx: Tx,
  ctx: SalesCtx,
  id: string,
  body: {
    channel: 'whatsapp' | 'sms'
    phone?: string | null | undefined
    locale?: Locale | undefined
  },
  publicBaseUrl: string,
): Promise<InvoiceShareResult> {
  const row = await loadInvoiceRow(tx, ctx, id, { forUpdate: true })
  if (row.status !== 'completed' && row.status !== 'converted') {
    throw conflict('Only completed bills can be shared', {
      reason: 'not_completed',
      status: row.status,
    })
  }
  let token = row.share_token
  if (!token) {
    token = generateShareToken()
    await tx
      .updateTable('sales_invoices')
      .set({ share_token: token })
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', id)
      .execute()
  }
  const url = shareUrlOf(publicBaseUrl, token)!
  const rawPhone = body.phone ?? row.customer_phone
  const phone = rawPhone ? normalizeIndianPhone(rawPhone) : null
  if (!phone) throw invalidField('phone', 'phone_required')
  const env = await salesEnv(tx, ctx)
  const locale = body.locale ?? ctx.locale
  const shopName = locale === 'ta' ? (env.tenant.name_ta ?? env.tenant.name) : env.tenant.name
  const params: NotificationParams = {
    shop_name: shopName,
    customer_name: row.customer_name ?? (locale === 'ta' ? 'வாடிக்கையாளர்' : 'Customer'),
    number: row.number ?? '',
    amount: formatINR(row.total_paise),
    due: row.due_paise > 0 && row.status === 'completed' ? formatINR(row.due_paise) : null,
    link: url,
  }
  const rendered = renderNotification({
    code: INVOICE_SHARE_TEMPLATE,
    channel: body.channel,
    locale,
    params,
  })
  const message = rendered?.body ?? url
  let notificationId: string | null = null
  if (env.features.has('notifications')) {
    const n = await enqueueNotification(tx, ctx, {
      channel: body.channel,
      template_code: INVOICE_SHARE_TEMPLATE,
      to: phone,
      recipient_name: row.customer_name,
      locale,
      params,
      ref_type: 'sales_invoice',
      ref_id: id,
    })
    notificationId = n.id
  }
  await audit(tx, ctx, {
    action: 'sales_invoice.share',
    entity_type: 'sales_invoice',
    entity_id: id,
    summary: `Bill ${row.number ?? ''} shared by ${body.channel}`,
    changes: { channel: body.channel, notification_id: notificationId },
  })
  return {
    url,
    share_token: token,
    notification_id: notificationId,
    message,
    wa_me_url: body.channel === 'whatsapp' ? waMeUrl(phone, message) : null,
  }
}
