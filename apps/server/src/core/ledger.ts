/**
 * Double-entry ledger posting (ARCHITECTURE.md §8.3, §10) — the ONLY writer of journal_entries,
 * journal_lines and of customers/suppliers.balance_paise.
 *
 *   await postJournal(tx, ctx, {
 *     entry_date: '2026-10-20', store_id, source_type: 'sales_invoice', source_id: invoice.id,
 *     lines: [
 *       { account: { subtype: 'receivable' }, debit_paise: 11800, party: { type: 'customer', id } },
 *       { account: { subtype: 'sales' }, credit_paise: 10000 },
 *       { account: { subtype: 'output_cgst' }, credit_paise: 900 },
 *       { account: { subtype: 'output_sgst' }, credit_paise: 900 },
 *     ],
 *   })
 *
 * * Lines address accounts by system subtype or by id (validated: same tenant, active).
 *   Zero lines are dropped; lines are merged per (account, party, store, side); the entry must
 *   balance or it is rejected before touching the database (the deferred trigger
 *   journal_lines_balanced is the backstop at COMMIT). An entry whose lines are all zero is not
 *   written ({ entry_id: null }).
 * * Party balances: a line on a `receivable` account with a customer party changes
 *   customers.balance_paise by debit − credit; a `payable` line with a supplier party changes
 *   suppliers.balance_paise by credit − debit. Parties on other accounts are annotations
 *   (e.g. the customer on customer_advance for store credit) and change no balance.
 * * reverseJournal posts the mirror entry (debits ↔ credits) of every not-yet-reversed entry of a
 *   source, referencing it with reverses_entry_id — at most once (unique index).
 * * journal tables are append-only: corrections are always reversals.
 */
import {
  DEFAULT_CHART,
  type JournalSourceType,
  JournalSourceTypeSchema,
  type SystemAccountSubtype,
  isDateStr,
  isSystemAccountSubtype,
  isUuid,
  newId,
} from '@kadai/shared'
import type { Tx } from '../db/tenant'
import type { RequestContext } from './context'
import { conflict, invalidField, notFound, unprocessable } from './errors'

type Ctx = Pick<RequestContext, 'tenantId' | 'userId'>

export type AccountRef = { subtype: SystemAccountSubtype } | { id: string }

export interface JournalParty {
  type: 'customer' | 'supplier'
  id: string
}

export interface JournalLineInput {
  account: AccountRef
  debit_paise?: number
  credit_paise?: number
  party?: JournalParty | null
  memo?: string | null
  /** Store dimension of the line; defaults to the entry's store_id. */
  store_id?: string | null
}

export interface JournalEntryInput {
  /** Business date (YYYY-MM-DD). */
  entry_date: string
  store_id?: string | null
  source_type: JournalSourceType
  source_id?: string | null
  narration?: string | null
  /** Manual journal number (JV series). */
  number?: string | null
  lines: readonly JournalLineInput[]
}

export interface PostedJournal {
  /** null when every line was zero (nothing posted). */
  entry_id: string | null
}

// ---------------------------------------------------------------------------------------------
// System accounts (cached per transaction)
// ---------------------------------------------------------------------------------------------

const systemAccounts = new WeakMap<Tx, Map<string, string>>()

/**
 * Id of the tenant's system account for `subtype` (seeded by onboarding from DEFAULT_CHART).
 * A missing system account (tenant created before the subtype existed) is re-created from the
 * default chart.
 */
export async function systemAccountId(
  tx: Tx,
  ctx: Pick<RequestContext, 'tenantId'>,
  subtype: SystemAccountSubtype,
): Promise<string> {
  if (!isSystemAccountSubtype(subtype)) {
    throw invalidField('account.subtype', `Unknown system account "${String(subtype)}"`)
  }
  let cache = systemAccounts.get(tx)
  if (!cache) {
    cache = new Map()
    systemAccounts.set(tx, cache)
  }
  const hit = cache.get(subtype)
  if (hit) return hit
  const find = () =>
    tx
      .selectFrom('accounts')
      .select('id')
      .where('tenant_id', '=', ctx.tenantId)
      .where('subtype', '=', subtype)
      .where('is_system', '=', true)
      .executeTakeFirst()
  let row = await find()
  if (!row) {
    const preset = DEFAULT_CHART.find((a) => a.subtype === subtype)
    if (preset) {
      await tx
        .insertInto('accounts')
        .values({
          id: newId(),
          tenant_id: ctx.tenantId,
          code: preset.code,
          name: preset.name,
          name_ta: preset.name_ta,
          type: preset.type,
          subtype: preset.subtype,
          is_system: true,
        })
        .onConflict((oc) => oc.doNothing())
        .execute()
      row = await find()
    }
  }
  if (!row) {
    throw unprocessable(`The system account "${subtype}" is missing from the chart of accounts`, {
      subtype,
    })
  }
  cache.set(subtype, row.id)
  return row.id
}

// ---------------------------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------------------------

interface AccountInfo {
  id: string
  subtype: string | null
  is_active: boolean
}

interface ResolvedLine {
  account_id: string
  subtype: string | null
  debit_paise: number
  credit_paise: number
  party_type: 'customer' | 'supplier' | null
  party_id: string | null
  store_id: string | null
  memo: string | null
}

function checkAmount(value: number | undefined, path: string): number {
  if (value === undefined) return 0
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalidField(path, 'Amounts must be non-negative integers (paise)')
  }
  return value
}

function cleanText(value: string | null | undefined, max: number): string | null {
  const t = value?.trim()
  return t ? t.slice(0, max) : null
}

async function loadAccounts(tx: Tx, ctx: Ctx, ids: string[]): Promise<Map<string, AccountInfo>> {
  if (ids.length === 0) return new Map()
  const rows = await tx
    .selectFrom('accounts')
    .select(['id', 'subtype', 'is_active'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', 'in', ids)
    .execute()
  return new Map(rows.map((r) => [r.id, r]))
}

/** Validates, resolves accounts, drops zero lines and merges per (account, party, store, side). */
async function resolveLines(
  tx: Tx,
  ctx: Ctx,
  lines: readonly JournalLineInput[],
  entryStoreId: string | null,
): Promise<ResolvedLine[]> {
  const explicitIds = new Set<string>()
  lines.forEach((l, i) => {
    if ('id' in l.account) {
      if (!isUuid(l.account.id)) throw invalidField(`lines.${i}.account.id`, 'Expected a UUID')
      explicitIds.add(l.account.id.toLowerCase())
    }
  })
  const accounts = await loadAccounts(tx, ctx, [...explicitIds])
  const subtypeIds = new Map<string, string>()

  const merged = new Map<string, ResolvedLine>()
  for (const [i, l] of lines.entries()) {
    const debit = checkAmount(l.debit_paise, `lines.${i}.debit_paise`)
    const credit = checkAmount(l.credit_paise, `lines.${i}.credit_paise`)
    if (debit === 0 && credit === 0) continue

    let accountId: string
    let subtype: string | null
    if ('id' in l.account) {
      accountId = l.account.id.toLowerCase()
      const info = accounts.get(accountId)
      // Unknown here also covers another tenant's account id (RLS + explicit tenant filter).
      if (!info) throw unprocessable('Account not found', { account_id: l.account.id, line: i })
      if (!info.is_active) throw unprocessable('Account is inactive', { account_id: accountId, line: i })
      subtype = info.subtype
    } else {
      subtype = l.account.subtype
      accountId = subtypeIds.get(subtype) ?? (await systemAccountId(tx, ctx, l.account.subtype))
      subtypeIds.set(subtype, accountId)
    }

    const party = l.party ?? null
    if (party) {
      if (party.type !== 'customer' && party.type !== 'supplier') {
        throw invalidField(`lines.${i}.party.type`, 'Party type must be customer or supplier')
      }
      if (!isUuid(party.id)) throw invalidField(`lines.${i}.party.id`, 'Expected a UUID')
      if (
        (subtype === 'receivable' && party.type === 'supplier') ||
        (subtype === 'payable' && party.type === 'customer')
      ) {
        throw unprocessable(`A ${party.type} cannot be posted to the ${subtype} account`, {
          line: i,
          party_type: party.type,
          subtype,
        })
      }
    }
    const storeId = l.store_id === undefined ? entryStoreId : l.store_id
    const memo = cleanText(l.memo, 500)
    const base = {
      account_id: accountId,
      subtype,
      party_type: party?.type ?? null,
      party_id: party ? party.id.toLowerCase() : null,
      store_id: storeId ? storeId.toLowerCase() : null,
    }
    // A line carrying both sides contributes to both (never netted: Dr and Cr of the same
    // account are both kept, e.g. a sale and its tender on the receivable).
    for (const [side, amount] of [
      ['d', debit],
      ['c', credit],
    ] as const) {
      if (amount === 0) continue
      const key = `${base.account_id}|${base.party_type ?? ''}|${base.party_id ?? ''}|${base.store_id ?? ''}|${side}`
      const existing = merged.get(key)
      if (existing) {
        if (side === 'd') existing.debit_paise += amount
        else existing.credit_paise += amount
        if (!Number.isSafeInteger(existing.debit_paise + existing.credit_paise)) {
          throw new RangeError('journal amount overflow')
        }
        if (memo && existing.memo !== memo) {
          existing.memo = existing.memo ? `${existing.memo}; ${memo}`.slice(0, 500) : memo
        }
      } else {
        merged.set(key, {
          ...base,
          debit_paise: side === 'd' ? amount : 0,
          credit_paise: side === 'c' ? amount : 0,
          memo,
        })
      }
    }
  }
  return [...merged.values()]
}

function assertBalanced(lines: readonly ResolvedLine[]): void {
  let debit = 0
  let credit = 0
  for (const l of lines) {
    debit += l.debit_paise
    credit += l.credit_paise
  }
  if (!Number.isSafeInteger(debit) || !Number.isSafeInteger(credit)) {
    throw new RangeError('journal total overflow')
  }
  if (debit !== credit) {
    throw unprocessable(
      `Journal entry is not balanced (debit ${debit} paise, credit ${credit} paise)`,
      { debit_paise: debit, credit_paise: credit, difference_paise: debit - credit },
    )
  }
}

/** Applies party balance deltas (receivable/customer, payable/supplier) in id order. */
async function applyPartyBalances(tx: Tx, ctx: Ctx, lines: readonly ResolvedLine[]): Promise<void> {
  const customers = new Map<string, number>()
  const suppliers = new Map<string, number>()
  const annotated = { customer: new Set<string>(), supplier: new Set<string>() }
  for (const l of lines) {
    if (!l.party_type || !l.party_id) continue
    if (l.subtype === 'receivable' && l.party_type === 'customer') {
      customers.set(l.party_id, (customers.get(l.party_id) ?? 0) + l.debit_paise - l.credit_paise)
    } else if (l.subtype === 'payable' && l.party_type === 'supplier') {
      suppliers.set(l.party_id, (suppliers.get(l.party_id) ?? 0) + l.credit_paise - l.debit_paise)
    } else {
      annotated[l.party_type].add(l.party_id)
    }
  }
  for (const [table, deltas] of [
    ['customers', customers],
    ['suppliers', suppliers],
  ] as const) {
    for (const id of [...deltas.keys()].sort()) {
      const delta = deltas.get(id)!
      const res =
        delta === 0
          ? await tx
              .selectFrom(table)
              .select('id')
              .where('tenant_id', '=', ctx.tenantId)
              .where('id', '=', id)
              .executeTakeFirst()
          : await tx
              .updateTable(table)
              .set((eb) => ({ balance_paise: eb('balance_paise', '+', delta) }))
              .where('tenant_id', '=', ctx.tenantId)
              .where('id', '=', id)
              .returning('id')
              .executeTakeFirst()
      if (!res) throw notFound(table === 'customers' ? 'customer' : 'supplier', id)
    }
  }
  // Annotation-only parties must still exist in this tenant.
  for (const [type, ids] of Object.entries(annotated) as Array<['customer' | 'supplier', Set<string>]>) {
    const pending = [...ids].filter((id) => !(type === 'customer' ? customers : suppliers).has(id))
    if (pending.length === 0) continue
    const table = type === 'customer' ? 'customers' : 'suppliers'
    const found = await tx
      .selectFrom(table)
      .select('id')
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', 'in', pending)
      .execute()
    const have = new Set(found.map((r) => r.id))
    const missing = pending.find((id) => !have.has(id))
    if (missing) throw notFound(type, missing)
  }
}

interface EntryHeader {
  entry_date: string
  store_id: string | null
  source_type: JournalSourceType
  source_id: string | null
  narration: string | null
  number: string | null
  reverses_entry_id: string | null
}

async function insertEntry(
  tx: Tx,
  ctx: Ctx,
  header: EntryHeader,
  lines: readonly ResolvedLine[],
): Promise<string> {
  const entryId = newId()
  await tx
    .insertInto('journal_entries')
    .values({
      id: entryId,
      tenant_id: ctx.tenantId,
      store_id: header.store_id,
      entry_date: header.entry_date,
      number: header.number,
      source_type: header.source_type,
      source_id: header.source_id,
      narration: header.narration,
      reverses_entry_id: header.reverses_entry_id,
      created_by: ctx.userId,
    })
    .execute()
  await tx
    .insertInto('journal_lines')
    .values(
      lines.map((l) => ({
        id: newId(),
        tenant_id: ctx.tenantId,
        entry_id: entryId,
        account_id: l.account_id,
        debit_paise: l.debit_paise,
        credit_paise: l.credit_paise,
        party_type: l.party_type,
        party_id: l.party_id,
        store_id: l.store_id,
        memo: l.memo,
        entry_date: header.entry_date,
      })),
    )
    .execute()
  await applyPartyBalances(tx, ctx, lines)
  return entryId
}

function checkHeader(input: {
  entry_date: string
  source_type: string
  source_id?: string | null
  store_id?: string | null
}): void {
  if (!isDateStr(input.entry_date)) throw invalidField('entry_date', 'Expected a date (YYYY-MM-DD)')
  if (!JournalSourceTypeSchema.safeParse(input.source_type).success) {
    throw invalidField('source_type', `Unknown source type "${input.source_type}"`)
  }
  if (input.source_id != null && !isUuid(input.source_id)) {
    throw invalidField('source_id', 'Expected a UUID')
  }
  if (input.store_id != null && !isUuid(input.store_id)) {
    throw invalidField('store_id', 'Expected a UUID')
  }
}

/** Posts one balanced journal entry in the caller's transaction. */
export async function postJournal(
  tx: Tx,
  ctx: Ctx,
  input: JournalEntryInput,
): Promise<PostedJournal> {
  checkHeader(input)
  const storeId = input.store_id ? input.store_id.toLowerCase() : null
  const lines = await resolveLines(tx, ctx, input.lines, storeId)
  if (lines.length === 0) return { entry_id: null }
  assertBalanced(lines)
  const entryId = await insertEntry(
    tx,
    ctx,
    {
      entry_date: input.entry_date,
      store_id: storeId,
      source_type: input.source_type,
      source_id: input.source_id ?? null,
      narration: cleanText(input.narration, 500),
      number: cleanText(input.number, 40),
      reverses_entry_id: null,
    },
    lines,
  )
  return { entry_id: entryId }
}

export interface ReverseJournalInput {
  source_type: JournalSourceType
  source_id: string
  /** Date of the reversal (usually the cancellation date). */
  entry_date: string
  narration?: string | null
}

export interface ReversedJournal {
  /** Reversal entry (the last one when several entries were reversed); null if nothing was posted. */
  entry_id: string | null
  entry_ids: string[]
}

/**
 * Reverses every not-yet-reversed entry of a source with a mirror entry. A source that never
 * posted anything (e.g. a zero-value document) returns { entry_id: null }; a source whose
 * entries are all reversed already is a CONFLICT.
 */
export async function reverseJournal(
  tx: Tx,
  ctx: Ctx,
  input: ReverseJournalInput,
): Promise<ReversedJournal> {
  checkHeader(input)
  const entries = await tx
    .selectFrom('journal_entries as e')
    .select(['e.id', 'e.store_id', 'e.narration', 'e.number'])
    .where('e.tenant_id', '=', ctx.tenantId)
    .where('e.source_type', '=', input.source_type)
    .where('e.source_id', '=', input.source_id)
    .where('e.reverses_entry_id', 'is', null)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('journal_entries as r')
            .select('r.id')
            .whereRef('r.tenant_id', '=', 'e.tenant_id')
            .whereRef('r.reverses_entry_id', '=', 'e.id'),
        ),
      ),
    )
    .orderBy('e.created_at')
    .orderBy('e.id')
    .execute()
  if (entries.length === 0) {
    const any = await tx
      .selectFrom('journal_entries')
      .select('id')
      .where('tenant_id', '=', ctx.tenantId)
      .where('source_type', '=', input.source_type)
      .where('source_id', '=', input.source_id)
      .limit(1)
      .executeTakeFirst()
    if (any) {
      throw conflict('The journal of this document was already reversed', {
        source_type: input.source_type,
        source_id: input.source_id,
      })
    }
    return { entry_id: null, entry_ids: [] }
  }

  const original = await tx
    .selectFrom('journal_lines as l')
    .leftJoin('accounts as a', (j) =>
      j.onRef('a.tenant_id', '=', 'l.tenant_id').onRef('a.id', '=', 'l.account_id'),
    )
    .select([
      'l.entry_id',
      'l.account_id',
      'a.subtype',
      'l.debit_paise',
      'l.credit_paise',
      'l.party_type',
      'l.party_id',
      'l.store_id',
      'l.memo',
    ])
    .where('l.tenant_id', '=', ctx.tenantId)
    .where(
      'l.entry_id',
      'in',
      entries.map((e) => e.id),
    )
    .orderBy('l.id')
    .execute()

  const ids: string[] = []
  for (const e of entries) {
    const mirror: ResolvedLine[] = original
      .filter((l) => l.entry_id === e.id)
      .map((l) => ({
        account_id: l.account_id,
        subtype: l.subtype,
        debit_paise: l.credit_paise,
        credit_paise: l.debit_paise,
        party_type: (l.party_type as ResolvedLine['party_type']) ?? null,
        party_id: l.party_id,
        store_id: l.store_id,
        memo: l.memo,
      }))
    if (mirror.length === 0) continue
    assertBalanced(mirror)
    ids.push(
      await insertEntry(
        tx,
        ctx,
        {
          entry_date: input.entry_date,
          store_id: e.store_id,
          source_type: input.source_type,
          source_id: input.source_id,
          narration:
            cleanText(input.narration, 500) ??
            `Reversal${e.number ? ` of ${e.number}` : ''}${e.narration ? `: ${e.narration}` : ''}`.slice(0, 500),
          number: null,
          reverses_entry_id: e.id,
        },
        mirror,
      ),
    )
  }
  return { entry_id: ids.at(-1) ?? null, entry_ids: ids }
}
