ALTER TABLE knowledge_versions ADD CONSTRAINT knowledge_versions_tenant_id_unique UNIQUE(tenant_id,id);
ALTER TABLE ai_assist_runs DROP CONSTRAINT ai_assist_runs_kind_check;
ALTER TABLE ai_assist_runs ADD CONSTRAINT ai_assist_runs_kind_check CHECK(kind IN ('creative','order_review','artwork_preflight','template_config','sku_package','business_review','procurement_review','after_sales_review','knowledge_answer'));
CREATE TABLE knowledge_documents (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), created_at timestamptz NOT NULL DEFAULT now(), revision integer NOT NULL DEFAULT 1,
 kind text NOT NULL CHECK(kind IN ('reference','account')), file_name text NOT NULL, media_type text NOT NULL, checksum text NOT NULL,
 encrypted_original text, encrypted_parsed text, raw_expires_at timestamptz NOT NULL, safe_text text NOT NULL DEFAULT '',
 state text NOT NULL CHECK(state IN ('preview','confirmed','failed','archived')), diagnostics jsonb NOT NULL, fields jsonb NOT NULL, account jsonb,
 store_id uuid, created_by uuid NOT NULL REFERENCES app_users(id), request_id uuid NOT NULL, request_checksum text NOT NULL,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,request_id), FOREIGN KEY(tenant_id,store_id) REFERENCES marketplace_accounts(tenant_id,id),
 CHECK ((kind='account' AND store_id IS NOT NULL AND account->>'storeId'=store_id::text) OR (kind='reference' AND store_id IS NULL AND account IS NULL))
);
CREATE TABLE knowledge_candidates (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), created_at timestamptz NOT NULL DEFAULT now(), document_id uuid NOT NULL,
 revision integer NOT NULL DEFAULT 1, fields jsonb NOT NULL, locator text NOT NULL, excerpt text NOT NULL,
 decision text NOT NULL DEFAULT 'pending' CHECK(decision IN ('pending','accepted','rejected')), entry_id uuid, request_id uuid, request_checksum text,
 FOREIGN KEY(tenant_id,document_id) REFERENCES knowledge_documents(tenant_id,id), FOREIGN KEY(tenant_id,entry_id) REFERENCES knowledge_entries(tenant_id,id)
);
CREATE TABLE knowledge_sources (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), created_at timestamptz NOT NULL DEFAULT now(), revision integer NOT NULL DEFAULT 1,
 label text NOT NULL, url text NOT NULL, owner text NOT NULL, check_every_hours integer NOT NULL CHECK(check_every_hours BETWEEN 6 AND 720),
 freshness_days integer NOT NULL CHECK(freshness_days BETWEEN 1 AND 365), monitoring boolean NOT NULL, latest_snapshot_id uuid,
 last_checked_at timestamptz, last_success_at timestamptz, last_error text, next_check_at timestamptz,
 request_id uuid NOT NULL, request_checksum text NOT NULL, created_by uuid NOT NULL REFERENCES app_users(id), archived_at timestamptz,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,request_id)
);
CREATE TABLE knowledge_source_snapshots (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), created_at timestamptz NOT NULL DEFAULT now(), source_id uuid NOT NULL,
 url text NOT NULL, body text NOT NULL, checksum text NOT NULL, valid_until timestamptz NOT NULL, UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,source_id) REFERENCES knowledge_sources(tenant_id,id)
);
ALTER TABLE knowledge_sources ADD CONSTRAINT knowledge_source_latest_fk FOREIGN KEY(tenant_id,latest_snapshot_id) REFERENCES knowledge_source_snapshots(tenant_id,id);
CREATE TABLE knowledge_source_checks (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), created_at timestamptz NOT NULL DEFAULT now(),
 source_id uuid NOT NULL, result text NOT NULL, diagnostic text NOT NULL, snapshot_id uuid,
 FOREIGN KEY(tenant_id,source_id) REFERENCES knowledge_sources(tenant_id,id),
 FOREIGN KEY(tenant_id,snapshot_id) REFERENCES knowledge_source_snapshots(tenant_id,id)
);
CREATE TABLE knowledge_source_reviews (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), created_at timestamptz NOT NULL DEFAULT now(), source_id uuid NOT NULL,
 revision integer NOT NULL DEFAULT 1, before_snapshot_id uuid, after_snapshot_id uuid NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','no_business_change','revision_required','needs_evidence','completed')),
 reason text NOT NULL DEFAULT '', entry_ids jsonb NOT NULL DEFAULT '[]',
 FOREIGN KEY(tenant_id,source_id) REFERENCES knowledge_sources(tenant_id,id),
 FOREIGN KEY(tenant_id,before_snapshot_id) REFERENCES knowledge_source_snapshots(tenant_id,id),
 FOREIGN KEY(tenant_id,after_snapshot_id) REFERENCES knowledge_source_snapshots(tenant_id,id)
);
CREATE TABLE knowledge_needs (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), created_at timestamptz NOT NULL DEFAULT now(),
 revision integer NOT NULL DEFAULT 1, question text NOT NULL, owner text NOT NULL, search_scope jsonb NOT NULL, entry_ids jsonb NOT NULL,
 request_id uuid NOT NULL, archived_at timestamptz
);
CREATE TABLE knowledge_conflicts (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), created_at timestamptz NOT NULL DEFAULT now(),
 revision integer NOT NULL DEFAULT 1, key text NOT NULL, left_version_id uuid NOT NULL, right_version_id uuid NOT NULL,
 fingerprint text NOT NULL, severity text NOT NULL CHECK(severity IN ('warning','blocking')),
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','conditional','superseded','needs_evidence')), reason text NOT NULL DEFAULT '',
 UNIQUE(tenant_id,fingerprint),
 FOREIGN KEY(tenant_id,left_version_id) REFERENCES knowledge_versions(tenant_id,id),
 FOREIGN KEY(tenant_id,right_version_id) REFERENCES knowledge_versions(tenant_id,id)
);
CREATE TABLE knowledge_evaluation_cases (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), created_at timestamptz NOT NULL DEFAULT now(),
 revision integer NOT NULL DEFAULT 1, fields jsonb NOT NULL, request_id uuid NOT NULL, archived_at timestamptz
);
CREATE TABLE knowledge_evaluation_runs (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), created_at timestamptz NOT NULL DEFAULT now(),
 case_id uuid NOT NULL REFERENCES knowledge_evaluation_cases(id), assist_run_id uuid NOT NULL REFERENCES ai_assist_runs(id),
 case_snapshot jsonb NOT NULL, request_id uuid NOT NULL, created_by uuid NOT NULL REFERENCES app_users(id), UNIQUE(tenant_id,request_id)
);
CREATE TABLE knowledge_governance_events (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), created_at timestamptz NOT NULL DEFAULT now(),
 resource_id uuid NOT NULL, action text NOT NULL, reason text NOT NULL, detail jsonb NOT NULL, created_by uuid NOT NULL REFERENCES app_users(id)
);
--> statement-breakpoint
CREATE FUNCTION protect_knowledge_document() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.checksum<>OLD.checksum OR NEW.created_by<>OLD.created_by OR NEW.kind<>OLD.kind OR NEW.store_id IS DISTINCT FROM OLD.store_id
 OR NEW.account IS DISTINCT FROM OLD.account OR NEW.fields IS DISTINCT FROM OLD.fields
 OR (NEW.encrypted_original IS DISTINCT FROM OLD.encrypted_original AND NEW.encrypted_original IS NOT NULL)
 OR (NEW.encrypted_parsed IS DISTINCT FROM OLD.encrypted_parsed AND NEW.encrypted_parsed IS NOT NULL)
 OR (OLD.state='confirmed' AND NEW.safe_text<>OLD.safe_text)
 THEN RAISE EXCEPTION 'Knowledge original and confirmed evidence are immutable'; END IF; RETURN NEW; END $$;
CREATE TRIGGER knowledge_documents_original BEFORE UPDATE ON knowledge_documents FOR EACH ROW EXECUTE FUNCTION protect_knowledge_document();
ALTER TABLE knowledge_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_documents_tenant ON knowledge_documents FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT,UPDATE ON knowledge_documents TO yummyai_app;
CREATE INDEX knowledge_documents_workspace ON knowledge_documents(tenant_id,created_at DESC);
ALTER TABLE knowledge_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_candidates FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_candidates_tenant ON knowledge_candidates FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT,UPDATE ON knowledge_candidates TO yummyai_app;
CREATE INDEX knowledge_candidates_workspace ON knowledge_candidates(tenant_id,created_at DESC);
ALTER TABLE knowledge_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_sources_tenant ON knowledge_sources FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT,UPDATE ON knowledge_sources TO yummyai_app;
CREATE INDEX knowledge_sources_workspace ON knowledge_sources(tenant_id,created_at DESC);
ALTER TABLE knowledge_source_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_source_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_source_snapshots_tenant ON knowledge_source_snapshots FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT ON knowledge_source_snapshots TO yummyai_app;
CREATE INDEX knowledge_source_snapshots_workspace ON knowledge_source_snapshots(tenant_id,created_at DESC);
CREATE TRIGGER knowledge_source_snapshots_immutable BEFORE UPDATE OR DELETE ON knowledge_source_snapshots FOR EACH ROW EXECUTE FUNCTION protect_knowledge_history();
ALTER TABLE knowledge_source_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_source_checks FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_source_checks_tenant ON knowledge_source_checks FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT ON knowledge_source_checks TO yummyai_app;
CREATE INDEX knowledge_source_checks_workspace ON knowledge_source_checks(tenant_id,created_at DESC);
CREATE TRIGGER knowledge_source_checks_immutable BEFORE UPDATE OR DELETE ON knowledge_source_checks FOR EACH ROW EXECUTE FUNCTION protect_knowledge_history();
ALTER TABLE knowledge_source_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_source_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_source_reviews_tenant ON knowledge_source_reviews FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT,UPDATE ON knowledge_source_reviews TO yummyai_app;
CREATE INDEX knowledge_source_reviews_workspace ON knowledge_source_reviews(tenant_id,created_at DESC);
ALTER TABLE knowledge_needs ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_needs FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_needs_tenant ON knowledge_needs FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT,UPDATE ON knowledge_needs TO yummyai_app;
CREATE INDEX knowledge_needs_workspace ON knowledge_needs(tenant_id,created_at DESC);
ALTER TABLE knowledge_conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_conflicts FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_conflicts_tenant ON knowledge_conflicts FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT,UPDATE ON knowledge_conflicts TO yummyai_app;
CREATE INDEX knowledge_conflicts_workspace ON knowledge_conflicts(tenant_id,created_at DESC);
ALTER TABLE knowledge_evaluation_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_evaluation_cases FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_evaluation_cases_tenant ON knowledge_evaluation_cases FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT,UPDATE ON knowledge_evaluation_cases TO yummyai_app;
CREATE INDEX knowledge_evaluation_cases_workspace ON knowledge_evaluation_cases(tenant_id,created_at DESC);
ALTER TABLE knowledge_evaluation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_evaluation_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_evaluation_runs_tenant ON knowledge_evaluation_runs FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT ON knowledge_evaluation_runs TO yummyai_app;
CREATE INDEX knowledge_evaluation_runs_workspace ON knowledge_evaluation_runs(tenant_id,created_at DESC);
CREATE TRIGGER knowledge_evaluation_runs_immutable BEFORE UPDATE OR DELETE ON knowledge_evaluation_runs FOR EACH ROW EXECUTE FUNCTION protect_knowledge_history();
ALTER TABLE knowledge_governance_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_governance_events FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_governance_events_tenant ON knowledge_governance_events FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT ON knowledge_governance_events TO yummyai_app;
CREATE INDEX knowledge_governance_events_workspace ON knowledge_governance_events(tenant_id,created_at DESC);
CREATE TRIGGER knowledge_governance_events_immutable BEFORE UPDATE OR DELETE ON knowledge_governance_events FOR EACH ROW EXECUTE FUNCTION protect_knowledge_history();
