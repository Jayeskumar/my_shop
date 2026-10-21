/**
 * GENERATED FILE — do not edit. Regenerate with `pnpm --filter @kadai/server db:types`.
 *
 * Kysely table types introspected from the migrated schema (kysely-codegen), post-processed to match
 * the pg type parsers in src/db/pool.ts:
 *   int8        → number (safe-integer checked at parse time)
 *   date        → 'YYYY-MM-DD' string
 *   timestamptz → Date on read; Date or ISO string on write
 *   json/jsonb  → `unknown` on read (validate with zod); JSON text on write — use `jsonb(value)`
 *                 from src/db/json.ts so arrays are never sent as Postgres array literals
 */

import type { ColumnType } from "kysely";

export type Generated<T> = T extends ColumnType<infer S, infer I, infer U>
  ? ColumnType<S, I | undefined, U>
  : ColumnType<T, T | undefined, T>;

export type Int8 = ColumnType<number, bigint | number, bigint | number>;

/** JSON as read from json/jsonb columns: deliberately `unknown` — validate before use. */
export type JsonValue = unknown;

/** json/jsonb column: read `unknown`, write JSON text (see `jsonb()` in src/db/json.ts). */
export type Json = ColumnType<JsonValue, string, string>;

export type Timestamp = ColumnType<Date, Date | string, Date | string>;

export interface Accounts {
  code: string;
  created_at: Generated<Timestamp>;
  details: Generated<Json>;
  id: Generated<string>;
  is_active: Generated<boolean>;
  is_system: Generated<boolean>;
  name: string;
  name_ta: string | null;
  parent_id: string | null;
  store_id: string | null;
  subtype: string | null;
  tenant_id: string;
  type: string;
  updated_at: Generated<Timestamp>;
}

export interface Announcements {
  audience: Generated<Json>;
  body_en: string;
  body_ta: string | null;
  created_at: Generated<Timestamp>;
  created_by: string | null;
  cta_label_en: string | null;
  cta_label_ta: string | null;
  cta_url: string | null;
  ends_at: Timestamp | null;
  id: Generated<string>;
  is_active: Generated<boolean>;
  offer_id: string | null;
  severity: Generated<string>;
  starts_at: Generated<Timestamp>;
  title_en: string;
  title_ta: string | null;
  updated_at: Generated<Timestamp>;
}

export interface ApiKeys {
  created_at: Generated<Timestamp>;
  created_by: string | null;
  expires_at: Timestamp | null;
  id: Generated<string>;
  key_hash: string;
  key_prefix: string;
  last_used_at: Timestamp | null;
  name: string;
  permissions: Generated<string[]>;
  revoked_at: Timestamp | null;
  store_ids: string[] | null;
  tenant_id: string;
  updated_at: Generated<Timestamp>;
}

export interface AuditLogs {
  action: string;
  changes: Json | null;
  created_at: Generated<Timestamp>;
  entity_id: string | null;
  entity_type: string | null;
  id: Generated<Int8>;
  ip: string | null;
  request_id: string | null;
  summary: string | null;
  tenant_id: string;
  user_agent: string | null;
  user_id: string | null;
}

export interface AuthSessions {
  auth_method: Generated<string>;
  created_at: Generated<Timestamp>;
  device_id: string | null;
  expires_at: Timestamp;
  family_id: string;
  id: Generated<string>;
  ip: string | null;
  last_used_at: Timestamp | null;
  refresh_token_hash: string;
  replaced_by: string | null;
  revoked_at: Timestamp | null;
  revoked_reason: string | null;
  tenant_id: string | null;
  user_agent: string | null;
  user_id: string;
}

export interface Backups {
  checksum_sha256: string | null;
  error: string | null;
  finished_at: Timestamp | null;
  id: Generated<string>;
  kind: Generated<string>;
  location: string | null;
  size_bytes: Int8 | null;
  started_at: Generated<Timestamp>;
  status: Generated<string>;
  uploaded_to_cloud: Generated<boolean>;
}

export interface Batches {
  batch_no: string;
  created_at: Generated<Timestamp>;
  expiry_date: string | null;
  id: Generated<string>;
  is_active: Generated<boolean>;
  mfg_date: string | null;
  mrp_paise: Int8 | null;
  product_id: string;
  purchase_price_paise: Int8 | null;
  sale_price_paise: Int8 | null;
  supplier_id: string | null;
  tenant_id: string;
  updated_at: Generated<Timestamp>;
}

export interface Brands {
  created_at: Generated<Timestamp>;
  id: Generated<string>;
  is_active: Generated<boolean>;
  name: string;
  tenant_id: string;
  updated_at: Generated<Timestamp>;
}

export interface Categories {
  created_at: Generated<Timestamp>;
  gst_rate_bp: number | null;
  hsn_code: string | null;
  id: Generated<string>;
  is_active: Generated<boolean>;
  name: string;
  name_ta: string | null;
  parent_id: string | null;
  sort_order: Generated<number>;
  tax_slab_rule_id: string | null;
  tenant_id: string;
  updated_at: Generated<Timestamp>;
}

export interface CloudBackups {
  activation_id: string;
  created_at: Generated<Timestamp>;
  expires_at: Timestamp | null;
  id: Generated<string>;
  object_key: string;
  sha256: string;
  size_bytes: Int8;
  status: Generated<string>;
}

export interface CreditNoteLines {
  batch_id: string | null;
  cess_paise: Generated<Int8>;
  cess_rate_bp: Generated<number>;
  cgst_paise: Generated<Int8>;
  cost_paise: Generated<Int8>;
  credit_note_id: string;
  gst_rate_bp: Generated<number>;
  hsn_code: string | null;
  id: Generated<string>;
  igst_paise: Generated<Int8>;
  invoice_line_id: string | null;
  line_no: number;
  name: string;
  pack_size: Generated<number>;
  product_id: string | null;
  qty_milli: Int8;
  restock: Generated<boolean>;
  sgst_paise: Generated<Int8>;
  taxable_paise: Int8;
  tenant_id: string;
  total_paise: Int8;
  unit: string;
  unit_cost_paise: Generated<Int8>;
  unit_price_paise: Int8;
}

export interface CreditNotes {
  cancel_reason: string | null;
  cancelled_at: Timestamp | null;
  cancelled_by: string | null;
  cess_paise: Generated<Int8>;
  cgst_paise: Generated<Int8>;
  client_ref: string | null;
  cost_paise: Generated<Int8>;
  created_at: Generated<Timestamp>;
  created_by: string | null;
  customer_gstin: string | null;
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  customer_state_code: string | null;
  fy: string;
  id: Generated<string>;
  igst_paise: Generated<Int8>;
  invoice_id: string | null;
  is_interstate: Generated<boolean>;
  note_date: string;
  notes: string | null;
  number: string;
  place_of_supply: string;
  reason: string;
  register_id: string | null;
  restock: Generated<boolean>;
  round_off_paise: Generated<Int8>;
  settled_paise: Generated<Int8>;
  settlement: string;
  sgst_paise: Generated<Int8>;
  shift_id: string | null;
  status: Generated<string>;
  store_id: string;
  taxable_paise: Generated<Int8>;
  tenant_id: string;
  total_paise: Generated<Int8>;
  updated_at: Generated<Timestamp>;
}

export interface Customers {
  address: Generated<Json>;
  alt_phone: string | null;
  anniversary: string | null;
  balance_paise: Generated<Int8>;
  code: string | null;
  created_at: Generated<Timestamp>;
  created_by: string | null;
  credit_days: number | null;
  credit_limit_paise: Int8 | null;
  customer_type: Generated<string>;
  date_of_birth: string | null;
  email: string | null;
  gstin: string | null;
  id: Generated<string>;
  is_active: Generated<boolean>;
  loyalty_points: Generated<Int8>;
  name: string;
  name_ta: string | null;
  notes: string | null;
  opening_balance_paise: Generated<Int8>;
  phone: string | null;
  price_tier: Generated<string>;
  state_code: string | null;
  tags: Generated<string[]>;
  tenant_id: string;
  updated_at: Generated<Timestamp>;
  whatsapp_opt_in: Generated<boolean>;
}

export interface DebitNoteLines {
  batch_id: string | null;
  bill_line_id: string | null;
  cess_paise: Generated<Int8>;
  cess_rate_bp: Generated<number>;
  cgst_paise: Generated<Int8>;
  debit_note_id: string;
  gst_rate_bp: Generated<number>;
  hsn_code: string | null;
  id: Generated<string>;
  igst_paise: Generated<Int8>;
  line_no: number;
  pack_size: Generated<number>;
  product_id: string;
  qty_milli: Int8;
  sgst_paise: Generated<Int8>;
  taxable_paise: Int8;
  tenant_id: string;
  total_paise: Int8;
  unit: string;
  unit_cost_paise: Int8;
}

export interface DebitNotes {
  bill_id: string | null;
  cancelled_at: Timestamp | null;
  cancelled_by: string | null;
  cess_paise: Generated<Int8>;
  cgst_paise: Generated<Int8>;
  created_at: Generated<Timestamp>;
  created_by: string | null;
  fy: string;
  id: Generated<string>;
  igst_paise: Generated<Int8>;
  is_interstate: Generated<boolean>;
  note_date: string;
  notes: string | null;
  number: string;
  reason: string;
  round_off_paise: Generated<Int8>;
  settlement: Generated<string>;
  sgst_paise: Generated<Int8>;
  status: Generated<string>;
  store_id: string;
  supplier_id: string;
  taxable_paise: Generated<Int8>;
  tenant_id: string;
  total_paise: Generated<Int8>;
  updated_at: Generated<Timestamp>;
}

export interface Devices {
  approved_by: string | null;
  created_at: Generated<Timestamp>;
  device_secret_hash: string;
  id: Generated<string>;
  is_active: Generated<boolean>;
  last_seen_at: Timestamp | null;
  name: string;
  register_id: string | null;
  revoked_at: Timestamp | null;
  store_id: string;
  tenant_id: string;
  updated_at: Generated<Timestamp>;
  user_agent: string | null;
}

export interface Doctors {
  address: Generated<Json>;
  clinic_name: string | null;
  created_at: Generated<Timestamp>;
  id: Generated<string>;
  is_active: Generated<boolean>;
  name: string;
  phone: string | null;
  qualification: string | null;
  registration_no: string | null;
  tenant_id: string;
  updated_at: Generated<Timestamp>;
}

export interface Expenses {
  attachment_file_id: string | null;
  cancel_reason: string | null;
  cancelled_at: Timestamp | null;
  cancelled_by: string | null;
  cgst_paise: Generated<Int8>;
  created_at: Generated<Timestamp>;
  created_by: string | null;
  description: string | null;
  expense_account_id: string;
  expense_date: string;
  fy: string | null;
  gst_rate_bp: Generated<number>;
  id: Generated<string>;
  igst_paise: Generated<Int8>;
  itc_eligible: Generated<boolean>;
  number: string | null;
  paid_from_account_id: string | null;
  payment_method: string;
  reference: string | null;
  sgst_paise: Generated<Int8>;
  shift_id: string | null;
  status: Generated<string>;
  store_id: string;
  supplier_id: string | null;
  taxable_paise: Int8;
  tenant_id: string;
  total_paise: Int8;
  updated_at: Generated<Timestamp>;
}

export interface Files {
  checksum_sha256: string;
  content_type: string;
  created_at: Generated<Timestamp>;
  created_by: string | null;
  filename: string;
  id: Generated<string>;
  purpose: string;
  size_bytes: Int8;
  storage: string;
  storage_key: string;
  tenant_id: string;
}

export interface IdempotencyKeys {
  created_at: Generated<Timestamp>;
  expires_at: Generated<Timestamp>;
  key: string;
  method: string;
  path: string;
  request_hash: string;
  response_body: Json | null;
  response_status: number | null;
  status: Generated<string>;
  tenant_id: string;
}

export interface Imports {
  created_at: Generated<Timestamp>;
  created_by: string | null;
  error_rows: Generated<number>;
  errors: Generated<Json>;
  file_id: string | null;
  finished_at: Timestamp | null;
  id: Generated<string>;
  kind: string;
  options: Generated<Json>;
  status: Generated<string>;
  store_id: string | null;
  success_rows: Generated<number>;
  tenant_id: string;
  total_rows: Generated<number>;
  updated_at: Generated<Timestamp>;
}

export interface InstallationSnapshots {
  activation_id: string;
  app_version: string | null;
  generated_at: Timestamp;
  received_at: Generated<Timestamp>;
  snapshot: Json;
}

export interface JournalEntries {
  created_at: Generated<Timestamp>;
  created_by: string | null;
  entry_date: string;
  id: Generated<string>;
  narration: string | null;
  number: string | null;
  reverses_entry_id: string | null;
  source_id: string | null;
  source_type: string;
  store_id: string | null;
  tenant_id: string;
}

export interface JournalLines {
  account_id: string;
  created_at: Generated<Timestamp>;
  credit_paise: Generated<Int8>;
  debit_paise: Generated<Int8>;
  entry_date: string;
  entry_id: string;
  id: Generated<string>;
  memo: string | null;
  party_id: string | null;
  party_type: string | null;
  store_id: string | null;
  tenant_id: string;
}

export interface LicenseActivations {
  activated_at: Generated<Timestamp>;
  app_version: string | null;
  business_name: string | null;
  cloud_backup_enabled: Generated<boolean>;
  connect_enabled: Generated<boolean>;
  created_at: Generated<Timestamp>;
  deactivated_at: Timestamp | null;
  deactivation_reason: string | null;
  fingerprint_hash: string;
  id: Generated<string>;
  installation_id: string;
  installation_public_key: string;
  last_check_in_at: Timestamp | null;
  last_check_in_ip: string | null;
  last_stats: Generated<Json>;
  last_version: string | null;
  license_id: string;
  machine_name: string | null;
  method: Generated<string>;
  os: string | null;
  stale_flagged_at: Timestamp | null;
  status: Generated<string>;
  updated_at: Generated<Timestamp>;
}

export interface LicenseEvents {
  activation_id: string | null;
  actor_user_id: string | null;
  created_at: Generated<Timestamp>;
  details: Generated<Json>;
  id: Generated<Int8>;
  ip: string | null;
  kind: string;
  license_id: string | null;
}

export interface LicenseProducts {
  channel: string;
  code: string;
  created_at: Generated<Timestamp>;
  description: string | null;
  description_ta: string | null;
  features: Generated<string[]>;
  gst_rate_bp: Generated<number>;
  hsn_sac: Generated<string>;
  included_amc_months: Generated<number>;
  is_active: Generated<boolean>;
  kind: string;
  limits: Generated<Json>;
  name: string;
  name_ta: string | null;
  plan_code: string | null;
  price_paise: Int8;
  renewal_price_paise: Int8 | null;
  sort_order: Generated<number>;
  term_months: number | null;
  updated_at: Generated<Timestamp>;
}

export interface LicenseReminders {
  channels: Generated<string[]>;
  due_on: string;
  kind: string;
  license_id: string;
  offset_days: number;
  order_id: string | null;
  partner_notified: Generated<boolean>;
  sent_at: Generated<Timestamp>;
}

export interface Licenses {
  addons: Generated<Json>;
  check_in_days: Generated<number>;
  created_at: Generated<Timestamp>;
  customer_id: string;
  features: string[] | null;
  grace_days: Generated<number>;
  id: Generated<string>;
  issued_by: string | null;
  key_hash: string;
  key_prefix: string;
  license_type: string;
  limits: Generated<Json>;
  max_activations: Generated<number>;
  notes: string | null;
  partner_id: string | null;
  plan_code: string;
  product_code: string;
  status: Generated<string>;
  support_until: string | null;
  suspended_reason: string | null;
  updated_at: Generated<Timestamp>;
  updates_until: string | null;
  valid_from: string;
  valid_until: string | null;
}

export interface LicensingRequestNonces {
  created_at: Generated<Timestamp>;
  installation_id: string;
  signature_sha256: string;
}

export interface LoyaltyLedger {
  created_at: Generated<Timestamp>;
  created_by: string | null;
  customer_id: string;
  id: Generated<string>;
  kind: string;
  notes: string | null;
  points: Int8;
  ref_id: string | null;
  ref_type: string | null;
  tenant_id: string;
}

export interface Memberships {
  created_at: Generated<Timestamp>;
  id: Generated<string>;
  invited_by: string | null;
  pin_failed_count: Generated<number>;
  pin_locked_until: Timestamp | null;
  pos_pin_hash: string | null;
  role_id: string;
  status: Generated<string>;
  store_ids: string[] | null;
  tenant_id: string;
  updated_at: Generated<Timestamp>;
  user_id: string;
}

export interface Notifications {
  attempts: Generated<number>;
  channel: string;
  created_at: Generated<Timestamp>;
  created_by: string | null;
  error: string | null;
  id: Generated<string>;
  locale: Generated<string>;
  params: Generated<Json>;
  provider: string | null;
  provider_message_id: string | null;
  recipient: string;
  recipient_name: string | null;
  ref_id: string | null;
  ref_type: string | null;
  rendered_body: string | null;
  scheduled_at: Generated<Timestamp>;
  sent_at: Timestamp | null;
  status: Generated<string>;
  template_code: string;
  tenant_id: string;
  updated_at: Generated<Timestamp>;
}

export interface NotificationTemplates {
  body: string;
  channel: string;
  code: string;
  created_at: Generated<Timestamp>;
  id: Generated<string>;
  is_active: Generated<boolean>;
  locale: string;
  provider_template_id: string | null;
  subject: string | null;
  tenant_id: string;
  updated_at: Generated<Timestamp>;
}

export interface NumberSeries {
  created_at: Generated<Timestamp>;
  doc_type: string;
  fy: string;
  id: Generated<string>;
  next_number: Generated<Int8>;
  padding: Generated<number>;
  prefix: string;
  register_id: string | null;
  store_id: string;
  tenant_id: string;
  updated_at: Generated<Timestamp>;
}

export interface OfferRedemptions {
  created_at: Generated<Timestamp>;
  customer_id: string | null;
  discount_paise: Int8;
  id: Generated<string>;
  offer_id: string;
  order_id: string;
  tenant_id: string | null;
}

export interface Offers {
  applies_to: Generated<string[]>;
  audience: Generated<Json>;
  banner: Json | null;
  channel: Generated<string>;
  code: string | null;
  created_at: Generated<Timestamp>;
  created_by: string | null;
  description: string | null;
  description_ta: string | null;
  ends_at: Timestamp | null;
  id: Generated<string>;
  is_active: Generated<boolean>;
  kind: string;
  max_discount_paise: Int8 | null;
  max_redemptions: number | null;
  name: string;
  name_ta: string | null;
  partner_id: string | null;
  per_customer_limit: Generated<number>;
  stackable: Generated<boolean>;
  starts_at: Timestamp | null;
  updated_at: Generated<Timestamp>;
  value: Int8;
}

export interface OtpCodes {
  attempts: Generated<number>;
  code_hash: string;
  consumed_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  expires_at: Timestamp;
  id: Generated<string>;
  ip: string | null;
  max_attempts: Generated<number>;
  phone: string;
  purpose: string;
}

export interface PartnerCommissions {
  amount_paise: Int8;
  created_at: Generated<Timestamp>;
  id: Generated<string>;
  order_id: string;
  paid_at: Timestamp | null;
  paid_ref: string | null;
  partner_id: string;
  status: Generated<string>;
  updated_at: Generated<Timestamp>;
}

export interface Partners {
  address: Generated<Json>;
  code: string;
  commission_bp: Generated<number>;
  contact_name: string | null;
  created_at: Generated<Timestamp>;
  discount_bp: Generated<number>;
  district: string | null;
  email: string | null;
  gstin: string | null;
  id: Generated<string>;
  name: string;
  notes: string | null;
  payout_details: Generated<Json>;
  phone: string | null;
  state_code: string | null;
  status: Generated<string>;
  tier: Generated<string>;
  updated_at: Generated<Timestamp>;
}

export interface PaymentAllocations {
  amount_paise: Int8;
  created_at: Generated<Timestamp>;
  id: Generated<string>;
  payment_id: string;
  target_id: string | null;
  target_type: string;
  tenant_id: string;
}

export interface PaymentIntents {
  amount_paise: Int8;
  confirmation: string | null;
  confirmed_by: string | null;
  created_at: Generated<Timestamp>;
  created_by: string | null;
  currency: Generated<string>;
  customer_id: string | null;
  expires_at: Timestamp | null;
  failure_reason: string | null;
  fee_paise: Int8 | null;
  id: Generated<string>;
  idempotency_key: string | null;
  kind: Generated<string>;
  last_polled_at: Timestamp | null;
  metadata: Generated<Json>;
  paid_amount_paise: Int8 | null;
  paid_at: Timestamp | null;
  payer_name: string | null;
  payer_vpa: string | null;
  payment_id: string | null;
  poll_count: Generated<number>;
  provider: string;
  provider_account_id: string;
  provider_payment_id: string | null;
  provider_ref: string | null;
  purpose: string;
  ref_id: string | null;
  ref_type: string | null;
  reference_code: string;
  register_id: string | null;
  short_url: string | null;
  status: Generated<string>;
  store_id: string;
  tenant_id: string;
  updated_at: Generated<Timestamp>;
  upi_uri: string | null;
  utr: string | null;
}

export interface PaymentProviderAccounts {
  created_at: Generated<Timestamp>;
  created_by: string | null;
  credentials_encrypted: string | null;
  display_name: string;
  id: Generated<string>;
  is_active: Generated<boolean>;
  is_default: Generated<boolean>;
  last_verified_at: Timestamp | null;
  merchant_code: string | null;
  mode: Generated<string>;
  payee_name: string | null;
  provider: string;
  settlement_account_id: string | null;
  store_id: string | null;
  tenant_id: string;
  updated_at: Generated<Timestamp>;
  vpa: string | null;
  webhook_secret_encrypted: string | null;
}

export interface Payments {
  account_id: string;
  amount_paise: Int8;
  cancel_reason: string | null;
  cancelled_at: Timestamp | null;
  cancelled_by: string | null;
  client_ref: string | null;
  created_at: Generated<Timestamp>;
  created_by: string | null;
  direction: string;
  fy: string | null;
  id: Generated<string>;
  method: string;
  notes: string | null;
  number: string | null;
  paid_at: Generated<Timestamp>;
  party_id: string | null;
  party_type: string | null;
  payment_date: string;
  payment_intent_id: string | null;
  reference: string | null;
  register_id: string | null;
  shift_id: string | null;
  status: Generated<string>;
  store_id: string;
  tenant_id: string;
  unallocated_paise: Generated<Int8>;
  updated_at: Generated<Timestamp>;
}

export interface PaymentWebhookEvents {
  attempts: Generated<number>;
  event_id: string;
  event_type: string;
  id: Generated<string>;
  payload: Json;
  processed_at: Timestamp | null;
  processing_error: string | null;
  provider: string;
  provider_account_id: string | null;
  received_at: Generated<Timestamp>;
  signature_valid: boolean;
  tenant_id: string | null;
}

export interface Plans {
  code: string;
  created_at: Generated<Timestamp>;
  description: string | null;
  features: Generated<string[]>;
  is_public: Generated<boolean>;
  limits: Generated<Json>;
  name: string;
  name_ta: string | null;
  price_monthly_paise: Generated<Int8>;
  price_yearly_paise: Generated<Int8>;
  sort_order: Generated<number>;
  updated_at: Generated<Timestamp>;
}

export interface PlatformAuditLogs {
  action: string;
  actor_user_id: string | null;
  created_at: Generated<Timestamp>;
  details: Generated<Json>;
  id: Generated<Int8>;
  ip: string | null;
  request_id: string | null;
  tenant_id: string | null;
}

export interface PlatformInvoices {
  cgst_paise: Generated<Int8>;
  created_at: Generated<Timestamp>;
  id: Generated<string>;
  igst_paise: Generated<Int8>;
  number: string;
  paid_at: Timestamp | null;
  period_end: string;
  period_start: string;
  plan_code: string;
  provider_invoice_id: string | null;
  provider_payment_id: string | null;
  sgst_paise: Generated<Int8>;
  status: Generated<string>;
  subscription_id: string | null;
  taxable_paise: Int8;
  tenant_id: string;
  total_paise: Int8;
  updated_at: Generated<Timestamp>;
}

export interface PlatformStaff {
  created_at: Generated<Timestamp>;
  created_by: string | null;
  is_active: Generated<boolean>;
  partner_id: string | null;
  role: string;
  updated_at: Generated<Timestamp>;
  user_id: string;
}

export interface ProductBarcodes {
  barcode: string;
  created_at: Generated<Timestamp>;
  id: Generated<string>;
  product_id: string;
  qty_milli: Generated<Int8>;
  tenant_id: string;
}

export interface Products {
  aliases: Generated<string[]>;
  allow_loose: Generated<boolean>;
  attributes: Generated<Json>;
  brand_id: string | null;
  category_id: string | null;
  cess_rate_bp: Generated<number>;
  created_at: Generated<Timestamp>;
  created_by: string | null;
  decimal_qty: Generated<boolean>;
  description: string | null;
  gst_rate_bp: Generated<number>;
  hsn_code: string | null;
  id: Generated<string>;
  image_file_id: string | null;
  is_active: Generated<boolean>;
  is_weighed: Generated<boolean>;
  kind: Generated<string>;
  max_discount_bp: number | null;
  min_sale_price_paise: Int8 | null;
  mrp_paise: Int8 | null;
  name: string;
  name_ta: string | null;
  pack_size: Generated<number>;
  parent_id: string | null;
  price_includes_tax: Generated<boolean>;
  purchase_price_paise: Generated<Int8>;
  reorder_level_milli: Int8 | null;
  reorder_qty_milli: Int8 | null;
  sale_price_paise: Generated<Int8>;
  scale_plu: string | null;
  search_text: Generated<string>;
  sku: string | null;
  tax_slab_rule_id: string | null;
  tenant_id: string;
  track_batches: Generated<boolean>;
  track_inventory: Generated<boolean>;
  unit: Generated<string>;
  updated_at: Generated<Timestamp>;
  variant_attributes: Generated<Json>;
  variant_axes: Generated<string[]>;
  wholesale_price_paise: Int8 | null;
}

export interface Promotions {
  created_at: Generated<Timestamp>;
  created_by: string | null;
  days_of_week: number[] | null;
  ends_at: Timestamp | null;
  id: Generated<string>;
  is_active: Generated<boolean>;
  kind: string;
  name: string;
  name_ta: string | null;
  priority: Generated<number>;
  rules: Json;
  stackable: Generated<boolean>;
  starts_at: Timestamp | null;
  store_ids: string[] | null;
  tenant_id: string;
  updated_at: Generated<Timestamp>;
}

export interface PurchaseBillLines {
  batch_id: string | null;
  batch_no: string | null;
  bill_id: string;
  cess_paise: Generated<Int8>;
  cess_rate_bp: Generated<number>;
  cgst_paise: Generated<Int8>;
  discount_bp: Generated<number>;
  discount_paise: Generated<Int8>;
  expiry_date: string | null;
  free_qty_milli: Generated<Int8>;
  gross_paise: Int8;
  gst_rate_bp: Generated<number>;
  hsn_code: string | null;
  id: Generated<string>;
  igst_paise: Generated<Int8>;
  landed_unit_cost_paise: Generated<Int8>;
  line_no: number;
  mfg_date: string | null;
  mrp_paise: Int8 | null;
  pack_size: Generated<number>;
  product_id: string;
  purchase_order_line_id: string | null;
  qty_milli: Int8;
  returned_qty_milli: Generated<Int8>;
  sale_price_paise: Int8 | null;
  sgst_paise: Generated<Int8>;
  taxable_paise: Int8;
  tenant_id: string;
  total_paise: Int8;
  unit: string;
  unit_cost_paise: Int8;
}

export interface PurchaseBills {
  attachment_file_id: string | null;
  cancel_reason: string | null;
  cancelled_at: Timestamp | null;
  cancelled_by: string | null;
  cess_paise: Generated<Int8>;
  cgst_paise: Generated<Int8>;
  created_at: Generated<Timestamp>;
  created_by: string | null;
  discount_paise: Generated<Int8>;
  due_date: string | null;
  due_paise: Generated<Int8>;
  fy: string | null;
  gross_paise: Generated<Int8>;
  id: Generated<string>;
  igst_paise: Generated<Int8>;
  is_interstate: Generated<boolean>;
  itc_eligible: Generated<boolean>;
  notes: string | null;
  number: string | null;
  other_charges_paise: Generated<Int8>;
  paid_paise: Generated<Int8>;
  payment_status: Generated<string>;
  posted_at: Timestamp | null;
  posted_by: string | null;
  purchase_order_id: string | null;
  received_date: string;
  returned_paise: Generated<Int8>;
  reverse_charge: Generated<boolean>;
  round_off_paise: Generated<Int8>;
  sgst_paise: Generated<Int8>;
  status: Generated<string>;
  store_id: string;
  supplier_gstin: string | null;
  supplier_id: string;
  supplier_invoice_date: string;
  supplier_invoice_no: string;
  supplier_state_code: string | null;
  taxable_paise: Generated<Int8>;
  tenant_id: string;
  total_paise: Generated<Int8>;
  updated_at: Generated<Timestamp>;
}

export interface PurchaseOrderLines {
  gst_rate_bp: Generated<number>;
  id: Generated<string>;
  line_no: number;
  notes: string | null;
  product_id: string;
  purchase_order_id: string;
  qty_milli: Int8;
  received_qty_milli: Generated<Int8>;
  tax_paise: Generated<Int8>;
  taxable_paise: Generated<Int8>;
  tenant_id: string;
  total_paise: Generated<Int8>;
  unit_cost_paise: Generated<Int8>;
}

export interface PurchaseOrders {
  created_at: Generated<Timestamp>;
  created_by: string | null;
  expected_date: string | null;
  fy: string;
  id: Generated<string>;
  is_interstate: Generated<boolean>;
  notes: string | null;
  number: string;
  order_date: string;
  sent_at: Timestamp | null;
  status: Generated<string>;
  store_id: string;
  supplier_id: string;
  tax_paise: Generated<Int8>;
  taxable_paise: Generated<Int8>;
  tenant_id: string;
  terms: string | null;
  total_paise: Generated<Int8>;
  updated_at: Generated<Timestamp>;
}

export interface Registers {
  code: string;
  created_at: Generated<Timestamp>;
  id: Generated<string>;
  is_active: Generated<boolean>;
  last_seen_at: Timestamp | null;
  name: string;
  settings: Generated<Json>;
  store_id: string;
  tenant_id: string;
  updated_at: Generated<Timestamp>;
}

export interface RegisterShifts {
  closed_at: Timestamp | null;
  closed_by: string | null;
  counted_cash_paise: Int8 | null;
  created_at: Generated<Timestamp>;
  denominations: Json | null;
  difference_paise: Int8 | null;
  expected_cash_paise: Int8 | null;
  id: Generated<string>;
  notes: string | null;
  opened_at: Generated<Timestamp>;
  opened_by: string;
  opening_cash_paise: Generated<Int8>;
  register_id: string;
  status: Generated<string>;
  store_id: string;
  summary: Json | null;
  tenant_id: string;
  updated_at: Generated<Timestamp>;
}

export interface RelayMessages {
  activation_id: string;
  attempts: Generated<number>;
  channel: string;
  client_ref: string;
  created_at: Generated<Timestamp>;
  error: string | null;
  error_kind: string | null;
  id: Generated<string>;
  license_id: string;
  locale: string;
  metered: Generated<boolean>;
  period: string;
  provider: string | null;
  provider_message_id: string | null;
  recipient: string;
  sent_at: Timestamp | null;
  status: Generated<string>;
  template_code: string;
  updated_at: Generated<Timestamp>;
}

export interface Releases {
  artifacts: Generated<Json>;
  channel: Generated<string>;
  created_at: Generated<Timestamp>;
  created_by: string | null;
  id: Generated<string>;
  is_active: Generated<boolean>;
  mandatory: Generated<boolean>;
  min_upgrade_from: string | null;
  notes_en: string;
  notes_ta: string | null;
  released_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
  version: string;
}

export interface Roles {
  code: string;
  created_at: Generated<Timestamp>;
  description: string | null;
  id: Generated<string>;
  is_system: Generated<boolean>;
  name: string;
  name_ta: string | null;
  permissions: Generated<string[]>;
  tenant_id: string;
  updated_at: Generated<Timestamp>;
}

export interface SalesInvoiceLines {
  batch_id: string | null;
  cess_paise: Generated<Int8>;
  cess_rate_bp: Generated<number>;
  cgst_paise: Generated<Int8>;
  cost_paise: Generated<Int8>;
  discount_bp: Generated<number>;
  discount_paise: Generated<Int8>;
  free_qty_milli: Generated<Int8>;
  gross_paise: Int8;
  gst_rate_bp: Generated<number>;
  hsn_code: string | null;
  id: Generated<string>;
  igst_paise: Generated<Int8>;
  invoice_id: string;
  line_no: number;
  meta: Generated<Json>;
  mrp_paise: Int8 | null;
  name: string;
  name_ta: string | null;
  pack_size: Generated<number>;
  product_id: string | null;
  promotion_id: string | null;
  qty_milli: Int8;
  returned_qty_milli: Generated<Int8>;
  serial_numbers: Generated<string[]>;
  sgst_paise: Generated<Int8>;
  taxable_paise: Int8;
  tenant_id: string;
  total_paise: Int8;
  unit: string;
  unit_cost_paise: Generated<Int8>;
  unit_price_paise: Int8;
}

export interface SalesInvoices {
  bill_discount_paise: Generated<Int8>;
  cancel_reason: string | null;
  cancelled_at: Timestamp | null;
  cancelled_by: string | null;
  cess_paise: Generated<Int8>;
  cgst_paise: Generated<Int8>;
  channel: Generated<string>;
  client_ref: string | null;
  completed_at: Timestamp | null;
  converted_to_id: string | null;
  cost_paise: Generated<Int8>;
  created_at: Generated<Timestamp>;
  created_by: string | null;
  customer_address: Json | null;
  customer_gstin: string | null;
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  customer_state_code: string | null;
  doc_type: Generated<string>;
  due_date: string | null;
  due_paise: Generated<Int8>;
  fy: string | null;
  gross_paise: Generated<Int8>;
  id: Generated<string>;
  igst_paise: Generated<Int8>;
  invoice_at: Generated<Timestamp>;
  invoice_date: string;
  is_interstate: Generated<boolean>;
  item_count: Generated<number>;
  item_discount_paise: Generated<Int8>;
  loyalty_points_earned: Generated<Int8>;
  loyalty_points_redeemed: Generated<Int8>;
  loyalty_redeem_paise: Generated<Int8>;
  notes: string | null;
  number: string | null;
  offline_created_at: Timestamp | null;
  paid_paise: Generated<Int8>;
  payment_status: Generated<string>;
  place_of_supply: string;
  price_includes_tax: Generated<boolean>;
  register_id: string | null;
  returned_paise: Generated<Int8>;
  reverse_charge: Generated<boolean>;
  round_off_paise: Generated<Int8>;
  rx: Json | null;
  salesperson_id: string | null;
  sgst_paise: Generated<Int8>;
  share_token: string | null;
  shift_id: string | null;
  status: Generated<string>;
  store_id: string;
  taxable_paise: Generated<Int8>;
  tenant_id: string;
  total_paise: Generated<Int8>;
  updated_at: Generated<Timestamp>;
}

export interface SchemaMigrations {
  applied_at: Generated<Timestamp>;
  checksum: string;
  name: string;
}

export interface ShiftCashEntries {
  account_id: string | null;
  amount_paise: Int8;
  created_at: Generated<Timestamp>;
  created_by: string | null;
  id: Generated<string>;
  kind: string;
  reason: string;
  shift_id: string;
  tenant_id: string;
}

export interface StockAdjustmentLines {
  adjustment_id: string;
  batch_id: string | null;
  counted_qty_milli: Int8 | null;
  id: Generated<string>;
  line_no: number;
  product_id: string;
  qty_delta_milli: Int8;
  reason: string | null;
  system_qty_milli: Int8 | null;
  tenant_id: string;
  unit_cost_paise: Generated<Int8>;
}

export interface StockAdjustments {
  adjustment_date: string;
  created_at: Generated<Timestamp>;
  created_by: string | null;
  fy: string | null;
  id: Generated<string>;
  kind: Generated<string>;
  notes: string | null;
  number: string | null;
  posted_at: Timestamp | null;
  posted_by: string | null;
  status: Generated<string>;
  store_id: string;
  tenant_id: string;
  total_value_paise: Generated<Int8>;
  updated_at: Generated<Timestamp>;
}

export interface StockLevels {
  avg_cost_paise: Generated<Int8>;
  batch_id: string | null;
  id: Generated<string>;
  last_movement_at: Timestamp | null;
  product_id: string;
  qty_milli: Generated<Int8>;
  store_id: string;
  tenant_id: string;
  updated_at: Generated<Timestamp>;
}

export interface StockMovements {
  balance_after_milli: Int8;
  batch_id: string | null;
  created_at: Generated<Timestamp>;
  created_by: string | null;
  id: Generated<string>;
  movement_type: string;
  product_id: string;
  qty_milli: Int8;
  reason: string | null;
  ref_id: string | null;
  ref_line_id: string | null;
  ref_type: string | null;
  store_id: string;
  tenant_id: string;
  unit_cost_paise: Int8 | null;
}

export interface StockTransferLines {
  batch_id: string | null;
  id: Generated<string>;
  line_no: number;
  product_id: string;
  qty_milli: Int8;
  received_qty_milli: Int8 | null;
  tenant_id: string;
  transfer_id: string;
  unit_cost_paise: Generated<Int8>;
}

export interface StockTransfers {
  created_at: Generated<Timestamp>;
  created_by: string | null;
  dispatched_at: Timestamp | null;
  dispatched_by: string | null;
  from_store_id: string;
  fy: string | null;
  id: Generated<string>;
  notes: string | null;
  number: string | null;
  received_at: Timestamp | null;
  received_by: string | null;
  status: Generated<string>;
  tenant_id: string;
  to_store_id: string;
  transfer_date: string;
  updated_at: Generated<Timestamp>;
}

export interface StoreProductPrices {
  mrp_paise: Int8 | null;
  product_id: string;
  sale_price_paise: Int8;
  store_id: string;
  tenant_id: string;
  updated_at: Generated<Timestamp>;
}

export interface Stores {
  address: Generated<Json>;
  code: string;
  created_at: Generated<Timestamp>;
  drug_license_numbers: string | null;
  email: string | null;
  fssai_number: string | null;
  gstin: string | null;
  id: Generated<string>;
  is_active: Generated<boolean>;
  name: string;
  name_ta: string | null;
  phone: string | null;
  settings: Generated<Json>;
  state_code: string;
  tenant_id: string;
  updated_at: Generated<Timestamp>;
}

export interface Subscriptions {
  billing_cycle: Generated<string>;
  cancel_at_period_end: Generated<boolean>;
  created_at: Generated<Timestamp>;
  current_period_end: Timestamp;
  current_period_start: Timestamp;
  id: Generated<string>;
  limit_overrides: Generated<Json>;
  plan_code: string;
  provider: string | null;
  provider_customer_id: string | null;
  provider_subscription_id: string | null;
  status: string;
  tenant_id: string;
  trial_ends_at: Timestamp | null;
  updated_at: Generated<Timestamp>;
}

export interface Suppliers {
  address: Generated<Json>;
  balance_paise: Generated<Int8>;
  bank_details: Generated<Json>;
  code: string | null;
  contact_person: string | null;
  created_at: Generated<Timestamp>;
  created_by: string | null;
  drug_license_no: string | null;
  email: string | null;
  gstin: string | null;
  id: Generated<string>;
  is_active: Generated<boolean>;
  name: string;
  notes: string | null;
  opening_balance_paise: Generated<Int8>;
  pan: string | null;
  payment_terms_days: number | null;
  phone: string | null;
  state_code: string | null;
  tenant_id: string;
  updated_at: Generated<Timestamp>;
  upi_vpa: string | null;
}

export interface SystemSettings {
  key: string;
  updated_at: Generated<Timestamp>;
  value: Json;
}

export interface TaxSlabRules {
  created_at: Generated<Timestamp>;
  description: string | null;
  id: Generated<string>;
  is_active: Generated<boolean>;
  name: string;
  slabs: Json;
  tenant_id: string;
  updated_at: Generated<Timestamp>;
}

export interface Tenants {
  address: Generated<Json>;
  business_type: string;
  created_at: Generated<Timestamp>;
  default_locale: Generated<string>;
  email: string | null;
  fy_start_month: Generated<number>;
  gst_scheme: Generated<string>;
  gstin: string | null;
  id: Generated<string>;
  legal_name: string | null;
  logo_file_id: string | null;
  name: string;
  name_ta: string | null;
  pan: string | null;
  phone: string | null;
  plan_code: Generated<string>;
  settings: Generated<Json>;
  slug: string | null;
  state_code: Generated<string>;
  status: Generated<string>;
  suspended_reason: string | null;
  timezone: Generated<string>;
  updated_at: Generated<Timestamp>;
}

export interface UsageCounters {
  metric: string;
  period: string;
  tenant_id: string;
  updated_at: Generated<Timestamp>;
  value: Generated<Int8>;
}

export interface Users {
  created_at: Generated<Timestamp>;
  email: string | null;
  failed_login_count: Generated<number>;
  full_name: string;
  id: Generated<string>;
  is_platform_admin: Generated<boolean>;
  last_login_at: Timestamp | null;
  locked_until: Timestamp | null;
  password_changed_at: Timestamp | null;
  password_hash: string | null;
  phone: string | null;
  preferred_locale: Generated<string>;
  status: Generated<string>;
  updated_at: Generated<Timestamp>;
}

export interface VendorCustomers {
  address: Generated<Json>;
  business_name: string;
  business_name_ta: string | null;
  business_type: string;
  created_at: Generated<Timestamp>;
  created_by: string | null;
  district: string | null;
  email: string | null;
  gstin: string | null;
  id: Generated<string>;
  name: string;
  notes: string | null;
  partner_id: string | null;
  phone: string;
  referral_code: string | null;
  referred_by_customer_id: string | null;
  state_code: Generated<string>;
  tags: Generated<string[]>;
  tenant_id: string | null;
  updated_at: Generated<Timestamp>;
}

export interface VendorIdempotencyKeys {
  created_at: Generated<Timestamp>;
  expires_at: Generated<Timestamp>;
  key: string;
  method: string;
  path: string;
  request_hash: string;
  response_body: Json | null;
  response_status: number | null;
  status: Generated<string>;
  user_id: string;
}

export interface VendorOrders {
  buyer_gstin: string | null;
  cancel_reason: string | null;
  cancelled_at: Timestamp | null;
  cgst_paise: Generated<Int8>;
  coupon_code: string | null;
  created_at: Generated<Timestamp>;
  created_by: string | null;
  customer_id: string | null;
  discount_paise: Generated<Int8>;
  fulfilled_at: Timestamp | null;
  fulfilment: Json | null;
  id: Generated<string>;
  igst_paise: Generated<Int8>;
  invoice_date: string | null;
  kind: string;
  license_id: string | null;
  lines: Json;
  notes: string | null;
  number: string | null;
  offer_ids: Generated<string[]>;
  paid_amount_paise: Int8 | null;
  paid_at: Timestamp | null;
  partner_id: string | null;
  payment_link_expires_at: Timestamp | null;
  payment_provider: string | null;
  payment_ref: string | null;
  place_of_supply: string;
  quote: Json | null;
  refund_reason: string | null;
  refund_ref: string | null;
  refunded_at: Timestamp | null;
  sgst_paise: Generated<Int8>;
  short_url: string | null;
  status: Generated<string>;
  subtotal_paise: Int8;
  taxable_paise: Int8;
  tenant_id: string | null;
  total_paise: Int8;
  updated_at: Generated<Timestamp>;
}

export interface DB {
  accounts: Accounts;
  announcements: Announcements;
  api_keys: ApiKeys;
  audit_logs: AuditLogs;
  auth_sessions: AuthSessions;
  backups: Backups;
  batches: Batches;
  brands: Brands;
  categories: Categories;
  cloud_backups: CloudBackups;
  credit_note_lines: CreditNoteLines;
  credit_notes: CreditNotes;
  customers: Customers;
  debit_note_lines: DebitNoteLines;
  debit_notes: DebitNotes;
  devices: Devices;
  doctors: Doctors;
  expenses: Expenses;
  files: Files;
  idempotency_keys: IdempotencyKeys;
  imports: Imports;
  installation_snapshots: InstallationSnapshots;
  journal_entries: JournalEntries;
  journal_lines: JournalLines;
  license_activations: LicenseActivations;
  license_events: LicenseEvents;
  license_products: LicenseProducts;
  license_reminders: LicenseReminders;
  licenses: Licenses;
  licensing_request_nonces: LicensingRequestNonces;
  loyalty_ledger: LoyaltyLedger;
  memberships: Memberships;
  notification_templates: NotificationTemplates;
  notifications: Notifications;
  number_series: NumberSeries;
  offer_redemptions: OfferRedemptions;
  offers: Offers;
  otp_codes: OtpCodes;
  partner_commissions: PartnerCommissions;
  partners: Partners;
  payment_allocations: PaymentAllocations;
  payment_intents: PaymentIntents;
  payment_provider_accounts: PaymentProviderAccounts;
  payment_webhook_events: PaymentWebhookEvents;
  payments: Payments;
  plans: Plans;
  platform_audit_logs: PlatformAuditLogs;
  platform_invoices: PlatformInvoices;
  platform_staff: PlatformStaff;
  product_barcodes: ProductBarcodes;
  products: Products;
  promotions: Promotions;
  purchase_bill_lines: PurchaseBillLines;
  purchase_bills: PurchaseBills;
  purchase_order_lines: PurchaseOrderLines;
  purchase_orders: PurchaseOrders;
  register_shifts: RegisterShifts;
  registers: Registers;
  relay_messages: RelayMessages;
  releases: Releases;
  roles: Roles;
  sales_invoice_lines: SalesInvoiceLines;
  sales_invoices: SalesInvoices;
  schema_migrations: SchemaMigrations;
  shift_cash_entries: ShiftCashEntries;
  stock_adjustment_lines: StockAdjustmentLines;
  stock_adjustments: StockAdjustments;
  stock_levels: StockLevels;
  stock_movements: StockMovements;
  stock_transfer_lines: StockTransferLines;
  stock_transfers: StockTransfers;
  store_product_prices: StoreProductPrices;
  stores: Stores;
  subscriptions: Subscriptions;
  suppliers: Suppliers;
  system_settings: SystemSettings;
  tax_slab_rules: TaxSlabRules;
  tenants: Tenants;
  usage_counters: UsageCounters;
  users: Users;
  vendor_customers: VendorCustomers;
  vendor_idempotency_keys: VendorIdempotencyKeys;
  vendor_orders: VendorOrders;
}
