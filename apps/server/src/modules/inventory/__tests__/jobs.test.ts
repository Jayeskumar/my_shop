/**
 * inventory.alerts job: cron fan-out over active tenants, the per-tenant low-stock / expiry
 * digests queued for owners through core notify, de-duplication on retries, and the setting /
 * plan gates.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addDays, newId, todayIn } from '@kadai/shared'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant } from '../../../test/tenants'
import {
  DIGEST_TEXT_MAX,
  INVENTORY_ALERTS_JOB,
  expiryItemsText,
  fanOutInventoryAlerts,
  jobs,
  lowStockItemsText,
  runInventoryAlerts,
} from '../jobs'
import { makeProduct, openStock } from './fixtures'

async function digests(t: TestApp, tenantId: string) {
  const rows = await t.deps.db.systemDb
    .selectFrom('notifications')
    .select([
      'template_code',
      'channel',
      'recipient',
      'locale',
      'params',
      'ref_type',
      'ref_id',
      'status',
    ])
    .where('tenant_id', '=', tenantId)
    .orderBy('template_code')
    .execute()
  return rows.map((r) => ({ ...r, params: r.params as Record<string, unknown> }))
}

describe('inventory.alerts job', () => {
  let t: TestApp
  let shop: TestShop
  const today = todayIn('Asia/Kolkata')

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t, { name: 'Lakshmi Stores' })
    const rice = await makeProduct(t, shop.tenant.id, {
      name: 'Ponni Rice',
      name_ta: 'பொன்னி அரிசி',
      unit: 'KG',
      reorder_level_milli: 10_000,
    })
    // Never stocked but with a reorder level: out of stock.
    await makeProduct(t, shop.tenant.id, { name: 'Gingelly Oil', reorder_level_milli: 2_000 })
    const tabs = await makeProduct(t, shop.tenant.id, {
      name: 'Dolo 650',
      unit: 'TAB',
      pack_size: 15,
      track_batches: true,
    })
    await openStock(shop, shop.store.id, [
      { product_id: rice.id, qty_milli: 4_500, unit_cost_paise: 6_000 },
      {
        product_id: tabs.id,
        qty_milli: 30_000,
        unit_cost_paise: 3_000,
        batch: { batch_no: 'D1', expiry_date: addDays(today, 10) },
      },
      {
        product_id: tabs.id,
        qty_milli: 15_000,
        unit_cost_paise: 3_000,
        batch: { batch_no: 'D0', expiry_date: addDays(today, -1) },
      },
    ])
  })
  afterAll(() => t.close())

  it('is registered as a daily 08:00 IST cron job', () => {
    const job = jobs.find((j) => j.name === INVENTORY_ALERTS_JOB)
    expect(job).toMatchObject({ cron: '0 8 * * *', tz: 'Asia/Kolkata' })
  })

  it('queues the low-stock and expiry digests for the owner, once per day', async () => {
    const res = await runInventoryAlerts(t.deps, shop.tenant.id, today)
    expect(res).toMatchObject({ skipped: null, stores: 1, queued: 2, duplicates: 0 })
    const rows = await digests(t, shop.tenant.id)
    expect(
      rows.map((r) => [r.template_code, r.channel, r.recipient, r.ref_type, r.ref_id]),
    ).toEqual([
      ['expiry_digest', 'whatsapp', shop.owner.user.phone, 'store', shop.store.id],
      ['low_stock_digest', 'whatsapp', shop.owner.user.phone, 'store', shop.store.id],
    ])
    const expiry = rows[0]!.params
    expect(expiry).toMatchObject({
      store_name: expect.any(String),
      expiring_count: 1,
      expired_count: 1,
      // 30 + 15 tablets at ₹30 per strip of 15.
      value_text: '₹90.00',
    })
    expect(String(expiry.items_text).split('\n')).toHaveLength(2)
    // Links open the pages with their own URL state (store + expired tab / low-stock chip).
    expect(String(expiry.link)).toMatch(
      new RegExp(`/inventory/batches\\?store=${shop.store.id}&tab=expired$`),
    )
    const low = rows[1]!.params
    expect(low).toMatchObject({ low_stock_count: 1, out_of_stock_count: 1 })
    expect(String(low.link)).toMatch(
      new RegExp(`/inventory/stock\\?store=${shop.store.id}&filter=low$`),
    )
    // Owner locale is Tamil: the Tamil product name is used.
    expect(String(low.items_text)).toContain('பொன்னி அரிசி')
    expect(String(low.items_text)).toContain('Gingelly Oil')
    expect(String(low.date)).toMatch(/^\d{2}-\d{2}-\d{4}$/)

    const again = await runInventoryAlerts(t.deps, shop.tenant.id, today)
    expect(again).toMatchObject({ queued: 0, duplicates: 2 })
    expect(await digests(t, shop.tenant.id)).toHaveLength(2)
  })

  it('runs through the job handler with a tenant payload', async () => {
    const quiet = await createTestTenant(t)
    const job = jobs.find((j) => j.name === INVENTORY_ALERTS_JOB)!
    await job.handler(
      {
        id: newId(),
        name: INVENTORY_ALERTS_JOB,
        data: { tenant_id: quiet.tenant.id, date: today },
        retryCount: 0,
      },
      t.deps,
    )
    // Nothing low or expiring: nothing queued.
    expect(await digests(t, quiet.tenant.id)).toEqual([])
  })

  it('respects the digest setting and the notifications plan feature', async () => {
    const off = await createTestTenant(t, {
      settings: { notifications: { low_stock_digest: false } },
    })
    const p = await makeProduct(t, off.tenant.id, { reorder_level_milli: 5_000 })
    await openStock(off, off.store.id, [
      { product_id: p.id, qty_milli: 1_000, unit_cost_paise: 10 },
    ])
    expect(await runInventoryAlerts(t.deps, off.tenant.id, today)).toMatchObject({
      skipped: 'disabled',
      queued: 0,
    })

    const free = await createTestTenant(t, { plan_code: 'free' })
    const q = await makeProduct(t, free.tenant.id, { reorder_level_milli: 5_000 })
    await openStock(free, free.store.id, [
      { product_id: q.id, qty_milli: 1_000, unit_cost_paise: 10 },
    ])
    expect(await runInventoryAlerts(t.deps, free.tenant.id, today)).toMatchObject({
      skipped: 'feature',
    })
    expect(await digests(t, free.tenant.id)).toEqual([])
  })

  it('fans out one singleton run per active tenant', async () => {
    const suspended = await createTestTenant(t)
    await t.deps.db.systemDb
      .updateTable('tenants')
      .set({ status: 'suspended' })
      .where('id', '=', suspended.tenant.id)
      .execute()
    const sent: Array<{
      name: string
      data: { tenant_id: string; date: string }
      key: string | undefined
    }> = []
    const count = await fanOutInventoryAlerts(t.deps, today, async (name, data, options) => {
      sent.push({
        name,
        data: data as { tenant_id: string; date: string },
        key: options.singletonKey,
      })
      return null
    })
    expect(count).toBe(sent.length)
    const mine = sent.find((s) => s.data.tenant_id === shop.tenant.id)
    expect(mine).toEqual({
      name: INVENTORY_ALERTS_JOB,
      data: { tenant_id: shop.tenant.id, date: today },
      key: `${INVENTORY_ALERTS_JOB}:${shop.tenant.id}:${today}`,
    })
    expect(sent.some((s) => s.data.tenant_id === suspended.tenant.id)).toBe(false)
  })

  it('formats digest lines in the recipient’s language', () => {
    const item = {
      store_id: null,
      product_id: newId(),
      sku: null,
      name: 'Ponni Rice',
      name_ta: 'பொன்னி அரிசி',
      unit: 'KG',
      pack_size: 1,
      qty_milli: 2_500,
      reorder_level_milli: 10_000,
      reorder_qty_milli: null,
    }
    expect(lowStockItemsText([item], 'en')).toBe('Ponni Rice — 2.5 kg')
    expect(lowStockItemsText([item], 'ta')).toMatch(/^பொன்னி அரிசி — 2\.5 /)
    // Long names never push the text past the template parameter limit; whole lines only.
    const long = Array.from({ length: 10 }, (_, i) => ({
      ...item,
      name: `${String(i)} ${'x'.repeat(190)}`,
    }))
    const text = lowStockItemsText(long, 'en')
    expect(text.length).toBeLessThanOrEqual(DIGEST_TEXT_MAX)
    expect(text.split('\n').every((l) => l.endsWith('— 2.5 kg'))).toBe(true)
    expect(lowStockItemsText([{ ...item, name: 'y'.repeat(2_000) }], 'en')).toHaveLength(
      DIGEST_TEXT_MAX,
    )
    expect(
      expiryItemsText(
        [
          {
            store_id: null,
            batch_id: newId(),
            batch_no: 'B1',
            product_id: newId(),
            name: 'Dolo 650',
            name_ta: null,
            unit: 'TAB',
            pack_size: 15,
            expiry_date: '2026-11-20',
            days_to_expiry: 30,
            qty_milli: 30_000,
            value_cost_paise: 6_000,
          },
        ],
        'en',
      ),
    ).toMatch(/^Dolo 650 \(B1\) — 20-11-2026 — 30 /)
  })
})
