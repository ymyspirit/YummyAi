-- Attribute already reviewed scrap to its original physical source. No backfill,
-- stock movement, production quantity rewrite or capacity refund occurs here.
ALTER TABLE quality_defects DROP CONSTRAINT quality_defects_disposition_check;
ALTER TABLE quality_defects ADD CONSTRAINT quality_defects_disposition_check
 CHECK(disposition IN('accept','rework','remake','reship','refund','cancel','scrap'));
CREATE FUNCTION quality_scrap_defect_group_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.disposition='scrap' AND NOT EXISTS(SELECT 1 FROM quality_group_defects gd
   WHERE gd.tenant_id=NEW.tenant_id AND gd.defect_id=NEW.id AND gd.inspection_id=NEW.inspection_id AND gd.production_order_id=NEW.production_order_id)
  THEN RAISE EXCEPTION 'quality_scrap_defect_group_required' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER quality_scrap_defect_group_guard AFTER INSERT ON quality_defects DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION quality_scrap_defect_group_guard();
CREATE FUNCTION quality_scrap_recovery_group_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='UPDATE' AND(NEW.original_production_order_id IS DISTINCT FROM OLD.original_production_order_id
   OR NEW.defect_id IS DISTINCT FROM OLD.defect_id OR NEW.type IS DISTINCT FROM OLD.type)
  THEN RAISE EXCEPTION 'production_recovery_source_immutable' USING ERRCODE='23514';END IF;
 IF NEW.type='remake' AND EXISTS(SELECT 1 FROM quality_defects d WHERE d.tenant_id=NEW.tenant_id AND d.id=NEW.defect_id
    AND d.production_order_id=NEW.original_production_order_id AND d.disposition='scrap')
  AND NOT EXISTS(SELECT 1 FROM production_recovery_groups rg WHERE rg.tenant_id=NEW.tenant_id AND rg.recovery_case_id=NEW.id
    AND rg.production_order_id=NEW.original_production_order_id)
  THEN RAISE EXCEPTION 'quality_scrap_recovery_group_required' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER quality_scrap_recovery_group_guard AFTER INSERT OR UPDATE ON production_recovery_cases DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION quality_scrap_recovery_group_guard();
CREATE TABLE quality_scrap_reviews (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),production_order_id uuid NOT NULL,production_version_id uuid NOT NULL,
 root_inspection_id uuid NOT NULL,quantity_review_id uuid NOT NULL,previous_review_id uuid,input jsonb NOT NULL,idempotency_key text NOT NULL,
 request_canonical text NOT NULL,request_checksum text NOT NULL,creation_transaction_id text NOT NULL,
 created_by uuid NOT NULL REFERENCES app_users(id),created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT quality_scrap_reviews_order FOREIGN KEY(tenant_id,production_order_id) REFERENCES production_orders(tenant_id,id),
 CONSTRAINT quality_scrap_reviews_version FOREIGN KEY(tenant_id,production_version_id,production_order_id) REFERENCES production_order_versions(tenant_id,id,production_order_id),
 CONSTRAINT quality_scrap_reviews_root FOREIGN KEY(tenant_id,root_inspection_id) REFERENCES quality_inspections(tenant_id,id),
 CONSTRAINT quality_scrap_reviews_quantity FOREIGN KEY(tenant_id,quantity_review_id,production_order_id,production_version_id) REFERENCES production_quantity_reviews(tenant_id,id,production_order_id,production_version_id),
 CONSTRAINT quality_scrap_reviews_hash CHECK(request_checksum=encode(sha256(convert_to(request_canonical,'UTF8')),'hex'))
);
CREATE UNIQUE INDEX quality_scrap_reviews_scope ON quality_scrap_reviews(tenant_id,id);
CREATE UNIQUE INDEX quality_scrap_reviews_parent ON quality_scrap_reviews(tenant_id,id,production_order_id,production_version_id);
CREATE UNIQUE INDEX quality_scrap_reviews_request ON quality_scrap_reviews(tenant_id,idempotency_key);
ALTER TABLE quality_scrap_reviews ADD CONSTRAINT quality_scrap_reviews_previous FOREIGN KEY(tenant_id,previous_review_id,production_order_id,production_version_id) REFERENCES quality_scrap_reviews(tenant_id,id,production_order_id,production_version_id);
CREATE TABLE quality_scrap_allocations (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),review_id uuid NOT NULL,production_order_id uuid NOT NULL,production_version_id uuid NOT NULL,
 quality_group_id uuid NOT NULL,source_quantity_review_id uuid NOT NULL,quantity integer NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT quality_scrap_allocations_review FOREIGN KEY(tenant_id,review_id,production_order_id,production_version_id) REFERENCES quality_scrap_reviews(tenant_id,id,production_order_id,production_version_id),
 CONSTRAINT quality_scrap_allocations_group FOREIGN KEY(tenant_id,quality_group_id,production_order_id,production_version_id) REFERENCES quality_inspection_groups(tenant_id,id,production_order_id,production_version_id),
 CONSTRAINT quality_scrap_allocations_source FOREIGN KEY(tenant_id,source_quantity_review_id,production_order_id,production_version_id) REFERENCES production_quantity_reviews(tenant_id,id,production_order_id,production_version_id),
 CONSTRAINT quality_scrap_allocations_quantity CHECK(quantity BETWEEN 1 AND 100000)
);
CREATE UNIQUE INDEX quality_scrap_allocations_scope ON quality_scrap_allocations(tenant_id,id);
CREATE UNIQUE INDEX quality_scrap_allocations_line ON quality_scrap_allocations(tenant_id,review_id,quality_group_id,source_quantity_review_id);
CREATE INDEX quality_scrap_allocations_group ON quality_scrap_allocations(tenant_id,quality_group_id);
CREATE INDEX quality_scrap_allocations_source ON quality_scrap_allocations(tenant_id,source_quantity_review_id);
--> statement-breakpoint
CREATE FUNCTION quality_scrap_group_quantity(tenant uuid,group_identity uuid,as_of_time timestamptz DEFAULT 'infinity') RETURNS integer LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT coalesce(sum(a.quantity),0)::int FROM quality_scrap_allocations a WHERE a.tenant_id=tenant AND a.quality_group_id=group_identity AND a.created_at<=as_of_time
$$;
CREATE FUNCTION quality_scrap_lots(tenant uuid,production_identity uuid,version_identity uuid)
 RETURNS TABLE(source_review_id uuid,report_id uuid,observed_at timestamptz,reviewed_at timestamptz,quantity integer,allocated_quantity integer)
 LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 WITH deltas AS (
  SELECT r.id,r.report_id,r.created_at,coalesce((r.quantities->>'scrappedQuantity')::int,0)-coalesce(lag((r.quantities->>'scrappedQuantity')::int) OVER(ORDER BY r.sequence),0) AS delta
  FROM production_quantity_reviews r WHERE r.tenant_id=tenant AND r.production_order_id=production_identity AND r.production_version_id=version_identity
 ) SELECT d.id,d.report_id,(report.input->>'observedAt')::timestamptz,d.created_at,d.delta,
   (SELECT coalesce(sum(a.quantity),0)::int FROM quality_scrap_allocations a WHERE a.tenant_id=tenant AND a.source_quantity_review_id=d.id)
  FROM deltas d JOIN production_quantity_reports report ON report.tenant_id=tenant AND report.id=d.report_id WHERE d.delta>0
$$;
CREATE FUNCTION quality_scrap_basis(tenant uuid,production_identity uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
DECLARE p production_orders;v production_order_versions;root quality_inspections;latest production_quantity_reviews;last_review quality_scrap_reviews;
 base jsonb;groups jsonb:='[]';lots jsonb:='[]';blockers jsonb:='[]';result jsonb;unassigned integer:=0;group_unassigned integer:=0;outside_quantity integer:=0;ambiguous_quantity integer:=0;mapped integer:=0;raw_allocations jsonb;
BEGIN
 IF tenant IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN RETURN NULL;END IF;
 SELECT * INTO p FROM production_orders WHERE tenant_id=tenant AND id=production_identity;
 IF p.id IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO v FROM production_order_versions WHERE tenant_id=tenant AND production_order_id=p.id AND version_number=p.current_version_number;
 base:=production_quantity_basis(tenant,p.id);blockers:=coalesce(base->'blockers','[]');
 SELECT q.* INTO root FROM quality_inspections q WHERE q.tenant_id=tenant AND q.production_order_id=p.id
  AND NOT EXISTS(SELECT 1 FROM quality_group_reinspections scope WHERE scope.tenant_id=tenant AND scope.inspection_id=q.id)
  ORDER BY q.production_projection_version DESC NULLS LAST,q.created_at DESC,q.id DESC LIMIT 1;
 SELECT * INTO latest FROM production_quantity_reviews WHERE tenant_id=tenant AND production_version_id=v.id ORDER BY sequence DESC LIMIT 1;
 SELECT * INTO last_review FROM quality_scrap_reviews WHERE tenant_id=tenant AND production_version_id=v.id ORDER BY id DESC LIMIT 1;
 IF root.id IS NULL OR root.assessment_version IS DISTINCT FROM 3 OR root.production_version_id IS DISTINCT FROM v.id THEN blockers:=blockers||'"需要原当前生产版本的实际分组检验"'::jsonb;END IF;
 IF latest.id IS NULL THEN blockers:=blockers||'"需要已核准的实际数量凭证 未知报废不能归属"'::jsonb;END IF;
 IF p.status NOT IN('completed','quality_hold') THEN blockers:=blockers||'"原生产尚未完成或已停止 请核对当前实物"'::jsonb;END IF;
 IF EXISTS(SELECT 1 FROM orders o WHERE o.tenant_id=tenant AND o.id=p.order_id AND(o.side_state IS NOT NULL OR o.workflow_state='completed'))
  OR EXISTS(SELECT 1 FROM order_work_items w WHERE w.tenant_id=tenant AND w.id=p.order_line_id AND w.held)
  THEN blockers:=blockers||'"订单或商品已停止 不能追加报废归属"'::jsonb;END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('sourceQuantityReviewId',l.source_review_id,'reportId',l.report_id,
  'observedAt',to_char(l.observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'reviewedAt',to_char(l.reviewed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'quantity',l.quantity,'allocatedQuantity',l.allocated_quantity,'remainingQuantity',l.quantity-l.allocated_quantity,
  'scope',CASE WHEN root.id IS NULL THEN 'no_root' WHEN l.reviewed_at<=root.created_at THEN 'before_root' WHEN l.observed_at<root.created_at THEN 'ambiguous' ELSE 'groupable' END) ORDER BY l.reviewed_at,l.source_review_id),'[]'),
  coalesce(sum(l.quantity-l.allocated_quantity),0)::int,
  coalesce(sum(l.quantity-l.allocated_quantity) FILTER(WHERE root.id IS NOT NULL AND l.reviewed_at>root.created_at AND l.observed_at>=root.created_at),0)::int,
  coalesce(sum(l.quantity-l.allocated_quantity) FILTER(WHERE root.id IS NOT NULL AND l.reviewed_at<=root.created_at),0)::int,
  coalesce(sum(l.quantity-l.allocated_quantity) FILTER(WHERE root.id IS NOT NULL AND l.reviewed_at>root.created_at AND l.observed_at<root.created_at),0)::int
  INTO lots,unassigned,group_unassigned,outside_quantity,ambiguous_quantity FROM quality_scrap_lots(tenant,p.id,v.id) l;
 SELECT coalesce(sum(a.quantity),0)::int,coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]') INTO mapped,raw_allocations
  FROM quality_scrap_allocations a WHERE a.tenant_id=tenant AND a.production_version_id=v.id;
 IF root.assessment_version=3 AND root.production_version_id=v.id THEN
  WITH RECURSIVE tree AS (
   SELECT g.*,ARRAY[g.id] AS visited FROM quality_inspection_groups g WHERE g.tenant_id=tenant AND g.inspection_id=root.id
   UNION ALL SELECT g.*,parent.visited||g.id FROM tree parent JOIN quality_group_reinspections scope ON scope.tenant_id=tenant AND scope.parent_group_id=parent.id
    JOIN quality_inspection_groups g ON g.tenant_id=tenant AND g.inspection_id=scope.inspection_id WHERE NOT g.id=ANY(parent.visited)
  ),measured AS (
   SELECT g.*,q.created_at AS inspection_recorded_at,NOT EXISTS(SELECT 1 FROM quality_group_reinspections scope WHERE scope.tenant_id=tenant AND scope.parent_group_id=g.id) AS active,
    quality_scrap_group_quantity(tenant,g.id) AS scrapped,
    (SELECT coalesce(sum(coalesce(production_quantity_remaining(tenant,rg.replacement_production_order_id,rg.replacement_production_version_id),rg.quantity)),0)::int FROM production_recovery_groups rg WHERE rg.tenant_id=tenant AND rg.quality_group_id=g.id) AS remake,
    (SELECT coalesce(sum(a.quantity),0)::int FROM shipment_production_allocations a JOIN shipment_versions sv ON sv.tenant_id=tenant AND sv.id=a.shipment_version_id JOIN shipments s ON s.tenant_id=tenant AND s.id=sv.shipment_id
      WHERE a.tenant_id=tenant AND a.production_order_id=p.id AND(a.quality_group_id=g.id OR a.quality_group_id IS NULL)
       AND((s.status<>'cancelled' AND sv.version_number=s.approved_version_number) OR production_quantity_physical_package(a.package_id))) AS allocated
   FROM tree g JOIN quality_inspections q ON q.tenant_id=tenant AND q.id=g.inspection_id
  ) SELECT coalesce(jsonb_agg(jsonb_build_object('qualityGroupId',g.id,'inspectionId',g.inspection_id,'label',g.label,'quantity',g.quantity,
    'inspectionRecordedAt',to_char(g.inspection_recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'active',g.active,'result',g.result,
    'scrappedQuantity',g.scrapped,'reinspectableQuantity',CASE WHEN g.active THEN g.quantity-g.scrapped ELSE 0 END,
    'maxAllocatableQuantity',CASE WHEN g.active AND g.result='failed' AND g.allocated=0 THEN g.quantity-g.scrapped ELSE 0 END,
    'remakeEligible',g.result='failed' AND(g.active OR g.scrapped>0),'remakeQuantity',g.remake,
    'remainingRemakeQuantity',CASE WHEN g.result='failed' THEN greatest((CASE WHEN g.active THEN g.quantity ELSE g.scrapped END)-g.remake,0) ELSE 0 END,
    'remainingScrapRemakeQuantity',CASE WHEN g.result='failed' THEN greatest(g.scrapped-g.remake,0) ELSE 0 END,'allocatedQuantity',g.allocated,
    'allocationBlockers',CASE WHEN NOT g.active THEN '["原组已复检替代 不能再扣其原实物"]'::jsonb WHEN g.result<>'failed' THEN '["已通过实物不能归入失败组报废"]'::jsonb
      WHEN g.allocated>0 THEN '["原组或未定位实物已有审核分配或实际交运"]'::jsonb WHEN g.scrapped=g.quantity THEN '["原组实物已全部归属报废"]'::jsonb ELSE '[]'::jsonb END) ORDER BY g.inspection_recorded_at,g.id),'[]') INTO groups FROM measured g;
 END IF;
 result:=jsonb_build_object('productionOrderId',p.id,'orderId',p.order_id,'productionVersionId',v.id,'projectionVersion',p.projection_version,
  'rootInspectionId',root.id,'quantityReviewId',latest.id,'scrapReviewId',last_review.id,'actualScrappedQuantity',(latest.quantities->>'scrappedQuantity')::int,
  'mappedScrappedQuantity',mapped,'unassignedQuantity',unassigned,'unassignedGroupQuantity',group_unassigned,'outsideRootQuantity',outside_quantity,'ambiguousQuantity',ambiguous_quantity,
  'groups',groups,'lots',lots,'blockers',blockers);
 RETURN result||jsonb_build_object('fingerprint',encode(sha256(convert_to(jsonb_build_object('basis',result,'productionFingerprint',base->>'fingerprint','allocations',raw_allocations)::text,'UTF8')),'hex'));
END $$;
--> statement-breakpoint
CREATE FUNCTION quality_scrap_input_valid(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE item jsonb;key text;uuid_pattern text:='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';
BEGIN
 IF jsonb_typeof(value) IS DISTINCT FROM 'object' OR value-ARRAY['idempotencyKey','productionVersionId','expectedProductionProjectionVersion','expectedRootInspectionId','expectedQuantityReviewId','expectedScrapReviewId','expectedBasisFingerprint','physicalSegregationConfirmed','occurredAt','evidenceCode','evidenceAssetIds','allocations']<>'{}'::jsonb
  OR(SELECT count(*) FROM jsonb_object_keys(value))<>12 THEN RETURN false;END IF;
 FOREACH key IN ARRAY ARRAY['productionVersionId','expectedRootInspectionId','expectedQuantityReviewId'] LOOP
  IF jsonb_typeof(value->key) IS DISTINCT FROM 'string' OR value->>key!~uuid_pattern THEN RETURN false;END IF;
 END LOOP;
 IF value->'expectedScrapReviewId'<>'null'::jsonb AND(jsonb_typeof(value->'expectedScrapReviewId') IS DISTINCT FROM 'string' OR value->>'expectedScrapReviewId'!~uuid_pattern) THEN RETURN false;END IF;
 IF jsonb_typeof(value->'idempotencyKey') IS DISTINCT FROM 'string' OR length(value->>'idempotencyKey') NOT BETWEEN 8 AND 200 OR value->>'idempotencyKey'<>btrim(value->>'idempotencyKey')
  OR jsonb_typeof(value->'expectedProductionProjectionVersion') IS DISTINCT FROM 'number' OR value->>'expectedProductionProjectionVersion'!~'^[1-9][0-9]*$' OR(value->>'expectedProductionProjectionVersion')::numeric>2147483647
  OR jsonb_typeof(value->'expectedBasisFingerprint') IS DISTINCT FROM 'string' OR value->>'expectedBasisFingerprint'!~'^[a-f0-9]{64}$'
  OR value->'physicalSegregationConfirmed' IS DISTINCT FROM 'true'::jsonb
  OR jsonb_typeof(value->'occurredAt') IS DISTINCT FROM 'string' OR value->>'occurredAt'!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$'
  OR jsonb_typeof(value->'evidenceCode') IS DISTINCT FROM 'string' OR value->>'evidenceCode'!~'^[A-Z0-9_:-]{1,160}$'
  OR jsonb_typeof(value->'evidenceAssetIds') IS DISTINCT FROM 'array' OR jsonb_array_length(value->'evidenceAssetIds')>100
  OR jsonb_typeof(value->'allocations') IS DISTINCT FROM 'array' OR jsonb_array_length(value->'allocations') NOT BETWEEN 1 AND 100 THEN RETURN false;END IF;
 PERFORM(value->>'occurredAt')::timestamptz;
 FOR item IN SELECT e FROM jsonb_array_elements(value->'evidenceAssetIds')e LOOP IF jsonb_typeof(item) IS DISTINCT FROM 'string' OR item#>>'{}'!~uuid_pattern THEN RETURN false;END IF;END LOOP;
 IF(SELECT count(DISTINCT e) FROM jsonb_array_elements_text(value->'evidenceAssetIds')e)<>jsonb_array_length(value->'evidenceAssetIds') THEN RETURN false;END IF;
 FOR item IN SELECT e FROM jsonb_array_elements(value->'allocations')e LOOP
  IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR item-ARRAY['qualityGroupId','sourceQuantityReviewId','quantity']<>'{}'::jsonb OR(SELECT count(*) FROM jsonb_object_keys(item))<>3
   OR jsonb_typeof(item->'qualityGroupId') IS DISTINCT FROM 'string' OR item->>'qualityGroupId'!~uuid_pattern OR jsonb_typeof(item->'sourceQuantityReviewId') IS DISTINCT FROM 'string' OR item->>'sourceQuantityReviewId'!~uuid_pattern
   OR jsonb_typeof(item->'quantity') IS DISTINCT FROM 'number' OR item->>'quantity'!~'^[1-9][0-9]*$' OR(item->>'quantity')::numeric>100000 THEN RETURN false;END IF;
 END LOOP;
 IF(SELECT sum((e->>'quantity')::int) FROM jsonb_array_elements(value->'allocations')e)>100000
  OR(SELECT count(DISTINCT(e->>'qualityGroupId',e->>'sourceQuantityReviewId')) FROM jsonb_array_elements(value->'allocations')e)<>jsonb_array_length(value->'allocations') THEN RETURN false;END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;END $$;
CREATE FUNCTION guard_quality_scrap_review() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE basis jsonb;asset uuid;latest production_quantity_reviews;
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid OR NEW.created_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
  OR substring(NEW.id::text FROM 15 FOR 1)<>'7' OR NOT quality_scrap_input_valid(NEW.input) THEN RAISE EXCEPTION 'quality_scrap_input_invalid' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('quality-scrap-request:'||NEW.tenant_id::text||':'||NEW.idempotency_key,0));
 PERFORM production_quantity_lock(NEW.tenant_id,NEW.production_order_id);basis:=quality_scrap_basis(NEW.tenant_id,NEW.production_order_id);
 IF basis IS NULL OR jsonb_array_length(basis->'blockers')>0 OR NEW.production_version_id::text<>basis->>'productionVersionId' OR NEW.root_inspection_id::text<>basis->>'rootInspectionId'
  OR NEW.quantity_review_id::text<>basis->>'quantityReviewId' OR NEW.previous_review_id IS DISTINCT FROM(basis->>'scrapReviewId')::uuid
  OR NEW.input->>'productionVersionId'<>NEW.production_version_id::text OR NEW.input->>'expectedRootInspectionId'<>NEW.root_inspection_id::text OR NEW.input->>'expectedQuantityReviewId'<>NEW.quantity_review_id::text
  OR NEW.input->>'expectedScrapReviewId' IS DISTINCT FROM basis->>'scrapReviewId' OR NEW.input->>'expectedProductionProjectionVersion'<>basis->>'projectionVersion' OR NEW.input->>'expectedBasisFingerprint'<>basis->>'fingerprint'
  OR NEW.idempotency_key<>NEW.input->>'idempotencyKey' OR NEW.request_canonical::jsonb<>jsonb_build_object('version',1,'operation','allocate','productionOrderId',NEW.production_order_id,'input',NEW.input)
  THEN RAISE EXCEPTION 'quality_scrap_basis_changed' USING ERRCODE='23514';END IF;
 SELECT * INTO latest FROM production_quantity_reviews WHERE tenant_id=NEW.tenant_id AND id=NEW.quantity_review_id;
 IF(NEW.input->>'occurredAt')::timestamptz>clock_timestamp() OR(NEW.input->>'occurredAt')::timestamptz<(latest.input->>'occurredAt')::timestamptz
  THEN RAISE EXCEPTION 'quality_scrap_time_invalid' USING ERRCODE='23514';END IF;
 FOR asset IN SELECT e::uuid FROM jsonb_array_elements_text(NEW.input->'evidenceAssetIds')e LOOP
  IF NOT EXISTS(SELECT 1 FROM asset_files a WHERE a.tenant_id=NEW.tenant_id AND a.id=asset AND a.asset_domain='authorized' AND a.rights_status='approved' AND a.deleted_at IS NULL)
   THEN RAISE EXCEPTION 'quality_scrap_evidence_invalid' USING ERRCODE='23514';END IF;
 END LOOP;
 NEW.creation_transaction_id:=pg_current_xact_id()::text;NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
--> statement-breakpoint
-- Reinspection remains a separate immutable event, covering only retained
-- physical pieces. Its retired parent's scrap still owns replacement credit.
CREATE OR REPLACE FUNCTION check_recovery_group_quantity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE basis jsonb;source_group jsonb;disposition text;ceiling integer;occupied integer;
BEGIN
 PERFORM production_quantity_lock(NEW.tenant_id,NEW.production_order_id);basis:=quality_scrap_basis(NEW.tenant_id,NEW.production_order_id);
 SELECT e INTO source_group FROM jsonb_array_elements(basis->'groups')e WHERE e->>'qualityGroupId'=NEW.quality_group_id::text;
 SELECT defect.disposition INTO disposition FROM production_recovery_cases recovery
  JOIN quality_group_defects gd ON gd.tenant_id=recovery.tenant_id AND gd.defect_id=recovery.defect_id
  JOIN quality_defects defect ON defect.tenant_id=gd.tenant_id AND defect.id=gd.defect_id
  WHERE recovery.tenant_id=NEW.tenant_id AND recovery.id=NEW.recovery_case_id AND recovery.type='remake' AND gd.quality_group_id=NEW.quality_group_id;
 IF source_group IS NULL OR source_group->>'result'<>'failed' OR source_group->'remakeEligible' IS DISTINCT FROM 'true'::jsonb
  OR disposition IS NULL OR disposition NOT IN('remake','rework','scrap') OR(basis->>'unassignedGroupQuantity')::int>0 OR(basis->>'ambiguousQuantity')::int>0
  THEN RAISE EXCEPTION 'quality_scrap_remake_source_invalid' USING ERRCODE='23514';END IF;
 ceiling:=CASE WHEN disposition='scrap' OR source_group->'active'='false'::jsonb THEN(source_group->>'scrappedQuantity')::int ELSE(source_group->>'quantity')::int END;
 occupied:=(source_group->>'remakeQuantity')::int;
 IF occupied>ceiling THEN RAISE EXCEPTION 'defects share the original physical group or retired scrap replacement limit' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION production_quantity_scrap_group_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE basis jsonb;source_group jsonb;group_identity uuid;physical_quantity integer;actual integer;
BEGIN
 IF TG_TABLE_NAME='quality_group_reinspections' THEN group_identity:=NEW.parent_group_id;ELSE group_identity:=NEW.quality_group_id;END IF;
 PERFORM production_quantity_lock(NEW.tenant_id,NEW.production_order_id);basis:=quality_scrap_basis(NEW.tenant_id,NEW.production_order_id);
 SELECT e INTO source_group FROM jsonb_array_elements(basis->'groups')e WHERE e->>'qualityGroupId'=group_identity::text;
 IF source_group IS NULL OR(basis->>'unassignedGroupQuantity')::int>0 OR(basis->>'ambiguousQuantity')::int>0
  THEN RAISE EXCEPTION 'production_quantity_scrap_group_unresolved' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='quality_group_reinspections' THEN
  physical_quantity:=(source_group->>'quantity')::int-(source_group->>'scrappedQuantity')::int;
  SELECT coalesce(sum(g.quantity),0)::int INTO actual FROM quality_inspection_groups g WHERE g.tenant_id=NEW.tenant_id AND g.inspection_id=NEW.inspection_id;
  IF physical_quantity<=0 OR actual<>physical_quantity OR(source_group->>'remakeQuantity')::int>0 OR(source_group->>'allocatedQuantity')::int>0
   THEN RAISE EXCEPTION 'quality_scrap_reinspection_source_invalid' USING ERRCODE='23514';END IF;
 END IF;RETURN NULL;
END $$;
DROP TRIGGER production_quantity_scrap_reinspection_guard ON quality_group_reinspections;
DROP TRIGGER production_quantity_scrap_recovery_guard ON production_recovery_groups;
CREATE CONSTRAINT TRIGGER production_quantity_scrap_reinspection_guard AFTER INSERT ON quality_group_reinspections DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION production_quantity_scrap_group_guard();
CREATE CONSTRAINT TRIGGER production_quantity_scrap_recovery_guard AFTER INSERT ON production_recovery_groups DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION production_quantity_scrap_group_guard();
CREATE FUNCTION quality_scrap_root_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE prior_root_id uuid;
BEGIN
 IF NEW.production_version_id IS NULL OR EXISTS(SELECT 1 FROM quality_group_reinspections scope WHERE scope.tenant_id=NEW.tenant_id AND scope.inspection_id=NEW.id) THEN RETURN NULL;END IF;
 SELECT prior_root.id INTO prior_root_id FROM quality_inspections prior_root
  WHERE prior_root.tenant_id=NEW.tenant_id AND prior_root.production_version_id=NEW.production_version_id AND prior_root.created_at<NEW.created_at
   AND NOT EXISTS(SELECT 1 FROM quality_group_reinspections scope WHERE scope.tenant_id=prior_root.tenant_id AND scope.inspection_id=prior_root.id)
  ORDER BY prior_root.created_at DESC,prior_root.id DESC LIMIT 1;
 IF(EXISTS(SELECT 1 FROM quality_inspection_groups original_group WHERE original_group.tenant_id=NEW.tenant_id AND original_group.inspection_id=prior_root_id)
   AND EXISTS(SELECT 1 FROM production_quantity_reviews r WHERE r.tenant_id=NEW.tenant_id AND r.production_version_id=NEW.production_version_id AND r.created_at<=NEW.created_at AND(r.quantities->>'scrappedQuantity')::int>0))
   OR EXISTS(SELECT 1 FROM quality_scrap_allocations a WHERE a.tenant_id=NEW.tenant_id AND a.production_version_id=NEW.production_version_id)
  THEN RAISE EXCEPTION 'quality_scrap_original_root_required' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER quality_scrap_root_guard AFTER INSERT ON quality_inspections DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION quality_scrap_root_guard();
CREATE TRIGGER quality_scrap_review_guard BEFORE INSERT ON quality_scrap_reviews FOR EACH ROW EXECUTE FUNCTION guard_quality_scrap_review();
CREATE FUNCTION guard_quality_scrap_allocation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE review quality_scrap_reviews;basis jsonb;source_group jsonb;lot record;inspection_time timestamptz;allocated integer;
BEGIN
 SELECT * INTO review FROM quality_scrap_reviews WHERE tenant_id=NEW.tenant_id AND id=NEW.review_id;
 IF review.id IS NULL OR review.creation_transaction_id IS DISTINCT FROM pg_current_xact_id()::text OR review.created_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
  OR substring(NEW.id::text FROM 15 FOR 1)<>'7' OR NEW.production_order_id<>review.production_order_id OR NEW.production_version_id<>review.production_version_id
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(review.input->'allocations')e WHERE e=jsonb_build_object('qualityGroupId',NEW.quality_group_id,'sourceQuantityReviewId',NEW.source_quantity_review_id,'quantity',NEW.quantity))
  THEN RAISE EXCEPTION 'quality_scrap_actual_review_required' USING ERRCODE='23514';END IF;
 PERFORM production_quantity_lock(NEW.tenant_id,NEW.production_order_id);basis:=quality_scrap_basis(NEW.tenant_id,NEW.production_order_id);
 SELECT e INTO source_group FROM jsonb_array_elements(basis->'groups')e WHERE e->>'qualityGroupId'=NEW.quality_group_id::text;
 SELECT * INTO lot FROM quality_scrap_lots(NEW.tenant_id,NEW.production_order_id,NEW.production_version_id) l WHERE l.source_review_id=NEW.source_quantity_review_id;
 SELECT q.created_at INTO inspection_time FROM quality_inspection_groups g JOIN quality_inspections q ON q.tenant_id=g.tenant_id AND q.id=g.inspection_id WHERE g.tenant_id=NEW.tenant_id AND g.id=NEW.quality_group_id;
 IF source_group IS NULL OR jsonb_array_length(source_group->'allocationBlockers')>0 OR NEW.quantity>(source_group->>'maxAllocatableQuantity')::int OR lot.source_review_id IS NULL
  OR lot.reviewed_at<inspection_time OR lot.observed_at<inspection_time OR lot.allocated_quantity+NEW.quantity>lot.quantity
  THEN RAISE EXCEPTION 'quality_scrap_source_or_balance_invalid' USING ERRCODE='23514';END IF;
 NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER quality_scrap_allocation_guard BEFORE INSERT ON quality_scrap_allocations FOR EACH ROW EXECUTE FUNCTION guard_quality_scrap_allocation();
CREATE FUNCTION require_quality_scrap_closure() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE review quality_scrap_reviews;p production_orders;production_identity uuid;expected integer;actual integer;
BEGIN
 IF TG_TABLE_NAME='production_orders' THEN production_identity:=NEW.id;ELSE production_identity:=NEW.production_order_id;END IF;
 FOR review IN SELECT r.* FROM quality_scrap_reviews r WHERE r.tenant_id=NEW.tenant_id AND r.production_order_id=production_identity AND r.creation_transaction_id=pg_current_xact_id()::text LOOP
  SELECT * INTO p FROM production_orders WHERE tenant_id=review.tenant_id AND id=review.production_order_id;
  SELECT jsonb_array_length(review.input->'allocations') INTO expected;SELECT count(*) INTO actual FROM quality_scrap_allocations a WHERE a.tenant_id=review.tenant_id AND a.review_id=review.id;
  IF actual<>expected OR p.projection_version<>(review.input->>'expectedProductionProjectionVersion')::int+1
   OR NOT EXISTS(SELECT 1 FROM production_order_versions v WHERE v.tenant_id=review.tenant_id AND v.id=review.production_version_id AND v.version_number=p.current_version_number)
   OR NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.tenant_id=review.tenant_id AND a.entity_id=review.id AND a.entity_type='quality_scrap_review' AND a.action='production.quality.scrap_allocated' AND a.actor_user_id=review.created_by AND a.result='success' AND a.xmin::text=(pg_current_xact_id()::text::numeric%4294967296)::bigint::text)
   THEN RAISE EXCEPTION 'quality_scrap_owner_closure_required' USING ERRCODE='23514';END IF;
 END LOOP;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER quality_scrap_review_closure AFTER INSERT ON quality_scrap_reviews DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_quality_scrap_closure();
CREATE CONSTRAINT TRIGGER quality_scrap_allocation_closure AFTER INSERT ON quality_scrap_allocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_quality_scrap_closure();
CREATE CONSTRAINT TRIGGER quality_scrap_projection_closure AFTER UPDATE ON production_orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_quality_scrap_closure();
DO $$DECLARE name text;BEGIN
 FOREACH name IN ARRAY ARRAY['quality_scrap_reviews','quality_scrap_allocations'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',name);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO yummyai_app',name);
  EXECUTE format('CREATE TRIGGER quality_scrap_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION factory_capacity_immutable()',name);
 END LOOP;
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION check_quality_group_cover() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inspection_id_value uuid; inspection_row quality_inspections%ROWTYPE; standard_row quality_standard_versions%ROWTYPE;
  expected_quantity integer; total_quantity integer; group_count integer; aggregate_score integer; aggregate_result text;
  group_row quality_inspection_groups%ROWTYPE; calculated_score integer; calculated_result text;
BEGIN
  IF TG_TABLE_NAME='quality_inspections' THEN inspection_id_value:=NEW.id; ELSE inspection_id_value:=NEW.inspection_id; END IF;
  SELECT * INTO inspection_row FROM quality_inspections WHERE id=inspection_id_value;
  IF inspection_row.assessment_version IS DISTINCT FROM 3 THEN RETURN NULL; END IF;
  SELECT coalesce(parent.quantity-quality_scrap_group_quantity(parent.tenant_id,parent.id,inspection_row.created_at),production_quantity_inspectable_as_of(pv.tenant_id,pv.id,inspection_row.created_at)) INTO expected_quantity FROM production_order_versions pv
    LEFT JOIN quality_group_reinspections scope ON scope.inspection_id=inspection_row.id AND scope.tenant_id=inspection_row.tenant_id
    LEFT JOIN quality_inspection_groups parent ON parent.id=scope.parent_group_id AND parent.tenant_id=scope.tenant_id
    WHERE pv.id=inspection_row.production_version_id AND pv.tenant_id=inspection_row.tenant_id;
  SELECT count(*),sum(quantity),round(sum(quantity::numeric*score_bps)/nullif(sum(quantity),0))::integer,
    CASE WHEN bool_and(result='passed') THEN 'passed' ELSE 'failed' END
    INTO group_count,total_quantity,aggregate_score,aggregate_result FROM quality_inspection_groups WHERE inspection_id=inspection_row.id AND tenant_id=inspection_row.tenant_id;
  IF group_count NOT BETWEEN 1 AND 100 OR total_quantity IS DISTINCT FROM expected_quantity
    OR aggregate_score IS DISTINCT FROM inspection_row.score_bps OR aggregate_result IS DISTINCT FROM inspection_row.result THEN
    RAISE EXCEPTION 'quality groups must completely cover their physical source with the actual aggregate outcome' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM quality_defects d WHERE d.inspection_id=inspection_row.id AND d.tenant_id=inspection_row.tenant_id
    AND NOT EXISTS(SELECT 1 FROM quality_group_defects gd WHERE gd.defect_id=d.id AND gd.tenant_id=d.tenant_id)) THEN
    RAISE EXCEPTION 'every grouped defect requires its explicit physical group and quantity' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM quality_group_defects gd JOIN quality_defects d ON d.id=gd.defect_id AND d.tenant_id=gd.tenant_id
    WHERE gd.inspection_id=inspection_row.id AND gd.tenant_id=inspection_row.tenant_id GROUP BY gd.quality_group_id,d.code HAVING count(*)>1) THEN
    RAISE EXCEPTION 'a defect code occurs once per physical group' USING ERRCODE='23514';
  END IF;
  SELECT * INTO standard_row FROM quality_standard_versions WHERE id=inspection_row.quality_standard_version_id AND tenant_id=inspection_row.tenant_id;
  FOR group_row IN SELECT * FROM quality_inspection_groups WHERE inspection_id=inspection_row.id AND tenant_id=inspection_row.tenant_id LOOP
    IF jsonb_array_length(group_row.criterion_results)<>jsonb_array_length(standard_row.criteria)
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(group_row.criterion_results) r WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(standard_row.criteria) c WHERE c->>'code'=r->>'code'))
      OR (SELECT count(DISTINCT r->>'code') FROM jsonb_array_elements(group_row.criterion_results) r)<>jsonb_array_length(standard_row.criteria)
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(group_row.criterion_results) r WHERE jsonb_typeof(r->'passed') IS DISTINCT FROM 'boolean'
        OR jsonb_typeof(r->'scoreBps') IS DISTINCT FROM 'number' OR (r->>'scoreBps')::numeric NOT BETWEEN 0 AND 10000 OR (r->>'scoreBps')::numeric<>trunc((r->>'scoreBps')::numeric)) THEN
      RAISE EXCEPTION 'group criterion evidence must exactly match its standard' USING ERRCODE='23514';
    END IF;
    SELECT round(sum((c->>'weightBps')::numeric*(r->>'scoreBps')::numeric)/10000)::integer INTO calculated_score
      FROM jsonb_array_elements(standard_row.criteria) c JOIN jsonb_array_elements(group_row.criterion_results) r ON r->>'code'=c->>'code';
    calculated_result:=CASE WHEN calculated_score>=standard_row.minimum_score_bps
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(standard_row.criteria) c JOIN jsonb_array_elements(group_row.criterion_results) r ON r->>'code'=c->>'code' WHERE (c->>'blocking')::boolean AND NOT (r->>'passed')::boolean)
      AND NOT EXISTS(SELECT 1 FROM quality_group_defects gd JOIN quality_defects d ON d.id=gd.defect_id AND d.tenant_id=gd.tenant_id WHERE gd.quality_group_id=group_row.id AND gd.tenant_id=group_row.tenant_id AND (d.severity='critical' OR d.disposition<>'accept'))
      THEN 'passed' ELSE 'failed' END;
    IF group_row.score_bps IS DISTINCT FROM calculated_score OR group_row.result IS DISTINCT FROM calculated_result
      OR ((calculated_result='failed' OR EXISTS(SELECT 1 FROM jsonb_array_elements(group_row.criterion_results) r WHERE NOT (r->>'passed')::boolean))
        AND NOT EXISTS(SELECT 1 FROM quality_group_defects gd WHERE gd.quality_group_id=group_row.id AND gd.tenant_id=group_row.tenant_id)) THEN
      RAISE EXCEPTION 'group outcome must follow actual criteria and defect dispositions' USING ERRCODE='23514';
    END IF;
  END LOOP;
  IF EXISTS(WITH RECURSIVE ancestry AS (
    SELECT scope.parent_group_id AS group_id,ARRAY[scope.parent_group_id] AS visited,false AS cycle FROM quality_group_reinspections scope WHERE scope.inspection_id=inspection_row.id AND scope.tenant_id=inspection_row.tenant_id
    UNION ALL SELECT scope.parent_group_id,ancestry.visited||scope.parent_group_id,scope.parent_group_id=ANY(ancestry.visited)
      FROM ancestry JOIN quality_inspection_groups g ON g.id=ancestry.group_id AND g.tenant_id=inspection_row.tenant_id
      JOIN quality_group_reinspections scope ON scope.inspection_id=g.inspection_id AND scope.tenant_id=g.tenant_id WHERE NOT ancestry.cycle)
    SELECT 1 FROM ancestry WHERE cycle) THEN
    RAISE EXCEPTION 'physical group reinspection cannot form a cycle' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
