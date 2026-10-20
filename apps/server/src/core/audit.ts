/**
 * Tenant audit trail (ARCHITECTURE.md §7.7). Write inside the business transaction so the audit
 * row commits (or rolls back) with the change it describes. audit_logs is append-only.
 *
 * Mandatory for: logins, role/permission changes, settings changes, price changes,
 * invoice/credit-note/purchase cancellation, stock adjustments, manual journal entries, payment
 * provider changes, discount/price overrides beyond limits, data exports.
 */
import { isIP } from 'node:net'
import type { Tx } from '../db/tenant'
import { jsonb } from '../db/json'
import type { RequestContext } from './context'

export interface AuditEntry {
  /** Dotted verb, e.g. 'sales_invoice.cancel', 'settings.update', 'auth.login'. */
  action: string
  entity_type?: string | null
  entity_id?: string | null
  /** Short human-readable line for the audit screen. */
  summary?: string | null
  /** {before, after} (see diffChanges) or arbitrary details. */
  changes?: unknown
}

type AuditContext = Pick<RequestContext, 'tenantId' | 'userId' | 'ip' | 'userAgent' | 'requestId'>

function cleanIp(ip: string): string | null {
  const v = ip.startsWith('::ffff:') ? ip.slice(7) : ip
  return isIP(v) ? v : null
}

export async function audit(tx: Tx, ctx: AuditContext, entry: AuditEntry): Promise<void> {
  await tx
    .insertInto('audit_logs')
    .values({
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      action: entry.action,
      entity_type: entry.entity_type ?? null,
      entity_id: entry.entity_id ?? null,
      summary: entry.summary?.slice(0, 500) ?? null,
      changes: entry.changes === undefined ? null : jsonb(entry.changes),
      ip: cleanIp(ctx.ip),
      user_agent: ctx.userAgent ? ctx.userAgent.slice(0, 512) : null,
      request_id: ctx.requestId,
    })
    .execute()
}

type Plain = Record<string, unknown>
const isPlain = (v: unknown): v is Plain => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date)

/**
 * Field-level diff of two objects (nested objects compared recursively, arrays/scalars by value):
 * returns only what changed, as {before, after}, or null when nothing changed. Secret-looking keys
 * are masked.
 */
export function diffChanges(before: unknown, after: unknown): { before: Plain; after: Plain } | null {
  const b: Plain = {}
  const a: Plain = {}
  const walk = (x: unknown, y: unknown, outB: Plain, outA: Plain): boolean => {
    let changed = false
    const keys = new Set([...Object.keys(isPlain(x) ? x : {}), ...Object.keys(isPlain(y) ? y : {})])
    for (const key of keys) {
      const xv = isPlain(x) ? x[key] : undefined
      const yv = isPlain(y) ? y[key] : undefined
      if (isPlain(xv) && isPlain(yv)) {
        const nb: Plain = {}
        const na: Plain = {}
        if (walk(xv, yv, nb, na)) {
          outB[key] = nb
          outA[key] = na
          changed = true
        }
      } else if (JSON.stringify(xv) !== JSON.stringify(yv)) {
        const secret = /(password|secret|token|pin|credential|key_hash)/i.test(key)
        outB[key] = secret ? '***' : (xv ?? null)
        outA[key] = secret ? '***' : (yv ?? null)
        changed = true
      }
    }
    return changed
  }
  return walk(before, after, b, a) ? { before: b, after: a } : null
}
