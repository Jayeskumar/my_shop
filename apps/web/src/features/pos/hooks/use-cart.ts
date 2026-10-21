/**
 * The counter's cart: reducer state persisted to IndexedDB on every change (debounced, flushed
 * when the tab is hidden or closed), so a reload, a crash or a power cut never loses the bill
 * being rung up.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { meta } from '@/lib/offline/db'
import { type CartAction, type CartState, cartReducer, emptyCart, isCartState } from '../lib/cart'
import { posMetaKeys } from '../lib/catalog'
import type { PosRegisterScope } from '../lib/types'

const SAVE_DELAY_MS = 150

type CartReducerAction = CartAction | { type: '__restore'; cart: CartState }

function reducer(state: CartState, action: CartReducerAction): CartState {
  if (action.type === '__restore') return action.cart
  return cartReducer(state, action)
}

export function useCart(scope: PosRegisterScope | null): {
  cart: CartState
  dispatch: (action: CartAction) => void
  restored: boolean
} {
  const [cart, rawDispatch] = useReducer(reducer, undefined, emptyCart)
  const [restored, setRestored] = useState(false)
  const key = scope ? posMetaKeys.cart(scope.tenantId, scope.key) : null
  const latest = useRef(cart)
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)
  const restoredRef = useRef(false)

  // Restore the persisted cart of this counter.
  useEffect(() => {
    restoredRef.current = false
    setRestored(false)
    if (!key) return
    let cancelled = false
    void meta
      .get<unknown>(key)
      .then((saved) => {
        if (cancelled) return
        if (isCartState(saved)) rawDispatch({ type: '__restore', cart: saved })
      })
      .catch(() => undefined)
      .finally(() => {
        if (cancelled) return
        restoredRef.current = true
        setRestored(true)
      })
    return () => {
      cancelled = true
    }
  }, [key])

  const flush = useCallback(() => {
    if (pending.current) {
      clearTimeout(pending.current)
      pending.current = null
    }
    if (!key || !restoredRef.current) return
    void meta.set(key, latest.current).catch((e: unknown) => {
      console.error('POS cart could not be saved on this device', e)
    })
  }, [key])

  useEffect(() => {
    latest.current = cart
    if (!restoredRef.current) return
    if (pending.current) clearTimeout(pending.current)
    pending.current = setTimeout(flush, SAVE_DELAY_MS)
  }, [cart, flush])

  useEffect(() => {
    const onHide = (): void => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onHide)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onHide)
      flush()
    }
  }, [flush])

  const dispatch = useCallback((action: CartAction) => rawDispatch(action), [])
  return { cart, dispatch, restored }
}
