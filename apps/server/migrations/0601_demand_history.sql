-- =============================================================================
-- Kadai — 0601 StockSense: imported sales history for the reorder forecast.
-- Does not change stock_levels. Recorded sales stay on stock_movements (postStock).
-- Re-importing a product and date replaces that imported quantity.
-- =============================================================================

CREATE TABLE demand_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id    uuid NOT NULL,
  product_id  uuid NOT NULL,
  sale_date   date NOT NULL,
  qty_milli   bigint NOT NULL CHECK (qty_milli > 0),
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, store_id, product_id, sale_date),
  FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id)
);

CREATE INDEX demand_history_store_idx
  ON demand_history (tenant_id, store_id, sale_date);
