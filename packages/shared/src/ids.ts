/**
 * Identifiers. Kadai generates UUID v7 ids in the application (server and offline POS) so
 * that rows can be created offline, retries are idempotent and ids sort by creation time.
 */
import { v7 as uuidv7 } from 'uuid'

/** RFC 9562 UUID (versions 1–8, RFC variant) plus the nil and max UUIDs, any case. */
const UUID_RE =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** New time-ordered UUID v7 (lower case, canonical form). Monotonic within a process. */
export function newId(): string {
  return uuidv7()
}

/** True for a canonical RFC 9562 UUID string (what PostgreSQL `uuid` and `z.uuid()` accept). */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

/** True for a UUID v7. */
export function isUuidV7(value: unknown): value is string {
  return typeof value === 'string' && UUID_V7_RE.test(value)
}

/**
 * Creation instant embedded in a UUID v7 (48-bit Unix milliseconds), or null for other ids.
 * Useful to order offline-created documents without trusting device clocks blindly.
 */
export function uuidV7Timestamp(id: string): Date | null {
  if (!isUuidV7(id)) return null
  const hex = id.slice(0, 8) + id.slice(9, 13)
  return new Date(Number.parseInt(hex, 16))
}
