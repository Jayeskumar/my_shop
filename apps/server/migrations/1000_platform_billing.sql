-- =============================================================================
-- Kadai — 1000 platform: cloud billing bookkeeping (ARCHITECTURE.md §3.1, band 1000–1049).
--
--   * subscriptions: dunning (past_due_since) and cancellation fields;
--   * platform_checkouts: every checkout started on the Plan & billing page (Razorpay payment
--     link or subscription), so the page can offer the pending link and the webhook can resolve
--     a subscription back to its tenant, plan and first-cycle order;
--   * platform_plan_periods: the service period each paid cloud-plan order covers (GST invoice
--     lines, GET /billing/invoices);
--   * platform_renewal_reminders: reminders already sent (job platform.subscription-renewals);
--   * announcement_dismissals: banners a tenant has hidden (GET /announcements).
--
-- Enum-like columns use regex CHECKs; their values are mirrored in @kadai/shared/api/platform
-- (CheckoutModeSchema, CheckoutStatusSchema, CancelReasonSchema, BannerSchema.source).
-- =============================================================================

ALTER TABLE subscriptions
  ADD COLUMN past_due_since       timestamptz,
  ADD COLUMN cancel_requested_at  timestamptz,
  ADD COLUMN cancel_reason        text CHECK (cancel_reason IS NULL OR cancel_reason ~ '^(too_expensive|missing_features|moving_to_onprem|closing_business|other)$'),
  ADD COLUMN cancel_feedback      text CHECK (cancel_feedback IS NULL OR length(cancel_feedback) <= 1000),
  ADD COLUMN ended_at             timestamptz;

CREATE INDEX subscriptions_provider_subscription_idx ON subscriptions (provider_subscription_id)
  WHERE provider_subscription_id IS NOT NULL;
CREATE INDEX subscriptions_live_period_end_idx ON subscriptions (current_period_end)
  WHERE status IN ('trialing', 'active', 'past_due');

-- Checkouts (one per Razorpay payment link / subscription we create for a tenant).
CREATE TABLE platform_checkouts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mode             text NOT NULL CHECK (mode ~ '^(payment_link|subscription)$'),
  plan_code        text NOT NULL REFERENCES plans(code),
  billing_cycle    text NOT NULL CHECK (billing_cycle ~ '^(monthly|yearly)$'),
  coupon_code      citext,
  auto_renew       boolean NOT NULL DEFAULT false,
  -- Prepaid order, or the first-cycle order of a subscription with offers (free months /
  -- discounted first cycle); NULL for a plain monthly subscription.
  order_id         uuid REFERENCES vendor_orders(id),
  -- Months the order pays for (term + free months; first-cycle orders: until start_at).
  covers_months    integer CHECK (covers_months IS NULL OR covers_months BETWEEN 1 AND 120),
  -- Offer redemptions to record when the order is paid: [{offer_id, discount_paise}] (value given,
  -- free months valued at the plan's monthly price).
  redemptions      jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Razorpay payment link id (plink_…) or subscription id (sub_…).
  provider_ref     text NOT NULL,
  short_url        text NOT NULL,
  -- First amount the buyer pays (incl. GST).
  total_paise      bigint NOT NULL CHECK (total_paise >= 0),
  first_charge_on  date,
  -- Subscriptions: first Razorpay charge when later than the checkout.
  start_at         timestamptz,
  expires_at       timestamptz,
  status           text NOT NULL DEFAULT 'pending' CHECK (status ~ '^(pending|completed|expired|cancelled)$'),
  completed_at     timestamptz,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (mode = 'subscription' OR order_id IS NOT NULL),
  CHECK (auto_renew = (mode = 'subscription')),
  CHECK ((order_id IS NULL) = (covers_months IS NULL))
);
CREATE UNIQUE INDEX platform_checkouts_provider_ref_uq ON platform_checkouts (provider_ref);
CREATE INDEX platform_checkouts_tenant_idx ON platform_checkouts (tenant_id, created_at DESC);
CREATE INDEX platform_checkouts_order_idx ON platform_checkouts (order_id) WHERE order_id IS NOT NULL;

-- Service period of each fulfilled cloud-plan order (vendor_orders kind 'cloud_plan').
CREATE TABLE platform_plan_periods (
  order_id         uuid PRIMARY KEY REFERENCES vendor_orders(id),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id  uuid,
  plan_code        text NOT NULL REFERENCES plans(code),
  billing_cycle    text NOT NULL CHECK (billing_cycle ~ '^(monthly|yearly)$'),
  period_start     timestamptz NOT NULL,
  period_end       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end > period_start),
  FOREIGN KEY (tenant_id, subscription_id) REFERENCES subscriptions (tenant_id, id)
);
CREATE INDEX platform_plan_periods_tenant_idx ON platform_plan_periods (tenant_id, period_start DESC);

-- Renewal reminders already sent: one per subscription period and lead time (7 / 1 days).
CREATE TABLE platform_renewal_reminders (
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id  uuid NOT NULL,
  period_end       timestamptz NOT NULL,
  days_before      smallint NOT NULL CHECK (days_before BETWEEN 1 AND 60),
  notifications    integer NOT NULL DEFAULT 0 CHECK (notifications >= 0),
  sent_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subscription_id, period_end, days_before),
  FOREIGN KEY (tenant_id, subscription_id) REFERENCES subscriptions (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX platform_renewal_reminders_tenant_idx ON platform_renewal_reminders (tenant_id);

-- Announcement / offer banners hidden by a tenant. banner_id is announcements.id or offers.id
-- (vendor tables, system pool only — no foreign key from a tenant table).
CREATE TABLE announcement_dismissals (
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  banner_id     uuid NOT NULL,
  source        text NOT NULL CHECK (source ~ '^(announcement|offer)$'),
  dismissed_by  uuid REFERENCES users(id),
  dismissed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, banner_id)
);
