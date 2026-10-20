-- =============================================================================
-- Kadai — 0006 sales, register shifts, payments & UPI
-- Sales document totals (all paise):
--   gross    = Σ line gross (qty × unit price as entered; inclusive/exclusive per flag)
--   discount = Σ line discounts + bill-level discount (allocated to lines pro-rata)
--   taxable  = Σ line taxable values (GST is charged on net-of-discount value)
--   tax      = cgst + sgst + igst + cess
--   total    = taxable + tax + round_off      (amount payable)
-- =============================================================================

CREATE TABLE register_shifts (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id                    uuid NOT NULL,
  register_id                 uuid NOT NULL,
  status                      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  opened_by                   uuid NOT NULL REFERENCES users(id),
  opened_at                   timestamptz NOT NULL DEFAULT now(),
  opening_cash_paise          bigint NOT NULL DEFAULT 0 CHECK (opening_cash_paise >= 0),
  closed_by                   uuid REFERENCES users(id),
  closed_at                   timestamptz,
  expected_cash_paise         bigint,
  counted_cash_paise          bigint,
  difference_paise            bigint,
  denominations               jsonb,       -- {"2000":0,"500":4,"200":3,"100":10,"50":2,"20":5,"10":8,"coins":1250}
  summary                     jsonb,       -- totals by payment method, bills count etc. captured at close
  notes                       text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id),
  FOREIGN KEY (tenant_id, register_id) REFERENCES registers (tenant_id, id)
);
CREATE UNIQUE INDEX register_shifts_one_open_uq ON register_shifts (tenant_id, register_id) WHERE status = 'open';

CREATE TABLE shift_cash_entries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shift_id     uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('pay_in', 'pay_out')),
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  account_id   uuid,             -- counter account (drawings, expense, bank deposit)
  reason       text NOT NULL,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, shift_id) REFERENCES register_shifts (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts (tenant_id, id)
);

ALTER TABLE expenses ADD FOREIGN KEY (tenant_id, shift_id) REFERENCES register_shifts (tenant_id, id);

-- -----------------------------------------------------------------------------
-- Sales invoices (also held bills & estimates via doc_type/status)
-- -----------------------------------------------------------------------------
CREATE TABLE sales_invoices (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id                 uuid NOT NULL,
  register_id              uuid,
  shift_id                 uuid,
  doc_type                 text NOT NULL DEFAULT 'tax_invoice' CHECK (doc_type IN ('tax_invoice', 'bill_of_supply', 'estimate')),
  number                   text,             -- assigned on completion (NULL while draft/held)
  fy                       text,
  invoice_date             date NOT NULL,
  invoice_at               timestamptz NOT NULL DEFAULT now(),
  due_date                 date,
  status                   text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'held', 'completed', 'cancelled', 'converted')),
  channel                  text NOT NULL DEFAULT 'pos' CHECK (channel IN ('pos', 'backoffice', 'online', 'whatsapp', 'api')),
  -- billing party snapshot (customer_id NULL = walk-in)
  customer_id              uuid,
  customer_name            text,
  customer_phone           text,
  customer_gstin           text,
  customer_address         jsonb,
  customer_state_code      text,
  place_of_supply          text NOT NULL CHECK (place_of_supply ~ '^[0-9]{2}$'),
  is_interstate            boolean NOT NULL DEFAULT false,
  reverse_charge           boolean NOT NULL DEFAULT false,
  price_includes_tax       boolean NOT NULL DEFAULT true,
  -- totals
  gross_paise              bigint NOT NULL DEFAULT 0,
  item_discount_paise      bigint NOT NULL DEFAULT 0,
  bill_discount_paise      bigint NOT NULL DEFAULT 0,
  taxable_paise            bigint NOT NULL DEFAULT 0,
  cgst_paise               bigint NOT NULL DEFAULT 0,
  sgst_paise               bigint NOT NULL DEFAULT 0,
  igst_paise               bigint NOT NULL DEFAULT 0,
  cess_paise               bigint NOT NULL DEFAULT 0,
  round_off_paise          bigint NOT NULL DEFAULT 0 CHECK (round_off_paise BETWEEN -99 AND 99),
  total_paise              bigint NOT NULL DEFAULT 0 CHECK (total_paise >= 0),
  cost_paise               bigint NOT NULL DEFAULT 0,           -- COGS
  paid_paise               bigint NOT NULL DEFAULT 0,
  returned_paise           bigint NOT NULL DEFAULT 0,           -- credit notes issued against it
  due_paise                bigint NOT NULL DEFAULT 0,
  payment_status           text NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'partial', 'paid', 'refunded')),
  item_count               integer NOT NULL DEFAULT 0,
  -- loyalty
  loyalty_points_earned    bigint NOT NULL DEFAULT 0,
  loyalty_points_redeemed  bigint NOT NULL DEFAULT 0,
  loyalty_redeem_paise     bigint NOT NULL DEFAULT 0,
  -- pharmacy prescription details {doctor_id, doctor_name, doctor_reg_no, patient_name, patient_age, patient_address, prescription_file_id}
  rx                       jsonb,
  salesperson_id           uuid REFERENCES users(id),
  notes                    text,
  share_token              text UNIQUE,
  client_ref               text,             -- POS-generated id for idempotent/offline sync
  offline_created_at       timestamptz,
  converted_to_id          uuid,             -- estimate -> invoice
  completed_at             timestamptz,
  cancelled_at             timestamptz,
  cancelled_by             uuid REFERENCES users(id),
  cancel_reason            text,
  created_by               uuid REFERENCES users(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, doc_type, fy, number),
  UNIQUE (tenant_id, client_ref),
  FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id),
  FOREIGN KEY (tenant_id, register_id) REFERENCES registers (tenant_id, id),
  FOREIGN KEY (tenant_id, shift_id) REFERENCES register_shifts (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, converted_to_id) REFERENCES sales_invoices (tenant_id, id),
  CHECK (status NOT IN ('completed', 'cancelled') OR number IS NOT NULL),
  CHECK (total_paise = taxable_paise + cgst_paise + sgst_paise + igst_paise + cess_paise + round_off_paise),
  CHECK (NOT is_interstate OR (cgst_paise = 0 AND sgst_paise = 0)),
  CHECK (is_interstate OR igst_paise = 0)
);
CREATE INDEX sales_invoices_date_idx ON sales_invoices (tenant_id, invoice_date DESC) WHERE status = 'completed';
CREATE INDEX sales_invoices_store_date_idx ON sales_invoices (tenant_id, store_id, invoice_date DESC);
CREATE INDEX sales_invoices_customer_idx ON sales_invoices (tenant_id, customer_id, invoice_date DESC) WHERE customer_id IS NOT NULL;
CREATE INDEX sales_invoices_due_idx ON sales_invoices (tenant_id, due_paise) WHERE due_paise > 0 AND status = 'completed';
CREATE INDEX sales_invoices_held_idx ON sales_invoices (tenant_id, store_id) WHERE status = 'held';

CREATE TABLE sales_invoice_lines (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id           uuid NOT NULL,
  line_no              integer NOT NULL CHECK (line_no >= 1),
  product_id           uuid,               -- NULL for ad-hoc items
  batch_id             uuid,
  name                 text NOT NULL,
  name_ta              text,
  hsn_code             text,
  unit                 text NOT NULL,
  pack_size            integer NOT NULL DEFAULT 1 CHECK (pack_size >= 1),
  qty_milli            bigint NOT NULL CHECK (qty_milli > 0),
  free_qty_milli       bigint NOT NULL DEFAULT 0 CHECK (free_qty_milli >= 0),
  mrp_paise            bigint,
  unit_price_paise     bigint NOT NULL CHECK (unit_price_paise >= 0),   -- per pack, as entered
  discount_bp          integer NOT NULL DEFAULT 0 CHECK (discount_bp BETWEEN 0 AND 10000),
  discount_paise       bigint NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),  -- item + allocated bill discount
  gross_paise          bigint NOT NULL,
  taxable_paise        bigint NOT NULL,
  gst_rate_bp          integer NOT NULL DEFAULT 0,
  cgst_paise           bigint NOT NULL DEFAULT 0,
  sgst_paise           bigint NOT NULL DEFAULT 0,
  igst_paise           bigint NOT NULL DEFAULT 0,
  cess_rate_bp         integer NOT NULL DEFAULT 0,
  cess_paise           bigint NOT NULL DEFAULT 0,
  total_paise          bigint NOT NULL,
  unit_cost_paise      bigint NOT NULL DEFAULT 0,   -- per pack at time of sale
  cost_paise           bigint NOT NULL DEFAULT 0,
  promotion_id         uuid,
  returned_qty_milli   bigint NOT NULL DEFAULT 0 CHECK (returned_qty_milli >= 0),
  serial_numbers       text[] NOT NULL DEFAULT '{}',
  meta                 jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {size,color} / {schedule:'H1'} / weighed barcode raw
  UNIQUE (tenant_id, id),
  UNIQUE (invoice_id, line_no),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES sales_invoices (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES batches (tenant_id, id),
  FOREIGN KEY (tenant_id, promotion_id) REFERENCES promotions (tenant_id, id),
  CHECK (returned_qty_milli <= qty_milli + free_qty_milli),
  CHECK (total_paise = taxable_paise + cgst_paise + sgst_paise + igst_paise + cess_paise)
);
CREATE INDEX sales_invoice_lines_invoice_idx ON sales_invoice_lines (tenant_id, invoice_id);
CREATE INDEX sales_invoice_lines_product_idx ON sales_invoice_lines (tenant_id, product_id);

-- Sales returns / credit notes
CREATE TABLE credit_notes (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id             uuid NOT NULL,
  register_id          uuid,
  shift_id             uuid,
  number               text NOT NULL,
  fy                   text NOT NULL,
  note_date            date NOT NULL,
  invoice_id           uuid,                -- original invoice (required for GST credit notes on registered sales)
  customer_id          uuid,
  customer_name        text,
  customer_phone       text,
  customer_gstin       text,
  customer_state_code  text,
  place_of_supply      text NOT NULL CHECK (place_of_supply ~ '^[0-9]{2}$'),
  is_interstate        boolean NOT NULL DEFAULT false,
  reason               text NOT NULL CHECK (reason IN ('return', 'damaged', 'expired', 'price_adjustment', 'other')),
  status               text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'cancelled')),
  taxable_paise        bigint NOT NULL DEFAULT 0,
  cgst_paise           bigint NOT NULL DEFAULT 0,
  sgst_paise           bigint NOT NULL DEFAULT 0,
  igst_paise           bigint NOT NULL DEFAULT 0,
  cess_paise           bigint NOT NULL DEFAULT 0,
  round_off_paise      bigint NOT NULL DEFAULT 0,
  total_paise          bigint NOT NULL DEFAULT 0 CHECK (total_paise >= 0),
  cost_paise           bigint NOT NULL DEFAULT 0,
  -- how the value goes back to the customer
  settlement           text NOT NULL CHECK (settlement IN ('cash', 'upi', 'bank_transfer', 'adjust_due', 'store_credit')),
  settled_paise        bigint NOT NULL DEFAULT 0,
  restock              boolean NOT NULL DEFAULT true,
  notes                text,
  client_ref           text,
  cancelled_at         timestamptz,
  cancelled_by         uuid REFERENCES users(id),
  cancel_reason        text,
  created_by           uuid REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, fy, number),
  UNIQUE (tenant_id, client_ref),
  FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id),
  FOREIGN KEY (tenant_id, register_id) REFERENCES registers (tenant_id, id),
  FOREIGN KEY (tenant_id, shift_id) REFERENCES register_shifts (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES sales_invoices (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  CHECK (total_paise = taxable_paise + cgst_paise + sgst_paise + igst_paise + cess_paise + round_off_paise)
);
CREATE INDEX credit_notes_date_idx ON credit_notes (tenant_id, note_date DESC);
CREATE INDEX credit_notes_invoice_idx ON credit_notes (tenant_id, invoice_id);

CREATE TABLE credit_note_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  credit_note_id    uuid NOT NULL,
  line_no           integer NOT NULL,
  invoice_line_id   uuid,
  product_id        uuid,
  batch_id          uuid,
  name              text NOT NULL,
  hsn_code          text,
  unit              text NOT NULL,
  pack_size         integer NOT NULL DEFAULT 1,
  qty_milli         bigint NOT NULL CHECK (qty_milli > 0),
  unit_price_paise  bigint NOT NULL,
  taxable_paise     bigint NOT NULL,
  gst_rate_bp       integer NOT NULL DEFAULT 0,
  cgst_paise        bigint NOT NULL DEFAULT 0,
  sgst_paise        bigint NOT NULL DEFAULT 0,
  igst_paise        bigint NOT NULL DEFAULT 0,
  cess_rate_bp      integer NOT NULL DEFAULT 0,
  cess_paise        bigint NOT NULL DEFAULT 0,
  total_paise       bigint NOT NULL,
  unit_cost_paise   bigint NOT NULL DEFAULT 0,
  cost_paise        bigint NOT NULL DEFAULT 0,
  restock           boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  UNIQUE (credit_note_id, line_no),
  FOREIGN KEY (tenant_id, credit_note_id) REFERENCES credit_notes (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, invoice_line_id) REFERENCES sales_invoice_lines (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES batches (tenant_id, id),
  CHECK (total_paise = taxable_paise + cgst_paise + sgst_paise + igst_paise + cess_paise)
);

-- -----------------------------------------------------------------------------
-- Payment providers & UPI
-- -----------------------------------------------------------------------------
CREATE TABLE payment_provider_accounts (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id                uuid,                     -- NULL = all stores
  provider                text NOT NULL CHECK (provider IN ('upi_vpa', 'razorpay', 'cashfree', 'phonepe', 'paytm', 'mock')),
  display_name            text NOT NULL,
  mode                    text NOT NULL DEFAULT 'live' CHECK (mode IN ('test', 'live')),
  vpa                     text CHECK (vpa IS NULL OR vpa ~ '^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,64}$'),
  payee_name              text,
  merchant_code           text,                     -- MCC for UPI intent (e.g. 5411 grocery, 5912 pharmacy)
  credentials_encrypted   text,                     -- AES-256-GCM envelope (key id + iv + tag + ciphertext), never returned by API
  webhook_secret_encrypted text,
  settlement_account_id   uuid,                     -- ledger (bank) account receiving funds
  is_default              boolean NOT NULL DEFAULT false,
  is_active               boolean NOT NULL DEFAULT true,
  last_verified_at        timestamptz,
  created_by              uuid REFERENCES users(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id),
  FOREIGN KEY (tenant_id, settlement_account_id) REFERENCES accounts (tenant_id, id),
  CHECK (provider <> 'upi_vpa' OR vpa IS NOT NULL)
);
CREATE UNIQUE INDEX payment_provider_accounts_default_uq
  ON payment_provider_accounts (tenant_id, coalesce(store_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE is_default AND is_active;

CREATE TABLE payment_intents (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id               uuid NOT NULL,
  register_id            uuid,
  provider_account_id    uuid NOT NULL,
  provider               text NOT NULL,
  kind                   text NOT NULL DEFAULT 'qr' CHECK (kind IN ('qr', 'link', 'collect')),
  purpose                text NOT NULL CHECK (purpose IN ('pos_sale', 'invoice_due', 'customer_due', 'advance')),
  ref_type               text,                    -- 'sales_invoice' | 'customer' | 'pos_cart'
  ref_id                 uuid,
  customer_id            uuid,
  reference_code         text NOT NULL,           -- short unique code sent as UPI `tr` / provider receipt
  amount_paise           bigint NOT NULL CHECK (amount_paise > 0),
  currency               text NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  status                 text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'pending', 'paid', 'failed', 'expired', 'cancelled')),
  upi_uri                text,                    -- upi://pay?... (rendered to QR client-side)
  short_url              text,                    -- payment link
  provider_ref           text,                    -- provider QR id / link id / order id
  provider_payment_id    text,
  payer_vpa              text,
  payer_name             text,
  utr                    text,                    -- bank RRN / UTR
  paid_amount_paise      bigint,
  fee_paise              bigint,
  confirmation           text CHECK (confirmation IN ('webhook', 'poll', 'manual', 'sync')),
  confirmed_by           uuid REFERENCES users(id),
  payment_id             uuid,                    -- resulting payments row
  expires_at             timestamptz,
  paid_at                timestamptz,
  last_polled_at         timestamptz,
  poll_count             integer NOT NULL DEFAULT 0,
  failure_reason         text,
  metadata               jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key        text,
  created_by             uuid REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, reference_code),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id),
  FOREIGN KEY (tenant_id, register_id) REFERENCES registers (tenant_id, id),
  FOREIGN KEY (tenant_id, provider_account_id) REFERENCES payment_provider_accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id)
);
CREATE UNIQUE INDEX payment_intents_provider_ref_uq ON payment_intents (provider, provider_ref) WHERE provider_ref IS NOT NULL;
CREATE INDEX payment_intents_open_idx ON payment_intents (status, last_polled_at) WHERE status IN ('created', 'pending');
CREATE INDEX payment_intents_ref_idx ON payment_intents (tenant_id, ref_type, ref_id);

-- Raw provider webhooks (system pool only). Dedup on provider event id.
CREATE TABLE payment_webhook_events (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider             text NOT NULL,
  provider_account_id  uuid,
  tenant_id            uuid REFERENCES tenants(id) ON DELETE CASCADE,
  event_id             text NOT NULL,
  event_type           text NOT NULL,
  signature_valid      boolean NOT NULL,
  payload              jsonb NOT NULL,
  received_at          timestamptz NOT NULL DEFAULT now(),
  processed_at         timestamptz,
  processing_error     text,
  attempts             integer NOT NULL DEFAULT 0,
  UNIQUE (provider, event_id)
);

-- Money in/out (receipts, POS tenders, refunds, supplier payments)
CREATE TABLE payments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id           uuid NOT NULL,
  register_id        uuid,
  shift_id           uuid,
  number             text,                   -- receipt / voucher number for standalone payments
  fy                 text,
  direction          text NOT NULL CHECK (direction IN ('in', 'out')),
  party_type         text CHECK (party_type IN ('customer', 'supplier')),
  party_id           uuid,
  method             text NOT NULL CHECK (method IN ('cash', 'upi', 'card', 'bank_transfer', 'cheque', 'wallet', 'store_credit', 'other')),
  amount_paise       bigint NOT NULL CHECK (amount_paise > 0),
  status             text NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'failed', 'cancelled')),
  payment_date       date NOT NULL,
  paid_at            timestamptz NOT NULL DEFAULT now(),
  reference          text,                   -- UTR / RRN / cheque no / card approval code
  payment_intent_id  uuid,
  account_id         uuid NOT NULL,          -- cash/bank/clearing ledger account debited (in) or credited (out)
  unallocated_paise  bigint NOT NULL DEFAULT 0 CHECK (unallocated_paise >= 0),   -- advance / on-account
  notes              text,
  client_ref         text,
  cancelled_at       timestamptz,
  cancelled_by       uuid REFERENCES users(id),
  cancel_reason      text,
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, fy, number),
  UNIQUE (tenant_id, client_ref),
  FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id),
  FOREIGN KEY (tenant_id, register_id) REFERENCES registers (tenant_id, id),
  FOREIGN KEY (tenant_id, shift_id) REFERENCES register_shifts (tenant_id, id),
  FOREIGN KEY (tenant_id, payment_intent_id) REFERENCES payment_intents (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts (tenant_id, id),
  CHECK ((party_type IS NULL) = (party_id IS NULL)),
  CHECK (unallocated_paise <= amount_paise)
);
CREATE INDEX payments_date_idx ON payments (tenant_id, payment_date DESC);
CREATE INDEX payments_party_idx ON payments (tenant_id, party_type, party_id, payment_date DESC) WHERE party_id IS NOT NULL;
CREATE INDEX payments_shift_idx ON payments (tenant_id, shift_id) WHERE shift_id IS NOT NULL;

ALTER TABLE payment_intents ADD FOREIGN KEY (tenant_id, payment_id) REFERENCES payments (tenant_id, id);

CREATE TABLE payment_allocations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  payment_id   uuid NOT NULL,
  target_type  text NOT NULL CHECK (target_type IN ('sales_invoice', 'purchase_bill', 'credit_note', 'debit_note', 'expense', 'opening_balance')),
  target_id    uuid,
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES payments (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX payment_allocations_target_idx ON payment_allocations (tenant_id, target_type, target_id);
CREATE INDEX payment_allocations_payment_idx ON payment_allocations (tenant_id, payment_id);
