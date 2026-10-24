-- Actual operator reports and reviewed stop quantities. No historical backfill.
CREATE TABLE production_quantity_reports (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),production_order_id uuid NOT NULL,production_version_id uuid NOT NULL,
 previous_review_id uuid,basis_fingerprint text NOT NULL,input jsonb NOT NULL,idempotency_key text NOT NULL,
 request_canonical text NOT NULL,request_checksum text NOT NULL,created_by uuid NOT NULL REFERENCES app_users(id),created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT production_quantity_reports_order FOREIGN KEY(tenant_id,production_order_id) REFERENCES production_orders(tenant_id,id),
 CONSTRAINT production_quantity_reports_version FOREIGN KEY(tenant_id,production_version_id,production_order_id) REFERENCES production_order_versions(tenant_id,id,production_order_id),
 CONSTRAINT production_quantity_reports_hash CHECK(basis_fingerprint~'^[a-f0-9]{64}$' AND request_checksum=encode(sha256(convert_to(request_canonical,'UTF8')),'hex'))
);
CREATE UNIQUE INDEX production_quantity_reports_scope ON production_quantity_reports(tenant_id,id);
CREATE UNIQUE INDEX production_quantity_reports_parent ON production_quantity_reports(tenant_id,id,production_order_id,production_version_id);
CREATE UNIQUE INDEX production_quantity_reports_request ON production_quantity_reports(tenant_id,idempotency_key);
CREATE TABLE production_quantity_reviews (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),production_order_id uuid NOT NULL,production_version_id uuid NOT NULL,
 report_id uuid NOT NULL,sequence integer NOT NULL,previous_review_id uuid,input jsonb NOT NULL,quantities jsonb NOT NULL,
 stopped_delta integer NOT NULL,cumulative_stopped_quantity integer NOT NULL,idempotency_key text NOT NULL,
 request_canonical text NOT NULL,request_checksum text NOT NULL,creation_transaction_id text NOT NULL,
 created_by uuid NOT NULL REFERENCES app_users(id),created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT production_quantity_reviews_report FOREIGN KEY(tenant_id,report_id,production_order_id,production_version_id) REFERENCES production_quantity_reports(tenant_id,id,production_order_id,production_version_id),
 CONSTRAINT production_quantity_reviews_version FOREIGN KEY(tenant_id,production_version_id,production_order_id) REFERENCES production_order_versions(tenant_id,id,production_order_id),
 CONSTRAINT production_quantity_reviews_count CHECK(sequence>0 AND stopped_delta BETWEEN 0 AND 100000 AND cumulative_stopped_quantity BETWEEN 0 AND 100000),
 CONSTRAINT production_quantity_reviews_hash CHECK(request_checksum=encode(sha256(convert_to(request_canonical,'UTF8')),'hex'))
);
CREATE UNIQUE INDEX production_quantity_reviews_scope ON production_quantity_reviews(tenant_id,id);
CREATE UNIQUE INDEX production_quantity_reviews_parent ON production_quantity_reviews(tenant_id,id,production_order_id,production_version_id);
CREATE UNIQUE INDEX production_quantity_reviews_report ON production_quantity_reviews(tenant_id,report_id);
CREATE UNIQUE INDEX production_quantity_reviews_sequence ON production_quantity_reviews(tenant_id,production_order_id,sequence);
CREATE UNIQUE INDEX production_quantity_reviews_request ON production_quantity_reviews(tenant_id,idempotency_key);
ALTER TABLE production_quantity_reports ADD CONSTRAINT production_quantity_reports_previous FOREIGN KEY(tenant_id,previous_review_id,production_order_id,production_version_id) REFERENCES production_quantity_reviews(tenant_id,id,production_order_id,production_version_id);
ALTER TABLE production_quantity_reviews ADD CONSTRAINT production_quantity_reviews_previous FOREIGN KEY(tenant_id,previous_review_id,production_order_id,production_version_id) REFERENCES production_quantity_reviews(tenant_id,id,production_order_id,production_version_id);
CREATE TABLE factory_capacity_stop_effects (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),review_id uuid NOT NULL,reservation_id uuid NOT NULL,
 stopped_quantity integer NOT NULL,released_units bigint NOT NULL,commit_reduction_units bigint NOT NULL,
 created_by uuid NOT NULL REFERENCES app_users(id),created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT factory_capacity_stop_effects_review FOREIGN KEY(tenant_id,review_id) REFERENCES production_quantity_reviews(tenant_id,id),
 CONSTRAINT factory_capacity_stop_effects_reservation FOREIGN KEY(tenant_id,reservation_id) REFERENCES factory_capacity_reservations(tenant_id,id),
 CONSTRAINT factory_capacity_stop_effects_count CHECK(stopped_quantity BETWEEN 1 AND 100000 AND released_units BETWEEN 1 AND 1000000000 AND commit_reduction_units BETWEEN 0 AND released_units)
);
CREATE UNIQUE INDEX factory_capacity_stop_effects_scope ON factory_capacity_stop_effects(tenant_id,id);
CREATE UNIQUE INDEX factory_capacity_stop_effects_review ON factory_capacity_stop_effects(tenant_id,review_id,reservation_id);
--> statement-breakpoint
CREATE FUNCTION production_quantity_physical_package(package_identity uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM shipment_tracking_events WHERE package_id=package_identity AND tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND status IN('picked_up','in_transit','out_for_delivery','delivered','returned'))
$$;
CREATE FUNCTION production_quantity_lock(tenant uuid,production_identity uuid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE production production_orders;parent orders;item record;
BEGIN
 SELECT * INTO production FROM production_orders WHERE tenant_id=tenant AND id=production_identity;
 IF production.id IS NULL THEN RAISE EXCEPTION 'production_quantity_not_found' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text||':whole-order:'||production.order_id::text,0));
 SELECT * INTO parent FROM orders WHERE tenant_id=tenant AND id=production.order_id FOR UPDATE;
 FOR item IN SELECT id FROM order_lines WHERE tenant_id=tenant AND order_id=parent.id ORDER BY id LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('order-work:'||item.id::text,0));
 END LOOP;
 FOR item IN SELECT id FROM production_orders WHERE tenant_id=tenant AND order_id=parent.id ORDER BY id LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('production-order:'||item.id::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('production-inspection:'||item.id::text,0));
 END LOOP;
 FOR item IN SELECT id FROM shipments WHERE tenant_id=tenant AND order_id=parent.id ORDER BY id LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('shipment:'||item.id::text,0));
 END LOOP;
END $$;
-- Summary and fingerprint share one database projection. Pending reports are excluded.
CREATE FUNCTION production_quantity_basis(tenant uuid,production_identity uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
DECLARE p production_orders;v production_order_versions;m production_manufacturing_bindings;prior production_quantity_reviews;
 parent orders;work order_work_items;root quality_inspections;group_rows jsonb;allocation_rows jsonb;reservation_rows jsonb;fingerprint_details jsonb;
 grouped integer:=0;passed integer:=0;allocated integer:=0;shipped integer:=0;unknown_source boolean:=false;blockers jsonb:='[]';result jsonb;raw_events jsonb;raw_effects jsonb;legacy_released boolean:=false;
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
 IF jsonb_array_length(reservation_rows)=0 THEN blockers:=blockers||'"历史生产没有资源预留 不能自动释放或重新安排数量"'::jsonb;END IF;
 IF legacy_released THEN blockers:=blockers||'"原里程碑已释放产能但无实物数量核准 请人工核对历史"'::jsonb;END IF;
 IF unknown_source THEN blockers:=blockers||'"旧审核或实际交运包裹未固定生产来源"'::jsonb;END IF;
 IF parent.address_status='anonymized' OR (work.id IS NOT NULL AND(work.encrypted_data_key IS NULL OR work.archived_at IS NOT NULL OR work.expires_at<=statement_timestamp())) THEN blockers:=blockers||'"原订单资料不可用或已归档到期"'::jsonb;END IF;
 result:=jsonb_build_object('productionOrderId',p.id,'orderId',p.order_id,'orderLineId',p.order_line_id,'productionVersionId',v.id,'projectionVersion',p.projection_version,'status',p.status,'quantity',v.quantity,
  'factoryId',p.factory_id,'manufacturingBindingId',m.id,'manufacturingVersionId',m.manufacturing_version_id,'unit',m.output_unit,
  'reviewId',prior.id,'cumulativeStoppedQuantity',coalesce(prior.cumulative_stopped_quantity,0),'currentQuantities',prior.quantities,
  'groupedQuantity',grouped,'groupedPassedQuantity',passed,'allocatedQuantity',allocated,'shippedQuantity',shipped,'completedLowerBound',greatest(passed,allocated),
  'unknownShipmentSource',unknown_source,'capacityStatus',CASE WHEN jsonb_array_length(reservation_rows)=0 THEN 'legacy_unreserved' WHEN legacy_released THEN 'legacy_released' ELSE 'reserved' END,'reservations',reservation_rows,'blockers',blockers);
 fingerprint_details:=jsonb_build_object('basis',result,'manufacturingChecksum',m.content_checksum,'productionVersion',to_jsonb(v)-'encrypted_instructions',
  'order',jsonb_build_object('state',parent.workflow_state,'side',parent.side_state,'addressStatus',parent.address_status,'updatedAt',parent.updated_at),
  'work',jsonb_build_object('revision',work.revision,'projection',work.projection_version,'held',work.held,'archived',work.archived_at,'expiresAt',work.expires_at,'retained',work.encrypted_data_key IS NOT NULL),
  'qualityRoot',to_jsonb(root),'groups',group_rows,'allocations',allocation_rows,'capacityEvents',raw_events,'stopEffects',raw_effects);
 RETURN result||jsonb_build_object('fingerprint',encode(sha256(convert_to(fingerprint_details::text,'UTF8')),'hex'));
END $$;
--> statement-breakpoint
CREATE FUNCTION production_quantity_counts_valid(value jsonb,allow_unknown boolean) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE key text;
BEGIN
 IF jsonb_typeof(value) IS DISTINCT FROM 'object' OR value-ARRAY['unstartedQuantity','inProcessQuantity','completedQuantity','scrappedQuantity']<>'{}'::jsonb THEN RETURN false;END IF;
 FOREACH key IN ARRAY ARRAY['unstartedQuantity','inProcessQuantity','completedQuantity','scrappedQuantity'] LOOP
  IF NOT value?key OR(value->key='null'::jsonb AND NOT allow_unknown) THEN RETURN false;END IF;
  IF value->key<>'null'::jsonb AND(jsonb_typeof(value->key) IS DISTINCT FROM 'number' OR value->>key!~'^[0-9]+$' OR(value->>key)::numeric>100000) THEN RETURN false;END IF;
 END LOOP;RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;END $$;
--> statement-breakpoint
CREATE FUNCTION guard_production_quantity_report() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE basis jsonb;known numeric;asset uuid;v production_order_versions;
BEGIN
 IF NEW.created_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid OR NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid
  OR substring(NEW.id::text FROM 15 FOR 1)<>'7' OR NOT production_quantity_input_valid(NEW.input,'report') THEN RAISE EXCEPTION 'production_quantity_report_input_invalid' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('production-quantity-request:'||NEW.tenant_id::text||':report:'||NEW.idempotency_key,0));
 PERFORM production_quantity_lock(NEW.tenant_id,NEW.production_order_id);
 basis:=production_quantity_basis(NEW.tenant_id,NEW.production_order_id);
 IF basis IS NULL OR basis->>'productionVersionId'<>NEW.production_version_id::text OR NEW.input->>'productionVersionId'<>NEW.production_version_id::text
  OR NEW.input->>'expectedProductionProjectionVersion'<>basis->>'projectionVersion' OR NEW.input->>'expectedReviewId' IS DISTINCT FROM basis->>'reviewId'
  OR NEW.previous_review_id IS DISTINCT FROM(basis->>'reviewId')::uuid OR NEW.basis_fingerprint<>basis->>'fingerprint' OR NEW.input->>'expectedBasisFingerprint'<>basis->>'fingerprint'
  OR NEW.idempotency_key<>NEW.input->>'idempotencyKey' OR NEW.request_canonical::jsonb<>jsonb_build_object('version',1,'operation','report','productionOrderId',NEW.production_order_id,'input',NEW.input)
  THEN RAISE EXCEPTION 'production_quantity_report_basis_changed' USING ERRCODE='23514';END IF;
 SELECT * INTO v FROM production_order_versions WHERE tenant_id=NEW.tenant_id AND id=NEW.production_version_id;
 IF(NEW.input->>'observedAt')::timestamptz>clock_timestamp() OR(NEW.input->>'observedAt')::timestamptz<v.created_at THEN RAISE EXCEPTION 'production_quantity_report_time_invalid' USING ERRCODE='23514';END IF;
 SELECT coalesce(sum((e.value#>>'{}')::numeric) FILTER(WHERE e.value<>'null'::jsonb),0) INTO known FROM jsonb_each(NEW.input->'quantities')e;
 IF known+(basis->>'cumulativeStoppedQuantity')::int>(basis->>'quantity')::int THEN RAISE EXCEPTION 'production_quantity_report_overflow' USING ERRCODE='23514';END IF;
 FOR asset IN SELECT e::uuid FROM jsonb_array_elements_text(NEW.input->'evidenceAssetIds')e LOOP
  IF NOT EXISTS(SELECT 1 FROM asset_files a WHERE a.tenant_id=NEW.tenant_id AND a.id=asset AND a.asset_domain='authorized' AND a.rights_status='approved' AND a.deleted_at IS NULL)
   THEN RAISE EXCEPTION 'production_quantity_evidence_invalid' USING ERRCODE='23514';END IF;
 END LOOP;
 NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE FUNCTION guard_production_quantity_review() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
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
 IF basis IS NULL OR report.id IS NULL OR jsonb_array_length(basis->'blockers')>0 OR basis->>'capacityStatus'<>'reserved'
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
CREATE FUNCTION guard_factory_capacity_stop_effect() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE review production_quantity_reviews;r factory_capacity_reservations;gross_commit numeric;gross_release numeric;stop_release numeric;stop_reduce numeric;
BEGIN
 SELECT * INTO review FROM production_quantity_reviews WHERE tenant_id=NEW.tenant_id AND id=NEW.review_id;
 SELECT * INTO r FROM factory_capacity_reservations WHERE tenant_id=NEW.tenant_id AND id=NEW.reservation_id;
 IF review.id IS NULL OR r.id IS NULL OR review.production_order_id<>r.production_order_id OR review.production_version_id<>r.production_version_id OR review.stopped_delta<=0
  OR review.creation_transaction_id<>pg_current_xact_id()::text OR NEW.created_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid OR review.created_by<>NEW.created_by
  OR NEW.stopped_quantity<>review.stopped_delta OR NEW.released_units<>review.stopped_delta::bigint*r.units_per_item
  THEN RAISE EXCEPTION 'factory_capacity_actual_stop_required' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtext('factory:'||r.factory_id::text));
 PERFORM pg_advisory_xact_lock(hashtextextended('factory-capacity-pool:'||r.pool_id::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('factory-capacity-day:'||r.pool_id::text||':'||r.local_date::text,0));
 SELECT coalesce(sum(units) FILTER(WHERE kind='commit'),0),coalesce(sum(units) FILTER(WHERE kind='release'),0) INTO gross_commit,gross_release FROM factory_capacity_events WHERE tenant_id=r.tenant_id AND reservation_id=r.id;
 SELECT coalesce(sum(released_units),0),coalesce(sum(commit_reduction_units),0) INTO stop_release,stop_reduce FROM factory_capacity_stop_effects WHERE tenant_id=r.tenant_id AND reservation_id=r.id;
 IF gross_release<>0 OR NEW.released_units+stop_release>r.total_units OR stop_reduce>gross_commit
  OR NEW.commit_reduction_units<>least(NEW.released_units,gross_commit-stop_reduce)
  OR gross_commit-stop_reduce-NEW.commit_reduction_units+gross_release+stop_release+NEW.released_units>r.total_units
  THEN RAISE EXCEPTION 'factory_capacity_stop_conservation_invalid' USING ERRCODE='23514';END IF;
 NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER production_quantity_report_guard BEFORE INSERT ON production_quantity_reports FOR EACH ROW EXECUTE FUNCTION guard_production_quantity_report();
CREATE TRIGGER production_quantity_review_guard BEFORE INSERT ON production_quantity_reviews FOR EACH ROW EXECUTE FUNCTION guard_production_quantity_review();
CREATE TRIGGER factory_capacity_stop_effect_guard BEFORE INSERT ON factory_capacity_stop_effects FOR EACH ROW EXECUTE FUNCTION guard_factory_capacity_stop_effect();
--> statement-breakpoint
CREATE FUNCTION require_production_quantity_closure() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
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
  IF(review.stopped_delta>0 AND(expected=0 OR actual<>expected)) OR(review.stopped_delta=0 AND actual<>0) THEN RAISE EXCEPTION 'production_quantity_all_stop_effects_required' USING ERRCODE='23514';END IF;
 END LOOP;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER production_quantity_report_closure AFTER INSERT ON production_quantity_reports DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_production_quantity_closure();
CREATE CONSTRAINT TRIGGER production_quantity_review_closure AFTER INSERT ON production_quantity_reviews DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_production_quantity_closure();
CREATE CONSTRAINT TRIGGER production_quantity_projection_closure AFTER UPDATE ON production_orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_production_quantity_closure();
DO $$DECLARE name text;BEGIN
 FOREACH name IN ARRAY ARRAY['production_quantity_reports','production_quantity_reviews','factory_capacity_stop_effects'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',name);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO yummyai_app',name);
  EXECUTE format('CREATE TRIGGER production_quantity_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION factory_capacity_immutable()',name);
 END LOOP;
END $$;
CREATE FUNCTION production_quantity_input_valid(value jsonb,operation text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE key text;allowed text[];asset jsonb;
BEGIN
 IF operation='report' THEN allowed:=ARRAY['idempotencyKey','productionVersionId','expectedProductionProjectionVersion','expectedReviewId','expectedBasisFingerprint','observedAt','quantities','evidenceCode','evidenceAssetIds'];
 ELSE allowed:=ARRAY['idempotencyKey','reportId','expectedProductionProjectionVersion','expectedReviewId','expectedBasisFingerprint','stoppedDelta','unstartedAcrossAllPoolsConfirmed','evidenceCode','occurredAt'];END IF;
 IF jsonb_typeof(value) IS DISTINCT FROM 'object' OR value-allowed<>'{}'::jsonb OR NOT value?&allowed THEN RETURN false;END IF;
 FOREACH key IN ARRAY ARRAY['idempotencyKey','expectedBasisFingerprint','evidenceCode'] LOOP IF jsonb_typeof(value->key) IS DISTINCT FROM 'string' THEN RETURN false;END IF;END LOOP;
 IF value->>'idempotencyKey'<>btrim(value->>'idempotencyKey') OR length(value->>'idempotencyKey') NOT BETWEEN 8 AND 200 OR value->>'expectedBasisFingerprint'!~'^[a-f0-9]{64}$' OR value->>'evidenceCode'!~'^[A-Z0-9_:-]{1,160}$'
  OR jsonb_typeof(value->'expectedProductionProjectionVersion') IS DISTINCT FROM 'number' OR value->>'expectedProductionProjectionVersion'!~'^[1-9][0-9]*$' OR(value->>'expectedProductionProjectionVersion')::numeric>2147483647 THEN RETURN false;END IF;
 IF value->'expectedReviewId'<>'null'::jsonb AND(jsonb_typeof(value->'expectedReviewId') IS DISTINCT FROM 'string' OR value->>'expectedReviewId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') THEN RETURN false;END IF;
 key:=CASE WHEN operation='report' THEN 'productionVersionId' ELSE 'reportId' END;
 IF jsonb_typeof(value->key) IS DISTINCT FROM 'string' OR value->>key!~'^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' THEN RETURN false;END IF;
 key:=CASE WHEN operation='report' THEN 'observedAt' ELSE 'occurredAt' END;
 IF jsonb_typeof(value->key) IS DISTINCT FROM 'string' OR value->>key!~'^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$' THEN RETURN false;END IF;
 PERFORM(value->>key)::timestamptz;
 IF operation='report' THEN
  IF NOT production_quantity_counts_valid(value->'quantities',true) OR jsonb_typeof(value->'evidenceAssetIds') IS DISTINCT FROM 'array' OR jsonb_array_length(value->'evidenceAssetIds')>100 THEN RETURN false;END IF;
  FOR asset IN SELECT e FROM jsonb_array_elements(value->'evidenceAssetIds')e LOOP IF jsonb_typeof(asset) IS DISTINCT FROM 'string' OR asset#>>'{}'!~'^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' THEN RETURN false;END IF;END LOOP;
  IF(SELECT count(*) FROM jsonb_array_elements(value->'evidenceAssetIds'))<>(SELECT count(DISTINCT e) FROM jsonb_array_elements(value->'evidenceAssetIds')e) THEN RETURN false;END IF;
 ELSE
  IF jsonb_typeof(value->'stoppedDelta') IS DISTINCT FROM 'number' OR value->>'stoppedDelta'!~'^[0-9]+$' OR(value->>'stoppedDelta')::numeric>100000 OR jsonb_typeof(value->'unstartedAcrossAllPoolsConfirmed') IS DISTINCT FROM 'boolean' OR((value->>'stoppedDelta')::int>0 AND value->'unstartedAcrossAllPoolsConfirmed'<>'true'::jsonb) THEN RETURN false;END IF;
 END IF;RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;END $$;

--> statement-breakpoint
-- Preserve all original calendar, owner-birth, cut-off and legacy guards. Only net stop effects change the capacity sums.
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
CREATE OR REPLACE FUNCTION guard_factory_capacity_event() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE reservation factory_capacity_reservations;last_sequence integer;reserved numeric;committed numeric;released numeric;proof factory_capacity_owner_proofs;stopped numeric;reduced numeric;remaining numeric;
BEGIN
 SELECT * INTO reservation FROM factory_capacity_reservations WHERE tenant_id=NEW.tenant_id AND id=NEW.reservation_id;
 IF reservation.id IS NULL THEN RAISE EXCEPTION 'factory_capacity_event_parent_required' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtext('factory:'||reservation.factory_id::text));
 PERFORM pg_advisory_xact_lock(hashtextextended('factory-capacity-pool:'||reservation.pool_id::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('factory-capacity-day:'||reservation.pool_id::text||':'||reservation.local_date::text,0));
 SELECT coalesce(max(sequence),0),coalesce(sum(units) FILTER(WHERE kind='reserve'),0),coalesce(sum(units) FILTER(WHERE kind='commit'),0),coalesce(sum(units) FILTER(WHERE kind='release'),0)
  INTO last_sequence,reserved,committed,released FROM factory_capacity_events WHERE tenant_id=NEW.tenant_id AND reservation_id=reservation.id;
 SELECT coalesce(sum(released_units),0),coalesce(sum(commit_reduction_units),0) INTO stopped,reduced FROM factory_capacity_stop_effects WHERE tenant_id=NEW.tenant_id AND reservation_id=reservation.id;
 remaining:=reservation.total_units-stopped;
 IF NEW.sequence<>last_sequence+1 OR NEW.created_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid THEN RAISE EXCEPTION 'factory_capacity_event_sequence_invalid' USING ERRCODE='23514';END IF;
 IF NEW.kind='reserve' THEN
  IF last_sequence<>0 OR NEW.units<>reservation.total_units OR reservation.creation_transaction_id<>pg_current_xact_id()::text OR NEW.milestone_event_id IS NOT NULL
   THEN RAISE EXCEPTION 'factory_capacity_reserve_event_invalid' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO proof FROM factory_capacity_owner_proofs WHERE tenant_id=NEW.tenant_id AND owner_kind='milestone' AND owner_id=NEW.milestone_event_id;
  IF proof.owner_id IS NULL OR proof.production_order_id<>reservation.production_order_id OR proof.creation_transaction_id<>pg_current_xact_id()::text
   OR proof.created_by<>NEW.created_by OR reserved<>reservation.total_units THEN RAISE EXCEPTION 'factory_capacity_actual_milestone_required' USING ERRCODE='23514';END IF;
  IF NEW.kind='commit' AND(proof.milestone_type<>'started' OR committed<>0 OR released<>0 OR NEW.units<>remaining)
   THEN RAISE EXCEPTION 'factory_capacity_commit_invalid' USING ERRCODE='23514';END IF;
  IF NEW.kind='release' AND(proof.milestone_type<>'cancelled' OR committed<>0 OR released<>0 OR reduced<>0 OR NEW.units<>remaining)
   THEN RAISE EXCEPTION 'factory_capacity_release_invalid' USING ERRCODE='23514';END IF;
 END IF;
 NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION require_factory_capacity_milestone() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE r factory_capacity_reservations;committed numeric;released numeric;stopped numeric;remaining numeric;
BEGIN
 IF NEW.type NOT IN('started','cancelled') THEN RETURN NULL;END IF;
 FOR r IN SELECT * FROM factory_capacity_reservations WHERE tenant_id=NEW.tenant_id AND production_order_id=NEW.production_order_id LOOP
  SELECT coalesce(sum(units) FILTER(WHERE kind='commit'),0),coalesce(sum(units) FILTER(WHERE kind='release'),0) INTO committed,released
   FROM factory_capacity_events WHERE tenant_id=r.tenant_id AND reservation_id=r.id;
  SELECT coalesce(sum(released_units),0) INTO stopped FROM factory_capacity_stop_effects WHERE tenant_id=r.tenant_id AND reservation_id=r.id;
  remaining:=r.total_units-stopped;
  IF NEW.type='started' AND remaining>0 AND committed=0 AND NOT EXISTS(SELECT 1 FROM factory_capacity_events WHERE tenant_id=r.tenant_id AND reservation_id=r.id AND kind='commit' AND milestone_event_id=NEW.id AND units=remaining)
   THEN RAISE EXCEPTION 'factory_capacity_started_effect_required' USING ERRCODE='23514';END IF;
  IF NEW.type='started' AND committed>0 AND committed-(SELECT coalesce(sum(commit_reduction_units),0) FROM factory_capacity_stop_effects WHERE tenant_id=r.tenant_id AND reservation_id=r.id)<>remaining
   THEN RAISE EXCEPTION 'factory_capacity_started_effect_required' USING ERRCODE='23514';END IF;
  IF NEW.type='cancelled' AND committed=0 AND remaining>0 AND(released<>remaining OR NOT EXISTS(SELECT 1 FROM factory_capacity_events WHERE tenant_id=r.tenant_id AND reservation_id=r.id AND kind='release' AND milestone_event_id=NEW.id AND units=remaining))
   THEN RAISE EXCEPTION 'factory_capacity_cancel_effect_required' USING ERRCODE='23514';END IF;
 END LOOP;
 RETURN NULL;
END $$;

--> statement-breakpoint
CREATE FUNCTION production_quantity_remaining(tenant uuid,production_identity uuid,pinned_version uuid DEFAULT NULL) RETURNS integer LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT greatest(0,v.quantity-coalesce((SELECT r.cumulative_stopped_quantity FROM production_quantity_reviews r WHERE r.tenant_id=tenant AND r.production_order_id=p.id AND r.production_version_id=v.id ORDER BY r.sequence DESC LIMIT 1),0))
 FROM production_orders p JOIN production_order_versions v ON v.tenant_id=p.tenant_id AND v.production_order_id=p.id AND(pinned_version IS NOT NULL AND v.id=pinned_version OR pinned_version IS NULL AND v.version_number=p.current_version_number)
 WHERE p.tenant_id=tenant AND p.id=production_identity
$$;
CREATE FUNCTION production_quantity_inspectable_as_of(tenant uuid,version_identity uuid,recorded_at timestamptz) RETURNS integer LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT coalesce((SELECT(r.quantities->>'completedQuantity')::integer FROM production_quantity_reviews r WHERE r.tenant_id=tenant AND r.production_version_id=v.id AND r.created_at<=recorded_at ORDER BY r.sequence DESC LIMIT 1),v.quantity)
 FROM production_order_versions v WHERE v.tenant_id=tenant AND v.id=version_identity
$$;
CREATE FUNCTION production_quantity_quality_record_time() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE completed integer;
BEGIN
 SELECT(r.quantities->>'completedQuantity')::integer INTO completed FROM production_quantity_reviews r WHERE r.tenant_id=NEW.tenant_id AND r.production_version_id=NEW.production_version_id ORDER BY r.sequence DESC LIMIT 1;
 IF completed=0 THEN RAISE EXCEPTION 'production_quantity_no_completed_physical_source' USING ERRCODE='23514';END IF;
 NEW.created_at:=clock_timestamp();RETURN NEW;END $$;
CREATE TRIGGER actual_quality_record_time BEFORE INSERT ON quality_inspections FOR EACH ROW EXECUTE FUNCTION production_quantity_quality_record_time();
CREATE OR REPLACE FUNCTION check_quality_group_cover() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inspection_id_value uuid; inspection_row quality_inspections%ROWTYPE; standard_row quality_standard_versions%ROWTYPE;
  expected_quantity integer; total_quantity integer; group_count integer; aggregate_score integer; aggregate_result text;
  group_row quality_inspection_groups%ROWTYPE; calculated_score integer; calculated_result text;
BEGIN
  IF TG_TABLE_NAME='quality_inspections' THEN inspection_id_value:=NEW.id; ELSE inspection_id_value:=NEW.inspection_id; END IF;
  SELECT * INTO inspection_row FROM quality_inspections WHERE id=inspection_id_value;
  IF inspection_row.assessment_version IS DISTINCT FROM 3 THEN RETURN NULL; END IF;
  SELECT coalesce(parent.quantity,production_quantity_inspectable_as_of(pv.tenant_id,pv.id,inspection_row.created_at)) INTO expected_quantity FROM production_order_versions pv
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
CREATE OR REPLACE FUNCTION check_recovery_group_quantity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_group quality_inspection_groups%ROWTYPE; occupied integer;
BEGIN
  SELECT * INTO source_group FROM quality_inspection_groups WHERE id=NEW.quality_group_id AND tenant_id=NEW.tenant_id;
  IF source_group.result IS DISTINCT FROM 'failed' OR NOT EXISTS(
    SELECT 1 FROM production_recovery_cases recovery JOIN quality_group_defects gd ON gd.defect_id=recovery.defect_id AND gd.tenant_id=recovery.tenant_id
    JOIN quality_defects defect ON defect.id=gd.defect_id AND defect.tenant_id=gd.tenant_id
    WHERE recovery.id=NEW.recovery_case_id AND recovery.tenant_id=NEW.tenant_id AND recovery.type='remake'
      AND gd.quality_group_id=NEW.quality_group_id AND defect.disposition IN ('remake','rework')) THEN
    RAISE EXCEPTION 'remake must identify its original held group and actionable defect' USING ERRCODE='23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('production-order:'||source_group.production_order_id::text,0));
  SELECT coalesce(sum(production_quantity_remaining(rg.tenant_id,rg.replacement_production_order_id,rg.replacement_production_version_id)),0)::integer INTO occupied FROM production_recovery_groups rg
    WHERE rg.quality_group_id=NEW.quality_group_id AND rg.tenant_id=NEW.tenant_id;
  IF occupied>source_group.quantity THEN
    RAISE EXCEPTION 'defects share the same physical group remake quantity' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION production_quantity_milestone_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE p production_orders;review production_quantity_reviews;quantity integer;
BEGIN
 SELECT * INTO p FROM production_orders WHERE tenant_id=NEW.tenant_id AND id=NEW.production_order_id;
 SELECT v.quantity INTO quantity FROM production_order_versions v WHERE v.tenant_id=p.tenant_id AND v.production_order_id=p.id AND v.version_number=p.current_version_number;
 SELECT r.* INTO review FROM production_quantity_reviews r JOIN production_order_versions v ON v.tenant_id=r.tenant_id AND v.id=r.production_version_id
  WHERE r.tenant_id=p.tenant_id AND r.production_order_id=p.id AND v.version_number=p.current_version_number ORDER BY r.sequence DESC LIMIT 1;
 IF NEW.type='cancelled' AND review.cumulative_stopped_quantity>0 AND review.cumulative_stopped_quantity<quantity THEN RAISE EXCEPTION 'production_quantity_partial_cancel_blocked' USING ERRCODE='23514';END IF;
 IF NEW.type='completed' AND review.id IS NOT NULL AND((review.quantities->>'unstartedQuantity')::int>0 OR(review.quantities->>'inProcessQuantity')::int>0 OR(review.quantities->>'completedQuantity')::int=0)
  THEN RAISE EXCEPTION 'production_quantity_remaining_not_complete' USING ERRCODE='23514';END IF;
 IF p.status='cancel_requested' AND NEW.type IN('started','completed') AND(review.id IS NULL OR review.cumulative_stopped_quantity=0 OR review.cumulative_stopped_quantity>=quantity OR NEW.occurred_at<(review.input->>'occurredAt')::timestamptz)
  THEN RAISE EXCEPTION 'production_quantity_resume_required' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER production_quantity_milestone_guard BEFORE INSERT ON production_milestone_events FOR EACH ROW EXECUTE FUNCTION production_quantity_milestone_guard();
CREATE FUNCTION production_quantity_partial_cancel_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE review production_quantity_reviews;quantity integer;
BEGIN
 SELECT v.quantity INTO quantity FROM production_order_versions v WHERE v.tenant_id=NEW.tenant_id AND v.production_order_id=NEW.id AND v.version_number=NEW.current_version_number;
 SELECT r.* INTO review FROM production_quantity_reviews r JOIN production_order_versions v ON v.tenant_id=r.tenant_id AND v.id=r.production_version_id
  WHERE r.tenant_id=NEW.tenant_id AND r.production_order_id=NEW.id AND v.version_number=NEW.current_version_number ORDER BY r.sequence DESC LIMIT 1;
 IF NEW.status='completed' AND OLD.status IS DISTINCT FROM NEW.status AND review.id IS NOT NULL
  AND((review.quantities->>'unstartedQuantity')::int>0 OR(review.quantities->>'inProcessQuantity')::int>0 OR(review.quantities->>'completedQuantity')::int=0)
  THEN RAISE EXCEPTION 'production_quantity_remaining_not_complete' USING ERRCODE='23514';END IF;
 IF OLD.status='cancel_requested' AND NEW.status IN('in_production','completed') AND(review.id IS NULL OR review.cumulative_stopped_quantity=0 OR review.cumulative_stopped_quantity>=quantity)
  THEN RAISE EXCEPTION 'production_quantity_resume_required' USING ERRCODE='23514';END IF;
 IF NEW.status='cancelled' AND OLD.status IS DISTINCT FROM NEW.status AND review.cumulative_stopped_quantity>0 AND review.cumulative_stopped_quantity<quantity
  THEN RAISE EXCEPTION 'production_quantity_partial_cancel_blocked' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER production_quantity_partial_cancel_guard BEFORE UPDATE ON production_orders FOR EACH ROW EXECUTE FUNCTION production_quantity_partial_cancel_guard();
CREATE FUNCTION production_quantity_scrap_group_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE group_identity uuid;
BEGIN
 IF TG_TABLE_NAME='quality_group_reinspections' THEN group_identity:=NEW.parent_group_id;ELSE group_identity:=NEW.quality_group_id;END IF;
 IF EXISTS(SELECT 1 FROM quality_inspection_groups g JOIN LATERAL(SELECT r.quantities FROM production_quantity_reviews r WHERE r.tenant_id=g.tenant_id AND r.production_order_id=g.production_order_id
   AND r.production_version_id=g.production_version_id ORDER BY r.sequence DESC LIMIT 1)review ON true WHERE g.tenant_id=NEW.tenant_id AND g.id=group_identity AND g.result='failed' AND(review.quantities->>'scrappedQuantity')::int>0)
  THEN RAISE EXCEPTION 'production_quantity_scrap_group_unresolved' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER production_quantity_scrap_reinspection_guard BEFORE INSERT ON quality_group_reinspections FOR EACH ROW EXECUTE FUNCTION production_quantity_scrap_group_guard();
CREATE TRIGGER production_quantity_scrap_recovery_guard BEFORE INSERT ON production_recovery_groups FOR EACH ROW EXECUTE FUNCTION production_quantity_scrap_group_guard();
