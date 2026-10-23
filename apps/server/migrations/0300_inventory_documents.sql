-- =============================================================================
-- Kadai — 0300 inventory documents (module band 0300–0399).
--
-- * stock_adjustments: who cancelled a posted adjustment, when and why (the
--   reversal movements / journal reference the adjustment itself).
-- * stock_adjustment_lines.unit_cost_given: the line carries a cost entered by the
--   user; otherwise the current average cost of the stock row is used at posting
--   (drafts show it live) and written back to unit_cost_paise.
-- * stock_transfers: receipt date and shortfall note, cancellation details.
-- * stock_transfer_lines.shortfall_value_paise: value of the transit shortfall
--   written off at the source store on receipt (Σ of its 'damage' movements).
-- * Indexes for the document lists (store + date) and per-store movement history.
-- =============================================================================

ALTER TABLE stock_adjustments
  ADD COLUMN cancelled_at  timestamptz,
  ADD COLUMN cancelled_by  uuid REFERENCES users(id),
  ADD COLUMN cancel_reason text,
  ADD CONSTRAINT stock_adjustments_cancel_chk
    CHECK (cancelled_at IS NULL OR status = 'cancelled'),
  ADD CONSTRAINT stock_adjustments_posted_number_chk
    CHECK (status = 'draft' OR number IS NOT NULL);

ALTER TABLE stock_adjustment_lines
  ADD COLUMN unit_cost_given boolean NOT NULL DEFAULT false;

ALTER TABLE stock_transfers
  ADD COLUMN received_date    date,
  ADD COLUMN shortfall_reason text,
  ADD COLUMN cancelled_at     timestamptz,
  ADD COLUMN cancelled_by     uuid REFERENCES users(id),
  ADD COLUMN cancel_reason    text,
  ADD CONSTRAINT stock_transfers_cancel_chk
    CHECK (cancelled_at IS NULL OR status = 'cancelled'),
  ADD CONSTRAINT stock_transfers_received_chk
    CHECK (received_date IS NULL OR received_date >= transfer_date);

ALTER TABLE stock_transfer_lines
  ADD COLUMN shortfall_value_paise bigint NOT NULL DEFAULT 0
    CHECK (shortfall_value_paise >= 0),
  ADD CONSTRAINT stock_transfer_lines_received_chk
    CHECK (received_qty_milli IS NULL OR received_qty_milli <= qty_milli);

CREATE INDEX stock_adjustments_store_date_idx
  ON stock_adjustments (tenant_id, store_id, adjustment_date DESC);
CREATE INDEX stock_transfers_from_idx
  ON stock_transfers (tenant_id, from_store_id, transfer_date DESC);
CREATE INDEX stock_transfers_to_idx
  ON stock_transfers (tenant_id, to_store_id, transfer_date DESC);
CREATE INDEX stock_movements_store_time_idx
  ON stock_movements (tenant_id, store_id, created_at DESC);
