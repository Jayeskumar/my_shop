/**
 * Feeds the customer-facing display window (/pos/display) over the BroadcastChannel helper:
 * branding on connect, the cart and totals as they change, the UPI QR while a customer pays,
 * then the thank-you screen.
 */
import { useCallback, useEffect, useRef } from 'react'
import {
  type DisplayBranding,
  type DisplayCart,
  type DisplayChannel,
  type DisplayMessage,
  openDisplayChannel,
} from '@/lib/display-channel'
import type { CartState } from '../lib/cart'
import type { CartPricing } from '../lib/pricing'

const CART_DEBOUNCE_MS = 120

export function displayCartOf(cart: CartState, pricing: CartPricing): DisplayCart {
  return {
    lines: pricing.lines.map((l) => ({
      key: l.line.key,
      name: l.line.product.name,
      name_ta: l.line.product.name_ta,
      qty_milli: l.line.qty_milli,
      unit: l.line.product.unit,
      unit_price_paise: l.price.unit_price_paise,
      total_paise: l.total_paise,
      mrp_paise: l.price.mrp_paise,
    })),
    item_count: pricing.item_count,
    discount_paise: pricing.result.item_discount_paise + pricing.result.bill_discount_paise,
    tax_paise: pricing.result.tax_paise,
    total_paise: pricing.result.total_paise,
    mrp_savings_paise: pricing.savings_paise,
    customer_name: cart.customer?.name ?? null,
  }
}

export interface CustomerDisplayApi {
  send: (message: DisplayMessage) => void
}

export function useCustomerDisplay(input: {
  enabled: boolean
  branding: DisplayBranding | null
  cart: CartState
  pricing: CartPricing
  /** Suspend cart updates (payment QR / thank-you screen showing). */
  paused: boolean
}): CustomerDisplayApi {
  const channelRef = useRef<DisplayChannel | null>(null)
  const brandingRef = useRef(input.branding)
  const lastCart = useRef<DisplayCart | null>(null)
  useEffect(() => {
    brandingRef.current = input.branding
  })

  useEffect(() => {
    if (!input.enabled) return
    const channel = openDisplayChannel()
    channelRef.current = channel
    const off = channel.subscribe((m) => {
      if (m.type !== 'hello') return
      // A display window (re)connected: send everything it needs.
      if (brandingRef.current) channel.send({ type: 'branding', branding: brandingRef.current })
      const cart = lastCart.current
      channel.send(cart && cart.lines.length ? { type: 'cart', cart } : { type: 'idle' })
    })
    return () => {
      off()
      channel.close()
      channelRef.current = null
    }
  }, [input.enabled])

  useEffect(() => {
    if (input.branding) channelRef.current?.send({ type: 'branding', branding: input.branding })
  }, [input.branding])

  const displayCart = displayCartOf(input.cart, input.pricing)
  const signature = JSON.stringify(displayCart)
  useEffect(() => {
    lastCart.current = displayCart
    if (input.paused) return
    const timer = setTimeout(() => {
      channelRef.current?.send(
        displayCart.lines.length ? { type: 'cart', cart: displayCart } : { type: 'idle' },
      )
    }, CART_DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // `signature` is the cart by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, input.paused])

  const send = useCallback((message: DisplayMessage) => channelRef.current?.send(message), [])
  return { send }
}
