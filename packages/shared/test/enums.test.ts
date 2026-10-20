import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import * as E from '../src/enums'
import { PromotionKindSchema } from '../src/promotions'
import { sqlEnumChecks } from './helpers/sql'

const MAPPING: Record<string, z.ZodEnum> = {
  'tenants.business_type': E.BusinessTypeSchema,
  'tenants.gst_scheme': E.GstSchemeSchema,
  'tenants.default_locale': E.LocaleSchema,
  'tenants.status': E.TenantStatusSchema,
  'users.preferred_locale': E.LocaleSchema,
  'users.status': E.UserStatusSchema,
  'auth_sessions.auth_method': E.AuthMethodSchema,
  'otp_codes.purpose': E.OtpPurposeSchema,
  'backups.kind': E.BackupKindSchema,
  'backups.status': E.BackupStatusSchema,
  'memberships.status': E.MembershipStatusSchema,
  'number_series.doc_type': E.NumberSeriesDocTypeSchema,
  'idempotency_keys.status': E.IdempotencyStatusSchema,
  'files.purpose': E.FilePurposeSchema,
  'files.storage': E.FileStorageSchema,
  'imports.kind': E.ImportKindSchema,
  'imports.status': E.ImportStatusSchema,
  'subscriptions.status': E.SubscriptionStatusSchema,
  'subscriptions.billing_cycle': E.BillingCycleSchema,
  'subscriptions.provider': E.SubscriptionProviderSchema,
  'platform_invoices.status': E.PlatformInvoiceStatusSchema,
  'products.kind': E.ProductKindSchema,
  'promotions.kind': PromotionKindSchema,
  'customers.customer_type': E.CustomerTypeSchema,
  'customers.price_tier': E.PriceTierSchema,
  'loyalty_ledger.kind': E.LoyaltyKindSchema,
  'stock_movements.movement_type': E.StockMovementTypeSchema,
  'stock_adjustments.kind': E.AdjustmentKindSchema,
  'stock_adjustments.status': E.AdjustmentStatusSchema,
  'stock_transfers.status': E.TransferStatusSchema,
  'accounts.type': E.AccountTypeSchema,
  'journal_lines.party_type': E.PartyTypeSchema,
  'expenses.payment_method': E.ExpensePaymentMethodSchema,
  'expenses.status': E.ExpenseStatusSchema,
  'register_shifts.status': E.ShiftStatusSchema,
  'shift_cash_entries.kind': E.ShiftCashEntryKindSchema,
  'sales_invoices.doc_type': E.SalesDocTypeSchema,
  'sales_invoices.status': E.SalesInvoiceStatusSchema,
  'sales_invoices.channel': E.SalesChannelSchema,
  'sales_invoices.payment_status': E.SalesPaymentStatusSchema,
  'credit_notes.reason': E.CreditNoteReasonSchema,
  'credit_notes.status': E.CreditNoteStatusSchema,
  'credit_notes.settlement': E.CreditNoteSettlementSchema,
  'payment_provider_accounts.provider': E.PaymentProviderCodeSchema,
  'payment_provider_accounts.mode': E.ProviderModeSchema,
  'payment_intents.kind': E.PaymentIntentKindSchema,
  'payment_intents.purpose': E.PaymentIntentPurposeSchema,
  'payment_intents.status': E.PaymentIntentStatusSchema,
  'payment_intents.confirmation': E.PaymentConfirmationSchema,
  'payments.direction': E.PaymentDirectionSchema,
  'payments.party_type': E.PartyTypeSchema,
  'payments.method': E.PaymentMethodSchema,
  'payments.status': E.PaymentStatusSchema,
  'payment_allocations.target_type': E.AllocationTargetTypeSchema,
  'purchase_orders.status': E.PurchaseOrderStatusSchema,
  'purchase_bills.status': E.PurchaseBillStatusSchema,
  'purchase_bills.payment_status': E.PurchasePaymentStatusSchema,
  'debit_notes.reason': E.DebitNoteReasonSchema,
  'debit_notes.status': E.DebitNoteStatusSchema,
  'debit_notes.settlement': E.DebitNoteSettlementSchema,
  'notification_templates.channel': E.NotificationChannelSchema,
  'notification_templates.locale': E.LocaleSchema,
  'notifications.channel': E.NotificationChannelSchema,
  'notifications.status': E.NotificationStatusSchema,
  // vendor control plane (0010)
  'platform_staff.role': E.PlatformStaffRoleSchema,
  'partners.tier': E.PartnerTierSchema,
  'partners.status': E.PartnerStatusSchema,
  'vendor_customers.business_type': E.BusinessTypeSchema,
  'license_products.kind': E.LicenseProductKindSchema,
  'license_products.channel': E.DeploymentChannelSchema,
  'licenses.license_type': E.LicenseTypeSchema,
  'licenses.status': E.VendorLicenseStatusSchema,
  'license_activations.method': E.ActivationMethodSchema,
  'license_activations.status': E.ActivationStatusSchema,
  'license_events.kind': E.LicenseEventKindSchema,
  'releases.channel': E.ReleaseChannelSchema,
  'offers.kind': E.OfferKindSchema,
  'offers.channel': E.DeploymentChannelSchema,
  'vendor_orders.kind': E.VendorOrderKindSchema,
  'vendor_orders.status': E.VendorOrderStatusSchema,
  'vendor_orders.payment_provider': E.VendorPaymentProviderSchema,
  'partner_commissions.status': E.CommissionStatusSchema,
  'announcements.severity': E.AnnouncementSeveritySchema,
  'cloud_backups.status': E.CloudBackupStatusSchema,
}

describe('enums mirror SQL CHECK constraints', () => {
  const checks = sqlEnumChecks()

  it('finds the CHECK constraints in the migrations', () => {
    expect(checks.size).toBeGreaterThanOrEqual(Object.keys(MAPPING).length)
  })

  it.each(Object.entries(MAPPING))('%s', (column, schema) => {
    expect(checks.get(column), `missing CHECK for ${column}`).toBeDefined()
    expect([...schema.options]).toEqual(checks.get(column))
  })

  it('every SQL enum column is mirrored in shared', () => {
    const unmapped = [...checks.keys()].filter((k) => !(k in MAPPING))
    expect(unmapped).toEqual([])
  })
})
