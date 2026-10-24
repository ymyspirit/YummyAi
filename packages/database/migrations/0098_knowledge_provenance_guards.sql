ALTER TABLE ai_assist_runs DROP CONSTRAINT IF EXISTS ai_assist_runs_kind_check;
ALTER TABLE ai_assist_runs ADD CONSTRAINT ai_assist_runs_kind_check CHECK(kind IN ('creative','order_review','artwork_preflight','template_config','sku_package','business_review','procurement_review','after_sales_review','knowledge_answer'));
ALTER TABLE knowledge_evaluation_cases ADD CONSTRAINT knowledge_evaluation_cases_tenant_id_unique UNIQUE(tenant_id,id);
ALTER TABLE knowledge_evaluation_runs ADD CONSTRAINT knowledge_evaluation_case_tenant_fk FOREIGN KEY(tenant_id,case_id) REFERENCES knowledge_evaluation_cases(tenant_id,id);
ALTER TABLE knowledge_evaluation_runs ADD CONSTRAINT knowledge_evaluation_assist_tenant_fk FOREIGN KEY(tenant_id,assist_run_id) REFERENCES ai_assist_runs(tenant_id,id);
CREATE TABLE knowledge_evidence_links (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),version_id uuid NOT NULL,document_id uuid,snapshot_id uuid,
 CHECK((document_id IS NOT NULL)::integer+(snapshot_id IS NOT NULL)::integer=1),
 UNIQUE(tenant_id,version_id,document_id),UNIQUE(tenant_id,version_id,snapshot_id),
 FOREIGN KEY(tenant_id,version_id) REFERENCES knowledge_versions(tenant_id,id),
 FOREIGN KEY(tenant_id,document_id) REFERENCES knowledge_documents(tenant_id,id),
 FOREIGN KEY(tenant_id,snapshot_id) REFERENCES knowledge_source_snapshots(tenant_id,id)
);
ALTER TABLE knowledge_evidence_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_evidence_links FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_evidence_links_tenant ON knowledge_evidence_links FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT ON knowledge_evidence_links TO yummyai_app;
CREATE TRIGGER knowledge_evidence_links_immutable BEFORE UPDATE OR DELETE ON knowledge_evidence_links FOR EACH ROW EXECUTE FUNCTION protect_knowledge_history();
--> statement-breakpoint
CREATE FUNCTION verify_knowledge_version_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(NEW.fields->'documentIds','[]')) d WHERE NOT EXISTS(SELECT 1 FROM knowledge_evidence_links l WHERE l.tenant_id=NEW.tenant_id AND l.version_id=NEW.id AND l.document_id=d::uuid))
 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(NEW.fields->'sourceSnapshotIds','[]')) s WHERE NOT EXISTS(SELECT 1 FROM knowledge_evidence_links l WHERE l.tenant_id=NEW.tenant_id AND l.version_id=NEW.id AND l.snapshot_id=s::uuid))
 THEN RAISE EXCEPTION 'Knowledge evidence must have immutable tenant provenance'; END IF; RETURN NEW; END $$;
CREATE CONSTRAINT TRIGGER knowledge_versions_evidence AFTER INSERT ON knowledge_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_knowledge_version_evidence();
CREATE OR REPLACE FUNCTION protect_knowledge_document() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.checksum<>OLD.checksum OR NEW.file_name<>OLD.file_name OR NEW.media_type<>OLD.media_type OR NEW.created_by<>OLD.created_by OR NEW.kind<>OLD.kind OR NEW.store_id IS DISTINCT FROM OLD.store_id
 OR NEW.account IS DISTINCT FROM OLD.account OR NEW.fields IS DISTINCT FROM OLD.fields
 OR (NEW.encrypted_original IS DISTINCT FROM OLD.encrypted_original AND NEW.encrypted_original IS NOT NULL)
 OR (NEW.encrypted_parsed IS DISTINCT FROM OLD.encrypted_parsed AND NEW.encrypted_parsed IS NOT NULL)
 OR (OLD.state='confirmed' AND NEW.safe_text<>OLD.safe_text)
 THEN RAISE EXCEPTION 'Knowledge original and confirmed evidence are immutable'; END IF; RETURN NEW; END $$;
