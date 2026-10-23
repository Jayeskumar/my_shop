/**
 * Server-sent event responses for MSW: `event: intent` frames carrying PaymentIntent JSON,
 * exactly as GET /payments/intents/:id/stream sends them. `delayMs` spaces the frames out;
 * the stream closes after the last frame unless `keepOpen`.
 */
import { INTENT_STREAM_EVENT, type PaymentIntent } from '@kadai/shared/api/payments'

export function sseResponse(
  frames: readonly PaymentIntent[],
  { delayMs = 20, keepOpen = false }: { delayMs?: number; keepOpen?: boolean } = {},
): Response {
  const encoder = new TextEncoder()
  let timer: ReturnType<typeof setTimeout> | null = null
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let i = 0
      const next = (): void => {
        if (i >= frames.length) {
          if (!keepOpen) controller.close()
          return
        }
        const frame = frames[i++]!
        controller.enqueue(
          encoder.encode(`event: ${INTENT_STREAM_EVENT}\ndata: ${JSON.stringify(frame)}\n\n`),
        )
        timer = setTimeout(next, delayMs)
      }
      controller.enqueue(encoder.encode(': connected\n\n'))
      timer = setTimeout(next, delayMs)
    },
    cancel() {
      if (timer) clearTimeout(timer)
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' },
  })
}
