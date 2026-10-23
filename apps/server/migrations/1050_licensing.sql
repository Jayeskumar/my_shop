-- =============================================================================
-- Kadai — 1050 licensing (vendor control plane) bookkeeping (band 1050–1099).
--
-- Adds what the licensing module needs on top of the 0010 vendor tables:
--   * licenses.check_in_days (signed into licences), activation stale flag;
--   * vendor_orders: stored quote (applied offers), fulfilment record, invoice date,
--     payment-link expiry, cancellation / refund bookkeeping;
--   * vendor_idempotency_keys: Idempotency-Key replay for console creates (no tenant);
--   * licensing_request_nonces: replay protection of installation-signed requests;
--   * relay_messages: messaging relay log & metering (per licence and IST month);
--   * license_reminders: renewal reminders already sent (job licensing.renewal-reminders).
--
-- Like 0010 these tables carry no tenant_id, are revoked from the runtime role (grant function
-- below) and are used only through the system pool by the licensing module.
-- =============================================================================

ALTER TABLE licenses
  ADD COLUMN check_in_days integer NOT NULL DEFAULT 7 CHECK (check_in_days BETWEEN 1 AND 365);

ALTER TABLE license_activations
  ADD COLUMN stale_flagged_at timestamptz;
CREATE INDEX license_activations_license_idx ON license_activations (license_id, status);
CREATE INDEX license_activations_stale_idx ON license_activations (last_check_in_at)
  WHERE status = 'active' AND stale_flagged_at IS NULL;

CREATE INDEX license_events_activation_idx ON license_events (activation_id, created_at DESC)
  WHERE activation_id IS NOT NULL;
CREATE INDEX license_events_kind_idx ON license_events (license_id, kind, created_at DESC);

ALTER TABLE vendor_orders
  -- PriceQuote of the order as priced (applied offers → redemptions at fulfilment).
  ADD COLUMN quote jsonb,
  -- {license_id, events:[ids], before:{…}, periods:{line_key:{from,to}}, error}
  ADD COLUMN fulfilment jsonb,
  ADD COLUMN invoice_date date,
  ADD COLUMN paid_amount_paise bigint CHECK (paid_amount_paise IS NULL OR paid_amount_paise >= 0),
  ADD COLUMN payment_link_expires_at timestamptz,
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN cancel_reason text,
  ADD COLUMN refunded_at timestamptz,
  ADD COLUMN refund_reason text,
  ADD COLUMN refund_ref text;
CREATE INDEX vendor_orders_license_idx ON vendor_orders (license_id, created_at DESC)
  WHERE license_id IS NOT NULL;
CREATE INDEX vendor_orders_partner_idx ON vendor_orders (partner_id, created_at DESC)
  WHERE partner_id IS NOT NULL;
CREATE INDEX vendor_orders_payment_ref_idx ON vendor_orders (payment_ref)
  WHERE payment_ref IS NOT NULL;

CREATE INDEX partner_commissions_partner_idx ON partner_commissions (partner_id, created_at DESC);
CREATE INDEX offer_redemptions_offer_idx ON offer_redemptions (offer_id, created_at DESC);
CREATE INDEX cloud_backups_expiry_idx ON cloud_backups (expires_at) WHERE status <> 'deleted';

-- Idempotency-Key replay for vendor-console creates (issue licence, create order). Keyed by the
-- staff user: console requests have no tenant (core idempotency_keys is per tenant).
CREATE TABLE vendor_idempotency_keys (
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key              text NOT NULL CHECK (length(key) BETWEEN 8 AND 200),
  method           text NOT NULL,
  path             text NOT NULL,
  request_hash     text NOT NULL,
  status           text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed')),
  response_status  integer,
  response_body    jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL DEFAULT now() + interval '1 day',
  PRIMARY KEY (user_id, key)
);
CREATE INDEX vendor_idempotency_keys_expiry_idx ON vendor_idempotency_keys (expires_at);

-- Signatures of installation-signed requests seen within the clock-skew window (replay guard).
CREATE TABLE licensing_request_nonces (
  signature_sha256  text PRIMARY KEY CHECK (signature_sha256 ~ '^[0-9a-f]{64}$'),
  installation_id   text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX licensing_request_nonces_created_idx ON licensing_request_nonces (created_at);

-- Messages on-prem shops send through our providers (POST /public/v1/licensing/relay/messages).
CREATE TABLE relay_messages (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  license_id           uuid NOT NULL REFERENCES licenses(id),
  activation_id        uuid NOT NULL REFERENCES license_activations(id),
  client_ref           text NOT NULL CHECK (length(client_ref) BETWEEN 8 AND 100),
  channel              text NOT NULL CHECK (channel IN ('sms', 'whatsapp', 'email')),
  template_code        text NOT NULL,
  locale               text NOT NULL CHECK (locale IN ('ta', 'en')),
  recipient            text NOT NULL,
  -- IST calendar month the message is metered in.
  period               text NOT NULL CHECK (period ~ '^[0-9]{4}-[0-9]{2}$'),
  status               text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'cancelled')),
  -- Messages that count against the monthly quota (accepted by a provider or being sent).
  metered              boolean NOT NULL DEFAULT false,
  provider             text,
  provider_message_id  text,
  error                text,
  error_kind           text CHECK (error_kind IS NULL OR error_kind IN ('retryable', 'permanent')),
  attempts             integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  sent_at              timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (license_id, client_ref)
);
CREATE INDEX relay_messages_usage_idx ON relay_messages (license_id, period) WHERE metered;
CREATE INDEX relay_messages_provider_idx ON relay_messages (provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- Renewal reminders already sent: one per licence, term kind, due date and offset
-- (30/15/7/1 days before = positive, 7/30 days after = negative).
CREATE TABLE license_reminders (
  license_id    uuid NOT NULL REFERENCES licenses(id),
  kind          text NOT NULL CHECK (kind IN ('amc', 'subscription')),
  due_on        date NOT NULL,
  offset_days   integer NOT NULL CHECK (offset_days BETWEEN -365 AND 365),
  order_id      uuid REFERENCES vendor_orders(id),
  channels      text[] NOT NULL DEFAULT '{}',
  partner_notified boolean NOT NULL DEFAULT false,
  sent_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (license_id, kind, due_on, offset_days)
);

-- -----------------------------------------------------------------------------
-- Runtime-role grants: same function as 0010 with this migration's tables added to the
-- system-only list (the migrator calls it after every batch).
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
    'cloud_backups',
    -- vendor control plane (1050)
    'vendor_idempotency_keys', 'licensing_request_nonces', 'relay_messages', 'license_reminders'
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
