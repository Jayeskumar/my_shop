/**
 * Tender maths of the payment dialog on top of the shared `allocateTenders` (the server applies
 * the very same rules): non-cash tenders first (each must fit what is left), then cash where the
 * amount is the cash handed over and the rest is change; whatever stays unpaid is the due
 * (khata / credit).
 */
import { allocateTenders, type TenderInput } from '@kadai/shared/api/sales'
import type { PaymentMethod } from '@kadai/shared/enums'

export interface PosTender {
  /** Local row id. */
  id: string
  method: PaymentMethod
  /** Cash: the cash handed over; others: the amount paid. */
  amount_paise: number
  reference?: string
  /** UPI via a dynamic QR / confirmed intent. */
  payment_intent_id?: string
  /** UPI to a static UPI ID (no intent): the account that received it. */
  provider_account_id?: string
}

export interface TenderSummary {
  total_paise: number
  /** Applied to the bill. */
  paid_paise: number
  change_paise: number
  /** Still unpaid after the tenders (credit when completed like this). */
  due_paise: number
  issue: { code: 'tender_exceeds_due' | 'cash_tender_not_needed'; index: number } | null
}

export function summarizeTenders(totalPaise: number, tenders: readonly PosTender[]): TenderSummary {
  const alloc = allocateTenders(totalPaise, tenders)
  return {
    total_paise: totalPaise,
    paid_paise: alloc.paid_paise,
    change_paise: alloc.change_paise,
    due_paise: alloc.due_paise,
    issue: alloc.issue,
  }
}

/** What a new non-cash tender may cover: the total minus every other non-cash tender. */
export function remainingForNonCash(totalPaise: number, tenders: readonly PosTender[]): number {
  const nonCash = tenders.filter((t) => t.method !== 'cash').reduce((s, t) => s + t.amount_paise, 0)
  return Math.max(0, totalPaise - nonCash)
}

/**
 * Default amount of a new non-cash tender: what the cash handed over leaves unpaid (₹500 cash on
 * a ₹791 bill → ₹291 by UPI). When the cash already covers the bill the customer is switching
 * method, so it is the whole non-cash remainder (and the cash is dropped once that is paid).
 */
export function suggestNonCash(
  totalPaise: number,
  nonCash: readonly PosTender[],
  cashPaise: number,
): number {
  const left = remainingForNonCash(totalPaise, nonCash)
  return cashPaise > 0 && cashPaise < left ? left - cashPaise : left
}

/** Cash still needed after the non-cash tenders (what "exact" fills in). */
export function cashNeeded(totalPaise: number, tenders: readonly PosTender[]): number {
  return remainingForNonCash(totalPaise, tenders)
}

/** Quick note buttons (₹10 … ₹500). */
export const QUICK_NOTES_PAISE = [1_000, 2_000, 5_000, 10_000, 20_000, 50_000] as const

/**
 * Likely cash a customer hands over for an amount: the next ₹10 / ₹50 / ₹100 above it, then one
 * and two ₹500 notes more (₹347 → ₹350, ₹400, ₹500, ₹1,000; ₹500 → ₹1,000, ₹1,500), without
 * duplicates or the exact amount itself (that is the "exact" button).
 */
export function suggestTendered(duePaise: number): number[] {
  if (duePaise <= 0) return []
  const out = new Set<number>()
  for (const step of [1_000, 5_000, 10_000]) {
    const next = Math.ceil(duePaise / step) * step
    if (next > duePaise) out.add(next)
  }
  const next500 = (Math.floor(duePaise / 50_000) + 1) * 50_000
  out.add(next500)
  out.add(next500 + 50_000)
  return [...out].sort((a, b) => a - b).slice(0, 4)
}

/** Request tenders for POST /sales/invoices, /pos/quote and /pos/sync. */
export function toTenderInputs(tenders: readonly PosTender[]): TenderInput[] {
  return tenders
    .filter((t) => t.amount_paise > 0)
    .map((t) => ({
      method: t.method,
      amount_paise: t.amount_paise,
      ...(t.payment_intent_id ? { payment_intent_id: t.payment_intent_id } : {}),
      ...(t.provider_account_id ? { provider_account_id: t.provider_account_id } : {}),
      ...(t.reference ? { reference: t.reference } : {}),
    }))
}

/** Cash handed over in total (for the change display). */
export function cashTendered(tenders: readonly PosTender[]): number {
  return tenders.filter((t) => t.method === 'cash').reduce((s, t) => s + t.amount_paise, 0)
}

/** Methods that work without the server (static UPI ID QR is confirmed by the cashier). */
export const OFFLINE_TENDER_METHODS: readonly PaymentMethod[] = ['cash', 'card', 'upi']
