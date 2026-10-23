-- =============================================================================
-- Kadai — 1100 identity module (band 1100–1199)
--   Indexes for the identity list filters (GET /audit-logs, roles in use):
--   * audit log by member (user_id) and by action prefix ('product' matches
--     product.create, product.update …), newest first — audit_logs grows with
--     every audited write, so these filters must not scan the tenant's whole
--     trail;
--   * memberships by role (member counts per role, "role in use" checks).
-- =============================================================================

CREATE INDEX IF NOT EXISTS audit_logs_tenant_user_time_idx
  ON audit_logs (tenant_id, user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS audit_logs_tenant_action_time_idx
  ON audit_logs (tenant_id, action text_pattern_ops, created_at DESC);

CREATE INDEX IF NOT EXISTS memberships_tenant_role_idx
  ON memberships (tenant_id, role_id);
