-- =============================================================================
-- Kadai — 0008 notifications outbox (SMS / WhatsApp / email) & templates
-- Messages are written to the outbox inside the business transaction and sent
-- by the worker (pg-boss), so a rollback never sends a message.
-- =============================================================================

CREATE TABLE notification_templates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code         text NOT NULL,          -- 'invoice_share','due_reminder','payment_receipt','daily_summary', ...
  channel      text NOT NULL CHECK (channel IN ('sms', 'whatsapp', 'email')),
  locale       text NOT NULL CHECK (locale IN ('ta', 'en')),
  subject      text,
  body         text NOT NULL,          -- {{placeholders}}
  provider_template_id text,           -- DLT template id (SMS) / WhatsApp approved template name
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code, channel, locale)
);

CREATE TABLE notifications (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel              text NOT NULL CHECK (channel IN ('sms', 'whatsapp', 'email')),
  template_code        text NOT NULL,
  locale               text NOT NULL DEFAULT 'ta',
  recipient            text NOT NULL,          -- E.164 phone or email
  recipient_name       text,
  params               jsonb NOT NULL DEFAULT '{}'::jsonb,
  rendered_body        text,
  status               text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'cancelled')),
  provider             text,
  provider_message_id  text,
  error                text,
  attempts             integer NOT NULL DEFAULT 0,
  ref_type             text,
  ref_id               uuid,
  scheduled_at         timestamptz NOT NULL DEFAULT now(),
  sent_at              timestamptz,
  created_by           uuid REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX notifications_queue_idx ON notifications (status, scheduled_at) WHERE status IN ('queued', 'sending');
CREATE INDEX notifications_tenant_time_idx ON notifications (tenant_id, created_at DESC);
CREATE INDEX notifications_ref_idx ON notifications (tenant_id, ref_type, ref_id);
