import { describe, expect, it } from 'vitest'
import {
  CompositionSummarySchema,
  CustomerOutstandingResponseSchema,
  DashboardSchema,
  ExpiryResponseSchema,
  Gstr1ReportSchema,
  Gstr3bReportSchema,
  ItemSalesResponseSchema,
  SalesSummaryResponseSchema,
} from '@kadai/shared/api/reports'
import * as F from './fixtures'

describe('reports fixtures follow the contract', () => {
  it.each([
    ['dashboard', DashboardSchema, F.dashboardFixture()],
    ['empty dashboard', DashboardSchema, F.emptyDashboardFixture()],
    ['sales summary', SalesSummaryResponseSchema, F.salesSummaryFixture()],
    ['item sales', ItemSalesResponseSchema, F.itemSalesFixture()],
    ['customer outstanding', CustomerOutstandingResponseSchema, F.customerOutstandingFixture()],
    ['expiry', ExpiryResponseSchema, F.expiryFixture()],
    ['gstr1', Gstr1ReportSchema, F.gstr1Fixture()],
    ['gstr3b', Gstr3bReportSchema, F.gstr3bFixture()],
    ['composition', CompositionSummarySchema, F.compositionFixture()],
  ] as const)('%s', (_name, schema, value) => {
    const result = schema.safeParse(value)
    expect(result.error?.issues ?? []).toEqual([])
  })

  it('the dashboard trend has 30 days ending today, and the payment mix adds up to the sales', () => {
    const d = F.dashboardFixture()
    expect(d.trend).toHaveLength(30)
    expect(d.trend.at(-1)?.date).toBe(F.TODAY)
    expect(d.payment_mix.reduce((s, m) => s + m.amount_paise, 0)).toBe(d.today.sales_paise)
    expect(d.payment_mix.reduce((s, m) => s + m.share_bp, 0)).toBe(10_000)
  })
})
