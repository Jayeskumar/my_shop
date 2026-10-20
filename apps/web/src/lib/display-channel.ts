/**
 * Customer-facing display (ARCHITECTURE.md §12): the POS window broadcasts the cart, the UPI QR
 * and payment status to a second window (`/pos/display`, e.g. on a customer-facing monitor or
 * tablet in kiosk mode) over BroadcastChannel 'kadai-customer-display'. Same browser & origin
 * only — nothing leaves the device, so it also works offline.
 */

export const DISPLAY_CHANNEL = 'kadai-customer-display'
export const DISPLAY_PROTOCOL_VERSION = 1

export interface DisplayCartLine {
  key: string
  name: string
  name_ta: string | null
  qty_milli: number
  unit: string
  unit_price_paise: number
  total_paise: number
  mrp_paise: number | null
}

export interface DisplayCart {
  lines: DisplayCartLine[]
  item_count: number
  discount_paise: number
  tax_paise: number
  total_paise: number
  mrp_savings_paise: number
  customer_name: string | null
}

export interface DisplayBranding {
  store_name: string
  store_name_ta: string | null
  /** Data URL / same-origin URL of the logo. */
  logo_url: string | null
}

export type DisplayMessage =
  | { type: 'hello'; role: 'display' }
  | { type: 'branding'; branding: DisplayBranding }
  | { type: 'idle' }
  | { type: 'cart'; cart: DisplayCart }
  | {
      type: 'upi_qr'
      upi_uri: string
      amount_paise: number
      payee_name: string
      expires_at: string | null
    }
  | { type: 'payment_status'; status: 'pending' | 'paid' | 'failed' | 'expired' | 'cancelled' }
  | {
      type: 'thank_you'
      total_paise: number
      paid_paise: number
      change_paise: number
      invoice_number: string | null
    }

interface Envelope {
  v: number
  sent_at: number
  message: DisplayMessage
}

function isEnvelope(data: unknown): data is Envelope {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as Envelope).v === DISPLAY_PROTOCOL_VERSION &&
    typeof (data as Envelope).message?.type === 'string'
  )
}

export interface DisplayChannel {
  send: (message: DisplayMessage) => void
  /** Subscribe to messages from the other side. Returns an unsubscribe function. */
  subscribe: (listener: (message: DisplayMessage) => void) => () => void
  close: () => void
  /** False when BroadcastChannel is unavailable (very old browsers): all calls are no-ops. */
  readonly supported: boolean
}

/** Opens the channel (call once per window; close it on unmount). */
export function openDisplayChannel(name: string = DISPLAY_CHANNEL): DisplayChannel {
  if (typeof BroadcastChannel === 'undefined') {
    return { send: () => {}, subscribe: () => () => {}, close: () => {}, supported: false }
  }
  const channel = new BroadcastChannel(name)
  const listeners = new Set<(message: DisplayMessage) => void>()
  channel.onmessage = (event: MessageEvent<unknown>) => {
    if (!isEnvelope(event.data)) return
    for (const l of [...listeners]) l(event.data.message)
  }
  return {
    supported: true,
    send(message) {
      const envelope: Envelope = { v: DISPLAY_PROTOCOL_VERSION, sent_at: Date.now(), message }
      try {
        channel.postMessage(envelope)
      } catch (error) {
        console.warn('customer display: message not sent', error)
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close() {
      listeners.clear()
      channel.close()
    },
  }
}

/** Opens /pos/display in a separate window (call from a click handler: popup blockers). */
export function openCustomerDisplayWindow(): Window | null {
  return window.open('/pos/display', 'kadai-customer-display', 'popup=yes,width=1024,height=768')
}
