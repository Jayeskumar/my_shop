-- =============================================================================
-- Kadai — 0005 accounting: chart of accounts, double-entry journal, expenses
-- Every financial document posts exactly one balanced journal entry (or a
-- reversal entry when cancelled). Journals are append-only; corrections are made
-- with reversal entries. Balance is enforced at COMMIT by a deferred trigger.
-- =============================================================================

CREATE TABLE accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code        text NOT NULL CHECK (code ~ '^[0-9]{3,6}$'),
  name        text NOT NULL,
  name_ta     text,
  type        text NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'income', 'expense')),
  -- system subtype used by posting rules (unique per tenant when not null); see shared/accounting.ts
  subtype     text,
  parent_id   uuid,
  is_system   boolean NOT NULL DEFAULT false,
  is_active   boolean NOT NULL DEFAULT true,
  store_id    uuid,                    -- optional: store-specific cash/bank accounts
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,   -- bank: {bank_name, account_last4, ifsc}
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id)
);
CREATE UNIQUE INDEX accounts_system_subtype_uq ON accounts (tenant_id, subtype)
  WHERE subtype IS NOT NULL AND is_system;

CREATE TABLE journal_entries (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id           uuid,
  entry_date         date NOT NULL,
  number             text,              -- manual journals only
  source_type        text NOT NULL,     -- 'sales_invoice','credit_note','purchase_bill','debit_note','payment','expense','stock_adjustment','stock_transfer','shift','manual','opening'
  source_id          uuid,
  narration          text,
  reverses_entry_id  uuid,
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id),
  FOREIGN KEY (tenant_id, reverses_entry_id) REFERENCES journal_entries (tenant_id, id)
);
CREATE INDEX journal_entries_date_idx ON journal_entries (tenant_id, entry_date);
CREATE INDEX journal_entries_source_idx ON journal_entries (tenant_id, source_type, source_id);
CREATE UNIQUE INDEX journal_entries_one_reversal_uq ON journal_entries (tenant_id, reverses_entry_id)
  WHERE reverses_entry_id IS NOT NULL;
CREATE TRIGGER journal_entries_append_only BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE journal_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entry_id      uuid NOT NULL,
  account_id    uuid NOT NULL,
  debit_paise   bigint NOT NULL DEFAULT 0 CHECK (debit_paise >= 0),
  credit_paise  bigint NOT NULL DEFAULT 0 CHECK (credit_paise >= 0),
  party_type    text CHECK (party_type IN ('customer', 'supplier')),
  party_id      uuid,
  store_id      uuid,
  memo          text,
  entry_date    date NOT NULL,          -- denormalised for ledger queries
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, entry_id) REFERENCES journal_entries (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id),
  CHECK ((debit_paise > 0) <> (credit_paise > 0)),
  CHECK ((party_type IS NULL) = (party_id IS NULL))
);
CREATE INDEX journal_lines_entry_idx ON journal_lines (tenant_id, entry_id);
CREATE INDEX journal_lines_account_idx ON journal_lines (tenant_id, account_id, entry_date);
CREATE INDEX journal_lines_party_idx ON journal_lines (tenant_id, party_type, party_id, entry_date) WHERE party_id IS NOT NULL;
CREATE TRIGGER journal_lines_append_only BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE OR REPLACE FUNCTION journal_entry_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  d bigint;
  c bigint;
BEGIN
  SELECT coalesce(sum(debit_paise), 0), coalesce(sum(credit_paise), 0)
    INTO d, c
    FROM journal_lines
   WHERE tenant_id = NEW.tenant_id AND entry_id = NEW.entry_id;
  IF d <> c THEN
    RAISE EXCEPTION 'journal entry % is not balanced (debit %, credit %)', NEW.entry_id, d, c
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER journal_lines_balanced
  AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION journal_entry_balanced();

CREATE TABLE expenses (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id              uuid NOT NULL,
  number                text,
  fy                    text,
  expense_date          date NOT NULL,
  expense_account_id    uuid NOT NULL,         -- expense-type account (rent, electricity, salary ...)
  supplier_id           uuid,                  -- vendor (optional)
  description           text,
  taxable_paise         bigint NOT NULL CHECK (taxable_paise >= 0),
  gst_rate_bp           integer NOT NULL DEFAULT 0,
  cgst_paise            bigint NOT NULL DEFAULT 0,
  sgst_paise            bigint NOT NULL DEFAULT 0,
  igst_paise            bigint NOT NULL DEFAULT 0,
  itc_eligible          boolean NOT NULL DEFAULT false,
  total_paise           bigint NOT NULL CHECK (total_paise >= 0),
  payment_method        text NOT NULL CHECK (payment_method IN ('cash', 'upi', 'card', 'bank_transfer', 'cheque', 'credit')),
  paid_from_account_id  uuid,                  -- cash/bank account; NULL when on credit (payable)
  reference             text,
  attachment_file_id    uuid,
  status                text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'cancelled')),
  cancelled_at          timestamptz,
  cancelled_by          uuid REFERENCES users(id),
  cancel_reason         text,
  shift_id              uuid,
  created_by            uuid REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, fy, number),
  FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id),
  FOREIGN KEY (tenant_id, expense_account_id) REFERENCES accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, paid_from_account_id) REFERENCES accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id),
  FOREIGN KEY (tenant_id, attachment_file_id) REFERENCES files (tenant_id, id)
);
CREATE INDEX expenses_date_idx ON expenses (tenant_id, expense_date);
