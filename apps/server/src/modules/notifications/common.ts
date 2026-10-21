/** Small helpers shared by the notifications module's services. */
import { DEFAULT_TIMEZONE, type Locale } from '@kadai/shared'
import type { RequestContext } from '../../core/context'
import type { Tx } from '../../db/tenant'

/** ISO-8601 string of a pg timestamptz value (Date) — the response schemas' zTimestamp output. */
export function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

export function isoOrNull(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined ? null : iso(value)
}

/** Escapes LIKE wildcards (the default escape character is a backslash). */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`)
}

export function localeOf(value: string | null | undefined): Locale {
  return value === 'en' ? 'en' : 'ta'
}

/** Business facts the module needs about the tenant (name in the message locale, timezone…). */
export interface ShopInfo {
  id: string
  name: string
  name_ta: string | null
  phone: string | null
  default_locale: Locale
  timezone: string
  status: string
}

export async function loadShop(tx: Tx, ctx: Pick<RequestContext, 'tenantId'>): Promise<ShopInfo> {
  const t = await tx
    .selectFrom('tenants')
    .select(['id', 'name', 'name_ta', 'phone', 'default_locale', 'timezone', 'status'])
    .where('id', '=', ctx.tenantId)
    .executeTakeFirstOrThrow()
  return {
    ...t,
    default_locale: localeOf(t.default_locale),
    timezone: t.timezone || DEFAULT_TIMEZONE,
  }
}

/** The shop name as customers know it in `locale` (Tamil name when set). */
export function shopNameFor(shop: Pick<ShopInfo, 'name' | 'name_ta'>, locale: Locale): string {
  return locale === 'ta' && shop.name_ta?.trim() ? shop.name_ta.trim() : shop.name
}
