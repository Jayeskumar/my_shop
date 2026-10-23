-- =============================================================================
-- Kadai — 0201 parties module lookups (band 0200–0299)
--   Per-customer lookups the parties services run on other modules' tables:
--   * credit_notes by customer — customer summary (returns) and the
--     delete-or-deactivate history check;
--   * payment_intents by customer — open payment links on the khata page and the
--     history check;
--   * customers by phone digits — list search "98765" (substring of the E.164).
--   IF NOT EXISTS: harmless if an owning module adds an equivalent index later.
-- =============================================================================

CREATE INDEX IF NOT EXISTS credit_notes_customer_idx
  ON credit_notes (tenant_id, customer_id, note_date DESC) WHERE customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS payment_intents_customer_idx
  ON payment_intents (tenant_id, customer_id, created_at DESC) WHERE customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS customers_phone_trgm_idx
  ON customers USING gin (phone gin_trgm_ops) WHERE phone IS NOT NULL;
