-- Relay 0.2 / RLY-0.2-M-002 — escalation plans and durable paging foundation.
-- Forward-only additive migration. Existing integrations retain their encrypted
-- secret and receive an empty structured config; legacy rules default to Discord.
BEGIN;

ALTER TABLE integrations ADD COLUMN IF NOT EXISTS config JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE integrations DROP CONSTRAINT IF EXISTS integrations_provider_check;
ALTER TABLE integrations ADD CONSTRAINT ck_integrations_provider
  CHECK (provider IN ('DISCORD','SLACK','SMTP'));

CREATE TABLE escalation_policies (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, name)
);

CREATE TABLE escalation_policy_steps (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  after_minutes INTEGER NOT NULL,
  target_schedule_id TEXT NOT NULL,
  channels JSONB NOT NULL DEFAULT '["DISCORD"]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (policy_id, position),
  UNIQUE (policy_id, after_minutes),
  FOREIGN KEY (organization_id, policy_id)
    REFERENCES escalation_policies(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, target_schedule_id)
    REFERENCES oncall_schedules(organization_id, id) ON DELETE RESTRICT,
  CHECK (position >= 0),
  CHECK (after_minutes > 0),
  CHECK (jsonb_typeof(channels) = 'array' AND jsonb_array_length(channels) > 0)
);
CREATE INDEX idx_escalation_steps_order ON escalation_policy_steps(policy_id, position);

ALTER TABLE alert_routing_rules ADD COLUMN IF NOT EXISTS notification_channels JSONB NOT NULL DEFAULT '["DISCORD"]'::jsonb;
ALTER TABLE alert_routing_rules ADD COLUMN IF NOT EXISTS escalation_policy_id TEXT;
ALTER TABLE alert_routing_rules ADD CONSTRAINT fk_rules_escalation_policy
  FOREIGN KEY (organization_id, escalation_policy_id)
  REFERENCES escalation_policies(organization_id, id) ON DELETE SET NULL (escalation_policy_id);
ALTER TABLE alert_routing_rules ADD CONSTRAINT ck_rules_notification_channels
  CHECK (jsonb_typeof(notification_channels) = 'array' AND jsonb_array_length(notification_channels) > 0);

-- Snapshots let an alert's existing plan survive policy edits/deletion.
CREATE TABLE escalation_jobs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  alert_id TEXT NOT NULL,
  routing_id TEXT NOT NULL,
  policy_id TEXT,
  policy_name_snapshot TEXT NOT NULL,
  step_position INTEGER NOT NULL,
  after_minutes INTEGER NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  target_schedule_id TEXT,
  target_schedule_name_snapshot TEXT NOT NULL,
  channels JSONB NOT NULL,
  state TEXT NOT NULL DEFAULT 'PENDING',
  claimed_at TIMESTAMPTZ,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  executed_at TIMESTAMPTZ,
  -- Snapshot of who was actually resolved when the step executed, so the
  -- execution history survives later rotation changes.
  resolved_responder_user_id TEXT,
  resolved_responder_name_snapshot TEXT,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (routing_id, step_position),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, alert_id) REFERENCES alerts(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, routing_id) REFERENCES alert_routings(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, target_schedule_id) REFERENCES oncall_schedules(organization_id, id) ON DELETE SET NULL (target_schedule_id),
  CHECK (state IN ('PENDING','IN_FLIGHT','COMPLETED','FAILED','CANCELLED_ACKNOWLEDGED'))
);
CREATE INDEX idx_escalation_jobs_due ON escalation_jobs(due_at, id) WHERE state IN ('PENDING','IN_FLIGHT');
CREATE INDEX idx_escalation_jobs_lease ON escalation_jobs(lease_expires_at) WHERE state='IN_FLIGHT';

CREATE TABLE notification_deliveries (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  alert_id TEXT NOT NULL,
  routing_id TEXT NOT NULL,
  escalation_job_id TEXT,
  provider TEXT NOT NULL,
  destination_snapshot JSONB NOT NULL,
  responder_user_id TEXT,
  responder_name_snapshot TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_attempt_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  -- Lease ownership. A worker may only write an outcome while it still owns the
  -- lease, so reclaimed work can never be overwritten by a zombie process.
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  manual_retry_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, alert_id) REFERENCES alerts(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, routing_id) REFERENCES alert_routings(organization_id, id) ON DELETE CASCADE,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, escalation_job_id) REFERENCES escalation_jobs(organization_id, id) ON DELETE SET NULL (escalation_job_id),
  CHECK (provider IN ('DISCORD','SLACK','EMAIL')),
  CHECK (status IN ('PENDING','IN_FLIGHT','RETRYING','SENT','FAILED','CANCELLED')),
  CHECK (attempt_count >= 0),
  -- Manual retries may add attempts beyond the bounded automatic policy, but a
  -- SENT delivery is never silently re-queued.
  CHECK (manual_retry_by_user_id IS NULL OR status <> 'SENT')
);
CREATE INDEX idx_notification_deliveries_due ON notification_deliveries(next_attempt_at, id) WHERE status IN ('PENDING','RETRYING','IN_FLIGHT');
CREATE INDEX idx_notification_deliveries_lease ON notification_deliveries(lease_expires_at) WHERE status='IN_FLIGHT';
CREATE INDEX idx_notification_deliveries_org_alert ON notification_deliveries(organization_id, alert_id, created_at);
-- Idempotency: one logical delivery per (routing, escalation step, provider).
-- Duplicate alert intake, a replayed route pass or a reclaimed escalation step
-- can therefore never create a second page for the same channel.
CREATE UNIQUE INDEX ux_notification_deliveries_immediate
  ON notification_deliveries(organization_id, routing_id, provider) WHERE escalation_job_id IS NULL;
CREATE UNIQUE INDEX ux_notification_deliveries_escalation
  ON notification_deliveries(organization_id, escalation_job_id, provider) WHERE escalation_job_id IS NOT NULL;

CREATE TABLE notification_attempts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  error_code TEXT,
  safe_error TEXT,
  provider_status_code INTEGER,
  manual_retry_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  manual BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (delivery_id, attempt_number),
  FOREIGN KEY (organization_id, delivery_id) REFERENCES notification_deliveries(organization_id, id) ON DELETE CASCADE,
  CHECK (outcome IN ('SENT','RETRYABLE_FAILURE','PERMANENT_FAILURE')),
  CHECK (attempt_number > 0),
  CHECK (provider_status_code IS NULL OR (provider_status_code >= 100 AND provider_status_code <= 599))
);
CREATE INDEX idx_notification_attempts_delivery ON notification_attempts(delivery_id, attempt_number);

COMMIT;
