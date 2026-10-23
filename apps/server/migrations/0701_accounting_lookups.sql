-- =============================================================================
-- Kadai — 0701 accounting lookups (band 0700–0799)
--   Indexes for the queries the accounting module runs:
--   * shift X / Z reports: bills, returns, expenses and cash entries of a shift;
--   * shift lists by opening time;
--   * expenses by supplier (credit expenses) and by category;
--   * journal lines by store (P&L / books store filter) and by date (statements).
--   IF NOT EXISTS: harmless if an owning module adds an equivalent index later.
-- =============================================================================

CREATE INDEX IF NOT EXISTS sales_invoices_shift_idx
  ON sales_invoices (tenant_id, shift_id) WHERE shift_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS credit_notes_shift_idx
  ON credit_notes (tenant_id, shift_id) WHERE shift_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS expenses_shift_idx
  ON expenses (tenant_id, shift_id) WHERE shift_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS expenses_supplier_idx
  ON expenses (tenant_id, supplier_id, expense_date) WHERE supplier_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS expenses_account_idx
  ON expenses (tenant_id, expense_account_id, expense_date);

CREATE INDEX IF NOT EXISTS shift_cash_entries_shift_idx
  ON shift_cash_entries (tenant_id, shift_id);

CREATE INDEX IF NOT EXISTS register_shifts_opened_idx
  ON register_shifts (tenant_id, opened_at DESC);

CREATE INDEX IF NOT EXISTS journal_lines_store_idx
  ON journal_lines (tenant_id, store_id, entry_date) WHERE store_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS journal_lines_date_idx
  ON journal_lines (tenant_id, entry_date);
