import { waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { type PaymentIntent, paymentsRoutes } from '@kadai/shared/api/payments'
import { makeMe } from '@/test/fixtures'
import { errorResponse, server } from '@/test/msw'
import { signIn } from '@/test/render'
import * as F from '../testing/fixtures'
import { createPaymentsApi, json } from '../testing/handlers'
import { sseResponse } from '../testing/sse'
import { type IntentWatchMode, parseIntentFrame, watchIntent } from './intent-watch'

const pending = F.intent()
const paid = F.paidIntent(pending)

function collect() {
  const intents: PaymentIntent[] = []
  const modes: IntentWatchMode[] = []
  return {
    intents,
    modes,
    onIntent: (i: PaymentIntent) => intents.push(i),
    onMode: (m: IntentWatchMode) => modes.push(m),
  }
}

describe('watchIntent', () => {
  it('follows the SSE stream and stops on a terminal status', async () => {
    const api = createPaymentsApi({ streamIntent: () => sseResponse([pending, paid]) })
    server.use(...api.handlers)
    await signIn(makeMe())
    const seen = collect()
    const watch = watchIntent(pending.id, { initial: pending, ...seen })
    await waitFor(() => expect(seen.intents.map((i) => i.status)).toEqual(['pending', 'paid']))
    expect(seen.modes).toEqual(['sse', 'stopped'])
    const stream = api.callsTo(paymentsRoutes.streamIntent)[0]!
    expect(stream.headers.get('authorization')).toMatch(/^Bearer /)
    expect(stream.path).toBe(`/api/v1/payments/intents/${pending.id}/stream`)
    // No long poll while the stream works.
    expect(api.callsTo(paymentsRoutes.getIntent)).toHaveLength(0)
    watch.close()
  })

  it('falls back to long polling when the stream fails', async () => {
    let polls = 0
    const api = createPaymentsApi({
      streamIntent: () => errorResponse(503, 'SERVICE_UNAVAILABLE'),
      getIntent: () => json({ data: ++polls < 2 ? pending : paid }),
    })
    server.use(...api.handlers)
    await signIn(makeMe())
    const seen = collect()
    watchIntent(pending.id, { initial: pending, ...seen })
    await waitFor(() => expect(seen.intents.at(-1)?.status).toBe('paid'), { timeout: 5_000 })
    expect(seen.modes).toContain('poll')
    expect(seen.modes.at(-1)).toBe('stopped')
    const first = api.callsTo(paymentsRoutes.getIntent)[0]!
    expect(first.query.get('wait')).toBe('25')
    expect(first.query.get('since_status')).toBe('pending')
  })

  it('stops for good when the intent is gone', async () => {
    const api = createPaymentsApi({
      streamIntent: () => errorResponse(404, 'NOT_FOUND'),
    })
    server.use(...api.handlers)
    await signIn(makeMe())
    const onError = vi.fn()
    const seen = collect()
    watchIntent(pending.id, { initial: pending, ...seen, onError })
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
    expect(seen.modes.at(-1)).toBe('stopped')
    expect(api.callsTo(paymentsRoutes.getIntent)).toHaveLength(0)
  })

  it('never goes back from a terminal status and ignores other intents', async () => {
    const api = createPaymentsApi({
      streamIntent: () =>
        sseResponse([F.intent({ id: F.ID.intentExpired }), paid, pending], { keepOpen: true }),
    })
    server.use(...api.handlers)
    await signIn(makeMe())
    const seen = collect()
    watchIntent(pending.id, { initial: pending, ...seen })
    await waitFor(() => expect(seen.modes.at(-1)).toBe('stopped'))
    expect(seen.intents.map((i) => i.status)).toEqual(['paid'])
  })

  it('does not watch an intent that is already final', () => {
    const seen = collect()
    watchIntent(paid.id, { initial: paid, ...seen })
    expect(seen.modes).toEqual(['stopped'])
  })

  it('drops malformed frames', () => {
    expect(parseIntentFrame('{not json')).toBeNull()
    expect(parseIntentFrame(JSON.stringify({ id: 'x' }))).toBeNull()
    expect(parseIntentFrame(JSON.stringify(paid))?.status).toBe('paid')
  })
})
