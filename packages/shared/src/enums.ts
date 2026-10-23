/**
 * String enums mirrored from the SQL CHECK constraints (apps/server/migrations). Values are
 * identical to SQL; `test/enums.test.ts` parses the migrations to detect drift.
 * Each enum exports `XxxSchema` (z.enum) and `type Xxx`; use `XxxSchema.options` for the list.
 */
import { z } from 'zod'

// ---- foundation / organization (0001, 0002) --------------------------------------------------
export const DeploymentModeSchema = z.enum(['cloud', 'onprem'])
export type DeploymentMode = z.infer<typeof DeploymentModeSchema>

export const BusinessTypeSchema = z.enum([
  'general_store',
  'supermarket',
  'apparel',
  'pharmacy',
  'footwear',
  'electronics',
  'hardware',
  'bakery_sweets',
  'stationery',
  'other',
])
export type BusinessType = z.infer<typeof BusinessTypeSchema>

export const GstSchemeSchema = z.enum(['regular', 'composition', 'unregistered'])
export type GstScheme = z.infer<typeof GstSchemeSchema>

export const LocaleSchema = z.enum(['ta', 'en'])
export type Locale = z.infer<typeof LocaleSchema>

export const TenantStatusSchema = z.enum(['active', 'suspended', 'closed'])
export type TenantStatus = z.infer<typeof TenantStatusSchema>

export const UserStatusSchema = z.enum(['active', 'disabled'])
export type UserStatus = z.infer<typeof UserStatusSchema>

export const AuthMethodSchema = z.enum(['password', 'otp', 'pin', 'api'])
export type AuthMethod = z.infer<typeof AuthMethodSchema>

export const OtpPurposeSchema = z.enum(['login', 'signup', 'reset_password', 'verify_phone'])
export type OtpPurpose = z.infer<typeof OtpPurposeSchema>

export const BackupKindSchema = z.enum(['scheduled', 'manual', 'pre_upgrade'])
export type BackupKind = z.infer<typeof BackupKindSchema>

export const BackupStatusSchema = z.enum(['running', 'completed', 'failed'])
export type BackupStatus = z.infer<typeof BackupStatusSchema>

export const MembershipStatusSchema = z.enum(['active', 'invited', 'disabled'])
export type MembershipStatus = z.infer<typeof MembershipStatusSchema>

export const NumberSeriesDocTypeSchema = z.enum([
  'sales_invoice',
  'bill_of_supply',
  'credit_note',
  'estimate',
  'sales_order',
  'receipt',
  'payment_voucher',
  'purchase_order',
  'purchase_bill',
  'debit_note',
  'stock_adjustment',
  'stock_transfer',
  'expense',
  'journal',
])
export type NumberSeriesDocType = z.infer<typeof NumberSeriesDocTypeSchema>

export const IdempotencyStatusSchema = z.enum(['processing', 'completed'])
export type IdempotencyStatus = z.infer<typeof IdempotencyStatusSchema>

export const FilePurposeSchema = z.enum([
  'logo',
  'product_image',
  'prescription',
  'import',
  'export',
  'attachment',
])
export type FilePurpose = z.infer<typeof FilePurposeSchema>

export const FileStorageSchema = z.enum(['local', 's3'])
export type FileStorage = z.infer<typeof FileStorageSchema>

export const ImportKindSchema = z.enum([
  'products',
  'customers',
  'suppliers',
  'opening_stock',
  'opening_balances',
])
export type ImportKind = z.infer<typeof ImportKindSchema>

export const ImportStatusSchema = z.enum([
  'pending',
  'validating',
  'processing',
  'completed',
  'failed',
])
export type ImportStatus = z.infer<typeof ImportStatusSchema>

export const SubscriptionStatusSchema = z.enum([
  'trialing',
  'active',
  'past_due',
  'cancelled',
  'expired',
])
export type SubscriptionStatus = z.infer<typeof SubscriptionStatusSchema>

export const BillingCycleSchema = z.enum(['monthly', 'yearly'])
export type BillingCycle = z.infer<typeof BillingCycleSchema>

export const SubscriptionProviderSchema = z.enum(['razorpay', 'manual'])
export type SubscriptionProvider = z.infer<typeof SubscriptionProviderSchema>

export const PlatformInvoiceStatusSchema = z.enum(['draft', 'issued', 'paid', 'void'])
export type PlatformInvoiceStatus = z.infer<typeof PlatformInvoiceStatusSchema>

// ---- catalog & parties (0003) -----------------------------------------------------------------
export const ProductKindSchema = z.enum(['standard', 'variant_parent', 'variant', 'service'])
export type ProductKind = z.infer<typeof ProductKindSchema>

// PromotionKindSchema lives in promotions.ts (same values as promotions.kind).

export const CustomerTypeSchema = z.enum(['retail', 'wholesale', 'business'])
export type CustomerType = z.infer<typeof CustomerTypeSchema>

export const PriceTierSchema = z.enum(['retail', 'wholesale'])
export type PriceTier = z.infer<typeof PriceTierSchema>

export const LoyaltyKindSchema = z.enum(['earn', 'redeem', 'adjust', 'expire', 'reverse'])
export type LoyaltyKind = z.infer<typeof LoyaltyKindSchema>

export const PartyTypeSchema = z.enum(['customer', 'supplier'])
export type PartyType = z.infer<typeof PartyTypeSchema>

// ---- inventory (0004) -------------------------------------------------------------------------
export const StockMovementTypeSchema = z.enum([
  'opening',
  'purchase',
  'purchase_return',
  'sale',
  'sale_return',
  'adjustment',
  'stock_take',
  'damage',
  'expiry_writeoff',
  'transfer_out',
  'transfer_in',
  'sale_cancel',
  'purchase_cancel',
])
export type StockMovementType = z.infer<typeof StockMovementTypeSchema>

export const AdjustmentKindSchema = z.enum([
  'adjustment',
  'stock_take',
  'damage',
  'expiry_writeoff',
  'opening',
])
export type AdjustmentKind = z.infer<typeof AdjustmentKindSchema>

export const AdjustmentStatusSchema = z.enum(['draft', 'posted', 'cancelled'])
export type AdjustmentStatus = z.infer<typeof AdjustmentStatusSchema>

export const TransferStatusSchema = z.enum(['draft', 'dispatched', 'received', 'cancelled'])
export type TransferStatus = z.infer<typeof TransferStatusSchema>

// ---- accounting (0005) ------------------------------------------------------------------------
export const AccountTypeSchema = z.enum(['asset', 'liability', 'equity', 'income', 'expense'])
export type AccountType = z.infer<typeof AccountTypeSchema>

/** journal_entries.source_type (documented in 0005, not a CHECK). */
export const JournalSourceTypeSchema = z.enum([
  'sales_invoice',
  'credit_note',
  'purchase_bill',
  'debit_note',
  'payment',
  'expense',
  'stock_adjustment',
  'stock_transfer',
  'shift',
  'manual',
  'opening',
])
export type JournalSourceType = z.infer<typeof JournalSourceTypeSchema>

export const ExpensePaymentMethodSchema = z.enum([
  'cash',
  'upi',
  'card',
  'bank_transfer',
  'cheque',
  'credit',
])
export type ExpensePaymentMethod = z.infer<typeof ExpensePaymentMethodSchema>

export const ExpenseStatusSchema = z.enum(['posted', 'cancelled'])
export type ExpenseStatus = z.infer<typeof ExpenseStatusSchema>

// ---- sales, shifts, payments (0006) -----------------------------------------------------------
export const ShiftStatusSchema = z.enum(['open', 'closed'])
export type ShiftStatus = z.infer<typeof ShiftStatusSchema>

export const ShiftCashEntryKindSchema = z.enum(['pay_in', 'pay_out'])
export type ShiftCashEntryKind = z.infer<typeof ShiftCashEntryKindSchema>

export const SalesDocTypeSchema = z.enum(['tax_invoice', 'bill_of_supply', 'estimate'])
export type SalesDocType = z.infer<typeof SalesDocTypeSchema>

export const SalesInvoiceStatusSchema = z.enum([
  'draft',
  'held',
  'completed',
  'cancelled',
  'converted',
])
export type SalesInvoiceStatus = z.infer<typeof SalesInvoiceStatusSchema>

export const SalesChannelSchema = z.enum(['pos', 'backoffice', 'online', 'whatsapp', 'api'])
export type SalesChannel = z.infer<typeof SalesChannelSchema>

export const SalesPaymentStatusSchema = z.enum(['unpaid', 'partial', 'paid', 'refunded'])
export type SalesPaymentStatus = z.infer<typeof SalesPaymentStatusSchema>

export const CreditNoteReasonSchema = z.enum([
  'return',
  'damaged',
  'expired',
  'price_adjustment',
  'other',
])
export type CreditNoteReason = z.infer<typeof CreditNoteReasonSchema>

export const CreditNoteStatusSchema = z.enum(['completed', 'cancelled'])
export type CreditNoteStatus = z.infer<typeof CreditNoteStatusSchema>

export const CreditNoteSettlementSchema = z.enum([
  'cash',
  'upi',
  'bank_transfer',
  'adjust_due',
  'store_credit',
])
export type CreditNoteSettlement = z.infer<typeof CreditNoteSettlementSchema>

export const PaymentProviderCodeSchema = z.enum([
  'upi_vpa',
  'razorpay',
  'cashfree',
  'phonepe',
  'paytm',
  'mock',
])
export type PaymentProviderCode = z.infer<typeof PaymentProviderCodeSchema>

export const ProviderModeSchema = z.enum(['test', 'live'])
export type ProviderMode = z.infer<typeof ProviderModeSchema>

export const PaymentIntentKindSchema = z.enum(['qr', 'link', 'collect'])
export type PaymentIntentKind = z.infer<typeof PaymentIntentKindSchema>

export const PaymentIntentPurposeSchema = z.enum([
  'pos_sale',
  'invoice_due',
  'customer_due',
  'advance',
])
export type PaymentIntentPurpose = z.infer<typeof PaymentIntentPurposeSchema>

export const PaymentIntentStatusSchema = z.enum([
  'created',
  'pending',
  'paid',
  'failed',
  'expired',
  'cancelled',
])
export type PaymentIntentStatus = z.infer<typeof PaymentIntentStatusSchema>

export const PaymentConfirmationSchema = z.enum(['webhook', 'poll', 'manual', 'sync'])
export type PaymentConfirmation = z.infer<typeof PaymentConfirmationSchema>

export const PaymentDirectionSchema = z.enum(['in', 'out'])
export type PaymentDirection = z.infer<typeof PaymentDirectionSchema>

export const PaymentMethodSchema = z.enum([
  'cash',
  'upi',
  'card',
  'bank_transfer',
  'cheque',
  'wallet',
  'store_credit',
  'other',
])
export type PaymentMethod = z.infer<typeof PaymentMethodSchema>

export const PaymentStatusSchema = z.enum(['pending', 'completed', 'failed', 'cancelled'])
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>

export const AllocationTargetTypeSchema = z.enum([
  'sales_invoice',
  'purchase_bill',
  'credit_note',
  'debit_note',
  'expense',
  'opening_balance',
])
export type AllocationTargetType = z.infer<typeof AllocationTargetTypeSchema>

// ---- purchases (0007) -------------------------------------------------------------------------
export const PurchaseOrderStatusSchema = z.enum([
  'draft',
  'sent',
  'partially_received',
  'received',
  'closed',
  'cancelled',
])
export type PurchaseOrderStatus = z.infer<typeof PurchaseOrderStatusSchema>

export const PurchaseBillStatusSchema = z.enum(['draft', 'posted', 'cancelled'])
export type PurchaseBillStatus = z.infer<typeof PurchaseBillStatusSchema>

export const PurchasePaymentStatusSchema = z.enum(['unpaid', 'partial', 'paid'])
export type PurchasePaymentStatus = z.infer<typeof PurchasePaymentStatusSchema>

export const DebitNoteReasonSchema = z.enum([
  'return',
  'damaged',
  'expired',
  'short_supply',
  'price_difference',
  'other',
])
export type DebitNoteReason = z.infer<typeof DebitNoteReasonSchema>

export const DebitNoteStatusSchema = z.enum(['completed', 'cancelled'])
export type DebitNoteStatus = z.infer<typeof DebitNoteStatusSchema>

export const DebitNoteSettlementSchema = z.enum(['adjust_due', 'refund_cash', 'refund_bank'])
export type DebitNoteSettlement = z.infer<typeof DebitNoteSettlementSchema>

// ---- notifications (0008) ---------------------------------------------------------------------
export const NotificationChannelSchema = z.enum(['sms', 'whatsapp', 'email'])
export type NotificationChannel = z.infer<typeof NotificationChannelSchema>

export const NotificationStatusSchema = z.enum([
  'queued',
  'sending',
  'sent',
  'delivered',
  'read',
  'failed',
  'cancelled',
])
export type NotificationStatus = z.infer<typeof NotificationStatusSchema>

// ---- vendor control plane (0010) ---------------------------------------------------------------
export const PlatformStaffRoleSchema = z.enum([
  'owner',
  'admin',
  'sales',
  'support',
  'finance',
  'partner',
])
export type PlatformStaffRole = z.infer<typeof PlatformStaffRoleSchema>

export const PartnerTierSchema = z.enum(['silver', 'gold', 'platinum'])
export type PartnerTier = z.infer<typeof PartnerTierSchema>

export const PartnerStatusSchema = z.enum(['active', 'suspended'])
export type PartnerStatus = z.infer<typeof PartnerStatusSchema>

export const LicenseProductKindSchema = z.enum([
  'edition',
  'subscription',
  'amc',
  'addon',
  'cloud_plan',
  'service',
])
export type LicenseProductKind = z.infer<typeof LicenseProductKindSchema>

/** Which deployment a product/offer is sold for. */
export const DeploymentChannelSchema = z.enum(['onprem', 'cloud', 'both'])
export type DeploymentChannel = z.infer<typeof DeploymentChannelSchema>

export const LicenseTypeSchema = z.enum(['perpetual', 'subscription', 'trial', 'nfr'])
export type LicenseType = z.infer<typeof LicenseTypeSchema>

export const VendorLicenseStatusSchema = z.enum(['active', 'suspended', 'revoked'])
export type VendorLicenseStatus = z.infer<typeof VendorLicenseStatusSchema>

export const ActivationMethodSchema = z.enum(['online', 'offline'])
export type ActivationMethod = z.infer<typeof ActivationMethodSchema>

export const ActivationStatusSchema = z.enum(['active', 'deactivated', 'blocked'])
export type ActivationStatus = z.infer<typeof ActivationStatusSchema>

export const LicenseEventKindSchema = z.enum([
  'issued',
  'activated',
  'offline_activated',
  'check_in',
  'deactivated',
  'transferred',
  'renewed',
  'upgraded',
  'addon_added',
  'suspended',
  'resumed',
  'revoked',
  'clone_suspected',
  'license_downloaded',
  'update_installed',
])
export type LicenseEventKind = z.infer<typeof LicenseEventKindSchema>

export const ReleaseChannelSchema = z.enum(['stable', 'beta'])
export type ReleaseChannel = z.infer<typeof ReleaseChannelSchema>

export const OfferKindSchema = z.enum(['percent', 'flat', 'free_months', 'price_override'])
export type OfferKind = z.infer<typeof OfferKindSchema>

export const VendorOrderKindSchema = z.enum([
  'new_license',
  'renewal',
  'upgrade',
  'addon',
  'cloud_plan',
  'service',
])
export type VendorOrderKind = z.infer<typeof VendorOrderKindSchema>

export const VendorOrderStatusSchema = z.enum([
  'draft',
  'pending_payment',
  'paid',
  'fulfilled',
  'cancelled',
  'refunded',
])
export type VendorOrderStatus = z.infer<typeof VendorOrderStatusSchema>

export const VendorPaymentProviderSchema = z.enum(['razorpay', 'manual', 'partner_credit'])
export type VendorPaymentProvider = z.infer<typeof VendorPaymentProviderSchema>

export const CommissionStatusSchema = z.enum(['accrued', 'approved', 'paid', 'void'])
export type CommissionStatus = z.infer<typeof CommissionStatusSchema>

export const AnnouncementSeveritySchema = z.enum(['info', 'offer', 'warning', 'critical'])
export type AnnouncementSeverity = z.infer<typeof AnnouncementSeveritySchema>

export const CloudBackupStatusSchema = z.enum(['pending', 'stored', 'deleted'])
export type CloudBackupStatus = z.infer<typeof CloudBackupStatusSchema>

export const LicenseReminderKindSchema = z.enum(['amc', 'subscription'])
export type LicenseReminderKind = z.infer<typeof LicenseReminderKindSchema>
