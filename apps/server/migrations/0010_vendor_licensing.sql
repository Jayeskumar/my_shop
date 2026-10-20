-- =============================================================================
-- Kadai — 0010 vendor control plane: licensing, editions & price book, orders,
-- offers/coupons, partners (resellers), releases, announcements, on-prem
-- installations (activations, check-ins, Kadai Connect snapshots, cloud backups).
--
-- These tables belong to the VENDOR (us), not to a shop. They have no tenant_id,
-- are revoked from the runtime role and are used only through the system pool by
-- the licensing module when KADAI_VENDOR_CONSOLE=true (our cloud deployment).
-- In shop databases (cloud tenants' rows aside, and every on-prem install) they
-- simply stay empty.
-- =============================================================================

-- Vendor staff & partner users (supersedes the boolean users.is_platform_admin, which
-- stays as a fast "is any staff" flag kept in sync by the licensing module).
CREATE TABLE platform_staff (
  user_id      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('owner', 'admin', 'sales', 'support', 'finance', 'partner')),
  partner_id   uuid,
  is_active    boolean NOT NULL DEFAULT true,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((role = 'partner') = (partner_id IS NOT NULL))
);

-- Resellers: local hardware/billing-software vendors who sell & install Kadai
CREATE TABLE partners (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{3,12}$'),
  name            text NOT NULL,
  contact_name    text,
  phone           text CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$'),
  email           citext,
  gstin           text CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  state_code      text CHECK (state_code IS NULL OR state_code ~ '^[0-9]{2}$'),
  district        text,
  address         jsonb NOT NULL DEFAULT '{}'::jsonb,
  tier            text NOT NULL DEFAULT 'silver' CHECK (tier IN ('silver', 'gold', 'platinum')),
  discount_bp     integer NOT NULL DEFAULT 2000 CHECK (discount_bp BETWEEN 0 AND 10000),   -- partner buy price discount
  commission_bp   integer NOT NULL DEFAULT 0 CHECK (commission_bp BETWEEN 0 AND 10000),   -- on direct sales they refer
  payout_details  jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {vpa} or {account_last4, ifsc}; never full account numbers
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE platform_staff ADD FOREIGN KEY (partner_id) REFERENCES partners(id);

-- Licensees (on-prem customers). A cloud tenant that also buys on-prem is linked via tenant_id.
CREATE TABLE vendor_customers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,                 -- contact person
  business_name   text NOT NULL,
  business_name_ta text,
  business_type   text NOT NULL CHECK (business_type IN (
                    'general_store', 'supermarket', 'apparel', 'pharmacy', 'footwear',
                    'electronics', 'hardware', 'bakery_sweets', 'stationery', 'other')),
  phone           text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  email           citext,
  gstin           text CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  state_code      text NOT NULL DEFAULT '33' CHECK (state_code ~ '^[0-9]{2}$'),
  district        text,
  address         jsonb NOT NULL DEFAULT '{}'::jsonb,
  partner_id      uuid REFERENCES partners(id),
  tenant_id       uuid REFERENCES tenants(id) ON DELETE SET NULL,
  referred_by_customer_id uuid REFERENCES vendor_customers(id),
  referral_code   text UNIQUE,
  tags            text[] NOT NULL DEFAULT '{}',
  notes           text,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX vendor_customers_phone_uq ON vendor_customers (phone);
CREATE INDEX vendor_customers_partner_idx ON vendor_customers (partner_id);

-- Price book: editions, AMC, add-ons and cloud plan SKUs we sell.
CREATE TABLE license_products (
  code              text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  kind              text NOT NULL CHECK (kind IN ('edition', 'subscription', 'amc', 'addon', 'cloud_plan', 'service')),
  channel           text NOT NULL CHECK (channel IN ('onprem', 'cloud', 'both')),
  name              text NOT NULL,
  name_ta           text,
  description       text,
  description_ta    text,
  plan_code         text REFERENCES plans(code),       -- entitlement set granted (editions / subscriptions / cloud plans)
  price_paise       bigint NOT NULL CHECK (price_paise >= 0),   -- excl. GST
  term_months       integer CHECK (term_months IS NULL OR term_months > 0),  -- subscription / AMC / addon term; NULL = perpetual
  included_amc_months integer NOT NULL DEFAULT 0,      -- editions: months of updates & support included
  renewal_price_paise bigint CHECK (renewal_price_paise IS NULL OR renewal_price_paise >= 0),
  limits            jsonb NOT NULL DEFAULT '{}'::jsonb,   -- addons: {"registers": 1} / {"stores": 1}
  features          text[] NOT NULL DEFAULT '{}',          -- addons: features unlocked (e.g. 'connect', 'cloud_backup')
  hsn_sac           text NOT NULL DEFAULT '997331',       -- SAC for software licensing services
  gst_rate_bp       integer NOT NULL DEFAULT 1800,
  is_active         boolean NOT NULL DEFAULT true,
  sort_order        integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE licenses (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_prefix         text NOT NULL UNIQUE,              -- 'KD-7Q2M' shown in UI
  key_hash           text NOT NULL UNIQUE,              -- sha256 of the full key 'KD-XXXX-XXXX-XXXX-XXXX'
  customer_id        uuid NOT NULL REFERENCES vendor_customers(id),
  partner_id         uuid REFERENCES partners(id),
  product_code       text NOT NULL REFERENCES license_products(code),
  license_type       text NOT NULL CHECK (license_type IN ('perpetual', 'subscription', 'trial', 'nfr')),
  plan_code          text NOT NULL REFERENCES plans(code),
  features           text[],                            -- NULL = plan features (+ addons)
  limits             jsonb NOT NULL DEFAULT '{}'::jsonb, -- overrides incl. addons: stores, registers, users
  addons             jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{product_code, qty, valid_until}]
  max_activations    integer NOT NULL DEFAULT 1 CHECK (max_activations >= 1),
  valid_from         date NOT NULL,
  valid_until        date,                              -- NULL = perpetual
  updates_until      date,                              -- AMC: releases published after this are not installable
  support_until      date,
  grace_days         integer NOT NULL DEFAULT 15,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
  suspended_reason   text,
  notes              text,
  issued_by          uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_until IS NULL OR valid_until >= valid_from)
);
CREATE INDEX licenses_customer_idx ON licenses (customer_id);
CREATE INDEX licenses_partner_idx ON licenses (partner_id);
CREATE INDEX licenses_renewals_idx ON licenses (updates_until) WHERE status = 'active';

-- One row per on-prem installation bound to a license.
CREATE TABLE license_activations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  license_id             uuid NOT NULL REFERENCES licenses(id),
  installation_id        text NOT NULL,
  installation_public_key text NOT NULL,           -- Ed25519 SPKI (base64); check-ins are signed with its private key
  fingerprint_hash       text NOT NULL,            -- sha256 of machine id + db system identifier
  machine_name           text,
  os                     text,
  app_version            text,
  business_name          text,
  method                 text NOT NULL DEFAULT 'online' CHECK (method IN ('online', 'offline')),
  status                 text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deactivated', 'blocked')),
  activated_at           timestamptz NOT NULL DEFAULT now(),
  last_check_in_at       timestamptz,
  last_check_in_ip       inet,
  last_version           text,
  last_stats             jsonb NOT NULL DEFAULT '{}'::jsonb,  -- counts only (stores, registers, users, invoices_30d) — no shop data
  connect_enabled        boolean NOT NULL DEFAULT false,      -- Kadai Connect remote dashboard opt-in
  cloud_backup_enabled   boolean NOT NULL DEFAULT false,
  deactivated_at         timestamptz,
  deactivation_reason    text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (license_id, installation_id)
);
CREATE UNIQUE INDEX license_activations_installation_live_uq ON license_activations (installation_id) WHERE status = 'active';
CREATE INDEX license_activations_checkin_idx ON license_activations (last_check_in_at);

CREATE TABLE license_events (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  license_id     uuid REFERENCES licenses(id),
  activation_id  uuid REFERENCES license_activations(id),
  kind           text NOT NULL CHECK (kind IN (
                   'issued', 'activated', 'offline_activated', 'check_in', 'deactivated', 'transferred',
                   'renewed', 'upgraded', 'addon_added', 'suspended', 'resumed', 'revoked',
                   'clone_suspected', 'license_downloaded', 'update_installed')),
  details        jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id  uuid REFERENCES users(id),
  ip             inet,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX license_events_license_idx ON license_events (license_id, created_at DESC);
CREATE TRIGGER license_events_append_only BEFORE UPDATE OR DELETE ON license_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Software releases offered to on-prem installations (signed artifacts).
CREATE TABLE releases (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version           text NOT NULL UNIQUE CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'),
  channel           text NOT NULL DEFAULT 'stable' CHECK (channel IN ('stable', 'beta')),
  released_at       timestamptz NOT NULL DEFAULT now(),
  notes_en          text NOT NULL,
  notes_ta          text,
  min_upgrade_from  text,                            -- installs older than this must step through it
  mandatory         boolean NOT NULL DEFAULT false,  -- security releases (still subject to AMC rules: see docs)
  artifacts         jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{platform:'windows-x64'|'linux-x64'|'docker', url, sha256, size_bytes, signature}]
  is_active         boolean NOT NULL DEFAULT true,
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Offers: coupon codes (code NOT NULL) and automatic campaigns (code NULL), e.g.
-- "Pongal: 20% off Standard edition", "Deepavali: 6 months AMC free", referral credits.
CREATE TABLE offers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code               citext UNIQUE CHECK (code IS NULL OR code ~* '^[A-Z0-9_-]{3,32}$'),
  name               text NOT NULL,
  name_ta            text,
  description        text,
  description_ta     text,
  kind               text NOT NULL CHECK (kind IN ('percent', 'flat', 'free_months', 'price_override')),
  value              bigint NOT NULL CHECK (value >= 0),        -- bp | paise | months | paise
  max_discount_paise bigint,
  applies_to         text[] NOT NULL DEFAULT '{}',              -- license_products codes; empty = all
  channel            text NOT NULL DEFAULT 'both' CHECK (channel IN ('onprem', 'cloud', 'both')),
  audience           jsonb NOT NULL DEFAULT '{}'::jsonb,        -- {business_types:[], state_codes:[], segment:'new'|'existing'|'lapsed_amc'|'any', min_order_paise}
  starts_at          timestamptz,
  ends_at            timestamptz,
  max_redemptions    integer,
  per_customer_limit integer NOT NULL DEFAULT 1,
  partner_id         uuid REFERENCES partners(id),             -- partner-exclusive code
  stackable          boolean NOT NULL DEFAULT false,
  banner             jsonb,                                     -- in-app banner {title_en,title_ta,body_en,body_ta,cta_en,cta_ta}
  is_active          boolean NOT NULL DEFAULT true,
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at),
  CHECK (kind <> 'percent' OR value <= 10000)
);

-- Orders for everything we sell (on-prem licenses, AMC renewals, add-ons, prepaid cloud plans).
CREATE TABLE vendor_orders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number              text UNIQUE,                     -- assigned on payment: KD/2627/000123 (GST invoice no.)
  kind                text NOT NULL CHECK (kind IN ('new_license', 'renewal', 'upgrade', 'addon', 'cloud_plan', 'service')),
  customer_id         uuid REFERENCES vendor_customers(id),
  tenant_id           uuid REFERENCES tenants(id) ON DELETE SET NULL,   -- cloud purchases
  license_id          uuid REFERENCES licenses(id),
  partner_id          uuid REFERENCES partners(id),
  lines               jsonb NOT NULL,                   -- [{product_code, qty, unit_price_paise, discount_paise, term_months}]
  subtotal_paise      bigint NOT NULL,
  discount_paise      bigint NOT NULL DEFAULT 0,
  taxable_paise       bigint NOT NULL,
  cgst_paise          bigint NOT NULL DEFAULT 0,
  sgst_paise          bigint NOT NULL DEFAULT 0,
  igst_paise          bigint NOT NULL DEFAULT 0,
  total_paise         bigint NOT NULL CHECK (total_paise >= 0),
  place_of_supply     text NOT NULL CHECK (place_of_supply ~ '^[0-9]{2}$'),
  buyer_gstin         text,
  offer_ids           uuid[] NOT NULL DEFAULT '{}',
  coupon_code         citext,
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_payment', 'paid', 'fulfilled', 'cancelled', 'refunded')),
  payment_provider    text CHECK (payment_provider IN ('razorpay', 'manual', 'partner_credit')),
  payment_ref         text,                            -- payment link id / UTR / partner settlement ref
  short_url           text,
  paid_at             timestamptz,
  fulfilled_at        timestamptz,
  notes               text,
  created_by          uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (customer_id IS NOT NULL OR tenant_id IS NOT NULL),
  CHECK (total_paise = taxable_paise + cgst_paise + sgst_paise + igst_paise)
);
CREATE INDEX vendor_orders_customer_idx ON vendor_orders (customer_id, created_at DESC);
CREATE INDEX vendor_orders_status_idx ON vendor_orders (status, created_at DESC);

CREATE TABLE offer_redemptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id        uuid NOT NULL REFERENCES offers(id),
  order_id        uuid NOT NULL REFERENCES vendor_orders(id),
  customer_id     uuid REFERENCES vendor_customers(id),
  tenant_id       uuid REFERENCES tenants(id) ON DELETE SET NULL,
  discount_paise  bigint NOT NULL CHECK (discount_paise >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (offer_id, order_id)
);

CREATE TABLE partner_commissions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id    uuid NOT NULL REFERENCES partners(id),
  order_id      uuid NOT NULL REFERENCES vendor_orders(id),
  amount_paise  bigint NOT NULL CHECK (amount_paise >= 0),
  status        text NOT NULL DEFAULT 'accrued' CHECK (status IN ('accrued', 'approved', 'paid', 'void')),
  paid_ref      text,
  paid_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (partner_id, order_id)
);

-- In-app announcements & offer banners for cloud tenants and on-prem installs (delivered on check-in).
CREATE TABLE announcements (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  severity     text NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'offer', 'warning', 'critical')),
  title_en     text NOT NULL,
  title_ta     text,
  body_en      text NOT NULL,
  body_ta      text,
  cta_label_en text,
  cta_label_ta text,
  cta_url      text,
  offer_id     uuid REFERENCES offers(id),
  audience     jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {channels:['cloud','onprem'], business_types:[], plan_codes:[], max_version:'1.4.0', amc:'active'|'expired'|'any'}
  starts_at    timestamptz NOT NULL DEFAULT now(),
  ends_at      timestamptz,
  is_active    boolean NOT NULL DEFAULT true,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Kadai Connect: latest dashboard snapshot pushed by an opted-in on-prem install, so the
-- owner can see today's sales / dues / stock alerts on the phone away from the shop.
CREATE TABLE installation_snapshots (
  activation_id  uuid PRIMARY KEY REFERENCES license_activations(id) ON DELETE CASCADE,
  app_version    text,
  snapshot       jsonb NOT NULL,                     -- reports dashboard payload (aggregates only)
  generated_at   timestamptz NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now()
);

-- Encrypted on-prem backups stored by us (add-on). Content is encrypted on the shop's
-- server with a key only the shop holds (recovery code); we store opaque blobs.
CREATE TABLE cloud_backups (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  activation_id  uuid NOT NULL REFERENCES license_activations(id),
  object_key     text NOT NULL UNIQUE,
  size_bytes     bigint NOT NULL CHECK (size_bytes >= 0),
  sha256         text NOT NULL,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'stored', 'deleted')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz
);
CREATE INDEX cloud_backups_activation_idx ON cloud_backups (activation_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- Runtime-role grants: vendor control-plane tables carry no tenant_id (so no RLS)
-- and must never be reachable by the RLS-restricted runtime role. Same function as
-- 0001 with the system-only list extended; the migrator calls it after every batch.
-- -----------------------------------------------------------------------------
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
    'payment_webhook_events', 'platform_invoices', 'platform_audit_logs', 'backups',
    -- vendor control plane (0010)
    'platform_staff', 'partners', 'vendor_customers', 'license_products', 'licenses',
    'license_activations', 'license_events', 'releases', 'offers', 'vendor_orders',
    'offer_redemptions', 'partner_commissions', 'announcements', 'installation_snapshots',
    'cloud_backups'
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

-- -----------------------------------------------------------------------------
-- On-prem editions are plans too (entitlements resolve license.plan_code → plans).
-- Not public (not sold through cloud self-service).
-- -----------------------------------------------------------------------------
INSERT INTO plans (code, name, name_ta, description, price_monthly_paise, price_yearly_paise, limits, features, is_public, sort_order) VALUES
('onprem_starter', 'Kadai Server Starter', 'கடை சர்வர் ஸ்டார்ட்டர்', 'Single counter shop on its own PC',
  0, 0, '{"stores":1,"users":3,"registers":1,"products":null,"invoices_per_month":null}',
  ARRAY['pos','catalog','inventory','customers','suppliers','upi_static','reports_basic','gst_invoice','khata',
        'purchases','gst_reports','batches_expiry','variants','barcode_labels','shifts','offline_pos'], false, 110),
('onprem_standard', 'Kadai Server Standard', 'கடை சர்வர் ஸ்டாண்டர்டு', 'Busy single store with up to 3 counters on the LAN',
  0, 0, '{"stores":1,"users":10,"registers":3,"products":null,"invoices_per_month":null}',
  ARRAY['pos','catalog','inventory','customers','suppliers','upi_static','reports_basic','gst_invoice','khata',
        'purchases','gst_reports','upi_dynamic','promotions','loyalty','batches_expiry','variants',
        'notifications','shifts','accounting','offline_pos','barcode_labels'], false, 120),
('onprem_pro', 'Kadai Server Pro', 'கடை சர்வர் ப்ரோ', 'Multi-counter supermarkets and up to 3 branches over LAN/VPN',
  0, 0, '{"stores":3,"users":30,"registers":10,"products":null,"invoices_per_month":null}',
  ARRAY['pos','catalog','inventory','customers','suppliers','upi_static','reports_basic','gst_invoice','khata',
        'purchases','gst_reports','upi_dynamic','promotions','loyalty','batches_expiry','variants',
        'notifications','shifts','accounting','offline_pos','barcode_labels',
        'multi_store','stock_transfers','advanced_reports','custom_roles','audit_log','api_access','store_pricing'], false, 130),
('onprem_enterprise', 'Kadai Server Enterprise', 'கடை சர்வர் எண்டர்பிரைஸ்', 'Chains and distributors; custom limits',
  0, 0, '{"stores":null,"users":null,"registers":null,"products":null,"invoices_per_month":null}',
  ARRAY['pos','catalog','inventory','customers','suppliers','upi_static','reports_basic','gst_invoice','khata',
        'purchases','gst_reports','upi_dynamic','promotions','loyalty','batches_expiry','variants',
        'notifications','shifts','accounting','offline_pos','barcode_labels',
        'multi_store','stock_transfers','advanced_reports','custom_roles','audit_log','api_access','store_pricing',
        'priority_support'], false, 140);

-- Default price book (excl. GST). Editable from the vendor console.
INSERT INTO license_products (code, kind, channel, name, name_ta, plan_code, price_paise, term_months, included_amc_months, renewal_price_paise, limits, features, sort_order) VALUES
('onprem_starter',       'edition',      'onprem', 'Kadai Server Starter (perpetual, 1 counter)',        'ஸ்டார்ட்டர் (நிரந்தர உரிமம், 1 கவுண்டர்)',  'onprem_starter',    799900,  NULL, 12, 159900, '{}', '{}', 10),
('onprem_standard',      'edition',      'onprem', 'Kadai Server Standard (perpetual, 3 counters)',      'ஸ்டாண்டர்டு (நிரந்தர உரிமம், 3 கவுண்டர்)',   'onprem_standard',  1499900,  NULL, 12, 299900, '{}', '{}', 20),
('onprem_pro',           'edition',      'onprem', 'Kadai Server Pro (perpetual, 3 branches, 10 counters)', 'ப்ரோ (நிரந்தர உரிமம், 3 கிளைகள்)',        'onprem_pro',       2499900,  NULL, 12, 499900, '{}', '{}', 30),
('onprem_starter_yearly',  'subscription', 'onprem', 'Kadai Server Starter — yearly',                    'ஸ்டார்ட்டர் — ஆண்டு சந்தா',                  'onprem_starter',    299900,  12,   12, 299900, '{}', '{}', 40),
('onprem_standard_yearly', 'subscription', 'onprem', 'Kadai Server Standard — yearly',                   'ஸ்டாண்டர்டு — ஆண்டு சந்தா',                 'onprem_standard',   499900,  12,   12, 499900, '{}', '{}', 50),
('onprem_pro_yearly',    'subscription', 'onprem', 'Kadai Server Pro — yearly',                          'ப்ரோ — ஆண்டு சந்தா',                         'onprem_pro',        899900,  12,   12, 899900, '{}', '{}', 60),
('amc_renewal',          'amc',          'onprem', 'Updates & support (AMC) — 1 year',                   'புதுப்பிப்புகள் & ஆதரவு (AMC) — 1 ஆண்டு',     NULL,                     0,  12,    0, NULL, '{}', '{}', 70),
('addon_counter',        'addon',        'onprem', 'Extra billing counter',                              'கூடுதல் பில்லிங் கவுண்டர்',                  NULL,                250000,  NULL,  0,  50000, '{"registers":1}', '{}', 80),
('addon_store',          'addon',        'onprem', 'Extra branch',                                       'கூடுதல் கிளை',                               NULL,                750000,  NULL,  0, 150000, '{"stores":1}', '{}', 90),
('addon_connect',        'addon',        'both',   'Kadai Connect — owner remote dashboard & daily WhatsApp summary', 'கடை கனெக்ட் — தொலைதூர டாஷ்போர்டு',      NULL,                 99900,  12,    0,  99900, '{}', ARRAY['connect'], 100),
('addon_cloud_backup',   'addon',        'onprem', 'Encrypted cloud backup (10 GB)',                     'மறைகுறியாக்கப்பட்ட கிளவுட் காப்புப்பிரதி',      NULL,                119900,  12,    0, 119900, '{}', ARRAY['cloud_backup'], 110),
('service_installation', 'service',      'onprem', 'On-site installation & data migration',              'நேரடி நிறுவல் & தரவு இடமாற்றம்',               NULL,                150000,  NULL,  0, NULL, '{}', '{}', 120),
('cloud_growth_yearly',  'cloud_plan',   'cloud',  'Valarchi (Growth) — yearly prepaid',                 'வளர்ச்சி — ஆண்டு முன்கட்டணம்',                 'growth',            299900,  12,    0, 299900, '{}', '{}', 200),
('cloud_pro_yearly',     'cloud_plan',   'cloud',  'Peru (Pro) — yearly prepaid',                        'பெரு — ஆண்டு முன்கட்டணம்',                    'pro',               799900,  12,    0, 799900, '{}', '{}', 210);
-- amc_renewal price is computed from the licensed edition's renewal_price_paise (+ add-ons).
