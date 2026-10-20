-- =============================================================================
-- Kadai — 0009 fix payment_provider_accounts.vpa CHECK
-- PostgreSQL regular expressions limit bounded repetition to 255 (RE_DUP_MAX), so
-- the original `{2,256}` made every insert/update with a VPA fail with
-- "invalid regular expression: invalid repetition count(s)". Same rule as before
-- (handle of 2..256 characters, then @psp; shared upi.ts isValidVpa), with the
-- upper bound on the handle expressed as a length check.
-- =============================================================================

ALTER TABLE payment_provider_accounts DROP CONSTRAINT IF EXISTS payment_provider_accounts_vpa_check;
ALTER TABLE payment_provider_accounts ADD CONSTRAINT payment_provider_accounts_vpa_check CHECK (
  vpa IS NULL OR (
    vpa ~ '^[a-zA-Z0-9.\-_]{2,}@[a-zA-Z][a-zA-Z0-9]{1,64}$'
    AND length(split_part(vpa, '@', 1)) <= 256
  )
);
