BEGIN;

-- Abort invalid legacy command references; never silently repair ownership.
DO $$
DECLARE invalid_ids TEXT;
BEGIN
  SELECT string_agg(i.id, ', ') INTO invalid_ids FROM incidents i
  WHERE i.commander_user_id IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM organization_memberships m WHERE m.organization_id=i.organization_id AND m.user_id=i.commander_user_id);
  IF invalid_ids IS NOT NULL THEN RAISE EXCEPTION 'Cross-tenant legacy commanders on incidents: %', invalid_ids; END IF;
END $$;

ALTER TABLE incidents ADD CONSTRAINT incidents_org_id_unique UNIQUE (organization_id,id);
ALTER TABLE incidents ADD COLUMN revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0);
ALTER TABLE incidents ADD COLUMN communications_owner_user_id TEXT;
ALTER TABLE incidents ADD COLUMN next_public_update_at TIMESTAMPTZ;
ALTER TABLE incidents ADD CONSTRAINT incident_commander_membership FOREIGN KEY (organization_id,commander_user_id) REFERENCES organization_memberships(organization_id,user_id);
ALTER TABLE incidents ADD CONSTRAINT incident_communications_membership FOREIGN KEY (organization_id,communications_owner_user_id) REFERENCES organization_memberships(organization_id,user_id);

ALTER TABLE incident_timeline_events ADD COLUMN organization_id TEXT;
ALTER TABLE incident_timeline_events ADD COLUMN incident_revision BIGINT NOT NULL DEFAULT 0;
ALTER TABLE incident_timeline_events ADD COLUMN event_index INTEGER NOT NULL DEFAULT 0;
ALTER TABLE incident_timeline_events ADD COLUMN actor_display_name_snapshot TEXT;
ALTER TABLE incident_timeline_events ADD COLUMN schema_version SMALLINT NOT NULL DEFAULT 0;
UPDATE incident_timeline_events e SET organization_id=i.organization_id FROM incidents i WHERE i.id=e.incident_id;
WITH numbered AS (SELECT id,row_number() OVER (PARTITION BY incident_id ORDER BY occurred_at,id)-1 AS n FROM incident_timeline_events)
UPDATE incident_timeline_events e SET event_index=numbered.n FROM numbered WHERE numbered.id=e.id;
ALTER TABLE incident_timeline_events ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE incident_timeline_events ADD CONSTRAINT timeline_tenant_incident FOREIGN KEY (organization_id,incident_id) REFERENCES incidents(organization_id,id);
CREATE UNIQUE INDEX timeline_revision_order ON incident_timeline_events(incident_id,incident_revision,event_index);

CREATE TABLE incident_handoffs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  from_user_id TEXT REFERENCES users(id),
  to_user_id TEXT NOT NULL REFERENCES users(id),
  requested_by_user_id TEXT NOT NULL REFERENCES users(id),
  from_name_snapshot TEXT,
  to_name_snapshot TEXT NOT NULL,
  requested_by_name_snapshot TEXT NOT NULL,
  note TEXT NOT NULL CHECK (length(note) BETWEEN 1 AND 5000),
  state TEXT NOT NULL CHECK (state IN ('PENDING','ACCEPTED','DECLINED','CANCELLED')),
  created_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ,
  decided_by_user_id TEXT REFERENCES users(id),
  decided_by_name_snapshot TEXT,
  decision_reason TEXT,
  creation_payload_hash TEXT NOT NULL,
  FOREIGN KEY (organization_id,incident_id) REFERENCES incidents(organization_id,id),
  CHECK ((state='PENDING' AND decided_at IS NULL AND decided_by_user_id IS NULL) OR
         (state<>'PENDING' AND decided_at IS NOT NULL AND decided_by_user_id IS NOT NULL)),
  CHECK (state<>'CANCELLED' OR (decision_reason IS NOT NULL AND length(decision_reason)>0))
);
CREATE UNIQUE INDEX one_pending_incident_handoff ON incident_handoffs(organization_id,incident_id) WHERE state='PENDING';
CREATE INDEX incident_handoff_history ON incident_handoffs(organization_id,incident_id,created_at,id);

CREATE TABLE incident_tasks (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('RESPONSE','FOLLOW_UP')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description)<=5000),
  state TEXT NOT NULL CHECK (state IN ('TODO','IN_PROGRESS','BLOCKED','DONE','CANCELLED')),
  assignee_user_id TEXT,
  assignee_name_snapshot TEXT,
  due_at TIMESTAMPTZ,
  blocked_reason TEXT,
  cancellation_reason TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_by_name_snapshot TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  creation_payload_hash TEXT NOT NULL,
  FOREIGN KEY (organization_id,incident_id) REFERENCES incidents(organization_id,id),
  FOREIGN KEY (organization_id,assignee_user_id) REFERENCES organization_memberships(organization_id,user_id),
  CHECK ((state='BLOCKED' AND blocked_reason IS NOT NULL AND length(blocked_reason) BETWEEN 1 AND 1000) OR (state<>'BLOCKED' AND blocked_reason IS NULL)),
  CHECK ((state='CANCELLED' AND cancellation_reason IS NOT NULL AND length(cancellation_reason) BETWEEN 1 AND 1000) OR (state<>'CANCELLED' AND cancellation_reason IS NULL)),
  CHECK ((state='DONE') = (completed_at IS NOT NULL))
);
CREATE INDEX incident_task_history ON incident_tasks(organization_id,incident_id,created_at,id);
CREATE INDEX incident_task_due ON incident_tasks(organization_id,assignee_user_id,due_at,id) WHERE state NOT IN ('DONE','CANCELLED');

COMMIT;
