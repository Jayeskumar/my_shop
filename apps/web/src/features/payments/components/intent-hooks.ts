/**
 * Reusable payment-intent hooks (POS, dues collection, invoice detail):
 *
 *   const create = useCreatePaymentIntent()
 *   const res = await create.mutateAsync({ body: { amount_paise, purpose: 'pos_sale', store_id,
 *     register_id, ref_type: 'pos_cart', ref_id: cartRef } })
 *   const live = usePaymentIntentStatus(res.data.id, { initial: res.data })
 *   live.intent?.status === 'paid' → tender { method: 'upi', payment_intent_id }
 *
 * The create mutation sends a fresh Idempotency-Key per call (route `idempotent`); pass
 * `idempotencyKey` (or body.idempotency_key) to make a retried click return the same intent.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  isTerminalIntentStatus,
  type PaymentIntent,
  paymentsRoutes,
} from '@kadai/shared/api/payments'
import { callRoute } from '@/lib/api'
import { type UseRouteMutationOptions, useRouteMutation } from '@/lib/query'
import { type IntentWatch, type IntentWatchMode, watchIntent } from '../lib/intent-watch'

/** POST /payments/intents (errors are toasted centrally unless `options.onError` is given). */
export function useCreatePaymentIntent(
  options: UseRouteMutationOptions<typeof paymentsRoutes.createIntent, unknown> = {},
) {
  return useRouteMutation(paymentsRoutes.createIntent, {
    ...options,
    invalidates: [paymentsRoutes.listIntents, ...(options.invalidates ?? [])],
  })
}

export interface PaymentIntentStatusState {
  /** The latest known intent (the `initial` one until the first live update). */
  intent: PaymentIntent | null
  status: PaymentIntent['status'] | null
  /** How updates arrive right now. */
  mode: IntentWatchMode
  isTerminal: boolean
  /** Permanent watch failure (intent not found, access lost). */
  error: unknown
  /** Fetch the status once now ("check again"). */
  refresh: () => Promise<PaymentIntent | null>
  /** Feed a newer intent from a mutation response (confirm / cancel). */
  update: (intent: PaymentIntent) => void
}

interface WatchState {
  id: string | null
  intent: PaymentIntent | null
  mode: IntentWatchMode
  error: unknown
}

/**
 * Live status of an intent: SSE with a long-poll fallback (lib/intent-watch). Watching starts
 * when `intentId` is set and stops on a terminal status, on unmount, or when the id changes.
 */
export function usePaymentIntentStatus(
  intentId: string | null | undefined,
  options: { initial?: PaymentIntent | null; enabled?: boolean } = {},
): PaymentIntentStatusState {
  const id = intentId ?? null
  const enabled = options.enabled ?? true
  const initial = options.initial && options.initial.id === id ? options.initial : null
  const initialRef = useRef(initial)
  initialRef.current = initial
  const [state, setState] = useState<WatchState>({
    id,
    intent: initial,
    mode: 'stopped',
    error: null,
  })
  const watchRef = useRef<IntentWatch | null>(null)

  // A new intent id resets the state to what the caller knows about it.
  const current: WatchState =
    state.id === id ? state : { id, intent: initial, mode: 'stopped', error: null }

  useEffect(() => {
    if (!id || !enabled) return undefined
    const seed = initialRef.current
    setState((s) => (s.id === id ? s : { id, intent: seed, mode: 'connecting', error: null }))
    if (seed && isTerminalIntentStatus(seed.status)) return undefined
    const watch = watchIntent(id, {
      initial: seed,
      onIntent: (intent) => setState((s) => ({ ...s, id, intent, error: null })),
      onMode: (mode) => setState((s) => (s.id === id ? { ...s, mode } : s)),
      onError: (error) => setState((s) => (s.id === id ? { ...s, error } : s)),
    })
    watchRef.current = watch
    return () => {
      watch.close()
      if (watchRef.current === watch) watchRef.current = null
    }
  }, [id, enabled])

  const update = useCallback(
    (intent: PaymentIntent) => {
      if (intent.id !== id) return
      setState((s) => {
        const known = s.id === id ? s.intent : null
        if (known && isTerminalIntentStatus(known.status) && !isTerminalIntentStatus(intent.status))
          return s
        return {
          id,
          intent,
          mode: isTerminalIntentStatus(intent.status) ? 'stopped' : s.mode,
          error: null,
        }
      })
      if (isTerminalIntentStatus(intent.status)) watchRef.current?.close()
    },
    [id],
  )

  const refresh = useCallback(async () => {
    if (!id) return null
    if (watchRef.current) return watchRef.current.refresh()
    const res = await callRoute(paymentsRoutes.getIntent, { params: { id } })
    update(res.data)
    return res.data
  }, [id, update])

  const intent = current.intent
  return {
    intent,
    status: intent?.status ?? null,
    mode: current.mode,
    isTerminal: intent ? isTerminalIntentStatus(intent.status) : false,
    error: current.error,
    refresh,
    update,
  }
}
