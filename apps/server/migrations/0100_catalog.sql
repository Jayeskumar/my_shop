-- =============================================================================
-- Kadai — 0100 catalog module (band 0100–0199)
--   * catalog_sequences: per-tenant counters for shop-generated identifiers
--     (internal EAN-13 barcodes '20…', automatic SKUs). One row per counter,
--     incremented with INSERT … ON CONFLICT DO UPDATE … RETURNING, so the row
--     lock serialises concurrent generators inside their transactions.
--   * imports: result columns read by GET /imports/:id (ImportJobSchema) for
--     product and customer imports alike (summary counters, preview rows,
--     progress of job-based imports, error truncation flag).
--   * indexes for catalog lists / filters / reference checks.
-- =============================================================================

CREATE TABLE catalog_sequences (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- 'internal_barcode' | 'auto_sku' (free-form key; validated by the catalog module)
  name        text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_]{0,39}$'),
  last_value  bigint NOT NULL DEFAULT 0 CHECK (last_value >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, name)
);

-- Import results (ImportJobSchema). IF NOT EXISTS: other modules writing `imports`
-- rows (customers import) may add the same columns from their band.
ALTER TABLE imports ADD COLUMN IF NOT EXISTS summary jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE imports ADD COLUMN IF NOT EXISTS preview jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE imports ADD COLUMN IF NOT EXISTS processed_rows integer NOT NULL DEFAULT 0 CHECK (processed_rows >= 0);
ALTER TABLE imports ADD COLUMN IF NOT EXISTS errors_truncated boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS imports_tenant_created_idx ON imports (tenant_id, created_at DESC);

-- Category names are unique per parent case-insensitively ("Rice" = "rice").
CREATE UNIQUE INDEX categories_parent_name_ci_uq
  ON categories (tenant_id, parent_id, lower(name)) NULLS NOT DISTINCT;

-- Product list sorting / filters and reference checks (brand / tax rule in use).
CREATE INDEX products_name_idx ON products (tenant_id, lower(name), id);
CREATE INDEX products_brand_idx ON products (tenant_id, brand_id) WHERE brand_id IS NOT NULL;
CREATE INDEX products_tax_slab_rule_idx ON products (tenant_id, tax_slab_rule_id) WHERE tax_slab_rule_id IS NOT NULL;
CREATE INDEX categories_tax_slab_rule_idx ON categories (tenant_id, tax_slab_rule_id) WHERE tax_slab_rule_id IS NOT NULL;
CREATE INDEX categories_parent_idx ON categories (tenant_id, parent_id);

-- Promotion lists (active filter) and store price grids.
CREATE INDEX promotions_active_idx ON promotions (tenant_id, is_active, priority DESC);
CREATE INDEX store_product_prices_product_idx ON store_product_prices (tenant_id, product_id);
