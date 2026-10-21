import { describe, expect, it } from 'vitest'
import { SettingsResponseSchema } from '@kadai/shared/api/identity'
import {
  CustomerRemindResultSchema,
  NotificationListResponseSchema,
  NotificationTemplateCatalogSchema,
  NotificationTemplateEntrySchema,
} from '@kadai/shared/api/notifications'
import { CustomerListItemSchema, CustomerSummarySchema } from '@kadai/shared/api/parties'
import { makeMe } from '@/test/fixtures'
import * as F from './fixtures'

describe('notifications fixtures match the contract', () => {
  it('outbox list', () => {
    expect(NotificationListResponseSchema.safeParse(F.outboxList()).success).toBe(true)
  })

  it('template catalogue (every code × channel × language)', () => {
    const c = F.catalog({
      overrides: [
        {
          code: 'due_reminder',
          channel: 'sms',
          locale: 'ta',
          body: '{{shop_name}}: {{customer_name}}, நிலுவை {{due}}. {{link}}',
          provider_template_id: '1107170000000000099',
        },
      ],
    })
    expect(NotificationTemplateCatalogSchema.safeParse(c).success).toBe(true)
    expect(c.templates.length).toBeGreaterThan(40)
    expect(c.templates.filter((e) => e.is_override)).toHaveLength(1)
    for (const e of c.templates)
      expect(NotificationTemplateEntrySchema.safeParse(e).success).toBe(true)
  })

  it('reminder, customer, summary and settings', () => {
    expect(CustomerRemindResultSchema.safeParse(F.remindResult()).success).toBe(true)
    expect(CustomerListItemSchema.safeParse(F.customer()).success).toBe(true)
    expect(CustomerSummarySchema.safeParse(F.customerSummary()).success).toBe(true)
    expect(SettingsResponseSchema.safeParse(F.settingsResponse({}, makeMe().tenant)).success).toBe(
      true,
    )
  })
})
