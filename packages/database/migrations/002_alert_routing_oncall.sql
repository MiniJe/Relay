-- Relay 0.2 / RLY-0.2-M-001 — Alert Routing & On-Call Foundation
--
-- Forward-only migration. It never alters, drops or rewrites Relay 0.1 data:
-- existing incidents, statuses, postmortems, alerts and integrations are left
-- exactly as 001_initial.sql created them. The only 0.1 tables touched are
-- `services` (one nullable owning-team column) and `services`/`alerts`
-- (additive unique indexes that enable tenant-safe composite foreign keys).
--
-- Tenant safety: configuration rows carry `organization_id` and reference their
-- parent through a composite (organization_id, id) key, so wiring another
-- organization's team, schedule, service or member into a configuration is
-- rejected by the database rather than only by application code.
--
-- Audit rows (alert_routings) intentionally use single-column referential keys
-- with ON DELETE SET NULL: a composite SET NULL would also null the referencing
-- organization_id. History survives deletion because names are snapshotted.
--
-- Handoff arithmetic is performed on absolute UTC instants by the application
-- (see packages/shared/oncall.mjs). `time_zone` stores an IANA identifier and
-- is used for validation and presentation only.

BEGIN;

-- ---------------------------------------------------------------------------
-- Additive uniqueness on 0.1 tables, required as composite FK reference targets.
-- `id` is already the primary key, so these are logically redundant but
-- physically necessary.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_services_org_id ON services(organization_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_org_id ON alerts(organization_id, id);

-- ---------------------------------------------------------------------------
-- Responder teams
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS responder_teams (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_responder_teams_org_slug UNIQUE (organization_id, slug),
  CONSTRAINT uq_responder_teams_org_id UNIQUE (organization_id, id)
);
CREATE INDEX IF NOT EXISTS idx_responder_teams_org ON responder_teams(organization_id, created_at);

-- Team membership never bypasses organization membership: the composite key to
-- organization_memberships makes it impossible to attach a user who is not a
-- member of the team's own organization.
CREATE TABLE IF NOT EXISTS responder_team_members (
  team_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_responder_team_members PRIMARY KEY (team_id, user_id),
  CONSTRAINT fk_team_members_team FOREIGN KEY (team_id, organization_id)
    REFERENCES responder_teams(id, organization_id) ON DELETE CASCADE,
  CONSTRAINT fk_team_members_membership FOREIGN KEY (organization_id, user_id)
    REFERENCES organization_memberships(organization_id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_responder_team_members_org ON responder_team_members(organization_id);
CREATE INDEX IF NOT EXISTS idx_responder_team_members_user ON responder_team_members(user_id);

-- ---------------------------------------------------------------------------
-- Service ownership. A Service may be owned by a responder team; a public
-- Component deliberately cannot. Service and Team remain distinct concepts.
-- ---------------------------------------------------------------------------
ALTER TABLE services ADD COLUMN IF NOT EXISTS owner_team_id TEXT;
DO $owner_team$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_services_owner_team') THEN
    ALTER TABLE services ADD CONSTRAINT fk_services_owner_team
      FOREIGN KEY (organization_id, owner_team_id)
      REFERENCES responder_teams(organization_id, id) ON DELETE SET NULL;
  END IF;
END
$owner_team$;
CREATE INDEX IF NOT EXISTS idx_services_owner_team ON services(owner_team_id) WHERE owner_team_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- On-call schedules
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oncall_schedules (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL,
  name TEXT NOT NULL,
  time_zone TEXT NOT NULL DEFAULT 'UTC',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  rotation_starts_at TIMESTAMPTZ NOT NULL,
  rotation_interval_minutes INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_schedules_team FOREIGN KEY (organization_id, team_id)
    REFERENCES responder_teams(organization_id, id) ON DELETE CASCADE,
  CONSTRAINT uq_schedules_org_id UNIQUE (organization_id, id),
  CONSTRAINT uq_schedules_org_team_id UNIQUE (organization_id, id, team_id),
  CONSTRAINT ck_schedules_interval CHECK (rotation_interval_minutes >= 60 AND rotation_interval_minutes <= 525600),
  CONSTRAINT ck_schedules_timezone CHECK (time_zone <> '' AND length(time_zone) <= 64)
);
CREATE INDEX IF NOT EXISTS idx_schedules_org ON oncall_schedules(organization_id, created_at);
CREATE INDEX IF NOT EXISTS idx_schedules_team ON oncall_schedules(team_id);

-- Ordered rotation participants. `position` is the rotation order and a person
-- may appear at most once per schedule. Removing a member from the team
-- cascades: leaving a rotation slot pointing at a non-member would be worse
-- than shrinking the rotation.
CREATE TABLE IF NOT EXISTS oncall_schedule_participants (
  schedule_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_schedule_participants PRIMARY KEY (schedule_id, position),
  CONSTRAINT uq_schedule_participants_user UNIQUE (schedule_id, user_id),
  CONSTRAINT fk_participants_schedule FOREIGN KEY (schedule_id, organization_id, team_id)
    REFERENCES oncall_schedules(id, organization_id, team_id) ON DELETE CASCADE,
  CONSTRAINT fk_participants_team_member FOREIGN KEY (team_id, user_id)
    REFERENCES responder_team_members(team_id, user_id) ON DELETE CASCADE,
  CONSTRAINT fk_participants_membership FOREIGN KEY (organization_id, user_id)
    REFERENCES organization_memberships(organization_id, user_id) ON DELETE CASCADE,
  CONSTRAINT ck_participants_position CHECK (position >= 0)
);
CREATE INDEX IF NOT EXISTS idx_schedule_participants_org ON oncall_schedule_participants(organization_id);

-- ---------------------------------------------------------------------------
-- On-call overrides (temporary, additive, never rewrite the rotation)
--
-- Overlap is rejected by the application inside a schedule-level lock; the
-- resolver additionally applies a documented deterministic tie-break so a
-- result can never be ambiguous even for pre-existing rows.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oncall_overrides (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  schedule_id TEXT NOT NULL,
  replacement_user_id TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_overrides_schedule FOREIGN KEY (organization_id, schedule_id)
    REFERENCES oncall_schedules(organization_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_overrides_replacement FOREIGN KEY (organization_id, replacement_user_id)
    REFERENCES organization_memberships(organization_id, user_id) ON DELETE CASCADE,
  CONSTRAINT uq_overrides_org_id UNIQUE (organization_id, id),
  CONSTRAINT ck_overrides_window CHECK (starts_at < ends_at)
);
CREATE INDEX IF NOT EXISTS idx_overrides_schedule_window ON oncall_overrides(schedule_id, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS idx_overrides_org ON oncall_overrides(organization_id, starts_at);

-- ---------------------------------------------------------------------------
-- Alert routing rules
--
-- Deletion of a matched Service cascades the rule. Fail-closed is deliberate:
-- nulling `match_service_id` would silently widen the rule to every service.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alert_routing_rules (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  priority INTEGER NOT NULL DEFAULT 100,
  match_service_id TEXT,
  match_source TEXT,
  match_severities JSONB NOT NULL DEFAULT '[]'::jsonb,
  target_kind TEXT NOT NULL DEFAULT 'ONCALL_SCHEDULE',
  target_schedule_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_rules_match_service FOREIGN KEY (organization_id, match_service_id)
    REFERENCES services(organization_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_rules_target_schedule FOREIGN KEY (organization_id, target_schedule_id)
    REFERENCES oncall_schedules(organization_id, id) ON DELETE CASCADE,
  CONSTRAINT uq_rules_org_id UNIQUE (organization_id, id),
  CONSTRAINT ck_rules_target_kind CHECK (target_kind IN ('ONCALL_SCHEDULE')),
  CONSTRAINT ck_rules_priority CHECK (priority >= 0 AND priority <= 100000),
  CONSTRAINT ck_rules_match_severities CHECK (jsonb_typeof(match_severities) = 'array')
);
CREATE INDEX IF NOT EXISTS idx_rules_org_priority ON alert_routing_rules(organization_id, enabled, priority, created_at, id);

-- ---------------------------------------------------------------------------
-- Routing / delivery audit record
--
-- Exactly one row per alert: `alert_id` is unique, which is the database-level
-- guarantee that a retried or concurrent intake of the same alert cannot
-- produce a second routing decision or a second notification.
--
-- Responder, team, schedule and rule *names* are snapshotted so history never
-- changes when a later rotation, rename or deletion happens.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alert_routings (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  alert_id TEXT NOT NULL,
  rule_id TEXT REFERENCES alert_routing_rules(id) ON DELETE SET NULL,
  rule_name TEXT,
  schedule_id TEXT REFERENCES oncall_schedules(id) ON DELETE SET NULL,
  schedule_name TEXT,
  team_id TEXT REFERENCES responder_teams(id) ON DELETE SET NULL,
  team_name TEXT,
  oncall_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  oncall_display_name TEXT,
  responder_source TEXT,
  override_id TEXT,
  resolution TEXT NOT NULL DEFAULT 'PENDING',
  period_starts_at TIMESTAMPTZ,
  period_ends_at TIMESTAMPTZ,
  notification_status TEXT NOT NULL DEFAULT 'NOT_ATTEMPTED',
  notification_provider TEXT,
  notification_error TEXT,
  notified_at TIMESTAMPTZ,
  discord_user_id TEXT,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  acknowledged_by_display_name TEXT,
  incident_id TEXT REFERENCES incidents(id) ON DELETE SET NULL,
  evaluated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_alert_routings_alert UNIQUE (alert_id),
  CONSTRAINT fk_routings_alert FOREIGN KEY (organization_id, alert_id)
    REFERENCES alerts(organization_id, id) ON DELETE CASCADE,
  CONSTRAINT uq_routings_org_id UNIQUE (organization_id, id),
  CONSTRAINT ck_routings_resolution CHECK (resolution IN (
    'PENDING','ROUTED','NO_MATCHING_RULE','SCHEDULE_DISABLED','SCHEDULE_MISSING',
    'ROTATION_NOT_STARTED','NO_PARTICIPANTS','RULE_TARGET_MISSING'
  )),
  CONSTRAINT ck_routings_responder_source CHECK (responder_source IS NULL OR responder_source IN ('ROTATION','OVERRIDE')),
  CONSTRAINT ck_routings_notification_status CHECK (notification_status IN (
    'NOT_ATTEMPTED','SENT','FAILED','SKIPPED_NO_INTEGRATION','SKIPPED_DISABLED','SKIPPED_NO_RESPONDER'
  ))
);
CREATE INDEX IF NOT EXISTS idx_routings_org_created ON alert_routings(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_routings_org_unacked ON alert_routings(organization_id, acknowledged_at) WHERE acknowledged_at IS NULL;

-- ---------------------------------------------------------------------------
-- Optional Relay user -> Discord user mapping. No OAuth and no secrets: a
-- Discord snowflake is a public identifier used only to mention the responder.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS discord_identities (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  discord_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_discord_identities_membership FOREIGN KEY (organization_id, user_id)
    REFERENCES organization_memberships(organization_id, user_id) ON DELETE CASCADE,
  CONSTRAINT uq_discord_identities_org_user UNIQUE (organization_id, user_id),
  CONSTRAINT ck_discord_identities_snowflake CHECK (discord_user_id ~ '^[0-9]{15,25}$')
);

COMMIT;
