-- =============================================================================
-- Kadai — 0004 inventory: batches, stock levels, movement ledger, adjustments,
-- transfers. All quantities are base-unit milli (1 unit = 1000).
-- stock_levels is the materialised balance; stock_movements is the append-only
-- ledger. Both are written ONLY through the inventory posting service in one
-- transaction, so SUM(movements) == level at all times (checked by tests).
-- =============================================================================

CREATE TABLE batches (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id            uuid NOT NULL,
  batch_no              text NOT NULL CHECK (length(batch_no) BETWEEN 1 AND 40),
  mfg_date              date,
  expiry_date           date,
  mrp_paise             bigint CHECK (mrp_paise IS NULL OR mrp_paise >= 0),
  purchase_price_paise  bigint CHECK (purchase_price_paise IS NULL OR purchase_price_paise >= 0),
  sale_price_paise      bigint CHECK (sale_price_paise IS NULL OR sale_price_paise >= 0),
  supplier_id           uuid,
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, product_id, batch_no),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id),
  CHECK (expiry_date IS NULL OR mfg_date IS NULL OR expiry_date >= mfg_date)
);
CREATE INDEX batches_expiry_idx ON batches (tenant_id, expiry_date) WHERE is_active;

CREATE TABLE stock_levels (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id        uuid NOT NULL,
  product_id      uuid NOT NULL,
  batch_id        uuid,
  qty_milli       bigint NOT NULL DEFAULT 0,
  avg_cost_paise  bigint NOT NULL DEFAULT 0,      -- moving average cost per PACK, excl. tax
  last_movement_at timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE NULLS NOT DISTINCT (tenant_id, store_id, product_id, batch_id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES batches (tenant_id, id)
);
CREATE INDEX stock_levels_product_idx ON stock_levels (tenant_id, product_id);

CREATE TABLE stock_movements (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id             uuid NOT NULL,
  product_id           uuid NOT NULL,
  batch_id             uuid,
  movement_type        text NOT NULL CHECK (movement_type IN (
                         'opening', 'purchase', 'purchase_return', 'sale', 'sale_return',
                         'adjustment', 'stock_take', 'damage', 'expiry_writeoff',
                         'transfer_out', 'transfer_in', 'sale_cancel', 'purchase_cancel')),
  qty_milli            bigint NOT NULL CHECK (qty_milli <> 0),   -- signed: + in, - out
  unit_cost_paise      bigint,                                  -- per pack, excl. tax
  balance_after_milli  bigint NOT NULL,
  ref_type             text,                                    -- 'sales_invoice', 'purchase_bill', ...
  ref_id               uuid,
  ref_line_id          uuid,
  reason               text,
  created_by           uuid REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES batches (tenant_id, id)
);
CREATE INDEX stock_movements_product_idx ON stock_movements (tenant_id, product_id, store_id, created_at DESC);
CREATE INDEX stock_movements_ref_idx ON stock_movements (tenant_id, ref_type, ref_id);
CREATE INDEX stock_movements_time_idx ON stock_movements (tenant_id, created_at DESC);
CREATE TRIGGER stock_movements_append_only BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE stock_adjustments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id         uuid NOT NULL,
  number           text,
  fy               text,
  adjustment_date  date NOT NULL,
  kind             text NOT NULL DEFAULT 'adjustment' CHECK (kind IN ('adjustment', 'stock_take', 'damage', 'expiry_writeoff', 'opening')),
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'cancelled')),
  notes            text,
  total_value_paise bigint NOT NULL DEFAULT 0,      -- signed value impact at cost
  posted_at        timestamptz,
  posted_by        uuid REFERENCES users(id),
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, fy, number),
  FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id)
);

CREATE TABLE stock_adjustment_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  adjustment_id     uuid NOT NULL,
  line_no           integer NOT NULL,
  product_id        uuid NOT NULL,
  batch_id          uuid,
  system_qty_milli  bigint,                -- stock_take: snapshot at posting
  counted_qty_milli bigint,                -- stock_take: physical count
  qty_delta_milli   bigint NOT NULL,       -- signed change applied
  unit_cost_paise   bigint NOT NULL DEFAULT 0,
  reason            text,
  UNIQUE (tenant_id, id),
  UNIQUE (adjustment_id, line_no),
  FOREIGN KEY (tenant_id, adjustment_id) REFERENCES stock_adjustments (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES batches (tenant_id, id)
);

CREATE TABLE stock_transfers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number          text,
  fy              text,
  from_store_id   uuid NOT NULL,
  to_store_id     uuid NOT NULL,
  transfer_date   date NOT NULL,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'dispatched', 'received', 'cancelled')),
  notes           text,
  dispatched_at   timestamptz,
  dispatched_by   uuid REFERENCES users(id),
  received_at     timestamptz,
  received_by     uuid REFERENCES users(id),
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, fy, number),
  FOREIGN KEY (tenant_id, from_store_id) REFERENCES stores (tenant_id, id),
  FOREIGN KEY (tenant_id, to_store_id) REFERENCES stores (tenant_id, id),
  CHECK (from_store_id <> to_store_id)
);

CREATE TABLE stock_transfer_lines (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  transfer_id         uuid NOT NULL,
  line_no             integer NOT NULL,
  product_id          uuid NOT NULL,
  batch_id            uuid,
  qty_milli           bigint NOT NULL CHECK (qty_milli > 0),
  received_qty_milli  bigint CHECK (received_qty_milli IS NULL OR received_qty_milli >= 0),
  unit_cost_paise     bigint NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  UNIQUE (transfer_id, line_no),
  FOREIGN KEY (tenant_id, transfer_id) REFERENCES stock_transfers (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES batches (tenant_id, id)
);
