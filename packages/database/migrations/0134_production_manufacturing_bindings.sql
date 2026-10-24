CREATE TABLE production_manufacturing_bindings (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id),
 production_order_id uuid NOT NULL, production_version_id uuid NOT NULL, order_line_id uuid NOT NULL,
 recipe_id uuid NOT NULL, manufacturing_version_id uuid NOT NULL, review_id uuid NOT NULL,
 specification_version_id uuid NOT NULL, source text NOT NULL, source_work_revision_id uuid, original_binding_id uuid, sku_id uuid, factory_basis jsonb NOT NULL,
 binding_version integer NOT NULL DEFAULT 1, quantity integer NOT NULL, output_unit text NOT NULL, order_unit_confirmed boolean NOT NULL,
 content_canonical text NOT NULL, content_checksum text NOT NULL,
 encrypted_confirmation_note text, confirmation_note_checksum text,
 created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT production_manufacturing_scope UNIQUE(tenant_id,id),
 CONSTRAINT production_manufacturing_version UNIQUE(tenant_id,production_version_id),
 CONSTRAINT production_manufacturing_id CHECK(substring(id::text from 15 for 1)='7'),
 CONSTRAINT production_manufacturing_count CHECK(binding_version=1 AND quantity>0 AND output_unit IN ('each','pair','set') AND order_unit_confirmed),
 CONSTRAINT production_manufacturing_source CHECK(
  (source='order_work_revision' AND source_work_revision_id IS NOT NULL AND original_binding_id IS NULL AND encrypted_confirmation_note IS NULL AND confirmation_note_checksum IS NULL)
  OR (source='approved_product_confirmation' AND source_work_revision_id IS NULL AND original_binding_id IS NULL AND encrypted_confirmation_note IS NOT NULL AND confirmation_note_checksum IS NOT NULL
    AND length(encrypted_confirmation_note)>0 AND confirmation_note_checksum~'^[a-f0-9]{64}$')
  OR (source='original_production_binding' AND original_binding_id IS NOT NULL AND encrypted_confirmation_note IS NULL AND confirmation_note_checksum IS NULL)),
 CONSTRAINT production_manufacturing_checksum CHECK(content_checksum=encode(sha256(convert_to(content_canonical,'UTF8')),'hex')),
 FOREIGN KEY(tenant_id,production_order_id,order_line_id) REFERENCES production_orders(tenant_id,id,order_line_id),
 FOREIGN KEY(tenant_id,production_version_id,production_order_id,quantity) REFERENCES production_order_versions(tenant_id,id,production_order_id,quantity),
 FOREIGN KEY(tenant_id,recipe_id,manufacturing_version_id) REFERENCES manufacturing_recipe_versions(tenant_id,recipe_id,id),
 FOREIGN KEY(tenant_id,manufacturing_version_id,review_id) REFERENCES manufacturing_recipe_reviews(tenant_id,version_id,id),
 FOREIGN KEY(tenant_id,order_line_id,source_work_revision_id) REFERENCES order_work_revisions(tenant_id,work_item_id,id),
 FOREIGN KEY(tenant_id,original_binding_id) REFERENCES production_manufacturing_bindings(tenant_id,id),
 FOREIGN KEY(tenant_id,sku_id) REFERENCES skus(tenant_id,id)
);
--> statement-breakpoint
ALTER TABLE production_manufacturing_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_manufacturing_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY production_manufacturing_tenant ON production_manufacturing_bindings
 USING(tenant_id=current_setting('app.tenant_id',true)::uuid) WITH CHECK(tenant_id=current_setting('app.tenant_id',true)::uuid);
GRANT SELECT,INSERT ON production_manufacturing_bindings TO yummyai_app;
CREATE TRIGGER immutable_evidence BEFORE UPDATE OR DELETE ON production_manufacturing_bindings
 FOR EACH ROW EXECUTE FUNCTION prevent_manufacturing_evidence_mutation();
--> statement-breakpoint
CREATE FUNCTION seal_production_manufacturing_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pv production_order_versions; po production_orders; mv manufacturing_recipe_versions; mr manufacturing_recipe_reviews;
 spec product_specification_versions; current_spec product_specifications; original production_manufacturing_bindings; actual_content jsonb; work_source order_work_revisions; creation_transaction text;
BEGIN
 SELECT * INTO pv FROM production_order_versions WHERE tenant_id=NEW.tenant_id AND id=NEW.production_version_id;
 SELECT p.xmin::text INTO creation_transaction FROM production_order_versions p WHERE p.tenant_id=NEW.tenant_id AND p.id=NEW.production_version_id;
 SELECT * INTO po FROM production_orders WHERE tenant_id=NEW.tenant_id AND id=NEW.production_order_id;
 IF pv.id IS NULL OR po.id IS NULL OR pv.production_order_id<>po.id OR po.order_line_id<>NEW.order_line_id OR pv.quantity<>NEW.quantity
  OR NEW.created_by IS DISTINCT FROM pv.created_by OR pv.created_at<>transaction_timestamp() OR NEW.created_at<>pv.created_at OR creation_transaction<>(txid_current()%4294967296)::text THEN
  RAISE EXCEPTION 'manufacturing binding must be sealed with the original production version transaction' USING ERRCODE='23514';
 END IF;
 SELECT * INTO mv FROM manufacturing_recipe_versions WHERE tenant_id=NEW.tenant_id AND id=NEW.manufacturing_version_id;
 SELECT * INTO mr FROM manufacturing_recipe_reviews WHERE tenant_id=NEW.tenant_id AND id=NEW.review_id;
 IF mv.id IS NULL OR mv.recipe_id<>NEW.recipe_id OR mv.specification_version_id<>NEW.specification_version_id OR mv.output_unit<>NEW.output_unit
  OR mr.id IS NULL OR mr.version_id<>mv.id OR mr.decision<>'approved' THEN
  RAISE EXCEPTION 'production manufacturing requires the exact approved manufacturing source' USING ERRCODE='23514';
 END IF;
 SELECT * INTO spec FROM product_specification_versions WHERE tenant_id=NEW.tenant_id AND id=NEW.specification_version_id;
 IF spec.id IS NULL OR spec.process_profile_version_id IS NULL OR spec.facts->>'factsConfirmed' IS DISTINCT FROM 'true' THEN
  RAISE EXCEPTION 'production manufacturing requires a confirmed specification and its process' USING ERRCODE='23514';
 END IF;
 IF NEW.sku_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM skus s JOIN product_specifications ps ON ps.tenant_id=s.tenant_id AND ps.spu_id=s.spu_id
  WHERE s.tenant_id=NEW.tenant_id AND s.id=NEW.sku_id AND ps.id=spec.specification_id) THEN
  RAISE EXCEPTION 'production SKU must belong to the exact manufacturing product' USING ERRCODE='23514';
 END IF;
 IF jsonb_typeof(NEW.factory_basis)<>'object' OR NEW.factory_basis->>'templateVersionId' IS DISTINCT FROM spec.process_profile_version_id::text
  OR NEW.factory_basis->>'skuId' IS DISTINCT FROM NEW.sku_id::text
  OR NEW.factory_basis->>'productType' IS DISTINCT FROM (SELECT product_type FROM print_profile_versions WHERE tenant_id=NEW.tenant_id AND id=spec.process_profile_version_id)
  OR NEW.factory_basis->>'productPlanId' IS DISTINCT FROM (SELECT s.product_plan_id::text FROM spus s JOIN product_specifications ps ON ps.tenant_id=s.tenant_id AND ps.spu_id=s.id WHERE ps.tenant_id=NEW.tenant_id AND ps.id=spec.specification_id)
  OR jsonb_typeof(NEW.factory_basis->'longestMm') IS DISTINCT FROM 'number' OR NOT ((NEW.factory_basis->>'longestMm')::numeric>0) THEN
  RAISE EXCEPTION 'factory basis must preserve the exact manufacturing source and physical size' USING ERRCODE='23514';
 END IF;
 IF NEW.source='order_work_revision' THEN
  SELECT * INTO work_source FROM order_work_revisions WHERE tenant_id=NEW.tenant_id AND id=NEW.source_work_revision_id;
  IF NEW.source_work_revision_id IS DISTINCT FROM pv.source_work_revision_id OR po.source_work_item_id IS DISTINCT FROM work_source.work_item_id OR work_source.work_item_id IS DISTINCT FROM po.order_line_id
   OR work_source.profile_version_id IS DISTINCT FROM spec.process_profile_version_id THEN
   RAISE EXCEPTION 'manufacturing source must match the actual production work revision' USING ERRCODE='23514';
  END IF;
 ELSIF NEW.source='approved_product_confirmation' THEN
  SELECT * INTO current_spec FROM product_specifications WHERE tenant_id=NEW.tenant_id AND id=spec.specification_id;
  IF pv.source_work_revision_id IS NOT NULL OR po.source_work_item_id IS NOT NULL OR current_spec.version_number<>spec.version_number
   OR EXISTS(SELECT 1 FROM order_work_items WHERE tenant_id=NEW.tenant_id AND id=po.order_line_id)
   OR NOT EXISTS(SELECT 1 FROM design_versions d JOIN design_tasks task ON task.tenant_id=d.tenant_id AND task.id=d.task_id
      JOIN skus sku ON sku.tenant_id=task.tenant_id AND sku.id=task.sku_id
      JOIN order_line_catalog_links link ON link.tenant_id=sku.tenant_id AND link.sku_id=sku.id AND link.order_line_id=po.order_line_id
      WHERE d.tenant_id=NEW.tenant_id AND d.id=pv.design_version_id AND d.status='approved' AND sku.id=NEW.sku_id AND sku.spu_id=current_spec.spu_id)
   OR jsonb_array_length(pv.production_asset_ids)=0
   OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(pv.production_asset_ids) selected(id)
      WHERE NOT EXISTS(SELECT 1 FROM design_version_files file WHERE file.tenant_id=NEW.tenant_id AND file.version_id=pv.design_version_id AND file.asset_file_id=selected.id::uuid AND file.role='production')) THEN
   RAISE EXCEPTION 'product confirmation requires a current specification, linked approved design and its production files without replacing order work' USING ERRCODE='23514';
  END IF;
 ELSIF NEW.source='original_production_binding' THEN
  SELECT * INTO original FROM production_manufacturing_bindings WHERE tenant_id=NEW.tenant_id AND id=NEW.original_binding_id;
  IF original.id IS NULL OR original.production_order_id IS DISTINCT FROM po.parent_production_order_id OR original.order_line_id<>po.order_line_id
   OR original.specification_version_id<>NEW.specification_version_id OR original.source_work_revision_id IS DISTINCT FROM NEW.source_work_revision_id OR original.sku_id IS DISTINCT FROM NEW.sku_id
   OR pv.source_work_revision_id IS DISTINCT FROM NEW.source_work_revision_id OR original.factory_basis IS DISTINCT FROM NEW.factory_basis THEN
   RAISE EXCEPTION 'remake manufacturing must preserve the actual original production basis' USING ERRCODE='23514';
  END IF;
 END IF;
 actual_content:=jsonb_build_object('specificationVersionId',mv.specification_version_id,'name',mv.name,'outputQuantity',mv.output_quantity,'outputUnit',mv.output_unit,'notes',mv.notes,
  'materials',coalesce((SELECT jsonb_agg(payload ORDER BY position) FROM manufacturing_bom_lines WHERE tenant_id=NEW.tenant_id AND version_id=mv.id),'[]'::jsonb),
  'operations',coalesce((SELECT jsonb_agg(payload ORDER BY position) FROM manufacturing_operations WHERE tenant_id=NEW.tenant_id AND version_id=mv.id),'[]'::jsonb));
 IF NEW.content_canonical::jsonb IS DISTINCT FROM actual_content THEN
  RAISE EXCEPTION 'production manufacturing content must preserve the immutable approved version' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER seal_source BEFORE INSERT ON production_manufacturing_bindings
 FOR EACH ROW EXECUTE FUNCTION seal_production_manufacturing_binding();
--> statement-breakpoint
CREATE FUNCTION require_new_production_manufacturing_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_user='yummyai_app' AND NOT EXISTS(SELECT 1 FROM production_manufacturing_bindings WHERE tenant_id=NEW.tenant_id AND production_version_id=NEW.id) THEN
  RAISE EXCEPTION 'new production versions require an explicit immutable manufacturing binding' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER complete_manufacturing_binding AFTER INSERT ON production_order_versions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_new_production_manufacturing_binding();
