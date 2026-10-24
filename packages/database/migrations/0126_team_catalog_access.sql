CREATE TABLE organization_teams (
 id uuid PRIMARY KEY CHECK(substring(id::text from 15 for 1)='7'),
 tenant_id uuid NOT NULL REFERENCES organizations(id),name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),access_generation integer NOT NULL DEFAULT 1 CHECK(access_generation>0),created_by uuid NOT NULL REFERENCES app_users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id)
);
CREATE UNIQUE INDEX organization_teams_name_unique ON organization_teams(tenant_id,lower(name));
CREATE TABLE organization_team_members (
 id uuid PRIMARY KEY CHECK(substring(id::text from 15 for 1)='7'),tenant_id uuid NOT NULL REFERENCES organizations(id),
 team_id uuid NOT NULL,membership_id uuid NOT NULL,active boolean NOT NULL DEFAULT true,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),created_by uuid NOT NULL REFERENCES app_users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,team_id,membership_id),
 FOREIGN KEY(tenant_id,team_id) REFERENCES organization_teams(tenant_id,id),
 FOREIGN KEY(tenant_id,membership_id) REFERENCES memberships(tenant_id,id)
);
CREATE INDEX organization_team_members_membership_idx ON organization_team_members(tenant_id,membership_id);
CREATE TABLE organization_team_commands (
 id uuid PRIMARY KEY CHECK(substring(id::text from 15 for 1)='7'),tenant_id uuid NOT NULL REFERENCES organizations(id),
 actor_id uuid NOT NULL REFERENCES app_users(id),request_id uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,request_id)
);
ALTER TABLE organization_teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_teams FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_teams_tenant ON organization_teams FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
ALTER TABLE organization_team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_team_members FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_team_members_tenant ON organization_team_members FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
ALTER TABLE organization_team_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_team_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_team_commands_tenant ON organization_team_commands FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT,UPDATE,DELETE ON organization_teams,organization_team_members TO yummyai_app;
GRANT SELECT,INSERT ON organization_team_commands TO yummyai_app;
CREATE FUNCTION reject_team_command_changes() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'team command receipts are immutable' USING ERRCODE='55000'; END $$;
CREATE TRIGGER organization_team_commands_immutable BEFORE UPDATE OR DELETE ON organization_team_commands FOR EACH ROW EXECUTE FUNCTION reject_team_command_changes();
ALTER TABLE product_plans ADD COLUMN team_id uuid;
ALTER TABLE product_plans ADD CONSTRAINT product_plans_team_fk FOREIGN KEY(tenant_id,team_id) REFERENCES organization_teams(tenant_id,id);
CREATE INDEX product_plans_team_idx ON product_plans(tenant_id,team_id);
ALTER TABLE artwork_masters ADD COLUMN team_id uuid;
ALTER TABLE artwork_masters ADD CONSTRAINT artwork_masters_team_fk FOREIGN KEY(tenant_id,team_id) REFERENCES organization_teams(tenant_id,id);
CREATE INDEX artwork_masters_team_idx ON artwork_masters(tenant_id,team_id);
