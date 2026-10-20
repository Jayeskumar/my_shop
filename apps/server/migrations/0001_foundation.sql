-- =============================================================================
-- Kadai — 0001 foundation: extensions, helper functions, platform & identity
-- -----------------------------------------------------------------------------
-- Conventions (see docs/ARCHITECTURE.md §Database):
--   * Every tenant-owned table has `tenant_id uuid NOT NULL` and UNIQUE(tenant_id, id)
--     so that child tables can use composite foreign keys (tenant_id, x_id) which
--     makes cross-tenant references impossible even though FK checks bypass RLS.
--   * Money is BIGINT paise (`*_paise`), quantities are BIGINT milli-units
--     (`*_milli`, 1 unit = 1000), rates are INTEGER basis points (`*_bp`, 18% = 1800).
--   * RLS + updated_at triggers are applied by kadai_ensure_conventions(), which
--     the migrator runs after every migration batch.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;

-- ----------------------------------------------------------------------------
-- Session context helpers (set per transaction with set_config(..., true))
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION current_app_user_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only (% not allowed)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'P0001';
END $$;

-- Immutable array_to_string so it can be used in index expressions / generated columns.
CREATE OR REPLACE FUNCTION kadai_text_array_join(arr text[]) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(array_to_string(arr, ' '), '')
$$;

-- Tables that carry tenant_id but are accessed only through the system pool and
-- therefore must NOT get the generic tenant RLS policy.
CREATE OR REPLACE FUNCTION kadai_rls_exempt_tables() RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY[
    'tenants',               -- has its own policy on id
    'auth_sessions',         -- system pool only
    'payment_webhook_events',-- system pool only (tenant resolved after verification)
    'platform_invoices',     -- SaaS vendor billing, system pool only
    'platform_audit_logs'    -- platform admin actions, system pool only
  ]::text[]
$$;

-- Applies cross-cutting conventions to every table. Idempotent; the migrator
-- runs it after each batch so tables added by later migrations are covered.
CREATE OR REPLACE FUNCTION kadai_ensure_conventions() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  r record;
BEGIN
  -- updated_at maintenance
  FOR r IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.column_name = 'updated_at'
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = 'trg_set_updated_at' AND tgrelid = format('public.%I', r.table_name)::regclass
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
        r.table_name);
    END IF;
  END LOOP;

  -- tenant isolation
  FOR r IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
      AND c.table_name <> ALL (kadai_rls_exempt_tables())
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.table_name);
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = r.table_name AND policyname = 'tenant_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON public.%I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())',
        r.table_name);
    END IF;
  END LOOP;
END $$;

-- Grants for the runtime (RLS-restricted) role. Called by the migrator with the
-- configured role name. System-only tables are revoked; append-only ledgers get
-- INSERT/SELECT only.
CREATE OR REPLACE FUNCTION kadai_apply_grants(app_role text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  t text;
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', app_role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', app_role);
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', app_role);

  -- system-only tables
  FOREACH t IN ARRAY ARRAY[
    'schema_migrations', 'auth_sessions', 'otp_codes', 'system_settings',
    'payment_webhook_events', 'platform_invoices', 'platform_audit_logs', 'backups'
  ] LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM %I', t, app_role);
    END IF;
  END LOOP;

  -- read-only reference tables
  FOREACH t IN ARRAY ARRAY['plans'] LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.%I FROM %I', t, app_role);
    END IF;
  END LOOP;

  -- append-only ledgers
  FOREACH t IN ARRAY ARRAY['audit_logs', 'stock_movements', 'journal_entries', 'journal_lines', 'loyalty_ledger'] LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
      EXECUTE format('REVOKE UPDATE, DELETE ON public.%I FROM %I', t, app_role);
    END IF;
  END LOOP;

  -- tenants: the app may read and update its own row (RLS) but never create/delete.
  EXECUTE format('REVOKE INSERT, DELETE ON public.tenants FROM %I', app_role);

  -- users: global identities; the app role may only read non-secret columns.
  EXECUTE format('REVOKE ALL ON public.users FROM %I', app_role);
  EXECUTE format(
    'GRANT SELECT (id, phone, email, full_name, preferred_locale, is_platform_admin, status, last_login_at, created_at, updated_at) ON public.users TO %I',
    app_role);
  EXECUTE format('GRANT UPDATE (full_name, preferred_locale, email) ON public.users TO %I', app_role);
END $$;

-- =============================================================================
-- Platform (global, not tenant-scoped)
-- =============================================================================

CREATE TABLE plans (
  code                 text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{1,31}$'),
  name                 text NOT NULL,
  name_ta              text,
  description          text,
  price_monthly_paise  bigint NOT NULL DEFAULT 0 CHECK (price_monthly_paise >= 0),
  price_yearly_paise   bigint NOT NULL DEFAULT 0 CHECK (price_yearly_paise >= 0),
  -- null limit value = unlimited. Keys: stores, users, registers, products, invoices_per_month
  limits               jsonb NOT NULL DEFAULT '{}'::jsonb,
  features             text[] NOT NULL DEFAULT '{}',
  is_public            boolean NOT NULL DEFAULT true,
  sort_order           integer NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE system_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- Tenants (businesses)
-- =============================================================================

CREATE TABLE tenants (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             citext UNIQUE CHECK (slug IS NULL OR slug ~ '^[a-z0-9][a-z0-9-]{2,62}$'),
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  name_ta          text,
  legal_name       text,
  business_type    text NOT NULL CHECK (business_type IN (
                     'general_store', 'supermarket', 'apparel', 'pharmacy', 'footwear',
                     'electronics', 'hardware', 'bakery_sweets', 'stationery', 'other')),
  gst_scheme       text NOT NULL DEFAULT 'regular' CHECK (gst_scheme IN ('regular', 'composition', 'unregistered')),
  gstin            text CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  pan              text CHECK (pan IS NULL OR pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  state_code       text NOT NULL DEFAULT '33' CHECK (state_code ~ '^[0-9]{2}$'),
  phone            text,
  email            citext,
  address          jsonb NOT NULL DEFAULT '{}'::jsonb,
  logo_file_id     uuid,
  default_locale   text NOT NULL DEFAULT 'ta' CHECK (default_locale IN ('ta', 'en')),
  timezone         text NOT NULL DEFAULT 'Asia/Kolkata',
  fy_start_month   smallint NOT NULL DEFAULT 4 CHECK (fy_start_month BETWEEN 1 AND 12),
  settings         jsonb NOT NULL DEFAULT '{}'::jsonb,
  plan_code        text NOT NULL DEFAULT 'free' REFERENCES plans(code),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  suspended_reason text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants
  USING (id = current_tenant_id())
  WITH CHECK (id = current_tenant_id());

-- =============================================================================
-- Users (global identities; a user may belong to several tenants)
-- =============================================================================

CREATE TABLE users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone                text UNIQUE CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$'),
  email                citext UNIQUE,
  full_name            text NOT NULL CHECK (length(full_name) BETWEEN 1 AND 120),
  password_hash        text,
  preferred_locale     text NOT NULL DEFAULT 'ta' CHECK (preferred_locale IN ('ta', 'en')),
  is_platform_admin    boolean NOT NULL DEFAULT false,
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  failed_login_count   integer NOT NULL DEFAULT 0,
  locked_until         timestamptz,
  last_login_at        timestamptz,
  password_changed_at  timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (phone IS NOT NULL OR email IS NOT NULL)
);

-- users RLS policies are created in 0002 (they reference memberships).

CREATE TABLE auth_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id           uuid REFERENCES tenants(id) ON DELETE CASCADE,
  refresh_token_hash  text NOT NULL UNIQUE,
  family_id           uuid NOT NULL,
  device_id           uuid,
  auth_method         text NOT NULL DEFAULT 'password' CHECK (auth_method IN ('password', 'otp', 'pin', 'api')),
  user_agent          text,
  ip                  inet,
  expires_at          timestamptz NOT NULL,
  last_used_at        timestamptz,
  revoked_at          timestamptz,
  revoked_reason      text,
  replaced_by         uuid,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX auth_sessions_family_idx ON auth_sessions (family_id);

CREATE TABLE otp_codes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone         text NOT NULL,
  purpose       text NOT NULL CHECK (purpose IN ('login', 'signup', 'reset_password', 'verify_phone')),
  code_hash     text NOT NULL,
  attempts      integer NOT NULL DEFAULT 0,
  max_attempts  integer NOT NULL DEFAULT 5,
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  ip            inet,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_codes_lookup_idx ON otp_codes (phone, purpose, created_at DESC);

-- Platform-level (vendor) audit trail: tenant suspension, plan changes, impersonation.
CREATE TABLE platform_audit_logs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id uuid REFERENCES users(id),
  tenant_id    uuid REFERENCES tenants(id) ON DELETE SET NULL,
  action       text NOT NULL,
  details      jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip           inet,
  request_id   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- On-prem local/cloud backups registry.
CREATE TABLE backups (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL DEFAULT 'scheduled' CHECK (kind IN ('scheduled', 'manual', 'pre_upgrade')),
  status        text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  location      text,
  size_bytes    bigint,
  checksum_sha256 text,
  uploaded_to_cloud boolean NOT NULL DEFAULT false,
  error         text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);

-- =============================================================================
-- Default plans (prices in paise). Platform admins can edit prices/limits later.
-- =============================================================================
INSERT INTO plans (code, name, name_ta, description, price_monthly_paise, price_yearly_paise, limits, features, sort_order) VALUES
('free', 'Thodakkam (Free)', 'தொடக்கம்', 'For a single counter getting started with digital billing',
  0, 0,
  '{"stores":1,"users":2,"registers":1,"products":1000,"invoices_per_month":300}',
  ARRAY['pos','catalog','inventory','customers','suppliers','upi_static','reports_basic','gst_invoice','khata'], 10),
('growth', 'Valarchi (Growth)', 'வளர்ச்சி', 'For busy single-store shops: purchases, GST returns, auto-reconciled UPI',
  29900, 299900,
  '{"stores":1,"users":5,"registers":3,"products":null,"invoices_per_month":null}',
  ARRAY['pos','catalog','inventory','customers','suppliers','upi_static','reports_basic','gst_invoice','khata',
        'purchases','gst_reports','upi_dynamic','promotions','loyalty','batches_expiry','variants',
        'notifications','shifts','accounting','offline_pos','barcode_labels'], 20),
('pro', 'Peru (Pro)', 'பெரு', 'For multi-branch retailers and supermarkets',
  79900, 799900,
  '{"stores":5,"users":25,"registers":15,"products":null,"invoices_per_month":null}',
  ARRAY['pos','catalog','inventory','customers','suppliers','upi_static','reports_basic','gst_invoice','khata',
        'purchases','gst_reports','upi_dynamic','promotions','loyalty','batches_expiry','variants',
        'notifications','shifts','accounting','offline_pos','barcode_labels',
        'multi_store','stock_transfers','advanced_reports','custom_roles','audit_log','api_access','store_pricing'], 30),
('enterprise', 'Enterprise', 'நிறுவனம்', 'Chains, distributors and on-prem deployments; custom limits & SLA',
  0, 0,
  '{"stores":null,"users":null,"registers":null,"products":null,"invoices_per_month":null}',
  ARRAY['pos','catalog','inventory','customers','suppliers','upi_static','reports_basic','gst_invoice','khata',
        'purchases','gst_reports','upi_dynamic','promotions','loyalty','batches_expiry','variants',
        'notifications','shifts','accounting','offline_pos','barcode_labels',
        'multi_store','stock_transfers','advanced_reports','custom_roles','audit_log','api_access','store_pricing',
        'priority_support'], 40);
UPDATE plans SET is_public = false WHERE code = 'enterprise';
