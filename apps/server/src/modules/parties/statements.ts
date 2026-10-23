/**
 * Party statements (khata / supplier ledger): journal_lines of the party on its control account
 * (customers: subtype 'receivable', suppliers: 'payable') — exactly the lines core/ledger applies
 * to balance_paise, so the closing balance of an open-ended statement equals the stored balance.
 *
 * * opening_balance_paise = effect of every line dated before `from` (0 without `from`).
 * * rows = lines dated from..to in posting order (entry date, entry creation, entry id, line id)
 *   with the source document number resolved from the document tables; at most LEDGER_MAX_ROWS
 *   rows (`truncated`), while totals and the closing balance always cover the whole window.
 * * CSV: the same statement with an opening and a closing row, labels in the request locale.
 */
import { formatDateDisplay, type JournalSourceType, paiseToRupeesString } from '@kadai/shared'
import { toCsv, type CsvValue } from '@kadai/shared/api/identity'
import {
  LEDGER_MAX_ROWS,
  LEDGER_SOURCE_LABELS,
  type PartyLedger,
  buildLedgerStatement,
  partyBalanceEffect,
} from '@kadai/shared/api/parties'
import { sql } from 'kysely'
import type { Tx } from '../../db/tenant'
import type { RequestContext } from '../../core/context'
import { type PartyKind, tenantToday } from './common'

export interface StatementParty {
  type: PartyKind
  id: string
  name: string
  name_ta: string | null
  phone: string | null
}

export interface StatementWindow {
  from?: string | undefined
  to?: string | undefined
}

function partyLines(tx: Tx, ctx: Pick<RequestContext, 'tenantId'>, party: StatementParty) {
  return tx
    .selectFrom('journal_lines as l')
    .innerJoin('accounts as a', (j) =>
      j.onRef('a.tenant_id', '=', 'l.tenant_id').onRef('a.id', '=', 'l.account_id'),
    )
    .where('l.tenant_id', '=', ctx.tenantId)
    .where('l.party_type', '=', party.type)
    .where('l.party_id', '=', party.id)
    .where('a.subtype', '=', party.type === 'customer' ? 'receivable' : 'payable')
}

type LineQuery = ReturnType<typeof partyLines>

async function sums(q: LineQuery): Promise<{ debit: number; credit: number }> {
  const row = await q
    .select([
      sql<number>`coalesce(sum(l.debit_paise), 0)::bigint`.as('debit'),
      sql<number>`coalesce(sum(l.credit_paise), 0)::bigint`.as('credit'),
    ])
    .executeTakeFirst()
  return { debit: Number(row?.debit ?? 0), credit: Number(row?.credit ?? 0) }
}

function describe(
  narration: string | null,
  memo: string | null,
  documentNumber: string | null,
): string | null {
  const parts: string[] = []
  if (narration) parts.push(narration)
  if (memo && memo !== narration && memo !== documentNumber && !narration?.includes(memo))
    parts.push(memo)
  return parts.length ? parts.join(' · ') : null
}

/** The statement of a party for a window (see the module comment). */
export async function partyStatement(
  tx: Tx,
  ctx: Pick<RequestContext, 'tenantId'>,
  party: StatementParty,
  window: StatementWindow,
): Promise<PartyLedger> {
  const today = await tenantToday(tx, ctx)
  const from = window.from ?? null
  const to = window.to ?? (from && from > today ? from : today)

  let openingEffect = 0
  if (from) {
    const s = await sums(partyLines(tx, ctx, party).where('l.entry_date', '<', from))
    openingEffect = partyBalanceEffect(party.type, s.debit, s.credit)
  }
  let inWindow = partyLines(tx, ctx, party).where('l.entry_date', '<=', to)
  if (from) inWindow = inWindow.where('l.entry_date', '>=', from)
  const totals = await sums(inWindow)

  const rows = await inWindow
    .innerJoin('journal_entries as e', (j) =>
      j.onRef('e.tenant_id', '=', 'l.tenant_id').onRef('e.id', '=', 'l.entry_id'),
    )
    .leftJoin('sales_invoices as si', (j) =>
      j
        .onRef('si.tenant_id', '=', 'e.tenant_id')
        .onRef('si.id', '=', 'e.source_id')
        .on('e.source_type', '=', 'sales_invoice'),
    )
    .leftJoin('credit_notes as cn', (j) =>
      j
        .onRef('cn.tenant_id', '=', 'e.tenant_id')
        .onRef('cn.id', '=', 'e.source_id')
        .on('e.source_type', '=', 'credit_note'),
    )
    .leftJoin('payments as p', (j) =>
      j
        .onRef('p.tenant_id', '=', 'e.tenant_id')
        .onRef('p.id', '=', 'e.source_id')
        .on('e.source_type', '=', 'payment'),
    )
    .leftJoin('purchase_bills as pb', (j) =>
      j
        .onRef('pb.tenant_id', '=', 'e.tenant_id')
        .onRef('pb.id', '=', 'e.source_id')
        .on('e.source_type', '=', 'purchase_bill'),
    )
    .leftJoin('debit_notes as dn', (j) =>
      j
        .onRef('dn.tenant_id', '=', 'e.tenant_id')
        .onRef('dn.id', '=', 'e.source_id')
        .on('e.source_type', '=', 'debit_note'),
    )
    .leftJoin('expenses as ex', (j) =>
      j
        .onRef('ex.tenant_id', '=', 'e.tenant_id')
        .onRef('ex.id', '=', 'e.source_id')
        .on('e.source_type', '=', 'expense'),
    )
    .select([
      'l.id as line_id',
      'l.entry_id',
      'l.entry_date',
      'l.debit_paise',
      'l.credit_paise',
      'l.memo',
      'e.source_type',
      'e.source_id',
      'e.narration',
      sql<string | null>`case e.source_type
          when 'sales_invoice' then si.number
          when 'credit_note' then cn.number
          when 'payment' then coalesce(p.number, p.reference)
          when 'purchase_bill' then coalesce(pb.supplier_invoice_no, pb.number)
          when 'debit_note' then dn.number
          when 'expense' then ex.number
          else e.number
        end`.as('document_number'),
    ])
    .orderBy('l.entry_date')
    .orderBy('e.created_at')
    .orderBy('e.id')
    .orderBy('l.id')
    .limit(LEDGER_MAX_ROWS + 1)
    .execute()

  const truncated = rows.length > LEDGER_MAX_ROWS
  const entries = rows.slice(0, LEDGER_MAX_ROWS).map((r) => ({
    entry_id: r.entry_id,
    date: r.entry_date,
    source_type: r.source_type as JournalSourceType,
    source_id: r.source_id,
    document_number: r.document_number,
    description: describe(r.narration, r.memo, r.document_number),
    debit_paise: Number(r.debit_paise),
    credit_paise: Number(r.credit_paise),
  }))
  const built = buildLedgerStatement(party.type, openingEffect, entries)
  return {
    party: {
      type: party.type,
      id: party.id,
      name: party.name,
      name_ta: party.name_ta,
      phone: party.phone,
    },
    from,
    to,
    opening_balance_paise: openingEffect,
    total_debit_paise: totals.debit,
    total_credit_paise: totals.credit,
    closing_balance_paise:
      openingEffect + partyBalanceEffect(party.type, totals.debit, totals.credit),
    rows: built.rows,
    truncated,
  }
}

const CSV_LABELS = {
  en: {
    date: 'Date',
    type: 'Type',
    document: 'Document no.',
    description: 'Description',
    debit: 'Debit (₹)',
    credit: 'Credit (₹)',
    balance: 'Balance (₹)',
    opening: 'Opening balance',
    closing: 'Closing balance',
    truncated: 'Statement truncated: narrow the date range',
  },
  ta: {
    date: 'தேதி',
    type: 'வகை',
    document: 'ஆவண எண்',
    description: 'விவரம்',
    debit: 'பற்று (₹)',
    credit: 'வரவு (₹)',
    balance: 'நிலுவை (₹)',
    opening: 'தொடக்க நிலுவை',
    closing: 'இறுதி நிலுவை',
    truncated: 'அறிக்கை முழுமையாக இல்லை: தேதி வரம்பைக் குறைக்கவும்',
  },
} as const

/** CSV of a statement (UTF-8 BOM, CRLF; amounts in rupees; labels in `locale`). */
export function statementCsv(statement: PartyLedger, locale: 'ta' | 'en'): string {
  const L = CSV_LABELS[locale]
  const money = (paise: number) => paiseToRupeesString(paise)
  const lines: CsvValue[][] = [
    [L.date, L.type, L.document, L.description, L.debit, L.credit, L.balance],
    [
      statement.from ? formatDateDisplay(statement.from) : '',
      L.opening,
      '',
      statement.party.name,
      '',
      '',
      money(statement.opening_balance_paise),
    ],
  ]
  for (const r of statement.rows) {
    lines.push([
      formatDateDisplay(r.date),
      LEDGER_SOURCE_LABELS[r.source_type][locale],
      r.document_number,
      r.description,
      r.debit_paise ? money(r.debit_paise) : '',
      r.credit_paise ? money(r.credit_paise) : '',
      money(r.balance_paise),
    ])
  }
  if (statement.truncated) lines.push(['', L.truncated, '', '', '', '', ''])
  lines.push([
    formatDateDisplay(statement.to),
    L.closing,
    '',
    '',
    money(statement.total_debit_paise),
    money(statement.total_credit_paise),
    money(statement.closing_balance_paise),
  ])
  return toCsv(lines)
}
