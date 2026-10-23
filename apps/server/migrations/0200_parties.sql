-- =============================================================================
-- Kadai — 0200 parties module (band 0200–0299)
--   * imports: result columns read by GET /imports/:id (ImportJobSchema) for the
--     customer import. Identical definitions to 0100_catalog (IF NOT EXISTS), so
--     whichever band runs first creates them and the other is a no-op.
--   * indexes for party lists (name sort, code lookups), the doctor search and the
--     loyalty statement (running balance in posting order = id order, UUID v7).
-- =============================================================================

ALTER TABLE imports ADD COLUMN IF NOT EXISTS summary jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE imports ADD COLUMN IF NOT EXISTS preview jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE imports ADD COLUMN IF NOT EXISTS processed_rows integer NOT NULL DEFAULT 0 CHECK (processed_rows >= 0);
ALTER TABLE imports ADD COLUMN IF NOT EXISTS errors_truncated boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS imports_tenant_created_idx ON imports (tenant_id, created_at DESC);

-- Customer / supplier lists sorted by name (keyset-friendly), code lookups (import match_by code).
CREATE INDEX customers_name_idx ON customers (tenant_id, lower(name), id);
CREATE INDEX customers_code_idx ON customers (tenant_id, lower(code)) WHERE code IS NOT NULL;
CREATE INDEX suppliers_list_name_idx ON suppliers (tenant_id, lower(name), id);
CREATE INDEX suppliers_due_idx ON suppliers (tenant_id, balance_paise) WHERE balance_paise <> 0;

-- Pharmacy POS doctor search (name / registration number / clinic).
CREATE INDEX doctors_search_trgm_idx ON doctors USING gin (
  lower(name || ' ' || coalesce(registration_no, '') || ' ' || coalesce(clinic_name, '')) gin_trgm_ops
);
CREATE INDEX doctors_name_idx ON doctors (tenant_id, lower(name), id);

-- Loyalty statement: window sum over a customer's entries in id (posting) order.
CREATE INDEX loyalty_ledger_customer_id_idx ON loyalty_ledger (tenant_id, customer_id, id);
