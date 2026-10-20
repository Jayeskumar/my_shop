-- =============================================================================
-- Kadai — 0003 catalog & parties
-- Price semantics: all *_price_paise / mrp_paise on products & batches are per
-- PACK of `pack_size` base units (pack_size = 1 for most goods; e.g. a strip of
-- 10 tablets has unit 'TAB', pack_size 10, MRP per strip). Quantities are always
-- in base units (milli). Line amount = round(price * qty_milli / (pack_size*1000)).
-- =============================================================================

-- Price-dependent GST rules (e.g. apparel/footwear: <= Rs 2,500 per piece 5%, above 18%)
CREATE TABLE tax_slab_rules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         text NOT NULL,
  description  text,
  -- ordered ascending: [{"max_unit_value_paise": 250000, "gst_rate_bp": 500}, {"max_unit_value_paise": null, "gst_rate_bp": 1800}]
  slabs        jsonb NOT NULL CHECK (jsonb_typeof(slabs) = 'array' AND jsonb_array_length(slabs) >= 1),
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE categories (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  parent_id         uuid,
  name              text NOT NULL,
  name_ta           text,
  hsn_code          text CHECK (hsn_code IS NULL OR hsn_code ~ '^[0-9]{4,8}$'),
  gst_rate_bp       integer CHECK (gst_rate_bp IS NULL OR gst_rate_bp BETWEEN 0 AND 4000),
  tax_slab_rule_id  uuid,
  sort_order        integer NOT NULL DEFAULT 0,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE NULLS NOT DISTINCT (tenant_id, parent_id, name),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES categories (tenant_id, id),
  FOREIGN KEY (tenant_id, tax_slab_rule_id) REFERENCES tax_slab_rules (tenant_id, id)
);

CREATE TABLE brands (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        citext NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE products (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  parent_id              uuid,          -- variant parent (kind='variant')
  kind                   text NOT NULL DEFAULT 'standard' CHECK (kind IN ('standard', 'variant_parent', 'variant', 'service')),
  sku                    text,
  name                   text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  name_ta                text,
  aliases                text[] NOT NULL DEFAULT '{}',   -- Tanglish/local names: 'arisi', 'paruppu'
  description            text,
  category_id            uuid,
  brand_id               uuid,
  unit                   text NOT NULL DEFAULT 'PCS',     -- base/stock unit code (see shared units)
  pack_size              integer NOT NULL DEFAULT 1 CHECK (pack_size >= 1),
  allow_loose            boolean NOT NULL DEFAULT false,  -- sell fractions of a pack (loose tablets)
  decimal_qty            boolean NOT NULL DEFAULT false,  -- weighed / measured goods (kg, m)
  hsn_code               text CHECK (hsn_code IS NULL OR hsn_code ~ '^[0-9]{4,8}$'),
  gst_rate_bp            integer NOT NULL DEFAULT 0 CHECK (gst_rate_bp BETWEEN 0 AND 4000),
  cess_rate_bp           integer NOT NULL DEFAULT 0 CHECK (cess_rate_bp BETWEEN 0 AND 30000),
  tax_slab_rule_id       uuid,
  price_includes_tax     boolean NOT NULL DEFAULT true,
  mrp_paise              bigint CHECK (mrp_paise IS NULL OR mrp_paise >= 0),
  sale_price_paise       bigint NOT NULL DEFAULT 0 CHECK (sale_price_paise >= 0),
  wholesale_price_paise  bigint CHECK (wholesale_price_paise IS NULL OR wholesale_price_paise >= 0),
  purchase_price_paise   bigint NOT NULL DEFAULT 0 CHECK (purchase_price_paise >= 0),   -- excl. tax, per pack
  min_sale_price_paise   bigint CHECK (min_sale_price_paise IS NULL OR min_sale_price_paise >= 0),
  max_discount_bp        integer CHECK (max_discount_bp IS NULL OR max_discount_bp BETWEEN 0 AND 10000),
  track_inventory        boolean NOT NULL DEFAULT true,
  track_batches          boolean NOT NULL DEFAULT false,  -- pharmacy / FMCG with expiry
  is_weighed             boolean NOT NULL DEFAULT false,  -- weighing-scale barcodes
  scale_plu              text,
  reorder_level_milli    bigint CHECK (reorder_level_milli IS NULL OR reorder_level_milli >= 0),
  reorder_qty_milli      bigint CHECK (reorder_qty_milli IS NULL OR reorder_qty_milli >= 0),
  variant_attributes     jsonb NOT NULL DEFAULT '{}'::jsonb,  -- kind='variant': {"size":"M","color":"Red"}
  variant_axes           text[] NOT NULL DEFAULT '{}',        -- kind='variant_parent': ['size','color']
  attributes             jsonb NOT NULL DEFAULT '{}'::jsonb,  -- vertical attributes (validated in app)
  image_file_id          uuid,
  is_active              boolean NOT NULL DEFAULT true,
  search_text            text NOT NULL DEFAULT '',            -- maintained by trigger
  created_by             uuid REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES products (tenant_id, id),
  FOREIGN KEY (tenant_id, category_id) REFERENCES categories (tenant_id, id),
  FOREIGN KEY (tenant_id, brand_id) REFERENCES brands (tenant_id, id),
  FOREIGN KEY (tenant_id, tax_slab_rule_id) REFERENCES tax_slab_rules (tenant_id, id),
  FOREIGN KEY (tenant_id, image_file_id) REFERENCES files (tenant_id, id),
  CHECK ((kind = 'variant') = (parent_id IS NOT NULL)),
  CHECK (kind <> 'service' OR track_inventory = false)
);
CREATE UNIQUE INDEX products_sku_uq ON products (tenant_id, lower(sku)) WHERE sku IS NOT NULL;
CREATE UNIQUE INDEX products_scale_plu_uq ON products (tenant_id, scale_plu) WHERE scale_plu IS NOT NULL;
CREATE INDEX products_category_idx ON products (tenant_id, category_id);
CREATE INDEX products_parent_idx ON products (tenant_id, parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX products_search_trgm_idx ON products USING gin (search_text gin_trgm_ops);
CREATE INDEX products_updated_idx ON products (tenant_id, updated_at);   -- POS delta sync

CREATE OR REPLACE FUNCTION products_search_text() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_text := lower(
    NEW.name || ' ' || coalesce(NEW.name_ta, '') || ' ' || coalesce(NEW.sku, '') || ' ' ||
    kadai_text_array_join(NEW.aliases) || ' ' || coalesce(NEW.attributes->>'generic_name', '') || ' ' ||
    coalesce(NEW.attributes->>'composition', ''));
  RETURN NEW;
END $$;
CREATE TRIGGER trg_products_search_text BEFORE INSERT OR UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION products_search_text();

CREATE TABLE product_barcodes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id  uuid NOT NULL,
  barcode     text NOT NULL CHECK (barcode ~ '^[0-9A-Za-z\-\.\/]{3,48}$'),
  qty_milli   bigint NOT NULL DEFAULT 1000 CHECK (qty_milli > 0),   -- qty represented by one scan (case barcodes)
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, barcode),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX product_barcodes_product_idx ON product_barcodes (tenant_id, product_id);

-- Per-store price overrides (feature: store_pricing)
CREATE TABLE store_product_prices (
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id          uuid NOT NULL,
  product_id        uuid NOT NULL,
  sale_price_paise  bigint NOT NULL CHECK (sale_price_paise >= 0),
  mrp_paise         bigint CHECK (mrp_paise IS NULL OR mrp_paise >= 0),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, store_id, product_id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id) ON DELETE CASCADE
);

-- Promotions / schemes (evaluated by the shared pricing engine, online and offline)
CREATE TABLE promotions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         text NOT NULL,
  name_ta      text,
  kind         text NOT NULL CHECK (kind IN ('item_percent', 'item_flat', 'buy_x_get_y', 'bill_percent', 'bill_flat', 'combo_price')),
  rules        jsonb NOT NULL,          -- shape per kind, validated by shared zod schema
  store_ids    uuid[],                  -- NULL = all stores
  starts_at    timestamptz,
  ends_at      timestamptz,
  days_of_week smallint[],              -- 0=Sunday..6; NULL = every day
  priority     integer NOT NULL DEFAULT 0,
  stackable    boolean NOT NULL DEFAULT false,
  is_active    boolean NOT NULL DEFAULT true,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);

-- =============================================================================
-- Parties
-- =============================================================================

CREATE TABLE customers (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code                   text,
  name                   text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  name_ta                text,
  phone                  text CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$'),
  alt_phone              text,
  email                  citext,
  gstin                  text CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  state_code             text CHECK (state_code IS NULL OR state_code ~ '^[0-9]{2}$'),
  address                jsonb NOT NULL DEFAULT '{}'::jsonb,
  customer_type          text NOT NULL DEFAULT 'retail' CHECK (customer_type IN ('retail', 'wholesale', 'business')),
  price_tier             text NOT NULL DEFAULT 'retail' CHECK (price_tier IN ('retail', 'wholesale')),
  credit_limit_paise     bigint CHECK (credit_limit_paise IS NULL OR credit_limit_paise >= 0),
  credit_days            integer CHECK (credit_days IS NULL OR credit_days >= 0),
  opening_balance_paise  bigint NOT NULL DEFAULT 0,
  balance_paise          bigint NOT NULL DEFAULT 0,      -- receivable (+ = customer owes shop)
  loyalty_points         bigint NOT NULL DEFAULT 0 CHECK (loyalty_points >= 0),
  date_of_birth          date,
  anniversary            date,
  notes                  text,
  tags                   text[] NOT NULL DEFAULT '{}',
  whatsapp_opt_in        boolean NOT NULL DEFAULT true,
  is_active              boolean NOT NULL DEFAULT true,
  created_by             uuid REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX customers_phone_uq ON customers (tenant_id, phone) WHERE phone IS NOT NULL;
CREATE INDEX customers_name_trgm_idx ON customers USING gin (lower(name || ' ' || coalesce(name_ta, '')) gin_trgm_ops);
CREATE INDEX customers_due_idx ON customers (tenant_id, balance_paise) WHERE balance_paise <> 0;

CREATE TABLE suppliers (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code                   text,
  name                   text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  contact_person         text,
  phone                  text CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$'),
  email                  citext,
  gstin                  text CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  pan                    text,
  state_code             text CHECK (state_code IS NULL OR state_code ~ '^[0-9]{2}$'),
  address                jsonb NOT NULL DEFAULT '{}'::jsonb,
  drug_license_no        text,
  payment_terms_days     integer CHECK (payment_terms_days IS NULL OR payment_terms_days >= 0),
  opening_balance_paise  bigint NOT NULL DEFAULT 0,
  balance_paise          bigint NOT NULL DEFAULT 0,      -- payable (+ = shop owes supplier)
  bank_details           jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {account_name, account_no_last4, ifsc}
  upi_vpa                text,
  notes                  text,
  is_active              boolean NOT NULL DEFAULT true,
  created_by             uuid REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX suppliers_name_trgm_idx ON suppliers USING gin (lower(name) gin_trgm_ops);

-- Pharmacy: prescribing doctors (Schedule H/H1 records)
CREATE TABLE doctors (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name             text NOT NULL,
  registration_no  text,
  qualification    text,
  phone            text,
  clinic_name      text,
  address          jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE loyalty_ledger (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id  uuid NOT NULL,
  points       bigint NOT NULL CHECK (points <> 0),
  kind         text NOT NULL CHECK (kind IN ('earn', 'redeem', 'adjust', 'expire', 'reverse')),
  ref_type     text,
  ref_id       uuid,
  notes        text,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id)
);
CREATE INDEX loyalty_ledger_customer_idx ON loyalty_ledger (tenant_id, customer_id, created_at DESC);
CREATE TRIGGER loyalty_ledger_append_only BEFORE UPDATE OR DELETE ON loyalty_ledger
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
