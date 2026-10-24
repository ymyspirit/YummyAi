-- xmin identifies a tuple version: UPDATE alone must not become RFQ creation.
-- Legacy RFQs retain NULL; no historical creation transaction is inferred.
ALTER TABLE inventory_procurement_rfqs ADD COLUMN creation_transaction_id text;
ALTER TABLE inventory_procurement_rfqs ADD CONSTRAINT procurement_rfq_creation_transaction_check
 CHECK(creation_transaction_id IS NULL OR creation_transaction_id ~ '^[0-9]+$');
--> statement-breakpoint
CREATE FUNCTION guard_procurement_rfq_creation_transaction() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  NEW.creation_transaction_id:=pg_current_xact_id()::text;
 ELSIF NEW.creation_transaction_id IS DISTINCT FROM OLD.creation_transaction_id THEN
  RAISE EXCEPTION 'RFQ creation transaction is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_procurement_rfq_creation_transaction() FROM PUBLIC;
CREATE TRIGGER procurement_rfq_creation_transaction_guard
 BEFORE INSERT OR UPDATE ON inventory_procurement_rfqs
 FOR EACH ROW EXECUTE FUNCTION guard_procurement_rfq_creation_transaction();
--> statement-breakpoint
CREATE FUNCTION require_procurement_rfq_creation_transaction() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.operation='rfq_create' AND NOT EXISTS(
  SELECT 1 FROM public.inventory_procurement_rfqs r
  WHERE r.tenant_id=NEW.tenant_id AND r.id=NEW.rfq_id
   AND r.creation_transaction_id=pg_current_xact_id()::text
 ) THEN
  RAISE EXCEPTION 'RFQ original evidence requires its actual creation transaction' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION require_procurement_rfq_creation_transaction() FROM PUBLIC;
CREATE TRIGGER procurement_rfq_creation_transaction_required
 BEFORE INSERT ON inventory_procurement_write_requests
 FOR EACH ROW EXECUTE FUNCTION require_procurement_rfq_creation_transaction();
