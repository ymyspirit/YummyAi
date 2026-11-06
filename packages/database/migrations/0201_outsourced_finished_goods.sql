-- The manufacturing binding is sealed against the reviewed operation in the production transaction.
-- Old records have no marker. RLS and the pinned version remain authoritative for every caller.
CREATE FUNCTION outsourced_production_factory(tenant uuid, version_identity uuid) RETURNS uuid
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT (b.content_canonical::jsonb->'operations'->0->>'outsourcedFactoryId')::uuid
 FROM production_manufacturing_bindings b
 WHERE b.tenant_id=tenant AND b.production_version_id=version_identity
 AND b.content_canonical::jsonb->'materials'='[]'::jsonb
 AND jsonb_array_length(b.content_canonical::jsonb->'operations')=1
 AND b.content_canonical::jsonb->'operations'->0 @> '{"processCode":"FULL_PRODUCT","responsibility":"factory"}'::jsonb
 AND tenant=nullif(current_setting('app.tenant_id',true),'')::uuid
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION require_complete_manufacturing_review() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE outsourced_factory uuid;
BEGIN
 IF NEW.decision<>'approved' THEN RETURN NEW; END IF;
 SELECT (o.payload->>'outsourcedFactoryId')::uuid INTO outsourced_factory FROM manufacturing_operations o
 WHERE o.tenant_id=NEW.tenant_id AND o.version_id=NEW.version_id AND o.payload ? 'outsourcedFactoryId' LIMIT 1;
 IF outsourced_factory IS NOT NULL AND (
   (SELECT count(*) FROM manufacturing_operations o WHERE o.tenant_id=NEW.tenant_id AND o.version_id=NEW.version_id)<>1
   OR NOT EXISTS(SELECT 1 FROM manufacturing_operations o WHERE o.tenant_id=NEW.tenant_id AND o.version_id=NEW.version_id
     AND o.payload->>'responsibility'='factory' AND o.payload->>'processCode'='FULL_PRODUCT')
   OR EXISTS(SELECT 1 FROM manufacturing_bom_lines b WHERE b.tenant_id=NEW.tenant_id AND b.version_id=NEW.version_id)
   OR NOT EXISTS(SELECT 1 FROM fulfillment_factories f JOIN fulfillment_factory_versions v ON v.tenant_id=f.tenant_id
     AND v.factory_id=f.id AND v.version_number=f.current_version_number
     JOIN fulfillment_suppliers s ON s.tenant_id=f.tenant_id AND s.id=f.supplier_id
     WHERE f.tenant_id=NEW.tenant_id AND f.id=outsourced_factory AND f.status='active' AND s.status='active' AND v.profile->>'ownership'='partner')
 ) THEN RAISE EXCEPTION 'outsourced_manufacturing_factory_invalid' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM manufacturing_recipe_versions v JOIN manufacturing_recipes r ON r.tenant_id=v.tenant_id AND r.id=v.recipe_id
  JOIN product_specification_versions pv ON pv.tenant_id=v.tenant_id AND pv.id=v.specification_version_id
  JOIN product_specifications p ON p.tenant_id=pv.tenant_id AND p.id=pv.specification_id
  WHERE v.tenant_id=NEW.tenant_id AND v.id=NEW.version_id AND v.recipe_id=NEW.recipe_id AND r.archived_at IS NULL
   AND r.version_number=v.version_number AND p.version_number=pv.version_number AND specification_production_facts_ready(pv.facts))
 OR (outsourced_factory IS NULL AND NOT EXISTS(SELECT 1 FROM manufacturing_bom_lines l WHERE l.tenant_id=NEW.tenant_id AND l.version_id=NEW.version_id))
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
CREATE OR REPLACE FUNCTION assert_factory_capacity_production_version(tenant uuid,version_identity uuid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE p production_order_versions;required_count integer;reserved_count integer;outsourced_factory uuid;
BEGIN
 SELECT * INTO p FROM production_order_versions WHERE tenant_id=tenant AND id=version_identity;
 IF p.id IS NULL OR p.factory_id IS NULL OR p.capability_version_id IS NULL THEN RAISE EXCEPTION 'factory_capacity_new_production_required' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtext('factory:'||p.factory_id::text));
 outsourced_factory:=outsourced_production_factory(tenant,p.id);
 IF outsourced_factory IS NOT NULL THEN
  IF outsourced_factory<>p.factory_id OR EXISTS(SELECT 1 FROM factory_capacity_reservations r WHERE r.tenant_id=tenant AND r.production_version_id=p.id)
   OR NOT EXISTS(SELECT 1 FROM fulfillment_factory_versions f JOIN factory_capability_versions c ON c.tenant_id=f.tenant_id AND c.factory_id=f.factory_id
     WHERE f.tenant_id=tenant AND f.id=p.factory_version_id AND f.factory_id=p.factory_id AND c.id=p.capability_version_id
     AND f.profile->>'ownership'='partner' AND f.profile->>'status'='active' AND c.profile->>'fulfillmentScope'='full_product'
     AND c.profile->>'status'='active' AND c.profile->>'verificationStatus'='confirmed')
   THEN RAISE EXCEPTION 'outsourced_production_factory_mismatch' USING ERRCODE='23514'; END IF;
  RETURN;
 END IF;
 SELECT count(*) INTO required_count FROM factory_capacity_pools pool JOIN factory_capacity_versions v ON v.tenant_id=pool.tenant_id AND v.pool_id=pool.id AND v.version_number=pool.current_version_number
  WHERE pool.tenant_id=p.tenant_id AND pool.factory_id=p.factory_id AND v.profile->>'status' IN('active','paused')
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(v.profile->'bindings') b WHERE b->>'capabilityVersionId'=p.capability_version_id::text);
 SELECT count(*) INTO reserved_count FROM factory_capacity_reservations r JOIN factory_capacity_pools pool ON pool.tenant_id=r.tenant_id AND pool.id=r.pool_id
  JOIN factory_capacity_versions v ON v.tenant_id=pool.tenant_id AND v.pool_id=pool.id AND v.version_number=pool.current_version_number AND v.id=r.pool_version_id
  WHERE r.tenant_id=p.tenant_id AND r.production_version_id=p.id AND r.production_order_id=p.production_order_id AND r.quantity=p.quantity
   AND r.creation_transaction_id=pg_current_xact_id()::text AND v.profile->>'status'='active'
   AND EXISTS(SELECT 1 FROM factory_capacity_events e WHERE e.tenant_id=r.tenant_id AND e.reservation_id=r.id AND e.kind='reserve' AND e.units=r.total_units);
 IF required_count=0 OR reserved_count<>required_count THEN RAISE EXCEPTION 'factory_capacity_all_pools_required' USING ERRCODE='23514';END IF;
 RETURN;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_factory_capacity_reservation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE pool factory_capacity_pools;version factory_capacity_versions;production production_order_versions;production_root production_orders;calendar record;used_units numeric;outstanding numeric;instant timestamptz;today date;current_factory fulfillment_factories;current_factory_version fulfillment_factory_versions;pinned_factory_version fulfillment_factory_versions;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('factory:'||NEW.factory_id::text));
 PERFORM pg_advisory_xact_lock(hashtextextended('factory-capacity-pool:'||NEW.pool_id::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('factory-capacity-day:'||NEW.pool_id::text||':'||NEW.local_date::text,0));
 SELECT * INTO pool FROM factory_capacity_pools WHERE tenant_id=NEW.tenant_id AND id=NEW.pool_id;
 SELECT * INTO version FROM factory_capacity_versions WHERE tenant_id=NEW.tenant_id AND id=NEW.pool_version_id AND pool_id=pool.id;
 SELECT * INTO production FROM production_order_versions WHERE tenant_id=NEW.tenant_id AND id=NEW.production_version_id AND production_order_id=NEW.production_order_id;
 SELECT * INTO production_root FROM production_orders WHERE tenant_id=NEW.tenant_id AND id=NEW.production_order_id;
 IF pool.id IS NULL OR version.id IS NULL OR production.id IS NULL OR pool.factory_id<>NEW.factory_id OR production.factory_id IS DISTINCT FROM NEW.factory_id
  OR production_root.id IS NULL OR production_root.factory_id IS DISTINCT FROM NEW.factory_id OR production_root.current_version_number<>production.version_number
  OR production.capability_version_id IS DISTINCT FROM NEW.capability_version_id OR production.quantity<>NEW.quantity
  OR pool.unit<>NEW.unit OR pool.time_zone<>NEW.time_zone OR pool.current_version_number<>version.version_number OR version.profile->>'status' IS DISTINCT FROM 'active'
  OR NEW.created_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
  OR NOT EXISTS(SELECT 1 FROM factory_capacity_owner_proofs proof WHERE proof.tenant_id=NEW.tenant_id AND proof.owner_kind='version' AND proof.owner_id=NEW.production_version_id
    AND proof.production_order_id=NEW.production_order_id AND proof.quantity=NEW.quantity AND proof.creation_transaction_id=pg_current_xact_id()::text)
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(version.profile->'bindings') binding WHERE binding->>'capabilityVersionId'=NEW.capability_version_id::text AND (binding->>'unitsPerItem')::numeric=NEW.units_per_item)
 THEN RAISE EXCEPTION 'factory_capacity_reservation_original_required' USING ERRCODE='23514';END IF;
 instant:=clock_timestamp();today:=(instant AT TIME ZONE pool.time_zone)::date;
 SELECT * INTO current_factory FROM fulfillment_factories WHERE tenant_id=NEW.tenant_id AND id=NEW.factory_id FOR SHARE;
 SELECT * INTO current_factory_version FROM fulfillment_factory_versions WHERE tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id AND version_number=current_factory.current_version_number;
 SELECT * INTO pinned_factory_version FROM fulfillment_factory_versions WHERE tenant_id=NEW.tenant_id AND factory_id=NEW.factory_id AND id=production.factory_version_id;
 IF current_factory.status IS DISTINCT FROM 'active' OR current_factory_version.profile->>'timeZone' IS DISTINCT FROM pool.time_zone
  OR pinned_factory_version.profile->>'timeZone' IS DISTINCT FROM pool.time_zone
  THEN RAISE EXCEPTION 'factory_capacity_factory_basis_changed' USING ERRCODE='23514';END IF;
 SELECT * INTO calendar FROM factory_capacity_calendar_day(version.profile,pool.time_zone,NEW.local_date,instant);
 IF NEW.local_date<today OR NEW.work_starts_at IS DISTINCT FROM calendar.first_start OR NEW.work_ends_at IS DISTINCT FROM calendar.last_end
  OR NEW.work_ends_at>production.expected_completion_at OR(NEW.local_date=today AND(calendar.remaining_minutes=0 OR(calendar.cutoff_at IS NOT NULL AND instant>=calendar.cutoff_at)))
  THEN RAISE EXCEPTION 'factory_capacity_reservation_date_invalid' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM production_orders p WHERE p.tenant_id=NEW.tenant_id AND p.factory_id=NEW.factory_id AND p.id<>NEW.production_order_id
  AND NOT EXISTS(SELECT 1 FROM factory_capacity_reservations r WHERE r.tenant_id=p.tenant_id AND r.production_order_id=p.id)
  AND NOT EXISTS(SELECT 1 FROM production_order_versions pv WHERE pv.tenant_id=p.tenant_id AND pv.production_order_id=p.id
    AND pv.version_number=p.current_version_number AND outsourced_production_factory(p.tenant_id,pv.id)=p.factory_id)
  AND(p.status NOT IN('completed','cancelled') OR(NEW.local_date=today AND((p.created_at AT TIME ZONE pool.time_zone)::date=today OR(p.updated_at AT TIME ZONE pool.time_zone)::date=today
   OR EXISTS(SELECT 1 FROM production_milestone_events m WHERE m.tenant_id=p.tenant_id AND m.production_order_id=p.id AND m.type IN('completed','cancelled') AND(m.recorded_at AT TIME ZONE pool.time_zone)::date=today)))))
  THEN RAISE EXCEPTION 'factory_capacity_legacy_untracked' USING ERRCODE='23514';END IF;
 SELECT coalesce(sum(r.total_units-coalesce(e.released,0)-coalesce(stopped.released,0)),0),coalesce(sum(r.total_units-coalesce(e.released,0)-coalesce(stopped.released,0)-coalesce(e.committed,0)+coalesce(stopped.reduced,0)),0) INTO used_units,outstanding FROM factory_capacity_reservations r
  LEFT JOIN(SELECT reservation_id,sum(units) FILTER(WHERE kind='release') AS released,sum(units) FILTER(WHERE kind='commit') AS committed FROM factory_capacity_events WHERE tenant_id=NEW.tenant_id GROUP BY reservation_id)e ON e.reservation_id=r.id
  LEFT JOIN(SELECT reservation_id,sum(released_units) released,sum(commit_reduction_units) reduced FROM factory_capacity_stop_effects WHERE tenant_id=NEW.tenant_id GROUP BY reservation_id)stopped ON stopped.reservation_id=r.id
  WHERE r.tenant_id=NEW.tenant_id AND r.pool_id=NEW.pool_id AND r.local_date=NEW.local_date;
 IF calendar.limit_units<0 OR used_units+NEW.total_units>calendar.limit_units OR(pool.unit='minute' AND(calendar.limit_units>calendar.working_minutes OR(NEW.local_date=today AND outstanding+NEW.total_units>calendar.remaining_minutes)))
  THEN RAISE EXCEPTION 'factory_capacity_insufficient' USING ERRCODE='23514';END IF;
 NEW.creation_transaction_id:=pg_current_xact_id()::text;NEW.created_at:=clock_timestamp();
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION production_quantity_basis(tenant uuid,production_identity uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
DECLARE p production_orders;v production_order_versions;m production_manufacturing_bindings;prior production_quantity_reviews;
 parent orders;work order_work_items;root quality_inspections;group_rows jsonb;allocation_rows jsonb;reservation_rows jsonb;fingerprint_details jsonb;
 grouped integer:=0;passed integer:=0;allocated integer:=0;shipped integer:=0;unknown_source boolean:=false;blockers jsonb:='[]';result jsonb;raw_events jsonb;raw_effects jsonb;legacy_released boolean:=false;factory_managed boolean;
BEGIN
 IF tenant IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN RETURN NULL;END IF;
 SELECT * INTO p FROM production_orders WHERE tenant_id=tenant AND id=production_identity;
 IF p.id IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO v FROM production_order_versions WHERE tenant_id=tenant AND production_order_id=p.id AND version_number=p.current_version_number;
 SELECT * INTO parent FROM orders WHERE tenant_id=tenant AND id=p.order_id;
 SELECT * INTO work FROM order_work_items WHERE tenant_id=tenant AND id=p.order_line_id;
 SELECT * INTO m FROM production_manufacturing_bindings WHERE tenant_id=tenant AND production_version_id=v.id;
 SELECT * INTO prior FROM production_quantity_reviews WHERE tenant_id=tenant AND production_order_id=p.id AND production_version_id=v.id ORDER BY sequence DESC LIMIT 1;
 SELECT q.* INTO root FROM quality_inspections q WHERE q.tenant_id=tenant AND q.production_order_id=p.id
  AND NOT EXISTS(SELECT 1 FROM quality_group_reinspections r WHERE r.tenant_id=q.tenant_id AND r.inspection_id=q.id)
  ORDER BY q.production_projection_version DESC NULLS LAST,q.created_at DESC,q.id DESC LIMIT 1;
 IF root.id IS NOT NULL AND root.production_version_id IS DISTINCT FROM v.id THEN blockers:=blockers||'"原质检未固定当前生产版本 实物数量仍待核对"'::jsonb;
 ELSIF root.assessment_version=3 THEN
  WITH RECURSIVE tree AS (
   SELECT g.*,ARRAY[g.id] AS visited FROM quality_inspection_groups g WHERE g.tenant_id=tenant AND g.inspection_id=root.id
   UNION ALL SELECT g.*,t.visited||g.id FROM tree t JOIN quality_group_reinspections r ON r.tenant_id=t.tenant_id AND r.parent_group_id=t.id
    JOIN quality_inspection_groups g ON g.tenant_id=r.tenant_id AND g.inspection_id=r.inspection_id WHERE NOT g.id=ANY(t.visited)
  ) SELECT coalesce(jsonb_agg(to_jsonb(t)-'visited' ORDER BY t.id),'[]'),coalesce(sum(t.quantity),0)::int,coalesce(sum(t.quantity) FILTER(WHERE t.result='passed'),0)::int
    INTO group_rows,grouped,passed FROM tree t WHERE NOT EXISTS(SELECT 1 FROM quality_group_reinspections r WHERE r.tenant_id=tenant AND r.parent_group_id=t.id);
 ELSIF root.id IS NOT NULL AND root.assessment_version=2 THEN
  grouped:=coalesce((SELECT (r.quantities->>'completedQuantity')::int FROM production_quantity_reviews r WHERE r.tenant_id=tenant AND r.production_order_id=p.id
    AND r.production_version_id=v.id AND r.created_at<=root.created_at ORDER BY r.sequence DESC LIMIT 1),v.quantity);
  IF root.result='passed' THEN passed:=grouped;END IF;
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'versionId',a.shipment_version_id,'packageId',a.package_id,'quantity',a.quantity,'groupId',a.quality_group_id,
    'physical',production_quantity_physical_package(a.package_id),'approved',s.status<>'cancelled' AND sv.version_number=s.approved_version_number) ORDER BY a.id),'[]'),
    coalesce(sum(a.quantity),0)::int,coalesce(sum(a.quantity) FILTER(WHERE production_quantity_physical_package(a.package_id)),0)::int
  INTO allocation_rows,allocated,shipped FROM shipment_production_allocations a JOIN shipment_versions sv ON sv.tenant_id=a.tenant_id AND sv.id=a.shipment_version_id
  JOIN shipments s ON s.tenant_id=sv.tenant_id AND s.id=sv.shipment_id WHERE a.tenant_id=tenant AND a.production_order_id=p.id
   AND ((s.status<>'cancelled' AND sv.version_number=s.approved_version_number) OR production_quantity_physical_package(a.package_id));
 SELECT EXISTS(SELECT 1 FROM shipment_package_lines pl JOIN shipment_versions sv ON sv.tenant_id=pl.tenant_id AND sv.id=pl.shipment_version_id JOIN shipments s ON s.tenant_id=sv.tenant_id AND s.id=sv.shipment_id
  WHERE pl.tenant_id=tenant AND pl.order_line_id=p.order_line_id AND sv.production_source_version IS NULL
   AND ((s.status<>'cancelled' AND sv.version_number=s.approved_version_number) OR production_quantity_physical_package(pl.package_id))) INTO unknown_source;
 SELECT coalesce(jsonb_agg(jsonb_build_object('reservationId',r.id,'poolId',r.pool_id,'poolVersionId',r.pool_version_id,'localDate',r.local_date,'unit',r.unit,'unitsPerItem',r.units_per_item,'totalUnits',r.total_units,
  'grossCommittedUnits',coalesce(e.committed,0),'grossReleasedUnits',coalesce(e.released,0),'stopReleasedUnits',coalesce(se.released,0),'stopCommitReductionUnits',coalesce(se.reduced,0)) ORDER BY r.id),'[]'),coalesce(bool_or(coalesce(e.released,0)>0),false)
 INTO reservation_rows,legacy_released FROM factory_capacity_reservations r
 LEFT JOIN LATERAL(SELECT sum(units) FILTER(WHERE kind='commit') committed,sum(units) FILTER(WHERE kind='release') released FROM factory_capacity_events e WHERE e.tenant_id=tenant AND e.reservation_id=r.id)e ON true
 LEFT JOIN LATERAL(SELECT sum(released_units) released,sum(commit_reduction_units) reduced FROM factory_capacity_stop_effects se WHERE se.tenant_id=tenant AND se.reservation_id=r.id)se ON true
 WHERE r.tenant_id=tenant AND r.production_order_id=p.id AND r.production_version_id=v.id;
 SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.reservation_id,e.sequence),'[]') INTO raw_events FROM factory_capacity_events e JOIN factory_capacity_reservations r ON r.tenant_id=e.tenant_id AND r.id=e.reservation_id WHERE r.tenant_id=tenant AND r.production_version_id=v.id;
 SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.id),'[]') INTO raw_effects FROM factory_capacity_stop_effects e JOIN factory_capacity_reservations r ON r.tenant_id=e.tenant_id AND r.id=e.reservation_id WHERE r.tenant_id=tenant AND r.production_version_id=v.id;
 IF m.id IS NULL THEN blockers:=blockers||'"历史生产缺少固定制造单位 不补造数量依据"'::jsonb;END IF;
 factory_managed:=coalesce(outsourced_production_factory(tenant,v.id)=v.factory_id,false);
 IF jsonb_array_length(reservation_rows)=0 AND NOT factory_managed THEN blockers:=blockers||'"历史生产没有资源预留 不能自动释放或重新安排数量"'::jsonb;END IF;
 IF legacy_released THEN blockers:=blockers||'"原里程碑已释放产能但无实物数量核准 请人工核对历史"'::jsonb;END IF;
 IF unknown_source THEN blockers:=blockers||'"旧审核或实际交运包裹未固定生产来源"'::jsonb;END IF;
 IF parent.address_status='anonymized' OR (work.id IS NOT NULL AND(work.encrypted_data_key IS NULL OR work.archived_at IS NOT NULL OR work.expires_at<=statement_timestamp())) THEN blockers:=blockers||'"原订单资料不可用或已归档到期"'::jsonb;END IF;
 result:=jsonb_build_object('productionOrderId',p.id,'orderId',p.order_id,'orderLineId',p.order_line_id,'productionVersionId',v.id,'projectionVersion',p.projection_version,'status',p.status,'quantity',v.quantity,
  'factoryId',p.factory_id,'manufacturingBindingId',m.id,'manufacturingVersionId',m.manufacturing_version_id,'unit',m.output_unit,
  'reviewId',prior.id,'cumulativeStoppedQuantity',coalesce(prior.cumulative_stopped_quantity,0),'currentQuantities',prior.quantities,
  'groupedQuantity',grouped,'groupedPassedQuantity',passed,'allocatedQuantity',allocated,'shippedQuantity',shipped,'completedLowerBound',greatest(passed,allocated),
  'unknownShipmentSource',unknown_source,'capacityStatus',CASE WHEN factory_managed THEN 'factory_managed' WHEN jsonb_array_length(reservation_rows)=0 THEN 'legacy_unreserved' WHEN legacy_released THEN 'legacy_released' ELSE 'reserved' END,'reservations',reservation_rows,'blockers',blockers);
 fingerprint_details:=jsonb_build_object('basis',result,'manufacturingChecksum',m.content_checksum,'productionVersion',to_jsonb(v)-'encrypted_instructions',
  'order',jsonb_build_object('state',parent.workflow_state,'side',parent.side_state,'addressStatus',parent.address_status,'updatedAt',parent.updated_at),
  'work',jsonb_build_object('revision',work.revision,'projection',work.projection_version,'held',work.held,'archived',work.archived_at,'expiresAt',work.expires_at,'retained',work.encrypted_data_key IS NOT NULL),
  'qualityRoot',to_jsonb(root),'groups',group_rows,'allocations',allocation_rows,'capacityEvents',raw_events,'stopEffects',raw_effects);
 RETURN result||jsonb_build_object('fingerprint',encode(sha256(convert_to(fingerprint_details::text,'UTF8')),'hex'));
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_production_quantity_review() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE basis jsonb;report production_quantity_reports;prior production_quantity_reviews;latest integer;counts jsonb;quantity integer;known integer;remaining integer;
BEGIN
 IF NEW.created_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid OR NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid
  OR substring(NEW.id::text FROM 15 FOR 1)<>'7' OR NOT production_quantity_input_valid(NEW.input,'review') OR NOT production_quantity_counts_valid(NEW.quantities,false)
  THEN RAISE EXCEPTION 'production_quantity_review_input_invalid' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('production-quantity-request:'||NEW.tenant_id::text||':review:'||NEW.idempotency_key,0));
 PERFORM production_quantity_lock(NEW.tenant_id,NEW.production_order_id);
 basis:=production_quantity_basis(NEW.tenant_id,NEW.production_order_id);
 SELECT * INTO report FROM production_quantity_reports WHERE tenant_id=NEW.tenant_id AND id=NEW.report_id AND production_order_id=NEW.production_order_id AND production_version_id=NEW.production_version_id;
 SELECT * INTO prior FROM production_quantity_reviews WHERE tenant_id=NEW.tenant_id AND production_order_id=NEW.production_order_id ORDER BY sequence DESC LIMIT 1;
 latest:=coalesce(prior.sequence,0);
 IF basis IS NULL OR report.id IS NULL OR jsonb_array_length(basis->'blockers')>0 OR basis->>'capacityStatus' NOT IN ('reserved','factory_managed')
  OR NEW.sequence<>latest+1 OR NEW.previous_review_id IS DISTINCT FROM prior.id OR NEW.previous_review_id IS DISTINCT FROM(basis->>'reviewId')::uuid
  OR NEW.input->>'expectedReviewId' IS DISTINCT FROM basis->>'reviewId' OR NEW.input->>'expectedProductionProjectionVersion'<>basis->>'projectionVersion'
  OR NEW.input->>'expectedBasisFingerprint'<>basis->>'fingerprint' OR report.basis_fingerprint<>basis->>'fingerprint'
  OR report.previous_review_id IS DISTINCT FROM NEW.previous_review_id OR NEW.input->>'reportId'<>report.id::text OR basis->>'productionVersionId'<>NEW.production_version_id::text
  OR NEW.idempotency_key<>NEW.input->>'idempotencyKey' OR NEW.stopped_delta<>(NEW.input->>'stoppedDelta')::int
  OR NEW.request_canonical::jsonb<>jsonb_build_object('version',1,'operation','review','productionOrderId',NEW.production_order_id,'input',NEW.input)
  THEN RAISE EXCEPTION 'production_quantity_review_basis_changed' USING ERRCODE='23514';END IF;
 counts:=report.input->'quantities';quantity:=(basis->>'quantity')::int;
 IF NOT production_quantity_counts_valid(counts,false) THEN RAISE EXCEPTION 'production_quantity_unknown_not_reviewable' USING ERRCODE='23514';END IF;
 SELECT sum((e.value#>>'{}')::int) INTO known FROM jsonb_each(counts)e;
 remaining:=(counts->>'unstartedQuantity')::int-NEW.stopped_delta;
 IF known+coalesce(prior.cumulative_stopped_quantity,0)<>quantity OR remaining<0 OR NEW.cumulative_stopped_quantity<>coalesce(prior.cumulative_stopped_quantity,0)+NEW.stopped_delta
  OR NEW.quantities<>counts||jsonb_build_object('unstartedQuantity',remaining)
  OR(counts->>'completedQuantity')::int<(basis->>'completedLowerBound')::int
  OR(counts->>'completedQuantity')::int+(counts->>'scrappedQuantity')::int<(basis->>'groupedQuantity')::int
  OR(prior.id IS NOT NULL AND((counts->>'completedQuantity')::int+(counts->>'scrappedQuantity')::int<(prior.quantities->>'completedQuantity')::int+(prior.quantities->>'scrappedQuantity')::int
    OR(counts->>'scrappedQuantity')::int<(prior.quantities->>'scrappedQuantity')::int
    OR(counts->>'inProcessQuantity')::int+(counts->>'completedQuantity')::int+(counts->>'scrappedQuantity')::int<(prior.quantities->>'inProcessQuantity')::int+(prior.quantities->>'completedQuantity')::int+(prior.quantities->>'scrappedQuantity')::int))
  THEN RAISE EXCEPTION 'production_quantity_conservation_invalid' USING ERRCODE='23514';END IF;
 IF(NEW.input->>'occurredAt')::timestamptz>clock_timestamp() OR(NEW.input->>'occurredAt')::timestamptz<(report.input->>'observedAt')::timestamptz
  OR(prior.id IS NOT NULL AND(NEW.input->>'occurredAt')::timestamptz<(prior.input->>'occurredAt')::timestamptz)
  THEN RAISE EXCEPTION 'production_quantity_review_time_invalid' USING ERRCODE='23514';END IF;
 NEW.creation_transaction_id:=pg_current_xact_id()::text;NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION require_production_quantity_closure() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE review production_quantity_reviews;production production_orders;expected integer;actual integer;report production_quantity_reports;production_identity uuid;
BEGIN
 IF TG_TABLE_NAME='production_quantity_reports' THEN
  SELECT * INTO report FROM production_quantity_reports WHERE tenant_id=NEW.tenant_id AND id=NEW.id;
  IF NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.tenant_id=NEW.tenant_id AND a.entity_id=NEW.id AND a.entity_type='production_quantity_report' AND a.action='production.quantity.report_recorded'
    AND a.actor_user_id=report.created_by AND a.result='success' AND a.xmin::text=(pg_current_xact_id()::text::numeric%4294967296)::bigint::text)
   THEN RAISE EXCEPTION 'production_quantity_report_audit_required' USING ERRCODE='23514';END IF;
  RETURN NULL;
 END IF;
 IF TG_TABLE_NAME='production_orders' THEN production_identity:=NEW.id;ELSE production_identity:=NEW.production_order_id;END IF;
 FOR review IN SELECT r.* FROM production_quantity_reviews r WHERE r.tenant_id=NEW.tenant_id
  AND r.production_order_id=production_identity
  AND r.creation_transaction_id=pg_current_xact_id()::text LOOP
  SELECT * INTO production FROM production_orders WHERE tenant_id=review.tenant_id AND id=review.production_order_id;
  IF production.projection_version<>(review.input->>'expectedProductionProjectionVersion')::int+1
   OR NOT EXISTS(SELECT 1 FROM production_order_versions v WHERE v.tenant_id=review.tenant_id AND v.id=review.production_version_id AND v.production_order_id=production.id AND v.version_number=production.current_version_number)
   OR NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.tenant_id=review.tenant_id AND a.entity_id=review.id AND a.entity_type='production_quantity_review' AND a.action='production.quantity.reviewed'
    AND a.actor_user_id=review.created_by AND a.result='success' AND a.xmin::text=(pg_current_xact_id()::text::numeric%4294967296)::bigint::text)
   THEN RAISE EXCEPTION 'production_quantity_review_owner_closure_required' USING ERRCODE='23514';END IF;
  SELECT count(*) INTO expected FROM factory_capacity_reservations r WHERE r.tenant_id=review.tenant_id AND r.production_version_id=review.production_version_id;
  SELECT count(*) INTO actual FROM factory_capacity_stop_effects e WHERE e.tenant_id=review.tenant_id AND e.review_id=review.id;
  IF(review.stopped_delta>0 AND((expected=0 AND outsourced_production_factory(review.tenant_id,review.production_version_id) IS NULL) OR actual<>expected)) OR(review.stopped_delta=0 AND actual<>0) THEN RAISE EXCEPTION 'production_quantity_all_stop_effects_required' USING ERRCODE='23514';END IF;
 END LOOP;RETURN NULL;
END $$;

--> statement-breakpoint
CREATE INDEX logistics_events_task_action_time ON logistics_events(tenant_id,task_id,action,created_at);
