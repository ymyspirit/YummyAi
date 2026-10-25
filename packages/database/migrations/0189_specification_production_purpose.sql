-- Production facts and commercial facts have separate purposes. Existing immutable
-- fully-confirmed specifications retain their historical SQL eligibility.
CREATE FUNCTION specification_production_facts_ready(facts jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE size jsonb; measurements jsonb; field text; value jsonb; amount numeric;
 basis text; net_weight numeric; gross_weight numeric; reference jsonb; seen_rules text[]:=ARRAY[]::text[];
 -- ECMAScript String.trim whitespace, matching the shared Zod contract.
 whitespace constant text:=U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
BEGIN
 IF jsonb_typeof(facts) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 IF facts->'factsConfirmed' = 'true'::jsonb THEN RETURN true; END IF;
 IF facts->'formatVersion' IS DISTINCT FROM '2'::jsonb
  OR facts->'productionConfirmed' IS DISTINCT FROM 'true'::jsonb
  OR jsonb_typeof(facts->'factsConfirmed') IS DISTINCT FROM 'boolean'
  OR facts-ARRAY['formatVersion','material','dimensions','physicalDimensions','structure','packageContents','packageQuantity',
   'factsConfirmed','productionConfirmed','productionRuleReferences','weightGrams','packagedWeightGrams',
   'packageDimensions','packageMeasurements','verificationReference']<>'{}'::jsonb THEN RETURN false; END IF;

 FOREACH field IN ARRAY ARRAY['material','structure','packageContents','verificationReference'] LOOP
  value:=facts->field;
  IF jsonb_typeof(value) IS DISTINCT FROM 'string' OR length(btrim(facts->>field,whitespace))=0
   OR length(btrim(facts->>field,whitespace))>(CASE WHEN field='material' THEN 300 ELSE 1000 END) THEN RETURN false; END IF;
 END LOOP;
 IF jsonb_typeof(facts->'dimensions') IS DISTINCT FROM 'string'
  OR length(btrim(facts->>'dimensions',whitespace))>300
  OR jsonb_typeof(facts->'packageQuantity') IS DISTINCT FROM 'number' THEN RETURN false; END IF;
 amount:=(facts->>'packageQuantity')::numeric;
 IF amount NOT BETWEEN 1 AND 10000 OR amount<>trunc(amount) THEN RETURN false; END IF;
 IF facts ? 'packageDimensions' THEN
  IF jsonb_typeof(facts->'packageDimensions') IS DISTINCT FROM 'string'
   OR length(btrim(facts->>'packageDimensions',whitespace))>300 THEN RETURN false; END IF;
 END IF;
 IF facts ? 'productionRuleReferences' THEN
  IF jsonb_typeof(facts->'productionRuleReferences') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(facts->'productionRuleReferences')>12 THEN RETURN false; END IF;
  FOR reference IN SELECT item FROM jsonb_array_elements(facts->'productionRuleReferences') AS items(item) LOOP
   IF jsonb_typeof(reference) IS DISTINCT FROM 'object'
    OR NOT (reference ?& ARRAY['ruleId','versionId','version'])
    OR reference-ARRAY['ruleId','versionId','version']<>'{}'::jsonb THEN RETURN false; END IF;
   FOREACH field IN ARRAY ARRAY['ruleId','versionId'] LOOP
    IF jsonb_typeof(reference->field) IS DISTINCT FROM 'string'
     OR reference->>field !~* '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN RETURN false; END IF;
   END LOOP;
   IF jsonb_typeof(reference->'version') IS DISTINCT FROM 'number' THEN RETURN false; END IF;
   amount:=(reference->>'version')::numeric;
   IF amount<1 OR amount>9007199254740991 OR amount<>trunc(amount)
    OR lower(reference->>'ruleId')=ANY(seen_rules) THEN RETURN false; END IF;
   seen_rules:=array_append(seen_rules,lower(reference->>'ruleId'));
  END LOOP;
 END IF;

 size:=facts->'physicalDimensions';
 IF jsonb_typeof(size) IS DISTINCT FROM 'object'
  OR NOT (size ?& ARRAY['basis','unit','length','width','height'])
  OR size-ARRAY['basis','unit','length','width','height']<>'{}'::jsonb
  OR jsonb_typeof(size->'basis') IS DISTINCT FROM 'string'
  OR jsonb_typeof(size->'unit') IS DISTINCT FROM 'string'
  OR size->>'unit' NOT IN ('mm','cm','in') THEN RETURN false; END IF;
 basis:=size->>'basis';
 IF basis NOT IN ('finished_outer_2d','finished_outer_3d','artwork_longest','flat_piece','diameter') THEN RETURN false; END IF;
 FOREACH field IN ARRAY ARRAY['length','width','height'] LOOP
  value:=size->field;
  IF value='null'::jsonb THEN
   IF field='length' OR (field='width' AND basis IN ('finished_outer_2d','finished_outer_3d','flat_piece'))
    OR (field='height' AND basis='finished_outer_3d') THEN RETURN false; END IF;
  ELSE
   IF jsonb_typeof(value) IS DISTINCT FROM 'number' THEN RETURN false; END IF;
   amount:=(value#>>'{}')::numeric;
   IF amount<=0 OR amount>1000000 THEN RETURN false; END IF;
  END IF;
 END LOOP;
 IF (basis IN ('artwork_longest','diameter') AND (size->'width'<>'null'::jsonb OR size->'height'<>'null'::jsonb))
  OR (basis IN ('finished_outer_2d','flat_piece') AND size->'height'<>'null'::jsonb) THEN RETURN false; END IF;

 FOREACH field IN ARRAY ARRAY['weightGrams','packagedWeightGrams'] LOOP
  value:=facts->field;
  IF value IS NULL OR value='null'::jsonb THEN CONTINUE; END IF;
  IF jsonb_typeof(value) IS DISTINCT FROM 'number' THEN RETURN false; END IF;
  amount:=(value#>>'{}')::numeric;
  IF amount<=0 OR amount>1000000 THEN RETURN false; END IF;
  IF field='weightGrams' THEN net_weight:=amount; ELSE gross_weight:=amount; END IF;
 END LOOP;
 IF net_weight IS NOT NULL AND gross_weight IS NOT NULL AND net_weight>gross_weight THEN RETURN false; END IF;

 -- Unknown shipping measurements remain unknown; supplied measurements must be valid.
 measurements:=facts->'packageMeasurements';
 IF measurements IS NOT NULL AND measurements<>'null'::jsonb THEN
  IF jsonb_typeof(measurements) IS DISTINCT FROM 'object'
   OR NOT (measurements ?& ARRAY['unit','length','width','height'])
   OR measurements-ARRAY['unit','length','width','height']<>'{}'::jsonb THEN RETURN false; END IF;
  value:=measurements->'unit';
  IF value<>'null'::jsonb AND (jsonb_typeof(value) IS DISTINCT FROM 'string' OR measurements->>'unit' NOT IN ('mm','cm','in')) THEN RETURN false; END IF;
  FOREACH field IN ARRAY ARRAY['length','width','height'] LOOP
   value:=measurements->field;
   IF value='null'::jsonb THEN CONTINUE; END IF;
   IF jsonb_typeof(value) IS DISTINCT FROM 'number' THEN RETURN false; END IF;
   amount:=(value#>>'{}')::numeric;
   IF amount<=0 OR amount>1000000 THEN RETURN false; END IF;
  END LOOP;
 END IF;
 RETURN true;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION require_complete_manufacturing_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.decision<>'approved' THEN RETURN NEW; END IF;
 IF NOT EXISTS(SELECT 1 FROM manufacturing_recipe_versions v JOIN manufacturing_recipes r ON r.tenant_id=v.tenant_id AND r.id=v.recipe_id
  JOIN product_specification_versions pv ON pv.tenant_id=v.tenant_id AND pv.id=v.specification_version_id
  JOIN product_specifications p ON p.tenant_id=pv.tenant_id AND p.id=pv.specification_id
  WHERE v.tenant_id=NEW.tenant_id AND v.id=NEW.version_id AND v.recipe_id=NEW.recipe_id AND r.archived_at IS NULL
   AND r.version_number=v.version_number AND p.version_number=pv.version_number AND specification_production_facts_ready(pv.facts))
 OR NOT EXISTS(SELECT 1 FROM manufacturing_bom_lines l WHERE l.tenant_id=NEW.tenant_id AND l.version_id=NEW.version_id)
 OR NOT EXISTS(SELECT 1 FROM manufacturing_operations o WHERE o.tenant_id=NEW.tenant_id AND o.version_id=NEW.version_id)
 OR EXISTS(SELECT 1 FROM manufacturing_bom_lines l LEFT JOIN inventory_stock_items i ON i.tenant_id=l.tenant_id AND i.id=l.stock_item_id
  WHERE l.tenant_id=NEW.tenant_id AND l.version_id=NEW.version_id AND (
   i.id IS NULL OR i.status<>'active' OR l.payload->>'unit' IS DISTINCT FROM i.base_unit
   OR coalesce(l.payload->>'responsibility','unknown') NOT IN ('merchant','factory')
   OR jsonb_typeof(l.payload->'quantityNumerator') IS DISTINCT FROM 'number' OR (l.payload->>'quantityNumerator')::numeric NOT BETWEEN 1 AND 1000000000
   OR (l.payload->>'quantityNumerator')::numeric<>trunc((l.payload->>'quantityNumerator')::numeric)
   OR jsonb_typeof(l.payload->'quantityDenominator') IS DISTINCT FROM 'number' OR (l.payload->>'quantityDenominator')::numeric NOT BETWEEN 1 AND 1000000000
   OR (l.payload->>'quantityDenominator')::numeric<>trunc((l.payload->>'quantityDenominator')::numeric)
   OR jsonb_typeof(l.payload->'lossBps') IS DISTINCT FROM 'number' OR (l.payload->>'lossBps')::numeric NOT BETWEEN 0 AND 100000
   OR (l.payload->>'lossBps')::numeric<>trunc((l.payload->>'lossBps')::numeric)
   OR coalesce(l.payload->>'lossBasis','') NOT IN ('add_to_net','fraction_of_input')
   OR (l.payload->>'lossBasis'='fraction_of_input' AND (l.payload->>'lossBps')::numeric>=10000)))
 OR EXISTS(SELECT 1 FROM manufacturing_operations o WHERE o.tenant_id=NEW.tenant_id AND o.version_id=NEW.version_id
  AND (coalesce(o.payload->>'responsibility','unknown') NOT IN ('merchant','factory') OR length(trim(coalesce(o.payload->>'processCode','')))=0)) THEN
  RAISE EXCEPTION 'manufacturing approval requires complete current material and operation evidence' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION seal_production_manufacturing_binding() RETURNS trigger LANGUAGE plpgsql AS $$
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
 IF spec.id IS NULL OR spec.process_profile_version_id IS NULL OR NOT specification_production_facts_ready(spec.facts) THEN
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

--> statement-breakpoint
