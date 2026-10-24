ALTER TABLE production_delivery_packages DROP CONSTRAINT production_delivery_packages_schema_version_check;
ALTER TABLE production_delivery_packages ADD CONSTRAINT production_delivery_packages_schema_version_check CHECK(schema_version IN (1,2,3));
ALTER TABLE production_delivery_packages DROP CONSTRAINT production_delivery_packages_factory_pin_check;
ALTER TABLE production_delivery_packages ADD CONSTRAINT production_delivery_packages_factory_pin_check CHECK
 ((schema_version=1 AND factory_id IS NULL AND factory_version_id IS NULL) OR (schema_version IN (2,3) AND factory_id IS NOT NULL AND factory_version_id IS NOT NULL));
--> statement-breakpoint
CREATE UNIQUE INDEX production_manufacturing_delivery_ref ON production_manufacturing_bindings(tenant_id,id,production_version_id);
ALTER TABLE production_delivery_items ADD COLUMN manufacturing_binding_id uuid,
 ADD COLUMN manufacturing_content_checksum text, ADD COLUMN manufacturing_plan_checksum text;
ALTER TABLE production_delivery_items ADD CONSTRAINT production_delivery_items_manufacturing_fk
 FOREIGN KEY(tenant_id,manufacturing_binding_id,production_version_id) REFERENCES production_manufacturing_bindings(tenant_id,id,production_version_id);
ALTER TABLE production_delivery_items ADD CONSTRAINT production_delivery_items_manufacturing_check CHECK
 ((manufacturing_binding_id IS NULL AND manufacturing_content_checksum IS NULL AND manufacturing_plan_checksum IS NULL)
 OR (manufacturing_binding_id IS NOT NULL AND manufacturing_content_checksum IS NOT NULL AND manufacturing_plan_checksum IS NOT NULL
 AND manufacturing_content_checksum~'^[a-f0-9]{64}$' AND manufacturing_plan_checksum~'^[a-f0-9]{64}$'));
--> statement-breakpoint
CREATE FUNCTION seal_manufacturing_delivery_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE packet production_delivery_packages; binding production_manufacturing_bindings; creation_transaction text;
BEGIN
 SELECT * INTO packet FROM production_delivery_packages WHERE tenant_id=NEW.tenant_id AND id=NEW.package_id;
 IF packet.schema_version=3 THEN
  SELECT p.xmin::text INTO creation_transaction FROM production_delivery_packages p WHERE p.tenant_id=NEW.tenant_id AND p.id=NEW.package_id;
  SELECT * INTO binding FROM production_manufacturing_bindings WHERE tenant_id=NEW.tenant_id AND id=NEW.manufacturing_binding_id;
  IF creation_transaction<>(txid_current()%4294967296)::text OR binding.id IS NULL OR binding.production_version_id<>NEW.production_version_id
   OR binding.production_order_id<>NEW.production_order_id OR binding.source_work_revision_id IS DISTINCT FROM NEW.work_revision_id
   OR binding.content_checksum IS DISTINCT FROM NEW.manufacturing_content_checksum OR NEW.manufacturing_plan_checksum IS NULL THEN
   RAISE EXCEPTION 'new delivery must seal its original manufacturing source in the package transaction' USING ERRCODE='23514';
  END IF;
 ELSIF NEW.manufacturing_binding_id IS NOT NULL OR NEW.manufacturing_content_checksum IS NOT NULL OR NEW.manufacturing_plan_checksum IS NOT NULL THEN
  RAISE EXCEPTION 'legacy delivery cannot acquire inferred manufacturing evidence' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER seal_manufacturing_source BEFORE INSERT ON production_delivery_items FOR EACH ROW EXECUTE FUNCTION seal_manufacturing_delivery_item();
CREATE FUNCTION require_manufacturing_delivery_items() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_user='yummyai_app' AND NEW.schema_version=3 AND NOT EXISTS(SELECT 1 FROM production_delivery_items WHERE tenant_id=NEW.tenant_id AND package_id=NEW.id) THEN
  RAISE EXCEPTION 'new manufacturing delivery requires sealed items' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER complete_manufacturing_delivery AFTER INSERT ON production_delivery_packages
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_manufacturing_delivery_items();
CREATE FUNCTION require_current_manufacturing_delivery_format() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_user='yummyai_app' AND NEW.schema_version<>3 THEN
  RAISE EXCEPTION 'new application delivery packages require the manufacturing format' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER current_manufacturing_format BEFORE INSERT ON production_delivery_packages
 FOR EACH ROW EXECUTE FUNCTION require_current_manufacturing_delivery_format();
