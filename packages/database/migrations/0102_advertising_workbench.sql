CREATE TABLE ad_import_batches (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), account_id uuid NOT NULL, created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
 idempotency_key text NOT NULL, input_checksum text NOT NULL CHECK(input_checksum ~ '^[a-f0-9]{64}$'),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,account_id,idempotency_key), UNIQUE(tenant_id,account_id,input_checksum), FOREIGN KEY(tenant_id,account_id) REFERENCES marketplace_accounts(tenant_id,id)
);
CREATE TABLE ad_imports (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), account_id uuid NOT NULL, created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
 batch_id uuid NOT NULL, file_name text NOT NULL, period_start text, period_end text, checksum text NOT NULL CHECK(checksum ~ '^[a-f0-9]{64}$'), object_key text NOT NULL, byte_size integer NOT NULL CHECK(byte_size BETWEEN 1 AND 5242880), report_type text NOT NULL,
 metadata jsonb NOT NULL, source_row_count integer NOT NULL CHECK(source_row_count>=0), accepted_row_count integer NOT NULL CHECK(accepted_row_count>=0), rejected_row_count integer NOT NULL CHECK(rejected_row_count>=0), diagnostics jsonb NOT NULL, scan jsonb NOT NULL CHECK(scan->>'result'='clean'), archived_at timestamptz,
 UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,account_id) REFERENCES marketplace_accounts(tenant_id,id), FOREIGN KEY(tenant_id,batch_id) REFERENCES ad_import_batches(tenant_id,id),
 CHECK(object_key LIKE 'tenants/'||tenant_id::text||'/advertising/%'),
 CHECK(report_type IN ('campaign','advertised_product','targeting','search_term','placement','converted_product','audience','benchmark','delivery_measurement','search_term_share','top_of_search_share'))
);
CREATE INDEX ad_imports_scope ON ad_imports(tenant_id,account_id,created_at);
CREATE TABLE ad_facts (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), import_id uuid NOT NULL, row_key text NOT NULL, entity_key text NOT NULL, fact jsonb NOT NULL,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,import_id,row_key), FOREIGN KEY(tenant_id,import_id) REFERENCES ad_imports(tenant_id,id), CHECK(row_key=fact->>'rowKey' AND entity_key=fact->>'entityKey')
);
CREATE INDEX ad_facts_entity ON ad_facts(tenant_id,entity_key);
CREATE TABLE ad_products (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), account_id uuid NOT NULL, created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
 marketplace text NOT NULL, currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'), asin text NOT NULL CHECK(asin ~ '^[A-Z0-9]{10}$'), revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,account_id,marketplace,currency,asin), FOREIGN KEY(tenant_id,account_id) REFERENCES marketplace_accounts(tenant_id,id)
);
CREATE TABLE ad_goal_versions (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), account_id uuid NOT NULL, created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
 product_id uuid NOT NULL, revision integer NOT NULL CHECK(revision>0), fields jsonb NOT NULL, checksum text NOT NULL, idempotency_key text NOT NULL, input_checksum text NOT NULL,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,product_id,revision), UNIQUE(tenant_id,account_id,idempotency_key), FOREIGN KEY(tenant_id,product_id) REFERENCES ad_products(tenant_id,id), FOREIGN KEY(tenant_id,account_id) REFERENCES marketplace_accounts(tenant_id,id)
);
CREATE TABLE ad_observations (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), account_id uuid NOT NULL, created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
 data jsonb NOT NULL, idempotency_key text NOT NULL, input_checksum text NOT NULL,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,account_id,idempotency_key), FOREIGN KEY(tenant_id,account_id) REFERENCES marketplace_accounts(tenant_id,id), CHECK(data->'scope'->>'accountId'=account_id::text)
);
CREATE TABLE ad_analysis_runs (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), account_id uuid NOT NULL, created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
 input jsonb NOT NULL, input_checksum text NOT NULL, idempotency_key text NOT NULL, result jsonb NOT NULL, status text NOT NULL CHECK(status IN ('complete','partial')),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,account_id,idempotency_key), FOREIGN KEY(tenant_id,account_id) REFERENCES marketplace_accounts(tenant_id,id), CHECK(input->>'accountId'=account_id::text)
);
CREATE TABLE ad_actions (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), account_id uuid NOT NULL, created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
 run_id uuid NOT NULL, recommendation_key text NOT NULL, recommendation jsonb NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','adopted','executed','observing','reviewed','rejected','deferred','stale')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), executed_at timestamptz, actual_before_minor text, actual_after_minor text, updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,run_id) REFERENCES ad_analysis_runs(tenant_id,id), FOREIGN KEY(tenant_id,account_id) REFERENCES marketplace_accounts(tenant_id,id),
 CHECK(recommendation_key=recommendation->>'key' AND recommendation->>'accountId'=account_id::text), CHECK(status NOT IN ('executed','observing','reviewed') OR executed_at IS NOT NULL)
);
CREATE UNIQUE INDEX ad_actions_candidate ON ad_actions(tenant_id,account_id,recommendation_key) WHERE status<>'stale';
CREATE TABLE ad_action_events (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), account_id uuid NOT NULL, created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
 action_id uuid NOT NULL, status text NOT NULL, reason text NOT NULL, data jsonb NOT NULL, idempotency_key text NOT NULL, input_checksum text NOT NULL,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,action_id,idempotency_key), FOREIGN KEY(tenant_id,action_id) REFERENCES ad_actions(tenant_id,id), FOREIGN KEY(tenant_id,account_id) REFERENCES marketplace_accounts(tenant_id,id)
);
CREATE TABLE ad_import_events (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), account_id uuid NOT NULL, created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
 import_id uuid NOT NULL, reason text NOT NULL, idempotency_key text NOT NULL, input_checksum text NOT NULL,
 UNIQUE(tenant_id,import_id,idempotency_key), FOREIGN KEY(tenant_id,import_id) REFERENCES ad_imports(tenant_id,id), FOREIGN KEY(tenant_id,account_id) REFERENCES marketplace_accounts(tenant_id,id)
);
CREATE TABLE ad_exports (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), account_id uuid NOT NULL, created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
 run_id uuid NOT NULL, data jsonb NOT NULL, checksum text NOT NULL, review_reason text NOT NULL, idempotency_key text NOT NULL, input_checksum text NOT NULL,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,account_id,idempotency_key), FOREIGN KEY(tenant_id,run_id) REFERENCES ad_analysis_runs(tenant_id,id), FOREIGN KEY(tenant_id,account_id) REFERENCES marketplace_accounts(tenant_id,id)
);
--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['ad_import_batches','ad_imports','ad_facts','ad_products','ad_goal_versions','ad_observations','ad_analysis_runs','ad_actions','ad_action_events','ad_import_events','ad_exports'] LOOP
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK(substring(id::text from 15 for 1) = ''7'')',t,t||'_uuidv7');
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid))',t||'_tenant',t);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO yummyai_app',t);
 END LOOP;
END $$;
GRANT UPDATE ON ad_products,ad_actions,ad_imports TO yummyai_app;
CREATE FUNCTION protect_ad_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Advertising evidence is immutable'; END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['ad_import_batches','ad_facts','ad_goal_versions','ad_observations','ad_analysis_runs','ad_action_events','ad_import_events','ad_exports'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION protect_ad_immutable()',t||'_immutable',t);
 END LOOP;
END $$;
CREATE FUNCTION protect_ad_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Advertising history cannot be deleted'; END IF;
 IF TG_TABLE_NAME='ad_products' THEN
  IF (to_jsonb(NEW)-'revision')<>(to_jsonb(OLD)-'revision') OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Invalid advertising product revision'; END IF;
 ELSIF TG_TABLE_NAME='ad_imports' THEN
  IF (to_jsonb(NEW)-'archived_at')<>(to_jsonb(OLD)-'archived_at') OR OLD.archived_at IS NOT NULL OR NEW.archived_at IS NULL THEN RAISE EXCEPTION 'Import evidence is immutable'; END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['status','revision','executed_at','actual_before_minor','actual_after_minor','updated_at'])<>(to_jsonb(OLD)-ARRAY['status','revision','executed_at','actual_before_minor','actual_after_minor','updated_at']) OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Invalid advertising action revision'; END IF;
  IF NOT ((OLD.status='pending' AND NEW.status IN ('adopted','rejected','deferred','stale')) OR (OLD.status='adopted' AND NEW.status IN ('executed','rejected','deferred','stale')) OR (OLD.status='executed' AND NEW.status='observing') OR (OLD.status='observing' AND NEW.status='reviewed') OR (OLD.status='deferred' AND NEW.status IN ('pending','rejected','stale'))) THEN RAISE EXCEPTION 'Invalid advertising action transition'; END IF;
  IF OLD.status<>'adopted' AND NEW.executed_at IS DISTINCT FROM OLD.executed_at THEN RAISE EXCEPTION 'Execution requires prior adoption'; END IF;
  IF OLD.executed_at IS NOT NULL AND (NEW.executed_at IS DISTINCT FROM OLD.executed_at OR NEW.actual_before_minor IS DISTINCT FROM OLD.actual_before_minor OR NEW.actual_after_minor IS DISTINCT FROM OLD.actual_after_minor) THEN RAISE EXCEPTION 'Execution evidence is immutable'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ad_products_projection BEFORE UPDATE OR DELETE ON ad_products FOR EACH ROW EXECUTE FUNCTION protect_ad_projection();
CREATE TRIGGER ad_imports_projection BEFORE UPDATE OR DELETE ON ad_imports FOR EACH ROW EXECUTE FUNCTION protect_ad_projection();
CREATE TRIGGER ad_actions_projection BEFORE UPDATE OR DELETE ON ad_actions FOR EACH ROW EXECUTE FUNCTION protect_ad_projection();
