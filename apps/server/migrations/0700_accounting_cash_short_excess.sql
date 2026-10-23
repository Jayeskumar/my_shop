-- =============================================================================
-- Kadai — 0700 accounting (band 0700–0799): cash short / excess system account
--   Shift close posts the drawer difference (counted − expected cash) to the system
--   account with subtype 'cash_short_excess' (shared DEFAULT_CHART code 5250, seeded
--   by onboarding for new tenants). This backfills every existing tenant that lacks
--   it. A tenant that already used code 5250 for a custom account gets the first free
--   code of 5251–5299, else of the expense range 5000–5999, else 52500–52999.
--   Ids are UUID v7 (ARCHITECTURE.md §5), built from clock_timestamp().
-- =============================================================================

INSERT INTO accounts (id, tenant_id, code, name, name_ta, type, subtype, is_system)
SELECT
  encode(
    set_bit(
      set_bit(
        overlay(uuid_send(gen_random_uuid())
                placing substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
                FROM 1 FOR 6),
        52, 1),
      53, 1),
    'hex')::uuid,
  t.id,
  (
    SELECT c.code
      FROM (
        SELECT '5250'::text AS code, 0 AS pri, 0 AS n
        UNION ALL SELECT g::text, 1, g FROM generate_series(5251, 5299) AS g
        UNION ALL SELECT g::text, 2, g FROM generate_series(5000, 5999) AS g
        UNION ALL SELECT g::text, 3, g FROM generate_series(52500, 52999) AS g
      ) AS c
     WHERE NOT EXISTS (
       SELECT 1 FROM accounts x WHERE x.tenant_id = t.id AND x.code = c.code
     )
     ORDER BY c.pri, c.n
     LIMIT 1
  ),
  'Cash short / excess',
  'ரொக்கக் குறைவு / மிகுதி',
  'expense',
  'cash_short_excess',
  true
FROM tenants AS t
WHERE NOT EXISTS (
  SELECT 1 FROM accounts a
   WHERE a.tenant_id = t.id AND a.subtype = 'cash_short_excess' AND a.is_system
);
