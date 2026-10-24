-- Preserve all original identities and monetary values. Legacy multi-SPU plans
-- remain explicitly ambiguous; no historical SPU is selected, merged or deleted.
ALTER TABLE spus ADD COLUMN legacy_plan_ambiguous boolean NOT NULL DEFAULT false;
DROP INDEX IF EXISTS spus_tenant_plan_unique;
UPDATE spus s SET legacy_plan_ambiguous=true WHERE EXISTS(
 SELECT 1 FROM spus siblings WHERE siblings.tenant_id=s.tenant_id AND siblings.product_plan_id=s.product_plan_id AND siblings.id<>s.id
);
CREATE UNIQUE INDEX spus_tenant_plan_unique ON spus(tenant_id,product_plan_id) WHERE NOT legacy_plan_ambiguous;
--> statement-breakpoint
CREATE FUNCTION protect_legacy_spu_plan_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_user='yummyai_app' THEN
  IF TG_OP='INSERT' THEN
   IF NEW.legacy_plan_ambiguous THEN RAISE EXCEPTION 'Legacy SPU binding requires audited reconciliation' USING ERRCODE='55000'; END IF;
  ELSIF NEW.legacy_plan_ambiguous IS DISTINCT FROM OLD.legacy_plan_ambiguous OR
    (OLD.legacy_plan_ambiguous AND (NEW.tenant_id,NEW.id,NEW.product_plan_id) IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.product_plan_id)) THEN
   RAISE EXCEPTION 'Legacy SPU binding requires audited reconciliation' USING ERRCODE='55000';
  END IF;
 END IF;
 IF current_user='yummyai_app' AND NOT NEW.legacy_plan_ambiguous AND EXISTS(
  SELECT 1 FROM spus WHERE tenant_id=NEW.tenant_id AND product_plan_id=NEW.product_plan_id AND legacy_plan_ambiguous
 ) THEN RAISE EXCEPTION 'Legacy SPU binding requires audited reconciliation' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER legacy_spu_plan_binding_guard BEFORE INSERT OR UPDATE ON spus FOR EACH ROW EXECUTE FUNCTION protect_legacy_spu_plan_binding();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.protect_known_order_line_money()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.unit_price_minor IS NOT NULL AND
    (NEW.unit_price_minor, NEW.unit_price_currency) IS DISTINCT FROM (OLD.unit_price_minor, OLD.unit_price_currency) THEN
    RAISE EXCEPTION 'Known order line money cannot be replaced';
  END IF;
  RETURN NEW;
END $function$;
DROP TRIGGER IF EXISTS order_lines_known_money_guard ON order_lines;
CREATE TRIGGER order_lines_known_money_guard BEFORE UPDATE OF unit_price_minor,unit_price_currency ON order_lines FOR EACH ROW EXECUTE FUNCTION protect_known_order_line_money();
GRANT UPDATE(unit_price_minor,unit_price_currency) ON order_lines TO yummyai_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.prevent_personalization_template_source_inspection_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id OR OLD.source_asset_id IS DISTINCT FROM NEW.source_asset_id
     OR OLD.source_asset_version IS DISTINCT FROM NEW.source_asset_version OR OLD.checksum_sha256 IS DISTINCT FROM NEW.checksum_sha256
     OR OLD.source IS DISTINCT FROM NEW.source OR OLD.asset_domain IS DISTINCT FROM NEW.asset_domain
     OR OLD.rights_status IS DISTINCT FROM NEW.rights_status OR OLD.rights_source_kind IS DISTINCT FROM NEW.rights_source_kind
     OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key OR OLD.parser_key IS DISTINCT FROM NEW.parser_key
     OR OLD.parser_version IS DISTINCT FROM NEW.parser_version OR OLD.requested_by IS DISTINCT FROM NEW.requested_by
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'personalization template source inspection identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.status IN ('completed','failed') AND ROW(OLD.status, OLD.canvas, OLD.slot_snapshot, OLD.warning_snapshot, OLD.error_code, OLD.error_message, OLD.started_at, OLD.completed_at, OLD.updated_at)
     IS DISTINCT FROM ROW(NEW.status, NEW.canvas, NEW.slot_snapshot, NEW.warning_snapshot, NEW.error_code, NEW.error_message, NEW.started_at, NEW.completed_at, NEW.updated_at) THEN
    RAISE EXCEPTION 'completed personalization template source inspection is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
REVOKE UPDATE ON ai_budget_ledger FROM yummyai_app;
GRANT UPDATE(state,amount_usd) ON ai_budget_ledger TO yummyai_app;
--> statement-breakpoint
CREATE TABLE schema_adoption_receipts (
 canonical_migrations_sha256 text NOT NULL CHECK(canonical_migrations_sha256 ~ '^[a-f0-9]{64}$'),
 actual_migrations_sha256 text NOT NULL CHECK(actual_migrations_sha256 ~ '^[a-f0-9]{64}$'),
 schema_sha256 text NOT NULL CHECK(schema_sha256 ~ '^[a-f0-9]{64}$'),
 migration_count integer NOT NULL CHECK(migration_count>0), prior_migration_count integer NOT NULL CHECK(prior_migration_count>0 AND prior_migration_count<=migration_count),
 verification_version text NOT NULL CHECK(verification_version='postgres-public-schema-v1'),
 backup_manifest_sha256 text NOT NULL CHECK(backup_manifest_sha256 ~ '^[a-f0-9]{64}$'),
 source_snapshot_sha256 text NOT NULL CHECK(source_snapshot_sha256 ~ '^[a-f0-9]{64}$'),
 original_drift jsonb NOT NULL CHECK(jsonb_typeof(original_drift)='array'), evidence jsonb NOT NULL CHECK(evidence @> '{"schema_matched":true,"original_data_matched":true,"objects_matched":true}'::jsonb),
 recorded_by text NOT NULL DEFAULT current_user, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(canonical_migrations_sha256,actual_migrations_sha256,schema_sha256)
);
ALTER TABLE schema_adoption_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_adoption_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY schema_adoption_receipts_read ON schema_adoption_receipts FOR SELECT TO yummyai_app USING(true);
GRANT SELECT ON schema_adoption_receipts TO yummyai_app;
CREATE FUNCTION protect_schema_adoption_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Schema adoption audit is immutable' USING ERRCODE='55000'; END $$;
CREATE TRIGGER schema_adoption_receipts_immutable BEFORE UPDATE OR DELETE ON schema_adoption_receipts FOR EACH ROW EXECUTE FUNCTION protect_schema_adoption_history();
--> statement-breakpoint
-- Startup metadata is readable by the non-owner application role; migration
-- execution and ledger mutations remain operational privileges only.
REVOKE ALL ON SCHEMA drizzle FROM yummyai_app;
GRANT USAGE ON SCHEMA drizzle TO yummyai_app;
REVOKE ALL ON drizzle.__drizzle_migrations FROM yummyai_app;
GRANT SELECT ON drizzle.__drizzle_migrations TO yummyai_app;
