-- =============================================================================
-- Kadai — 0602 StockSense planning inputs.
--   suppliers.lead_time_days  days from order to delivery (null = the plan default)
--   products.shelf_life_days  days a new unit can be sold (null = no shelf-life cap)
-- Earlier StockSense builds kept shelf life in products.attributes.shelf_life_days; copy it.
-- =============================================================================

ALTER TABLE suppliers
  ADD COLUMN lead_time_days integer CHECK (lead_time_days BETWEEN 1 AND 180);

ALTER TABLE products
  ADD COLUMN shelf_life_days integer CHECK (shelf_life_days BETWEEN 0 AND 3650);

UPDATE products
   SET shelf_life_days = (attributes->>'shelf_life_days')::integer
 WHERE attributes ? 'shelf_life_days'
   AND (attributes->>'shelf_life_days') ~ '^[0-9]{1,4}$'
   AND (attributes->>'shelf_life_days')::integer <= 3650;
