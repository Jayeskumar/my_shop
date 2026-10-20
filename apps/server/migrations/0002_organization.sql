-- =============================================================================
-- Kadai — 0002 organization: roles, memberships, stores, registers, devices,
-- numbering, idempotency, audit, files, API keys, subscriptions & usage
-- =============================================================================

CREATE TABLE roles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code         text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  name         text NOT NULL,
  name_ta      text,
  description  text,
  permissions  text[] NOT NULL DEFAULT '{}',
  is_system    boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE stores (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code                  text NOT NULL CHECK (code ~ '^[A-Z0-9]{1,4}$'),
  name                  text NOT NULL,
  name_ta               text,
  gstin                 text CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  state_code            text NOT NULL CHECK (state_code ~ '^[0-9]{2}$'),
  address               jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {line1,line2,city,district,state,pincode}
  phone                 text,
  email                 citext,
  drug_license_numbers  text,      -- pharmacy: Form 20/21 numbers printed on invoice
  fssai_number          text,      -- food business licence
  is_active             boolean NOT NULL DEFAULT true,
  settings              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE registers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id      uuid NOT NULL,
  code          text NOT NULL CHECK (code ~ '^[A-Z0-9]{1,2}$'),
  name          text NOT NULL,
  is_active     boolean NOT NULL DEFAULT true,
  settings      jsonb NOT NULL DEFAULT '{}'::jsonb,   -- printer width, customer display, cash drawer
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, store_id, code),
  FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id)
);

CREATE TABLE memberships (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id        uuid NOT NULL,
  store_ids      uuid[],                 -- NULL = all stores
  pos_pin_hash   text,                   -- quick-switch PIN on trusted devices
  pin_failed_count integer NOT NULL DEFAULT 0,
  pin_locked_until timestamptz,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invited', 'disabled')),
  invited_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, user_id),
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);

-- users RLS (needs memberships)
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_visible ON users FOR SELECT
  USING (id = current_app_user_id()
         OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id));
CREATE POLICY users_self_update ON users FOR UPDATE
  USING (id = current_app_user_id())
  WITH CHECK (id = current_app_user_id());

-- Trusted POS devices (a browser/PC approved by a manager). Enables PIN login
-- and binds offline invoice numbering to a register.
CREATE TABLE devices (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id            uuid NOT NULL,
  register_id         uuid,
  name                text NOT NULL,
  device_secret_hash  text NOT NULL,
  user_agent          text,
  is_active           boolean NOT NULL DEFAULT true,
  approved_by         uuid REFERENCES users(id),
  last_seen_at        timestamptz,
  revoked_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id),
  FOREIGN KEY (tenant_id, register_id) REFERENCES registers (tenant_id, id)
);

-- Gapless document numbering per (store, register?, doc type, financial year).
-- Allocation: UPDATE ... SET next_number = next_number + 1 RETURNING (row lock).
CREATE TABLE number_series (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id     uuid NOT NULL,
  register_id  uuid,
  doc_type     text NOT NULL CHECK (doc_type IN (
                 'sales_invoice', 'bill_of_supply', 'credit_note', 'estimate', 'sales_order',
                 'receipt', 'payment_voucher', 'purchase_order', 'purchase_bill', 'debit_note',
                 'stock_adjustment', 'stock_transfer', 'expense', 'journal')),
  fy           text NOT NULL CHECK (fy ~ '^[0-9]{4}-[0-9]{2}$'),     -- '2026-27'
  prefix       text NOT NULL,                                        -- rendered, e.g. 'S1A/2627/'
  next_number  bigint NOT NULL DEFAULT 1 CHECK (next_number >= 1),
  padding      smallint NOT NULL DEFAULT 5 CHECK (padding BETWEEN 1 AND 10),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE NULLS NOT DISTINCT (tenant_id, store_id, register_id, doc_type, fy),
  FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id),
  FOREIGN KEY (tenant_id, register_id) REFERENCES registers (tenant_id, id)
);

-- Idempotent POSTs (double-click protection, offline POS sync, webhooks->API)
CREATE TABLE idempotency_keys (
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key              text NOT NULL CHECK (length(key) BETWEEN 8 AND 200),
  method           text NOT NULL,
  path             text NOT NULL,
  request_hash     text NOT NULL,
  status           text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed')),
  response_status  integer,
  response_body    jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL DEFAULT now() + interval '7 days',
  PRIMARY KEY (tenant_id, key)
);
CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);

-- Tenant audit trail (append-only)
CREATE TABLE audit_logs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id      uuid REFERENCES users(id),
  action       text NOT NULL,            -- e.g. 'sales_invoice.cancel'
  entity_type  text,
  entity_id    uuid,
  summary      text,
  changes      jsonb,                    -- {before:{}, after:{}} or arbitrary details
  ip           inet,
  user_agent   text,
  request_id   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_tenant_time_idx ON audit_logs (tenant_id, created_at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs (tenant_id, entity_type, entity_id);
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Uploaded files (logos, product images, prescriptions, imports, backups)
CREATE TABLE files (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  purpose        text NOT NULL CHECK (purpose IN ('logo', 'product_image', 'prescription', 'import', 'export', 'attachment')),
  filename       text NOT NULL,
  content_type   text NOT NULL,
  size_bytes     bigint NOT NULL CHECK (size_bytes >= 0),
  checksum_sha256 text NOT NULL,
  storage        text NOT NULL CHECK (storage IN ('local', 's3')),
  storage_key    text NOT NULL,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

-- Bulk imports (CSV/XLSX) tracking
CREATE TABLE imports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('products', 'customers', 'suppliers', 'opening_stock', 'opening_balances')),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'validating', 'processing', 'completed', 'failed')),
  file_id       uuid,
  store_id      uuid,
  options       jsonb NOT NULL DEFAULT '{}'::jsonb,
  total_rows    integer NOT NULL DEFAULT 0,
  success_rows  integer NOT NULL DEFAULT 0,
  error_rows    integer NOT NULL DEFAULT 0,
  errors        jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{row, field, message}]
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, file_id) REFERENCES files (tenant_id, id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id)
);

-- Enterprise API access (server-to-server integrations)
CREATE TABLE api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          text NOT NULL,
  key_prefix    text NOT NULL UNIQUE,     -- first chars shown in UI, used for lookup
  key_hash      text NOT NULL,
  permissions   text[] NOT NULL DEFAULT '{}',
  store_ids     uuid[],
  last_used_at  timestamptz,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

-- SaaS subscription of a tenant (cloud mode). On-prem entitlements come from the license file.
CREATE TABLE subscriptions (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_code                 text NOT NULL REFERENCES plans(code),
  status                    text NOT NULL CHECK (status IN ('trialing', 'active', 'past_due', 'cancelled', 'expired')),
  billing_cycle             text NOT NULL DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly', 'yearly')),
  current_period_start      timestamptz NOT NULL,
  current_period_end        timestamptz NOT NULL,
  trial_ends_at             timestamptz,
  cancel_at_period_end      boolean NOT NULL DEFAULT false,
  provider                  text CHECK (provider IN ('razorpay', 'manual')),
  provider_subscription_id  text,
  provider_customer_id      text,
  limit_overrides           jsonb NOT NULL DEFAULT '{}'::jsonb,   -- enterprise custom limits
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX subscriptions_one_live_idx ON subscriptions (tenant_id)
  WHERE status IN ('trialing', 'active', 'past_due');

CREATE TABLE usage_counters (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  metric      text NOT NULL,                       -- 'invoices', 'sms', 'whatsapp'
  period      text NOT NULL CHECK (period ~ '^[0-9]{4}-[0-9]{2}$'),
  value       bigint NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, metric, period)
);

-- Invoices the SaaS vendor issues to tenants (system pool only)
CREATE TABLE platform_invoices (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id       uuid REFERENCES subscriptions(id),
  number                text NOT NULL UNIQUE,
  period_start          date NOT NULL,
  period_end            date NOT NULL,
  plan_code             text NOT NULL REFERENCES plans(code),
  taxable_paise         bigint NOT NULL,
  cgst_paise            bigint NOT NULL DEFAULT 0,
  sgst_paise            bigint NOT NULL DEFAULT 0,
  igst_paise            bigint NOT NULL DEFAULT 0,
  total_paise           bigint NOT NULL,
  status                text NOT NULL DEFAULT 'issued' CHECK (status IN ('draft', 'issued', 'paid', 'void')),
  provider_invoice_id   text,
  provider_payment_id   text,
  paid_at               timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
