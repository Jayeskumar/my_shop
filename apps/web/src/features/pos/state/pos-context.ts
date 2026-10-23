/**
 * Context of the billing counter (see PosProvider in pos-controller.tsx): the types every screen
 * and dialog uses, and usePos().
 */
import { createContext, useContext } from 'react'
import type { Feature } from '@kadai/shared/features'
import type { QuoteResult, SalesIssue } from '@kadai/shared/api/sales'
import type { CustomerDisplayApi } from '../hooks/use-customer-display'
import type { PosOutbox } from '../hooks/use-outbox'
import type { CatalogStatus } from '../hooks/use-pos-catalog'
import type { UseScale } from '../hardware/use-scale'
import type { CartAction, CartCustomer, CartState } from '../lib/cart'
import type { CartPricing, PricingEnv } from '../lib/pricing'
import type { PosTender } from '../lib/tenders'
import type { PosBatch, PosContext, PosProduct, PosRegisterScope } from '../lib/types'

export interface AddOptions {
  qty_milli?: number | null
  /** Line amount of a price scale barcode (the quantity is derived from the price). */
  price_paise?: number | null
  scanned_code?: string | null
  batch?: PosBatch | null
  /** Quantity already confirmed (weigh dialog): do not ask again. */
  confirmed?: boolean
}

export type PosDialog =
  | { name: 'payment'; method?: 'cash' | 'upi' | 'card' | 'credit'; outcome?: SaleOutcome }
  | { name: 'held' }
  | { name: 'bill_discount' }
  | { name: 'line'; key: string; focus?: 'qty' | 'price' | 'discount' }
  | { name: 'weigh'; product: PosProduct; options: AddOptions }
  | { name: 'batch'; key: string }
  | { name: 'variants'; parent: PosProduct; options: AddOptions }
  | { name: 'rx'; then?: 'payment' }
  | { name: 'shift' }
  | { name: 'help' }
  | { name: 'sync' }
  | { name: 'customer_add'; draft: { name?: string; phone?: string } }
  | { name: 'pin' }

export interface CompletedSale {
  mode: 'online' | 'offline'
  invoice_id: string | null
  number: string | null
  total_paise: number
  paid_paise: number
  change_paise: number
  due_paise: number
  customer_name: string | null
  customer_phone: string | null
  warnings: SalesIssue[]
  at: string
}

export type SaleOutcome =
  | { status: 'done'; sale: CompletedSale }
  | { status: 'blocked'; issues: SalesIssue[] }
  | { status: 'price_changed'; quote: QuoteResult; server_total_paise: number }
  | { status: 'needs_rx' }
  | { status: 'error'; message: string }

export interface CompleteOptions {
  credit_limit_override?: boolean
  /** The cashier accepted the server's total after a price change. */
  accept_server_total?: boolean
}

export interface PosPermissions {
  priceOverride: boolean
  discountOverride: boolean
  credit: boolean
  collect: boolean
  customersRead: boolean
  customersWrite: boolean
  catalogRead: boolean
  createSales: boolean
  returns: boolean
  shiftsOperate: boolean
  /** Rate can be edited at all (setting allow_price_edit or the override permission). */
  editPrice: boolean
}

export interface PosApi {
  scope: PosRegisterScope | null
  context: PosContext | null
  catalogStatus: CatalogStatus
  catalogSyncing: boolean
  catalogError: unknown
  catalogRevision: number
  refreshCatalog: (options?: { full?: boolean }) => Promise<PosContext | null>
  online: boolean
  cart: CartState
  cartRestored: boolean
  dispatch: (action: CartAction) => void
  pricing: CartPricing
  pricingEnv: PricingEnv | null
  today: string
  perms: PosPermissions
  hasFeature: (f: Feature) => boolean
  outbox: PosOutbox
  /** Web Serial weighing scale of the register (one connection for the session). */
  scale: UseScale
  display: CustomerDisplayApi & {
    enabled: boolean
    paused: boolean
    setPaused: (p: boolean) => void
  }
  dialog: PosDialog | null
  openDialog: (d: PosDialog) => void
  closeDialog: () => void
  busy: string | null
  lastSale: CompletedSale | null
  dismissLastSale: () => void
  silentPrint: boolean
  addProduct: (product: PosProduct, options?: AddOptions) => Promise<void>
  /** `multiplierMilli`: a "3*" typed before the code (3000) — that many of what the code stands for. */
  addByCode: (code: string, multiplierMilli?: number | null) => Promise<boolean>
  setCustomer: (customer: CartCustomer | null) => void
  hold: (label?: string | null) => Promise<void>
  recallServer: (invoiceId: string) => Promise<void>
  recallLocal: (heldId: string) => Promise<void>
  saveEstimate: () => Promise<void>
  completeSale: (tenders: PosTender[], options?: CompleteOptions) => Promise<SaleOutcome>
  printLast: () => Promise<void>
  clearCart: () => void
  rxNeeded: boolean
  /** Focus helpers registered by the search / customer boxes. */
  searchRef: React.RefObject<HTMLInputElement | null>
  customerRef: React.RefObject<HTMLInputElement | null>
  focusSearch: () => void
}

export const PosCtx = createContext<PosApi | null>(null)

export function usePos(): PosApi {
  const v = useContext(PosCtx)
  if (!v) throw new Error('usePos() outside <PosProvider>')
  return v
}
