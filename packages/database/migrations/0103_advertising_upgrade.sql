-- Upgrade the development version of 0102 without rewriting source histories.
-- Earlier running APIs could apply 0102 before its final date/guard columns.
ALTER TABLE ad_imports ADD COLUMN IF NOT EXISTS period_start text;
ALTER TABLE ad_imports ADD COLUMN IF NOT EXISTS period_end text;
ALTER TABLE ad_actions DROP CONSTRAINT IF EXISTS ad_actions_tenant_id_account_id_recommendation_key_key;
DROP INDEX IF EXISTS ad_actions_candidate;
CREATE UNIQUE INDEX ad_actions_candidate ON ad_actions(tenant_id,account_id,recommendation_key) WHERE status<>'stale';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_ad_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
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
