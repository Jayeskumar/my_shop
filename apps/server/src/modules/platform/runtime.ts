/** What the platform module's handlers share: deps, settings, the Razorpay client and a clock. */
import type { KadaiDeps } from '../../core/runtime'
import type { RazorpayPlatformClient } from './razorpay'
import type { PlatformSettings } from './settings'
import type { Clock } from './util'

export interface PlatformRuntime {
  deps: KadaiDeps
  settings: PlatformSettings
  razorpay: RazorpayPlatformClient
  now: Clock
  /** system_settings key of the worker heartbeat read by GET /system/info. */
  heartbeatKey: string
}
