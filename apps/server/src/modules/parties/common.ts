/**
 * Helpers shared by the parties services: tenant business date, LIKE-safe search, advisory locks,
 * opening-balance journals (the ONLY way this module changes a party balance — through
 * core/ledger postJournal), stored-JSON readers and CSV replies.
 */
import { type Address, AddressSchema } from '@kadai/shared/api/common'
import { OPENING_BALANCE_EDIT_PERMISSION } from '@kadai/shared/api/parties'
import { hasPermission, paiseToRupeesString, todayIn } from '@kadai/shared'
import type { FastifyReply } from 'fastify'
import { type Expression, type RawBuilder, type SqlBool, sql } from 'kysely'
import type { Tx } from '../../db/tenant'
import type { RequestContext } from '../../core/context'
import { forbidden } from '../../core/errors'
import { postJournal } from '../../core/ledger'
import { tenantCalendar } from '../../core/numbering'

export type PartyKind = 'customer' | 'supplier'

/** ISO string of a timestamptz value (response schemas output strings). */
export function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

export function isoOrNull(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined ? null : iso(value)
}

/** Today's business date in the tenant timezone. */
export async function tenantToday(tx: Tx, ctx: Pick<RequestContext, 'tenantId'>): Promise<string> {
  const cal = await tenantCalendar(tx, { tenantId: ctx.tenantId })
  return todayIn(cal.timezone)
}

/** Escapes LIKE wildcards (backslash is PostgreSQL's default LIKE escape character). */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/**
 * Digits to match against stored E.164 phones when the query looks like (part of) a phone
 * number: at least 3 digits, only digits / spaces / + - ( ). Leading zeros (trunk prefix) are
 * dropped, so '098765' matches '+9198765…'.
 */
export function phoneSearchDigits(q: string): string | null {
  if (!/^[\d\s+\-()]+$/.test(q)) return null
  const digits = q.replace(/\D/g, '').replace(/^0+/, '')
  return digits.length >= 3 ? digits : null
}

/** OR of the given conditions (wrapped in parentheses). */
export function anyOf(parts: readonly Expression<SqlBool>[]): Expression<SqlBool> {
  return sql<SqlBool>`(${sql.join(parts, sql` or `)})`
}

/** Transaction-scoped advisory lock on an arbitrary key (serialises e.g. phone uniqueness checks). */
export async function lockKey(tx: Tx, key: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(tx)
}

/** Reads a stored address jsonb leniently (invalid / missing → {}). */
export function readAddress(value: unknown): Address {
  const parsed = AddressSchema.safeParse(value ?? {})
  return parsed.success ? parsed.data : AddressSchema.parse({})
}

/** 403 unless the member may change an existing party's opening balance. */
export function assertOpeningBalanceEdit(ctx: Pick<RequestContext, 'permissions'>): void {
  if (!hasPermission(ctx.permissions, OPENING_BALANCE_EDIT_PERMISSION)) {
    throw forbidden('Changing an opening balance needs accounting permission', {
      required: [OPENING_BALANCE_EDIT_PERMISSION],
      reason: 'opening_balance_permission',
    })
  }
}

/**
 * Posts an opening balance (or a change of it) for a party as a journal with source 'opening':
 *   customer  +amount: Dr receivable(customer) / Cr opening_balance   (customer owes the shop)
 *   supplier  +amount: Cr payable(supplier)    / Dr opening_balance   (shop owes the supplier)
 * Negative amounts post the mirror lines. Zero posts nothing.
 */
export async function postOpeningBalance(
  tx: Tx,
  ctx: Pick<RequestContext, 'tenantId' | 'userId'>,
  input: {
    party: PartyKind
    party_id: string
    /** Signed amount in the party's sign convention (the delta for a change). */
    amount_paise: number
    entry_date: string
    narration: string
  },
): Promise<string | null> {
  const amount = input.amount_paise
  if (amount === 0) return null
  const abs = Math.abs(amount)
  const partyRef = { type: input.party, id: input.party_id }
  const partyAccount = input.party === 'customer' ? 'receivable' : 'payable'
  // Customer: + is a debit on the receivable. Supplier: + is a credit on the payable.
  const partyDebit = input.party === 'customer' ? amount > 0 : amount < 0
  const posted = await postJournal(tx, ctx, {
    entry_date: input.entry_date,
    store_id: null,
    source_type: 'opening',
    source_id: input.party_id,
    narration: input.narration,
    lines: [
      {
        account: { subtype: partyAccount },
        ...(partyDebit ? { debit_paise: abs } : { credit_paise: abs }),
        party: partyRef,
      },
      {
        account: { subtype: 'opening_balance' },
        ...(partyDebit ? { credit_paise: abs } : { debit_paise: abs }),
      },
    ],
  })
  return posted.entry_id
}

/** "₹1250.00" style amount for narrations / audit summaries (English, developer-facing). */
export function rupees(paise: number): string {
  return `₹${paiseToRupeesString(paise)}`
}

/** ASCII-only slug for download file names. */
export function fileSlug(text: string, fallback: string): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug || fallback
}

/** Sends a CSV document (already BOM-prefixed by toCsv) as a download. */
export function sendCsv(reply: FastifyReply, filename: string, csv: string): FastifyReply {
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, '_')
  return reply
    .code(200)
    .header('content-type', 'text/csv; charset=utf-8')
    .header('content-disposition', `attachment; filename="${safe}"`)
    .send(Buffer.from(csv, 'utf8'))
}

/**
 * `and <column> = any(storeIds)` for sub-queries on store-specific documents (sales, payment
 * links) when the member is store-scoped; empty otherwise.
 */
export function storeScopeSql(
  column: string,
  ctx: Pick<RequestContext, 'storeIds'>,
): RawBuilder<unknown> {
  if (ctx.storeIds === null) return sql``
  return sql`and ${sql.ref(column)} = any(${[...ctx.storeIds]}::uuid[])`
}
