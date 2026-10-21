/**
 * Public components and hooks of the payments feature, for the POS, sales, parties and any
 * screen that collects money:
 *
 *   import { UpiQrPanel, useCreatePaymentIntent, usePaymentIntentStatus, PaymentMethodIcon }
 *     from '@/features/payments/components'
 *
 *  - UpiQrPanel: `{ intent }` (live status over SSE with a long-poll fallback, countdown,
 *    manual confirm with optional UTR for shop-UPI-ID QRs, cancel / regenerate) or
 *    `{ static: { vpa, payee_name, amount_paise } }` (offline QR, cashier confirms).
 *  - useCreatePaymentIntent: POST /payments/intents (idempotent).
 *  - usePaymentIntentStatus: live status of one intent.
 *  - PaymentMethodIcon, IntentStatusBadge, PaymentStatusBadge, QrCode.
 */
export { UpiQrPanel, type StaticUpiQr, type UpiQrPanelProps } from './UpiQrPanel'
export {
  useCreatePaymentIntent,
  usePaymentIntentStatus,
  type PaymentIntentStatusState,
} from './intent-hooks'
export { PaymentMethodIcon, type PaymentMethodIconProps } from './PaymentMethodIcon'
export { IntentStatusBadge, PaymentStatusBadge } from './StatusBadges'
export { QrCode, type QrCodeProps } from './QrCode'
export type { IntentWatchMode } from '../lib/intent-watch'
