/**
 * Customer display state machine: what /pos/display shows for the messages the POS window sends
 * (lib/display-channel). Pure, unit tested.
 */
import type { DisplayCart, DisplayMessage } from '@/lib/display-channel'

/** How long the thank-you screen stays before the welcome screen returns. */
export const THANK_YOU_MS = 12_000

export type DisplayScreen =
  | { kind: 'idle' }
  | { kind: 'cart'; cart: DisplayCart }
  | {
      kind: 'upi'
      uri: string
      amount_paise: number
      payee: string
      expires_at: string | null
      cart: DisplayCart | null
    }
  | {
      kind: 'status'
      status: 'paid' | 'failed' | 'expired' | 'cancelled' | 'pending'
      cart: DisplayCart | null
    }
  | {
      kind: 'thanks'
      total_paise: number
      paid_paise: number
      change_paise: number
      number: string | null
    }

/** Reducer of display messages (exported for tests). */
export function nextScreen(screen: DisplayScreen, message: DisplayMessage): DisplayScreen {
  const cartOf = (s: DisplayScreen): DisplayCart | null =>
    s.kind === 'cart' ? s.cart : s.kind === 'upi' || s.kind === 'status' ? s.cart : null
  switch (message.type) {
    case 'idle':
      return { kind: 'idle' }
    case 'cart':
      return message.cart.lines.length ? { kind: 'cart', cart: message.cart } : { kind: 'idle' }
    case 'upi_qr':
      return {
        kind: 'upi',
        uri: message.upi_uri,
        amount_paise: message.amount_paise,
        payee: message.payee_name,
        expires_at: message.expires_at,
        cart: cartOf(screen),
      }
    case 'payment_status':
      return { kind: 'status', status: message.status, cart: cartOf(screen) }
    case 'thank_you':
      return {
        kind: 'thanks',
        total_paise: message.total_paise,
        paid_paise: message.paid_paise,
        change_paise: message.change_paise,
        number: message.invoice_number,
      }
    default:
      return screen
  }
}
