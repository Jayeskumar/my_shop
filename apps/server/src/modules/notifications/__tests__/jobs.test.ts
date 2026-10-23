/**
 * The daily jobs, called directly with a fixed clock: notifications.due-reminders (10:00 IST)
 * and notifications.daily-summary (21:30 IST). Covers the selection rules (oldest unpaid bill
 * exactly N days old in the shop's timezone, WhatsApp opt-in, the three-day gap, settings, plan,
 * provider availability), the summary figures and de-duplication of re-runs.
 */
import { addDays, newId, todayIn } from '@kadai/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { systemContext } from '../../../core/context'
import { withTenant } from '../../../db/tenant'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant, insertTestProduct } from '../../../test/tenants'
import { dailyFigures, isQuietDay, runDailySummary } from '../daily-summary'
import { jobs } from '../jobs'
import { DUE_REMINDERS_PER_RUN, runDueReminders } from '../reminders'
import { processNotification } from '../send'
import {
  type FakeProvider,
  fakeProvider,
  insertCustomer,
  insertInvoice,
  insertReceipt,
  insertVpaAccount,
  notificationsOf,
  patchSettings,
  useProviders,
} from './fixtures'

let t: TestApp
let wa: FakeProvider
let sms: FakeProvider

beforeAll(async () => {
  t = await buildTestApp()
})
afterAll(() => t.close())
beforeEach(() => {
  wa = fakeProvider('whatsapp_cloud', ['whatsapp'])
  sms = fakeProvider('msg91', ['sms'])
  useProviders([wa, sms])
})

/** A due_reminder outbox row for the customer created `daysAgo` days before `now`. */
async function pastReminder(
  s: TestShop,
  customerId: string,
  now: Date,
  daysAgo: number,
  status = 'sent',
): Promise<void> {
  await t.deps.db.systemDb
    .insertInto('notifications')
    .values({
      id: newId(),
      tenant_id: s.tenant.id,
      channel: 'whatsapp',
      template_code: 'due_reminder',
      recipient: '+919876543210',
      status,
      ref_type: 'customer',
      ref_id: customerId,
      created_at: new Date(now.getTime() - daysAgo * 86_400_000),
    })
    .execute()
}

describe('notifications.due-reminders', () => {
  // 10:00 IST on 21-10-2026 (04:30 UTC).
  const NOW = new Date('2026-10-21T04:30:00Z')
  const TODAY = '2026-10-21'

  async function customerDue(
    s: TestShop,
    daysAgo: number,
    opts: Parameters<typeof insertCustomer>[2] & {
      doc_type?: 'tax_invoice' | 'estimate'
      status?: 'completed' | 'cancelled'
    } = {},
  ) {
    const c = await insertCustomer(t, s, { balance_paise: 120_000, ...opts })
    await insertInvoice(t, s, {
      customer_id: c.id,
      invoice_date: addDays(TODAY, -daysAgo),
      total_paise: 120_000,
      due_paise: 120_000,
      ...(opts.doc_type ? { doc_type: opts.doc_type } : {}),
      ...(opts.status ? { status: opts.status } : {}),
    })
    return c
  }

  it('selects dues whose oldest unpaid bill is exactly N days old, opted in, not reminded lately', async () => {
    const s = await createTestTenant(t)
    await insertVpaAccount(t, s)
    // Default due_reminder_days: [7, 15, 30].
    const at15 = await customerDue(s, 15, { name: 'Fifteen' })
    const at14 = await customerDue(s, 14)
    const at7 = await customerDue(s, 7)
    // A newer bill does not change the age of the oldest one.
    await insertInvoice(t, s, {
      customer_id: at7.id,
      invoice_date: addDays(TODAY, -2),
      total_paise: 10_000,
      due_paise: 10_000,
    })
    const optedOut = await customerDue(s, 30, { whatsapp_opt_in: false })
    const settled = await customerDue(s, 15, { balance_paise: 0 })
    const inactive = await customerDue(s, 15, { is_active: false })
    const noPhone = await customerDue(s, 15, { phone: null })
    const estimate = await customerDue(s, 15, { doc_type: 'estimate' })
    const cancelled = await customerDue(s, 15, { status: 'cancelled' })
    const recent = await customerDue(s, 15)
    await pastReminder(s, recent.id, NOW, 2)
    const gapDone = await customerDue(s, 15)
    await pastReminder(s, gapDone.id, NOW, 3)
    const onlyCancelled = await customerDue(s, 15)
    await pastReminder(s, onlyCancelled.id, NOW, 1, 'cancelled')

    const res = await runDueReminders(t.deps, { now: NOW, tenantIds: [s.tenant.id] })
    expect(res).toEqual({ tenants: 1, queued: 4 })
    const queued = (await notificationsOf(t, s)).filter((n) => n.status === 'queued')
    expect(new Set(queued.map((n) => n.ref_id))).toEqual(
      new Set([at15.id, at7.id, gapDone.id, onlyCancelled.id]),
    )
    for (const skipped of [at14, optedOut, settled, inactive, noPhone, estimate, cancelled, recent])
      expect(queued.some((n) => n.ref_id === skipped.id)).toBe(false)

    const n = queued.find((q) => q.ref_id === at15.id)!
    expect(n).toMatchObject({
      channel: 'whatsapp',
      template_code: 'due_reminder',
      locale: 'ta',
      recipient: at15.phone,
      recipient_name: 'Fifteen',
      ref_type: 'customer',
      created_by: null,
    })
    const params = n.params as Record<string, unknown>
    expect(params).toMatchObject({ customer_name: 'Fifteen', due: '₹1,200.00', days: 15 })
    expect(params.link).toMatch(new RegExp(`^${t.config.publicBaseUrl}/pay/[0-9A-Z]{12}$`))
    const intent = await t.deps.db.systemDb
      .selectFrom('payment_intents')
      .select(['kind', 'purpose', 'amount_paise', 'short_url', 'created_by'])
      .where('tenant_id', '=', s.tenant.id)
      .where('customer_id', '=', at15.id)
      .executeTakeFirstOrThrow()
    expect(intent).toMatchObject({
      kind: 'link',
      purpose: 'customer_due',
      amount_paise: 120_000,
      short_url: params.link,
      created_by: null,
    })

    // The same morning again (a retried job): everybody was just reminded.
    expect(await runDueReminders(t.deps, { now: NOW, tenantIds: [s.tenant.id] })).toEqual({
      tenants: 1,
      queued: 0,
    })
  })

  it('counts days in the shop timezone (IST): 00:30 IST is already the next day', async () => {
    const s = await createTestTenant(t)
    // Oldest bill of 06-10-2026: 14 days old on the 20th, 15 days old on the 21st (IST).
    const c = await customerDue(s, 15)
    const lateEveningIst = new Date('2026-10-20T18:00:00Z') // 23:30 IST on the 20th
    expect(
      await runDueReminders(t.deps, { now: lateEveningIst, tenantIds: [s.tenant.id] }),
    ).toEqual({ tenants: 1, queued: 0 })
    const afterMidnightIst = new Date('2026-10-20T19:00:00Z') // 00:30 IST on the 21st, UTC still 20th
    expect(
      await runDueReminders(t.deps, { now: afterMidnightIst, tenantIds: [s.tenant.id] }),
    ).toEqual({ tenants: 1, queued: 1 })
    const [n] = await notificationsOf(t, s)
    expect(n!.ref_id).toBe(c.id)
    // Without a UPI ID the reminder still goes, with the shop phone instead of a link.
    expect((n!.params as Record<string, unknown>).link).not.toMatch(/\/pay\//)
  })

  it('follows settings.notifications.due_reminder_days, the plan, the tenant status and the providers', async () => {
    const s = await createTestTenant(t)
    await patchSettings(t, s, { notifications: { due_reminder_days: [45] } })
    await customerDue(s, 15)
    const at45 = await customerDue(s, 45)
    expect(await runDueReminders(t.deps, { now: NOW, tenantIds: [s.tenant.id] })).toEqual({
      tenants: 1,
      queued: 1,
    })
    expect((await notificationsOf(t, s))[0]!.ref_id).toBe(at45.id)

    const off = await createTestTenant(t)
    await patchSettings(t, off, { notifications: { due_reminder_days: [] } })
    await customerDue(off, 15)
    const free = await createTestTenant(t, { plan_code: 'free' })
    await customerDue(free, 15)
    const suspended = await createTestTenant(t)
    await customerDue(suspended, 15)
    await t.deps.db.systemDb
      .updateTable('tenants')
      .set({ status: 'suspended' })
      .where('id', '=', suspended.tenant.id)
      .execute()
    expect(
      await runDueReminders(t.deps, {
        now: NOW,
        tenantIds: [off.tenant.id, free.tenant.id, suspended.tenant.id],
      }),
    ).toEqual({ tenants: 2, queued: 0 })

    // WhatsApp not live → SMS; nothing live in production → nothing is queued.
    useProviders([sms])
    const smsShop = await createTestTenant(t)
    await customerDue(smsShop, 7)
    await runDueReminders(t.deps, { now: NOW, tenantIds: [smsShop.tenant.id] })
    expect((await notificationsOf(t, smsShop))[0]!.channel).toBe('sms')
    useProviders([], { withLog: true })
    const prodShop = await createTestTenant(t)
    await customerDue(prodShop, 7)
    const prodDeps = { ...t.deps, config: { ...t.deps.config, isProduction: true } }
    expect(await runDueReminders(prodDeps, { now: NOW, tenantIds: [prodShop.tenant.id] })).toEqual({
      tenants: 1,
      queued: 0,
    })
    expect(DUE_REMINDERS_PER_RUN).toBeGreaterThan(0)
  })

  it('the job handler runs a manual { tenant_id } run with the real clock', async () => {
    const s = await createTestTenant(t)
    const c = await insertCustomer(t, s, { balance_paise: 5_000 })
    await insertInvoice(t, s, {
      customer_id: c.id,
      invoice_date: addDays(todayIn('Asia/Kolkata'), -7),
      total_paise: 5_000,
      due_paise: 5_000,
    })
    const handler = jobs.find((j) => j.name === 'notifications.due-reminders')!.handler
    await handler(
      {
        id: 'j',
        name: 'notifications.due-reminders',
        data: { tenant_id: s.tenant.id },
        retryCount: 0,
      },
      t.deps,
    )
    expect((await notificationsOf(t, s)).map((n) => n.ref_id)).toEqual([c.id])
  })
})

describe('notifications.daily-summary', () => {
  // 21:30 IST on 21-10-2026.
  const NOW = new Date('2026-10-21T16:00:00Z')
  const DAY = '2026-10-21'

  async function busyDay(s: TestShop) {
    const c = await insertCustomer(t, s, { balance_paise: 70_000 })
    const old = await insertInvoice(t, s, {
      customer_id: c.id,
      invoice_date: '2026-10-10',
      total_paise: 80_000,
      due_paise: 50_000,
    })
    const rice = await insertTestProduct(t.deps, s.tenant.id, { name: 'Ponni rice 25 kg' })
    await t.deps.db.systemDb
      .updateTable('products')
      .set({ name_ta: 'பொன்னி அரிசி 25 கிலோ' })
      .where('id', '=', rice.id)
      .execute()
    const inv1 = await insertInvoice(t, s, {
      customer_id: null,
      invoice_date: DAY,
      total_paise: 100_000,
      lines: [
        {
          product_id: rice.id,
          name: 'Ponni rice 25 kg',
          name_ta: 'பொன்னி அரிசி 25 கிலோ',
          total_paise: 60_000,
        },
        { name: 'Toor dal 1 kg', total_paise: 40_000 },
      ],
    })
    const inv2 = await insertInvoice(t, s, {
      customer_id: c.id,
      invoice_date: DAY,
      total_paise: 50_000,
      due_paise: 20_000,
      lines: [
        {
          product_id: rice.id,
          name: 'Ponni rice 25 kg',
          name_ta: 'பொன்னி அரிசி 25 கிலோ',
          total_paise: 50_000,
        },
      ],
    })
    // Not counted: cancelled, estimate, another day.
    await insertInvoice(t, s, {
      customer_id: null,
      invoice_date: DAY,
      total_paise: 99_900,
      status: 'cancelled',
    })
    await insertInvoice(t, s, {
      customer_id: c.id,
      invoice_date: DAY,
      total_paise: 55_500,
      doc_type: 'estimate',
    })
    await insertInvoice(t, s, {
      customer_id: null,
      invoice_date: '2026-10-20',
      total_paise: 70_000,
    })
    await t.deps.db.systemDb
      .insertInto('credit_notes')
      .values({
        id: newId(),
        tenant_id: s.tenant.id,
        store_id: s.store.id,
        number: `CN${newId().slice(-8)}`,
        fy: '2627',
        note_date: DAY,
        invoice_id: inv1.id,
        place_of_supply: '33',
        reason: 'return',
        settlement: 'cash',
        taxable_paise: 10_000,
        total_paise: 10_000,
      })
      .execute()
    await insertReceipt(t, s, {
      method: 'cash',
      amount_paise: 100_000,
      payment_date: DAY,
      allocate_to: { target_type: 'sales_invoice', target_id: inv1.id },
    })
    await insertReceipt(t, s, {
      method: 'upi',
      amount_paise: 30_000,
      payment_date: DAY,
      customer_id: c.id,
      allocate_to: { target_type: 'sales_invoice', target_id: inv2.id },
    })
    // Dues collected: an earlier bill and the opening balance.
    await insertReceipt(t, s, {
      method: 'upi',
      amount_paise: 50_000,
      payment_date: DAY,
      customer_id: c.id,
      allocate_to: { target_type: 'sales_invoice', target_id: old.id },
    })
    await insertReceipt(t, s, {
      method: 'card',
      amount_paise: 5_000,
      payment_date: DAY,
      customer_id: c.id,
      allocate_to: { target_type: 'opening_balance', target_id: null },
    })
    await insertReceipt(t, s, { method: 'cash', amount_paise: 7_000, payment_date: '2026-10-20' })
    // Low stock: at / below the reorder level (no stock rows = 0); others are fine.
    const low = await insertTestProduct(t.deps, s.tenant.id)
    const fine = await insertTestProduct(t.deps, s.tenant.id)
    await insertTestProduct(t.deps, s.tenant.id) // no reorder level
    await t.deps.db.systemDb
      .updateTable('products')
      .set({ reorder_level_milli: 5_000 })
      .where('id', 'in', [low.id, fine.id])
      .execute()
    await t.deps.db.systemDb
      .insertInto('stock_levels')
      .values({
        tenant_id: s.tenant.id,
        store_id: s.store.id,
        product_id: fine.id,
        qty_milli: 9_000,
      })
      .execute()
  }

  it("computes today's figures of the whole business (IST business date)", async () => {
    const s = await createTestTenant(t)
    await busyDay(s)
    const f = await withTenant(t.deps.db.appDb, systemContext(s.tenant.id), (tx) =>
      dailyFigures(tx, systemContext(s.tenant.id), DAY),
    )
    expect(f).toEqual({
      date: DAY,
      bills: 2,
      sales_paise: 150_000,
      returns_paise: 10_000,
      net_sales_paise: 140_000,
      credit_paise: 20_000,
      received: { cash: 100_000, upi: 80_000, card: 5_000, other: 0 },
      dues_collected_paise: 55_000,
      top_item: { name: 'Ponni rice 25 kg', name_ta: 'பொன்னி அரிசி 25 கிலோ', total_paise: 110_000 },
      low_stock_count: 1,
    })
    expect(isQuietDay(f)).toBe(false)
  })

  it('queues one summary per owner phone in their language, once per day', async () => {
    const s = await createTestTenant(t)
    await busyDay(s)
    const second = await s.asRole('owner')
    await t.deps.db.systemDb
      .updateTable('users')
      .set({ preferred_locale: 'en' })
      .where('id', '=', second.user.id)
      .execute()
    await s.asRole('manager') // not an owner: gets nothing
    const res = await runDailySummary(t.deps, { now: NOW, tenantIds: [s.tenant.id] })
    expect(res).toEqual({ tenants: 1, queued: 2 })
    const rows = await notificationsOf(t, s)
    expect(rows).toHaveLength(2)
    const owners = await t.deps.db.systemDb
      .selectFrom('users')
      .select(['id', 'phone'])
      .where('id', 'in', [s.owner.user.id, second.user.id])
      .execute()
    expect(new Set(rows.map((r) => r.recipient))).toEqual(new Set(owners.map((o) => o.phone)))
    const en = rows.find((r) => r.locale === 'en')!
    const ta = rows.find((r) => r.locale === 'ta')!
    expect(en).toMatchObject({
      channel: 'whatsapp',
      template_code: 'daily_summary',
      ref_type: 'tenant',
      ref_id: s.tenant.id,
    })
    expect(en.params).toMatchObject({
      date: '21-10-2026',
      net_sales: '₹1,400.00',
      bills: 2,
      cash: '₹1,000.00',
      upi: '₹800.00',
      card: '₹50.00',
      credit: '₹200.00',
      dues_collected: '₹550.00',
      top_item: 'Ponni rice 25 kg',
      low_stock_count: 1,
    })
    expect((ta.params as Record<string, unknown>).top_item).toBe('பொன்னி அரிசி 25 கிலோ')

    // Delivered as the approved WhatsApp template.
    await processNotification(t.deps, { tenant_id: s.tenant.id, notification_id: ta.id })
    expect(wa.sent[0]!.whatsapp).toMatchObject({
      template_name: 'kadai_daily_summary',
      language: 'ta',
    })
    expect(wa.sent[0]!.whatsapp!.body_params).toContain('₹1,400.00')
    expect(wa.sent[0]!.body).toContain('அன்றைய சுருக்கம்')

    // A re-run the same evening queues nothing new.
    expect(await runDailySummary(t.deps, { now: NOW, tenantIds: [s.tenant.id] })).toEqual({
      tenants: 1,
      queued: 0,
    })
  })

  it('skips quiet days, the switched-off setting and plans without notifications', async () => {
    const quiet = await createTestTenant(t)
    const off = await createTestTenant(t)
    await busyDay(off)
    await patchSettings(t, off, { notifications: { daily_summary_to_owner: false } })
    const free = await createTestTenant(t, { plan_code: 'free' })
    await busyDay(free)
    expect(
      await runDailySummary(t.deps, {
        now: NOW,
        tenantIds: [quiet.tenant.id, off.tenant.id, free.tenant.id],
      }),
    ).toEqual({ tenants: 3, queued: 0 })
  })

  it('summarises the IST day: just after midnight IST the new day has no business yet', async () => {
    const s = await createTestTenant(t)
    await busyDay(s)
    const afterMidnightIst = new Date('2026-10-21T19:00:00Z') // 00:30 IST on the 22nd
    expect(
      await runDailySummary(t.deps, { now: afterMidnightIst, tenantIds: [s.tenant.id] }),
    ).toEqual({ tenants: 1, queued: 0 })
    const beforeMidnightIst = new Date('2026-10-21T18:00:00Z') // 23:30 IST on the 21st
    expect(
      await runDailySummary(t.deps, { now: beforeMidnightIst, tenantIds: [s.tenant.id] }),
    ).toEqual({ tenants: 1, queued: 1 })
  })
})
