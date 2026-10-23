-- =============================================================================
-- Kadai — 0500 payments module (band 0500–0599): provider options, the provider-hosted QR
-- image of an intent, provider close tracking after cancel / expiry, reconciliation indexes.
-- =============================================================================

-- Non-secret provider options: mock `auto_pay_delay_ms`; razorpay `key_id_masked` (so listing
-- accounts never needs to decrypt credentials). Secrets stay in the *_encrypted columns.
ALTER TABLE payment_provider_accounts ADD COLUMN config jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Provider-hosted QR image (Razorpay `image_url`), rendered when the intent has no upi_uri.
ALTER TABLE payment_intents ADD COLUMN image_url text;
-- When the QR / link was closed at the provider after a cancel or expiry (NULL = still open or
-- nothing to close). close_attempts counts failed close calls; the expire job retries them.
ALTER TABLE payment_intents ADD COLUMN provider_closed_at timestamptz;
ALTER TABLE payment_intents ADD COLUMN close_attempts integer NOT NULL DEFAULT 0
  CHECK (close_attempts >= 0);

-- Intent lists / reconciliation (newest first, paid-but-unapplied queue, UTR search).
CREATE INDEX payment_intents_list_idx ON payment_intents (tenant_id, created_at DESC);
CREATE INDEX payment_intents_unapplied_idx ON payment_intents (tenant_id, paid_at DESC)
  WHERE status = 'paid' AND payment_id IS NULL;
CREATE INDEX payment_intents_utr_idx ON payment_intents (tenant_id, utr) WHERE utr IS NOT NULL;
-- Jobs: expiry of open intents and close retries at the provider (cross-tenant fan-out).
CREATE INDEX payment_intents_expiry_idx ON payment_intents (expires_at)
  WHERE status IN ('created', 'pending');
CREATE INDEX payment_intents_close_pending_idx ON payment_intents (updated_at)
  WHERE status IN ('expired', 'cancelled') AND provider_ref IS NOT NULL AND provider_closed_at IS NULL;

-- Receipts & vouchers list (default sort: newest payment first).
CREATE INDEX payments_paid_at_idx ON payments (tenant_id, paid_at DESC);

-- Webhook events whose processing failed (retried by payments.process-webhook).
CREATE INDEX payment_webhook_events_retry_idx ON payment_webhook_events (received_at)
  WHERE processed_at IS NULL AND signature_valid;
