CREATE FUNCTION prevent_amazon_order_report_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Amazon order report versions cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF ROW(OLD.id, OLD.tenant_id, OLD.report_line_id, OLD.version_number, OLD.checksum, OLD.scan_engine, OLD.scan_signature, OLD.created_at, OLD.expires_at)
     IS DISTINCT FROM ROW(NEW.id, NEW.tenant_id, NEW.report_line_id, NEW.version_number, NEW.checksum, NEW.scan_engine, NEW.scan_signature, NEW.created_at, NEW.expires_at) THEN
    RAISE EXCEPTION 'Amazon order report version identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF ROW(OLD.encrypted_document, OLD.encrypted_archive) IS DISTINCT FROM ROW(NEW.encrypted_document, NEW.encrypted_archive)
     AND (NEW.encrypted_document IS NOT NULL OR NEW.encrypted_archive IS NOT NULL) THEN
    RAISE EXCEPTION 'Amazon order report version content is immutable except for erasure' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER amazon_order_report_versions_immutable BEFORE UPDATE OR DELETE ON amazon_order_report_versions FOR EACH ROW EXECUTE FUNCTION prevent_amazon_order_report_version_mutation();
--> statement-breakpoint
ALTER TABLE "amazon_order_report_batches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "amazon_order_report_batches" FORCE ROW LEVEL SECURITY;
CREATE POLICY "amazon_order_report_batches_tenant_policy" ON "amazon_order_report_batches" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
ALTER TABLE "amazon_order_report_batch_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "amazon_order_report_batch_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "amazon_order_report_batch_items_tenant_policy" ON "amazon_order_report_batch_items" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
ALTER TABLE "amazon_order_report_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "amazon_order_report_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY "amazon_order_report_lines_tenant_policy" ON "amazon_order_report_lines" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
ALTER TABLE "amazon_order_report_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "amazon_order_report_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "amazon_order_report_versions_tenant_policy" ON "amazon_order_report_versions" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE ON amazon_order_report_batches, amazon_order_report_batch_items, amazon_order_report_lines, amazon_order_report_versions TO yummyai_app;
