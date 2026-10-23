-- =============================================================================
-- Kadai — 0900 notifications module (band 0900–0999)
-- Delivery receipts (WhatsApp status callbacks, MSG91 delivery reports) arrive
-- without a tenant and are matched by the provider's message id; due-reminder
-- de-duplication looks up the latest reminder per customer.
-- =============================================================================

CREATE INDEX notifications_provider_message_idx
  ON notifications (provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE INDEX notifications_template_ref_idx
  ON notifications (tenant_id, template_code, ref_type, ref_id, created_at DESC);
