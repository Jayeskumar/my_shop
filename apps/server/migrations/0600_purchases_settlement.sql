-- =============================================================================
-- Kadai — 0600 purchases: debit-note settlement bookkeeping, cancellation reason
-- and lookup indexes for the purchases module (band 0600-0699).
-- =============================================================================

-- adjusted_paise: the part of a debit note applied against its bill's due (settlement
-- 'adjust_due'): purchase_bills.returned_paise / due_paise move by exactly this amount, and a
-- cancellation gives it back. The rest of an adjust_due note (bill already paid, or a free-form
-- note without a bill) stays on the supplier's account as an advance. Refund settlements are
-- receipts (payments direction 'in', allocated to the debit note), so the open (unsettled)
-- amount of a note is total_paise − adjusted_paise − Σ live allocations.
ALTER TABLE debit_notes
  ADD COLUMN adjusted_paise bigint NOT NULL DEFAULT 0,
  ADD COLUMN cancel_reason text,
  ADD CONSTRAINT debit_notes_adjusted_chk CHECK (adjusted_paise >= 0 AND adjusted_paise <= total_paise),
  ADD CONSTRAINT debit_notes_adjusted_bill_chk CHECK (adjusted_paise = 0 OR bill_id IS NOT NULL);

CREATE INDEX debit_notes_bill_idx ON debit_notes (tenant_id, bill_id) WHERE bill_id IS NOT NULL;
CREATE INDEX debit_notes_date_idx ON debit_notes (tenant_id, note_date DESC);
CREATE INDEX debit_notes_supplier_idx ON debit_notes (tenant_id, supplier_id, note_date DESC);
CREATE INDEX debit_note_lines_bill_line_idx ON debit_note_lines (tenant_id, bill_line_id)
  WHERE bill_line_id IS NOT NULL;
CREATE INDEX debit_note_lines_note_idx ON debit_note_lines (tenant_id, debit_note_id);

CREATE INDEX purchase_orders_date_idx ON purchase_orders (tenant_id, order_date DESC);
CREATE INDEX purchase_orders_supplier_idx ON purchase_orders (tenant_id, supplier_id, order_date DESC);
CREATE INDEX purchase_order_lines_order_idx ON purchase_order_lines (tenant_id, purchase_order_id);
CREATE INDEX purchase_order_lines_product_idx ON purchase_order_lines (tenant_id, product_id);

CREATE INDEX purchase_bills_order_idx ON purchase_bills (tenant_id, purchase_order_id)
  WHERE purchase_order_id IS NOT NULL;
CREATE INDEX purchase_bills_supplier_idx ON purchase_bills (tenant_id, supplier_id, received_date DESC);
CREATE INDEX purchase_bill_lines_bill_idx ON purchase_bill_lines (tenant_id, bill_id);
CREATE INDEX purchase_bill_lines_order_line_idx ON purchase_bill_lines (tenant_id, purchase_order_line_id)
  WHERE purchase_order_line_id IS NOT NULL;
CREATE INDEX purchase_bill_lines_batch_idx ON purchase_bill_lines (tenant_id, batch_id)
  WHERE batch_id IS NOT NULL;
