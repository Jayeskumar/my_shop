-- =============================================================================
-- Kadai — 0400 sales module: cart metadata, credit-note loyalty/offline columns,
-- POS delta-sync tombstones.
-- =============================================================================

-- Cart inputs of a document that are not totals: manual bill discount (bp / flat), requested
-- loyalty points, override / offline flags. Held bills and drafts are re-priced from these.
ALTER TABLE sales_invoices ADD COLUMN meta jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Credit notes: loyalty reversed with the return (earned points taken back, redeemed points
-- given back), offline creation instant (POST /pos/sync) and settlement details.
ALTER TABLE credit_notes
  ADD COLUMN loyalty_points_reversed bigint NOT NULL DEFAULT 0 CHECK (loyalty_points_reversed >= 0),
  ADD COLUMN loyalty_points_restored bigint NOT NULL DEFAULT 0 CHECK (loyalty_points_restored >= 0),
  ADD COLUMN offline_created_at timestamptz,
  ADD COLUMN meta jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE credit_note_lines
  ADD COLUMN name_ta text,
  ADD COLUMN meta jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX sales_invoices_open_idx ON sales_invoices (tenant_id, store_id, updated_at DESC)
  WHERE status IN ('held', 'draft');
CREATE INDEX sales_invoices_store_updated_idx ON sales_invoices (tenant_id, store_id, invoice_at DESC);
CREATE INDEX credit_note_lines_note_idx ON credit_note_lines (tenant_id, credit_note_id);
CREATE INDEX credit_note_lines_invoice_line_idx ON credit_note_lines (tenant_id, invoice_line_id)
  WHERE invoice_line_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- POS delta sync (GET /pos/bootstrap?since=): rows hard-deleted from the catalogue are recorded
-- here so offline registers drop them from their cache. Deactivations are seen through
-- updated_at. Written only by the triggers below; pruned by the job `sales.prune-pos-tombstones`.
-- No FK on tenant_id: rows are also written while a tenant is being deleted (cascade).
-- -----------------------------------------------------------------------------
CREATE TABLE pos_tombstones (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  kind        text NOT NULL CHECK (kind ~ '^(product|barcode|batch|promotion)$'),
  ref         text NOT NULL,
  deleted_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pos_tombstones_tenant_idx ON pos_tombstones (tenant_id, deleted_at);
CREATE INDEX pos_tombstones_deleted_idx ON pos_tombstones (deleted_at);

-- SECURITY DEFINER: the row is written whoever deletes (app role under RLS, owner, cascades).
CREATE OR REPLACE FUNCTION pos_record_tombstone() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO pos_tombstones (tenant_id, kind, ref)
  VALUES (OLD.tenant_id, TG_ARGV[0], to_jsonb(OLD) ->> TG_ARGV[1]);
  RETURN OLD;
END $$;

CREATE TRIGGER trg_pos_tombstone AFTER DELETE ON products
  FOR EACH ROW EXECUTE FUNCTION pos_record_tombstone('product', 'id');
CREATE TRIGGER trg_pos_tombstone AFTER DELETE ON product_barcodes
  FOR EACH ROW EXECUTE FUNCTION pos_record_tombstone('barcode', 'barcode');
CREATE TRIGGER trg_pos_tombstone AFTER DELETE ON batches
  FOR EACH ROW EXECUTE FUNCTION pos_record_tombstone('batch', 'id');
CREATE TRIGGER trg_pos_tombstone AFTER DELETE ON promotions
  FOR EACH ROW EXECUTE FUNCTION pos_record_tombstone('promotion', 'id');
