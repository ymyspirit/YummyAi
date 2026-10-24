-- Attribution projections preserve every original fact, contribution and aggregate calculation.
CREATE TABLE finance_cost_allocation_versions (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),allocation_id uuid NOT NULL,version_number integer NOT NULL,
 previous_version_id uuid,base_run_id uuid NOT NULL,base_input_checksum text NOT NULL,dimension text NOT NULL,method text NOT NULL,algorithm text NOT NULL,
 reason_code text NOT NULL,basis_description text NOT NULL,preview jsonb NOT NULL,checksum text NOT NULL,request_identity jsonb NOT NULL,
 request_checksum text NOT NULL,idempotency_key text NOT NULL,reviewed_by uuid NOT NULL REFERENCES app_users(id),created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT finance_cost_version_tenant_unique UNIQUE(tenant_id,id),
 CONSTRAINT finance_cost_version_base_fk FOREIGN KEY(tenant_id,base_run_id) REFERENCES finance_profit_runs(tenant_id,id),
 CONSTRAINT finance_cost_version_previous_fk FOREIGN KEY(tenant_id,previous_version_id) REFERENCES finance_cost_allocation_versions(tenant_id,id),
 CONSTRAINT finance_cost_version_number_check CHECK(version_number>0 AND ((version_number=1 AND previous_version_id IS NULL) OR (version_number>1 AND previous_version_id IS NOT NULL))),
 CONSTRAINT finance_cost_version_dimension CHECK(dimension IN ('order','order_line','sku','listing','period')),
 CONSTRAINT finance_cost_version_method CHECK(method IN ('equal','manual_weights') AND algorithm='finance-allocation-largest-remainder-v1')
);
CREATE UNIQUE INDEX finance_cost_version_number ON finance_cost_allocation_versions(tenant_id,allocation_id,version_number);
CREATE UNIQUE INDEX finance_cost_version_request ON finance_cost_allocation_versions(tenant_id,idempotency_key);
CREATE INDEX finance_cost_version_base ON finance_cost_allocation_versions(tenant_id,base_run_id,id);
CREATE TABLE finance_allocated_profit_runs (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),base_run_id uuid NOT NULL,base_input_checksum text NOT NULL,dimension text NOT NULL,
 version_pins jsonb NOT NULL,algorithm text NOT NULL,reporting_currency text NOT NULL,status text NOT NULL,revenue_minor bigint,cost_minor bigint,profit_minor bigint,margin_bps integer,
 diagnostics jsonb NOT NULL,breakdowns jsonb NOT NULL,input_checksum text NOT NULL,request_identity jsonb NOT NULL,request_checksum text NOT NULL,
 idempotency_key text NOT NULL,calculated_by uuid NOT NULL REFERENCES app_users(id),created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT finance_allocated_run_tenant_unique UNIQUE(tenant_id,id),
 CONSTRAINT finance_allocated_run_base_fk FOREIGN KEY(tenant_id,base_run_id) REFERENCES finance_profit_runs(tenant_id,id),
 CONSTRAINT finance_allocated_run_dimension CHECK(dimension IN ('order','order_line','sku','listing','period')),
 CONSTRAINT finance_allocated_run_status CHECK((status='incomplete' AND revenue_minor IS NULL AND cost_minor IS NULL AND profit_minor IS NULL AND margin_bps IS NULL)
  OR (status='complete' AND revenue_minor IS NOT NULL AND cost_minor IS NOT NULL AND profit_minor IS NOT NULL))
);
CREATE UNIQUE INDEX finance_allocated_run_request ON finance_allocated_profit_runs(tenant_id,idempotency_key);
CREATE INDEX finance_allocated_run_base ON finance_allocated_profit_runs(tenant_id,base_run_id,id);
CREATE TABLE finance_allocated_profit_slices (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations(id),run_id uuid NOT NULL,base_contribution_id uuid NOT NULL,source_fact_id uuid NOT NULL,root_fact_id uuid NOT NULL,
 allocation_version_id uuid,target jsonb,amount_minor bigint NOT NULL,original_reporting_amount_minor bigint NOT NULL,bucket text NOT NULL,effect_sign integer NOT NULL,fact_type text NOT NULL,
 weight text,floor_minor bigint,remainder_numerator text,remainder_denominator text,receives_remainder boolean NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT finance_allocated_slice_tenant_unique UNIQUE(tenant_id,id),
 CONSTRAINT finance_allocated_slice_run_fk FOREIGN KEY(tenant_id,run_id) REFERENCES finance_allocated_profit_runs(tenant_id,id),
 CONSTRAINT finance_allocated_slice_contribution_fk FOREIGN KEY(tenant_id,base_contribution_id) REFERENCES finance_profit_contributions(tenant_id,id),
 CONSTRAINT finance_allocated_slice_fact_fk FOREIGN KEY(tenant_id,source_fact_id) REFERENCES finance_facts(tenant_id,id),
 CONSTRAINT finance_allocated_slice_root_fk FOREIGN KEY(tenant_id,root_fact_id) REFERENCES finance_facts(tenant_id,id),
 CONSTRAINT finance_allocated_slice_version_fk FOREIGN KEY(tenant_id,allocation_version_id) REFERENCES finance_cost_allocation_versions(tenant_id,id),
 CONSTRAINT finance_allocated_slice_amount CHECK(amount_minor BETWEEN 0 AND 9007199254740991 AND original_reporting_amount_minor BETWEEN 0 AND 9007199254740991),
 CONSTRAINT finance_allocated_slice_bucket CHECK(bucket IN ('revenue','cost','unclassified') AND effect_sign IN (-1,1))
);
CREATE UNIQUE INDEX finance_allocated_slice_target ON finance_allocated_profit_slices(tenant_id,run_id,base_contribution_id,(coalesce(target->>'key','')));
CREATE INDEX finance_allocated_slice_run ON finance_allocated_profit_slices(tenant_id,run_id,id);
--> statement-breakpoint
CREATE FUNCTION finance_cost_hash(value jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT encode(sha256(convert_to(invoice_reconciliation_canonical(value),'UTF8')),'hex')
$$;
CREATE FUNCTION finance_cost_target_basis(t uuid,d text,k text) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
DECLARE result jsonb; o uuid; line uuid; sku uuid; listing uuid; account uuid; spu uuid; link uuid; a timestamptz;b timestamptz;
BEGIN
 IF d='period' THEN
  IF k !~ '^(?!0000)[0-9]{4}-(0[1-9]|1[0-2])$' OR k='9999-12' THEN RETURN NULL;END IF;
  a:=(k||'-01T00:00:00Z')::timestamptz;b:=((a AT TIME ZONE 'UTC')+interval '1 month') AT TIME ZONE 'UTC';
 ELSIF k !~ '^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' THEN RETURN NULL;
 ELSIF d='order' THEN SELECT id,account_id INTO o,account FROM orders WHERE tenant_id=t AND id=k::uuid;IF o IS NULL THEN RETURN NULL;END IF;
 ELSIF d='sku' THEN SELECT id,spu_id INTO sku,spu FROM skus WHERE tenant_id=t AND id=k::uuid;IF sku IS NULL THEN RETURN NULL;END IF;
 ELSIF d='listing' THEN SELECT id,spu_id INTO listing,spu FROM listings WHERE tenant_id=t AND id=k::uuid;IF listing IS NULL THEN RETURN NULL;END IF;
 ELSIF d='order_line' THEN
  SELECT ol.id,ord.id,ord.account_id,cl.id,cl.sku_id,cl.listing_id,coalesce(s.spu_id,l.spu_id)
   INTO line,o,account,link,sku,listing,spu FROM order_lines ol JOIN orders ord ON ord.tenant_id=ol.tenant_id AND ord.id=ol.order_id
   LEFT JOIN order_line_catalog_links cl ON cl.tenant_id=ol.tenant_id AND cl.order_line_id=ol.id
   LEFT JOIN skus s ON s.tenant_id=ol.tenant_id AND s.id=cl.sku_id
   LEFT JOIN listings l ON l.tenant_id=ol.tenant_id AND l.id=cl.listing_id
   WHERE ol.tenant_id=t AND ol.id=k::uuid AND (cl.sku_id IS NULL OR s.id IS NOT NULL) AND (cl.listing_id IS NULL OR l.id IS NOT NULL)
   AND (s.spu_id IS NULL OR l.spu_id IS NULL OR s.spu_id=l.spu_id) AND (l.id IS NULL OR l.platform=ord.platform);
  IF line IS NULL THEN RETURN NULL;END IF;
 ELSE RETURN NULL;END IF;
 RETURN jsonb_build_object('dimension',d,'key',k,'orderId',o,'orderLineId',line,'skuId',sku,'listingId',listing,'accountId',account,'spuId',spu,'catalogLinkId',link,
  'period',CASE WHEN d='period' THEN k END,'periodStart',CASE WHEN d='period' THEN to_char(a AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
  'periodEnd',CASE WHEN d='period' THEN to_char(b AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END);
END $$;
CREATE FUNCTION finance_cost_fact_root(t uuid,f uuid) RETURNS uuid LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 WITH RECURSIVE parents AS (
  SELECT id,corrects_fact_id,ARRAY[id] AS seen FROM finance_facts WHERE tenant_id=t AND id=f
  UNION ALL SELECT x.id,x.corrects_fact_id,p.seen||x.id FROM finance_facts x JOIN parents p ON x.id=p.corrects_fact_id
   WHERE x.tenant_id=t AND NOT x.id=ANY(p.seen)
 ) SELECT id FROM parents WHERE corrects_fact_id IS NULL LIMIT 1
$$;
--> statement-breakpoint
CREATE FUNCTION finance_cost_family_facts(t uuid,r uuid) RETURNS SETOF finance_facts
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 WITH RECURSIVE family AS (
  SELECT f.*,ARRAY[f.id] AS seen FROM finance_facts f WHERE f.tenant_id=t AND f.id=r AND f.corrects_fact_id IS NULL
  UNION ALL SELECT f.*,p.seen||f.id FROM finance_facts f JOIN family p ON f.corrects_fact_id=p.id
   WHERE f.tenant_id=t AND NOT f.id=ANY(p.seen)
 ) SELECT f.* FROM finance_facts f JOIN family x ON x.id=f.id WHERE f.tenant_id=t
$$;
CREATE FUNCTION finance_cost_source_chain(t uuid,r uuid) RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT finance_cost_hash(jsonb_build_object('rootFactId',r,'facts',coalesce(jsonb_agg(jsonb_build_object('id',f.id,'statementId',f.statement_id,
  'statementChecksum',s.checksum,'correctsFactId',f.corrects_fact_id,'correctionKind',f.correction_kind) ORDER BY f.id),'[]'::jsonb)))
 FROM finance_cost_family_facts(t,r) f JOIN finance_statements s ON s.tenant_id=f.tenant_id AND s.id=f.statement_id
$$;
CREATE FUNCTION finance_cost_weight_units(w text) RETURNS numeric LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
 IF w !~ '^(0|[1-9][0-9]{0,20})(\.[0-9]{0,8}[1-9])?$' OR w='0' THEN RAISE EXCEPTION 'finance_cost_weight_invalid' USING ERRCODE='23514';END IF;
 RETURN trunc(w::numeric*1000000000);
END $$;
CREATE FUNCTION finance_cost_expected_shares(m bigint,shares jsonb)
RETURNS TABLE(key text,weight_units text,floor_minor bigint,amount_minor bigint,remainder_numerator text,remainder_denominator text,receives_remainder boolean)
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 WITH weights AS(SELECT e->'target'->>'key' AS k,finance_cost_weight_units(e->>'weight') AS w FROM jsonb_array_elements(shares) e),
 totals AS(SELECT *,sum(w) OVER() AS total FROM weights),
 raw AS(SELECT *,div(m::numeric*w,total) AS floor_amount,mod(m::numeric*w,total) AS remainder FROM totals),
 ranked AS(SELECT *,row_number() OVER(ORDER BY remainder DESC,k COLLATE "C") AS position,m::numeric-sum(floor_amount) OVER() AS remaining FROM raw)
 SELECT k,w::numeric(100,0)::text,floor_amount::bigint,(floor_amount+CASE WHEN position<=remaining THEN 1 ELSE 0 END)::bigint,
  remainder::numeric(100,0)::text,total::numeric(100,0)::text,position<=remaining FROM ranked ORDER BY k COLLATE "C"
$$;
CREATE FUNCTION finance_cost_base_ready(t uuid,b uuid,h text) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM finance_profit_runs r WHERE r.tenant_id=t AND r.id=b AND r.input_checksum=h AND r.status='complete'
  AND r.source_identity_version=1 AND r.monetary_basis->>'schemaVersion'='2' AND r.monetary_basis->>'algorithm'='iso_minor_fx_v2'
  AND r.diagnostics->'coverage'->>'dimension'='aggregate' AND (r.diagnostics->'coverage'->>'checkedEntityCount')::integer>0
  AND r.diagnostics->'coverage'->'missingByEntity'='[]'::jsonb AND r.diagnostics->'coverage'->'unattributedFactIds'='[]'::jsonb
  AND r.diagnostics->'missingFactTypes'='[]'::jsonb AND r.diagnostics->'missingFxPairs'='[]'::jsonb AND r.diagnostics->'unclassifiedFactTypes'='[]'::jsonb
  AND r.diagnostics->'sourceIdentity'->>'schemaVersion'='1' AND r.diagnostics->'sourceIdentity'->'unidentifiedFactIds'='[]'::jsonb
  AND r.diagnostics->'monetary'->'unknownCurrencies'='[]'::jsonb AND r.diagnostics->'monetary'->'ambiguousFxRateIds'='[]'::jsonb)
$$;

--> statement-breakpoint
CREATE FUNCTION finance_cost_target_checked(t uuid,d text,value jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public AS $$
DECLARE basis jsonb; after_lock jsonb; k text:=value->>'key';
BEGIN
 basis:=finance_cost_target_basis(t,d,k);
 IF basis IS NULL THEN RAISE EXCEPTION 'finance_cost_target_invalid' USING ERRCODE='23514';END IF;
 -- Same table order as the service owner. Locks last through the approval commit.
 IF d<>'period' THEN
  PERFORM 1 FROM orders WHERE tenant_id=t AND id=(basis->>'orderId')::uuid FOR SHARE;
  -- The append-only catalog-link table deliberately has no UPDATE grant.
  -- Lock its real parent FOR UPDATE to fence new FK-linked rows as well.
  PERFORM 1 FROM order_lines WHERE tenant_id=t AND id=(basis->>'orderLineId')::uuid FOR UPDATE;
  PERFORM 1 FROM skus WHERE tenant_id=t AND id=(basis->>'skuId')::uuid FOR SHARE;
  PERFORM 1 FROM listings WHERE tenant_id=t AND id=(basis->>'listingId')::uuid FOR SHARE;
 END IF;
 after_lock:=finance_cost_target_basis(t,d,k);
 IF basis IS DISTINCT FROM after_lock OR jsonb_typeof(value->'label') IS DISTINCT FROM 'string'
  OR finance_source_entry_utf16_length(value->>'label') NOT BETWEEN 1 AND 300
  OR value IS DISTINCT FROM (basis||jsonb_build_object('label',value->>'label','basisChecksum',finance_cost_hash(basis))) THEN
  RAISE EXCEPTION 'finance_cost_target_invalid' USING ERRCODE='23514';END IF;
 RETURN value;
END $$;
CREATE FUNCTION finance_cost_target_compatible(f finance_facts,value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT value->>'dimension'='period' OR NOT EXISTS(
  SELECT 1 FROM (VALUES('accountId',f.account_id),('orderId',f.order_id),('orderLineId',f.order_line_id),('skuId',f.sku_id),('listingId',f.listing_id)) x(k,id)
  WHERE x.id IS NOT NULL AND value->>x.k IS NOT NULL AND value->>x.k<>x.id::text)
$$;
CREATE FUNCTION finance_cost_family_complete(t uuid,b uuid,r uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM finance_cost_family_facts(t,r)) AND NOT EXISTS(
  SELECT 1 FROM finance_cost_family_facts(t,r) f WHERE NOT EXISTS(
   SELECT 1 FROM finance_profit_contributions c WHERE c.tenant_id=t AND c.run_id=b AND c.fact_id=f.id))
$$;
CREATE FUNCTION finance_cost_validate_preview(t uuid,b uuid,p jsonb,body jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public AS $$
DECLARE base finance_profit_runs; family jsonb; choice jsonb; original record; source jsonb; actual_share jsonb; expected_share record;
 sources jsonb:='[]'; shares jsonb; expected jsonb; target jsonb; root uuid; direct_key text; count_targets integer:=0; count_shares integer:=0;
BEGIN
 SELECT * INTO base FROM finance_profit_runs WHERE tenant_id=t AND id=b;
 IF NOT finance_cost_base_ready(t,b,body->>'baseInputChecksum') OR body->>'baseRunId' IS DISTINCT FROM b::text
  OR body->>'dimension' NOT IN ('order','order_line','sku','listing','period') OR body->>'method' NOT IN ('equal','manual_weights')
  OR jsonb_typeof(body->'reasonCode') IS DISTINCT FROM 'string' OR body->>'reasonCode' !~ '^[A-Z0-9][A-Z0-9._-]{0,99}$'
  OR jsonb_typeof(body->'basisDescription') IS DISTINCT FROM 'string'
  OR finance_source_entry_utf16_length(body->>'basisDescription') NOT BETWEEN 1 AND 1000
  OR body->>'basisDescription' IS DISTINCT FROM finance_source_entry_trim(body->>'basisDescription')
  OR jsonb_typeof(body->'sources') IS DISTINCT FROM 'array' OR jsonb_array_length(body->'sources') NOT BETWEEN 1 AND 100
  OR (SELECT count(DISTINCT e->>'rootFactId') FROM jsonb_array_elements(body->'sources') e)<>jsonb_array_length(body->'sources')
  OR (SELECT jsonb_agg(e ORDER BY e->>'rootFactId' COLLATE "C") FROM jsonb_array_elements(body->'sources') e) IS DISTINCT FROM body->'sources' THEN
  RAISE EXCEPTION 'finance_cost_preview_request_invalid' USING ERRCODE='23514';END IF;
 FOR family IN SELECT * FROM jsonb_array_elements(body->'sources') LOOP
  IF (SELECT array_agg(key ORDER BY key COLLATE "C") FROM jsonb_object_keys(family) key) IS DISTINCT FROM ARRAY['rootFactId','targets']::text[]
   OR family->>'rootFactId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
   OR jsonb_typeof(family->'targets') IS DISTINCT FROM 'array' OR jsonb_array_length(family->'targets') NOT BETWEEN 1 AND 1000 THEN
   RAISE EXCEPTION 'finance_cost_family_invalid' USING ERRCODE='23514';END IF;
  root:=(family->>'rootFactId')::uuid;
  PERFORM pg_advisory_xact_lock(hashtextextended('finance-correction:'||t||':'||root,0));
  IF NOT finance_cost_family_complete(t,b,root) THEN RAISE EXCEPTION 'finance_cost_family_incomplete' USING ERRCODE='23514';END IF;
  count_targets:=count_targets+jsonb_array_length(family->'targets');
  IF count_targets>1000 OR (SELECT count(DISTINCT x->>'key') FROM jsonb_array_elements(family->'targets') x)<>jsonb_array_length(family->'targets')
   OR (SELECT jsonb_agg(x ORDER BY x->>'key' COLLATE "C") FROM jsonb_array_elements(family->'targets') x) IS DISTINCT FROM family->'targets' THEN
   RAISE EXCEPTION 'finance_cost_targets_invalid' USING ERRCODE='23514';END IF;
  FOR choice IN SELECT * FROM jsonb_array_elements(family->'targets') LOOP
   IF (SELECT array_agg(key ORDER BY key COLLATE "C") FROM jsonb_object_keys(choice) key) IS DISTINCT FROM ARRAY['key','weight']::text[]
    OR jsonb_typeof(choice->'weight') IS DISTINCT FROM 'string' OR (body->>'method'='equal' AND choice->>'weight'<>'1') THEN
    RAISE EXCEPTION 'finance_cost_weight_invalid' USING ERRCODE='23514';END IF;
   PERFORM finance_cost_weight_units(choice->>'weight');
  END LOOP;
  FOR original IN SELECT c.*,f AS fact,s.checksum AS statement_checksum FROM finance_profit_contributions c
   JOIN finance_facts f ON f.tenant_id=c.tenant_id AND f.id=c.fact_id
   JOIN finance_statements s ON s.tenant_id=f.tenant_id AND s.id=f.statement_id
   WHERE c.tenant_id=t AND c.run_id=b AND f.id IN(SELECT id FROM finance_cost_family_facts(t,root)) ORDER BY c.id LOOP
   direct_key:=CASE body->>'dimension' WHEN 'order' THEN (original.fact).order_id::text WHEN 'order_line' THEN (original.fact).order_line_id::text
    WHEN 'sku' THEN (original.fact).sku_id::text WHEN 'listing' THEN (original.fact).listing_id::text END;
   IF original.bucket<>'cost' OR original.reporting_amount_minor IS NULL OR direct_key IS NOT NULL THEN
    RAISE EXCEPTION 'finance_cost_source_not_allocatable' USING ERRCODE='23514';END IF;
   SELECT x INTO source FROM jsonb_array_elements(p->'sources') x WHERE x->>'contributionId'=original.id::text;
   IF source IS NULL OR jsonb_typeof(source->'shares') IS DISTINCT FROM 'array'
    OR jsonb_array_length(source->'shares')<>jsonb_array_length(family->'targets') THEN
    RAISE EXCEPTION 'finance_cost_source_shares_invalid' USING ERRCODE='23514';END IF;
   shares:='[]';
   FOR expected_share IN SELECT * FROM finance_cost_expected_shares(original.reporting_amount_minor,source->'shares') LOOP
    SELECT x INTO actual_share FROM jsonb_array_elements(source->'shares') x WHERE x->'target'->>'key'=expected_share.key;
    SELECT x INTO choice FROM jsonb_array_elements(family->'targets') x WHERE x->>'key'=expected_share.key;
    IF choice IS NULL OR actual_share->>'weight' IS DISTINCT FROM choice->>'weight' THEN
     RAISE EXCEPTION 'finance_cost_share_weight_mismatch' USING ERRCODE='23514';END IF;
    target:=finance_cost_target_checked(t,body->>'dimension',actual_share->'target');
    IF NOT finance_cost_target_compatible(original.fact,target) THEN RAISE EXCEPTION 'finance_cost_source_target_mismatch' USING ERRCODE='23514';END IF;
    shares:=shares||jsonb_build_array(jsonb_build_object('target',target,'weight',choice->>'weight','weightUnits',expected_share.weight_units,
     'floorMinor',expected_share.floor_minor,'amountMinor',expected_share.amount_minor,'remainderNumerator',expected_share.remainder_numerator,
     'remainderDenominator',expected_share.remainder_denominator,'receivesRemainder',expected_share.receives_remainder));
   END LOOP;
   count_shares:=count_shares+jsonb_array_length(shares);
   IF count_shares>5000 THEN RAISE EXCEPTION 'finance_cost_scope_too_large' USING ERRCODE='23514';END IF;
   sources:=sources||jsonb_build_array(jsonb_build_object('rootFactId',root,'contributionId',original.id,'factId',original.fact_id,
    'statementId',(original.fact).statement_id,'statementChecksum',original.statement_checksum,'sourceEntryId',(original.fact).source_entry_id,
    'factType',(original.fact).fact_type,'effectSign',original.effect_sign,'sourceCurrency',original.source_currency,'sourceAmountMinor',original.source_amount_minor,
    'reportingCurrency',base.reporting_currency,'reportingAmountMinor',original.reporting_amount_minor,'fxRateId',original.fx_rate_id,
    'sourceChainChecksum',finance_cost_source_chain(t,root),'shares',shares));
  END LOOP;
 END LOOP;
 SELECT jsonb_agg(x ORDER BY x->>'contributionId' COLLATE "C") INTO sources FROM jsonb_array_elements(sources) x;
 expected:=jsonb_build_object('baseRunId',b,'baseInputChecksum',base.input_checksum,'allocationId',body->'allocationId','expectedVersion',body->'expectedVersion',
  'dimension',body->>'dimension','method',body->>'method','algorithm','finance-allocation-largest-remainder-v1','reportingCurrency',base.reporting_currency,
  'reasonCode',body->>'reasonCode','basisDescription',body->>'basisDescription','sources',sources);
 expected:=expected||jsonb_build_object('previewChecksum',finance_cost_hash(expected));
 IF p IS DISTINCT FROM expected OR body->>'previewChecksum' IS DISTINCT FROM p->>'previewChecksum' THEN
  RAISE EXCEPTION 'finance_cost_preview_mismatch' USING ERRCODE='23514';END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION guard_finance_cost_version() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE body jsonb:=NEW.request_identity->'input'; previous finance_cost_allocation_versions;
BEGIN
 NEW.created_at:=date_trunc('milliseconds',clock_timestamp());
 IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid
  OR NEW.reviewed_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
  OR NEW.id::text !~ '^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
  OR NEW.request_identity IS DISTINCT FROM jsonb_build_object('version',1,'operation','version','input',body)
  OR NEW.request_checksum IS DISTINCT FROM finance_cost_hash(NEW.request_identity)
  OR jsonb_typeof(body) IS DISTINCT FROM 'object'
  OR (SELECT array_agg(key ORDER BY key COLLATE "C") FROM jsonb_object_keys(body) key) IS DISTINCT FROM
   ARRAY['allocationId','baseInputChecksum','baseRunId','basisDescription','dimension','expectedVersion','idempotencyKey','method','previewChecksum','reasonCode','sources']::text[]
  OR jsonb_typeof(body->'idempotencyKey') IS DISTINCT FROM 'string' OR body->>'idempotencyKey' IS DISTINCT FROM NEW.idempotency_key OR finance_source_entry_utf16_length(NEW.idempotency_key) NOT BETWEEN 8 AND 200
  OR body->>'baseRunId' IS DISTINCT FROM NEW.base_run_id::text OR body->>'baseInputChecksum' IS DISTINCT FROM NEW.base_input_checksum
  OR body->>'dimension' IS DISTINCT FROM NEW.dimension OR body->>'method' IS DISTINCT FROM NEW.method
  OR body->>'reasonCode' IS DISTINCT FROM NEW.reason_code OR body->>'basisDescription' IS DISTINCT FROM NEW.basis_description
  OR NEW.algorithm<>'finance-allocation-largest-remainder-v1' THEN
  RAISE EXCEPTION 'finance_cost_version_request_invalid' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('finance-cost-allocation:'||NEW.tenant_id||':'||NEW.allocation_id,0));
 SELECT * INTO previous FROM finance_cost_allocation_versions WHERE tenant_id=NEW.tenant_id AND allocation_id=NEW.allocation_id ORDER BY version_number DESC LIMIT 1;
 IF previous.id IS NULL THEN
  IF NEW.version_number<>1 OR NEW.allocation_id<>NEW.id OR NEW.previous_version_id IS NOT NULL
   OR body->'allocationId' IS DISTINCT FROM 'null'::jsonb OR body->'expectedVersion' IS DISTINCT FROM 'null'::jsonb THEN
   RAISE EXCEPTION 'finance_cost_version_sequence_invalid' USING ERRCODE='23514';END IF;
 ELSE
  IF NEW.version_number<>previous.version_number+1 OR NEW.previous_version_id IS DISTINCT FROM previous.id OR NEW.dimension<>previous.dimension
   OR body->>'allocationId' IS DISTINCT FROM NEW.allocation_id::text OR body->'expectedVersion' IS DISTINCT FROM to_jsonb(previous.version_number) THEN
   RAISE EXCEPTION 'finance_cost_version_sequence_invalid' USING ERRCODE='23514';END IF;
 END IF;
 PERFORM finance_cost_validate_preview(NEW.tenant_id,NEW.base_run_id,NEW.preview,body);
 IF NEW.checksum IS DISTINCT FROM finance_cost_hash(jsonb_build_object('allocationId',NEW.allocation_id,'versionNumber',NEW.version_number,
  'previousVersionId',NEW.previous_version_id,'preview',NEW.preview)) THEN
  RAISE EXCEPTION 'finance_cost_version_checksum_invalid' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION guard_finance_allocated_run() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE body jsonb:=NEW.request_identity->'input'; pins jsonb; v finance_cost_allocation_versions; root uuid;
BEGIN
 NEW.created_at:=date_trunc('milliseconds',clock_timestamp());
 IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid
  OR NEW.calculated_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
  OR NEW.id::text !~ '^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
  OR NOT finance_cost_base_ready(NEW.tenant_id,NEW.base_run_id,NEW.base_input_checksum)
  OR NEW.request_identity IS DISTINCT FROM jsonb_build_object('version',1,'operation','run','input',body)
  OR NEW.request_checksum IS DISTINCT FROM finance_cost_hash(NEW.request_identity) OR jsonb_typeof(body) IS DISTINCT FROM 'object'
  OR (SELECT array_agg(key ORDER BY key COLLATE "C") FROM jsonb_object_keys(body) key) IS DISTINCT FROM ARRAY['baseInputChecksum','baseRunId','dimension','idempotencyKey','versionIds']::text[]
  OR body->>'baseRunId' IS DISTINCT FROM NEW.base_run_id::text OR body->>'baseInputChecksum' IS DISTINCT FROM NEW.base_input_checksum
  OR body->>'dimension' IS DISTINCT FROM NEW.dimension OR jsonb_typeof(body->'idempotencyKey') IS DISTINCT FROM 'string' OR body->>'idempotencyKey' IS DISTINCT FROM NEW.idempotency_key
  OR finance_source_entry_utf16_length(NEW.idempotency_key) NOT BETWEEN 8 AND 200
  OR jsonb_typeof(body->'versionIds') IS DISTINCT FROM 'array' OR jsonb_array_length(body->'versionIds')>500
  OR (SELECT count(DISTINCT x) FROM jsonb_array_elements(body->'versionIds') x)<>jsonb_array_length(body->'versionIds')
  OR (SELECT coalesce(jsonb_agg(x ORDER BY x #>> '{}' COLLATE "C"),'[]') FROM jsonb_array_elements(body->'versionIds') x) IS DISTINCT FROM body->'versionIds'
  OR NEW.algorithm<>'finance-allocation-largest-remainder-v1' THEN
  RAISE EXCEPTION 'finance_cost_run_request_invalid' USING ERRCODE='23514';END IF;
 FOR v IN SELECT * FROM finance_cost_allocation_versions WHERE tenant_id=NEW.tenant_id AND to_jsonb(id::text)<@(body->'versionIds') ORDER BY allocation_id LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('finance-cost-allocation:'||NEW.tenant_id||':'||v.allocation_id,0));
  IF v.base_run_id<>NEW.base_run_id OR v.base_input_checksum<>NEW.base_input_checksum OR v.dimension<>NEW.dimension THEN
   RAISE EXCEPTION 'finance_cost_run_version_invalid' USING ERRCODE='23514';END IF;
 END LOOP;
 FOR root IN SELECT DISTINCT coalesce(f.corrects_fact_id,f.id) FROM finance_facts f JOIN finance_profit_contributions c ON c.tenant_id=f.tenant_id AND c.fact_id=f.id
  WHERE c.tenant_id=NEW.tenant_id AND c.run_id=NEW.base_run_id ORDER BY 1 LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('finance-correction:'||NEW.tenant_id||':'||root,0));
 END LOOP;
 FOR v IN SELECT * FROM finance_cost_allocation_versions WHERE tenant_id=NEW.tenant_id AND to_jsonb(id::text)<@(body->'versionIds') ORDER BY allocation_id LOOP
  PERFORM finance_cost_validate_preview(NEW.tenant_id,NEW.base_run_id,v.preview,v.request_identity->'input');
 END LOOP;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'allocationId',allocation_id,'versionNumber',version_number,'checksum',checksum) ORDER BY id),'[]') INTO pins
  FROM finance_cost_allocation_versions WHERE tenant_id=NEW.tenant_id AND to_jsonb(id::text)<@(body->'versionIds');
 IF jsonb_array_length(pins)<>jsonb_array_length(body->'versionIds') OR pins IS DISTINCT FROM NEW.version_pins
  OR (SELECT count(DISTINCT x->>'allocationId') FROM jsonb_array_elements(pins) x)<>jsonb_array_length(pins)
  OR EXISTS(SELECT 1 FROM finance_profit_runs WHERE tenant_id=NEW.tenant_id AND id=NEW.base_run_id AND reporting_currency<>NEW.reporting_currency)
  OR NEW.input_checksum IS DISTINCT FROM finance_cost_hash(jsonb_build_object('baseRunId',NEW.base_run_id,'baseInputChecksum',NEW.base_input_checksum,
   'dimension',NEW.dimension,'versionPins',pins,'algorithm',NEW.algorithm)) THEN
  RAISE EXCEPTION 'finance_cost_run_pin_invalid' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION guard_finance_allocated_slice() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE r finance_allocated_profit_runs; c finance_profit_contributions; f finance_facts; chosen jsonb; chosen_version uuid; share jsonb; direct_key text; family_ready boolean;
BEGIN
 NEW.created_at:=date_trunc('milliseconds',clock_timestamp());
 SELECT * INTO r FROM finance_allocated_profit_runs WHERE tenant_id=NEW.tenant_id AND id=NEW.run_id;
 IF r.id IS NULL OR NOT EXISTS(SELECT 1 FROM finance_allocated_profit_runs WHERE tenant_id=NEW.tenant_id AND id=NEW.run_id
  AND xmin::text=mod(txid_current()::numeric,4294967296)::text)
  OR EXISTS(SELECT 1 FROM audit_events a WHERE a.tenant_id=NEW.tenant_id AND a.entity_id=NEW.run_id AND a.entity_type='finance_allocated_profit_run'
   AND a.action='finance.cost_allocation.profit_calculated' AND a.result='success' AND a.actor_user_id=r.calculated_by
   AND a.xmin::text=mod(txid_current()::numeric,4294967296)::text) THEN
  RAISE EXCEPTION 'finance_cost_run_sealed' USING ERRCODE='23514';END IF;
 SELECT * INTO c FROM finance_profit_contributions WHERE tenant_id=NEW.tenant_id AND id=NEW.base_contribution_id AND run_id=r.base_run_id;
 SELECT * INTO f FROM finance_facts WHERE tenant_id=NEW.tenant_id AND id=c.fact_id;
 IF c.id IS NULL OR NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid
  OR r.calculated_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
  OR NEW.id::text !~ '^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
  OR NEW.source_fact_id IS DISTINCT FROM c.fact_id OR NEW.root_fact_id IS DISTINCT FROM coalesce(f.corrects_fact_id,f.id)
  OR NEW.original_reporting_amount_minor IS DISTINCT FROM c.reporting_amount_minor OR NEW.bucket IS DISTINCT FROM c.bucket
  OR NEW.effect_sign IS DISTINCT FROM c.effect_sign OR NEW.fact_type IS DISTINCT FROM f.fact_type THEN
  RAISE EXCEPTION 'finance_cost_slice_source_invalid' USING ERRCODE='23514';END IF;
 IF (SELECT count(*) FROM finance_cost_allocation_versions v CROSS JOIN LATERAL jsonb_array_elements(v.preview->'sources') s
   WHERE v.tenant_id=NEW.tenant_id AND r.version_pins @> jsonb_build_array(jsonb_build_object('id',v.id)) AND s->>'contributionId'=c.id::text)>1 THEN
  RAISE EXCEPTION 'finance_cost_slice_version_overlap' USING ERRCODE='23514';END IF;
 SELECT v.id,s INTO chosen_version,chosen FROM finance_cost_allocation_versions v CROSS JOIN LATERAL jsonb_array_elements(v.preview->'sources') s
  WHERE v.tenant_id=NEW.tenant_id AND r.version_pins @> jsonb_build_array(jsonb_build_object('id',v.id)) AND s->>'contributionId'=c.id::text;
 IF chosen IS NOT NULL THEN
  SELECT x INTO share FROM jsonb_array_elements(chosen->'shares') x WHERE x->'target'->>'key'=NEW.target->>'key';
  IF share IS NULL OR NEW.allocation_version_id IS DISTINCT FROM chosen_version OR NEW.target IS DISTINCT FROM share->'target'
   OR NEW.amount_minor IS DISTINCT FROM (share->>'amountMinor')::bigint OR NEW.weight IS DISTINCT FROM share->>'weight'
   OR NEW.floor_minor IS DISTINCT FROM (share->>'floorMinor')::bigint OR NEW.remainder_numerator IS DISTINCT FROM share->>'remainderNumerator'
   OR NEW.remainder_denominator IS DISTINCT FROM share->>'remainderDenominator' OR NEW.receives_remainder IS DISTINCT FROM (share->>'receivesRemainder')::boolean THEN
   RAISE EXCEPTION 'finance_cost_slice_share_invalid' USING ERRCODE='23514';END IF;
 ELSE
  family_ready:=finance_cost_family_complete(NEW.tenant_id,r.base_run_id,NEW.root_fact_id);
  direct_key:=CASE r.dimension WHEN 'period' THEN to_char(f.occurred_at AT TIME ZONE 'UTC','YYYY-MM') WHEN 'order' THEN f.order_id::text
   WHEN 'order_line' THEN f.order_line_id::text WHEN 'sku' THEN f.sku_id::text WHEN 'listing' THEN f.listing_id::text END;
  IF NEW.allocation_version_id IS NOT NULL OR NEW.amount_minor IS DISTINCT FROM c.reporting_amount_minor OR NEW.weight IS NOT NULL
   OR NEW.floor_minor IS NOT NULL OR NEW.remainder_numerator IS NOT NULL OR NEW.remainder_denominator IS NOT NULL OR NEW.receives_remainder
   OR ((direct_key IS NULL OR NOT family_ready) AND NEW.target IS NOT NULL)
   OR (direct_key IS NOT NULL AND family_ready AND (NEW.target IS NULL OR NEW.target->>'key' IS DISTINCT FROM direct_key)) THEN
   RAISE EXCEPTION 'finance_cost_slice_direct_invalid' USING ERRCODE='23514';END IF;
 END IF;
 IF NEW.target IS NOT NULL THEN
  PERFORM finance_cost_target_checked(NEW.tenant_id,r.dimension,NEW.target);
  IF NOT finance_cost_target_compatible(f,NEW.target) THEN RAISE EXCEPTION 'finance_cost_source_target_mismatch' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION require_finance_cost_closed() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE r finance_allocated_profit_runs; base finance_profit_runs; metric finance_profit_metric_versions; c finance_profit_contributions;
 expected_count integer; actual_count integer; required text; key text; group_target jsonb; group_missing jsonb; missing jsonb:='[]';
 unallocated jsonb; diag jsonb; breakdowns jsonb:='[]'; revenue numeric; cost numeric; profit numeric; group_revenue numeric; group_cost numeric; fact_count integer;
 groups integer:=0; complete boolean; expected_action text; expected_type text; actor uuid; expected_metadata jsonb; slice_count integer;
BEGIN
 IF TG_TABLE_NAME='finance_cost_allocation_versions' THEN
  expected_action:='finance.cost_allocation.version_approved';expected_type:='finance_cost_allocation_version';actor:=NEW.reviewed_by;
  expected_metadata:=jsonb_build_object('baseRunId',NEW.base_run_id,'allocationId',NEW.allocation_id,'versionNumber',NEW.version_number);
 ELSE
  r:=NEW;
  SELECT * INTO base FROM finance_profit_runs WHERE tenant_id=r.tenant_id AND id=r.base_run_id;
  SELECT * INTO metric FROM finance_profit_metric_versions WHERE tenant_id=r.tenant_id AND id=base.metric_version_id;
  SELECT count(*) INTO slice_count FROM finance_allocated_profit_slices WHERE tenant_id=r.tenant_id AND run_id=r.id;
  FOR c IN SELECT * FROM finance_profit_contributions WHERE tenant_id=r.tenant_id AND run_id=r.base_run_id LOOP
   SELECT coalesce(sum(jsonb_array_length(s->'shares')),1)::integer INTO expected_count
    FROM finance_cost_allocation_versions v CROSS JOIN LATERAL jsonb_array_elements(v.preview->'sources') s
    WHERE v.tenant_id=r.tenant_id AND r.version_pins @> jsonb_build_array(jsonb_build_object('id',v.id)) AND s->>'contributionId'=c.id::text;
   SELECT count(*),coalesce(sum(amount_minor::numeric),-1) INTO actual_count,revenue FROM finance_allocated_profit_slices
    WHERE tenant_id=r.tenant_id AND run_id=r.id AND base_contribution_id=c.id;
   IF actual_count<>expected_count OR revenue IS DISTINCT FROM c.reporting_amount_minor::numeric THEN
    RAISE EXCEPTION 'finance_cost_slices_incomplete' USING ERRCODE='23514';END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM finance_allocated_profit_slices s WHERE s.tenant_id=r.tenant_id AND s.run_id=r.id
    AND NOT EXISTS(SELECT 1 FROM finance_profit_contributions original_contribution WHERE original_contribution.tenant_id=r.tenant_id AND original_contribution.run_id=r.base_run_id AND original_contribution.id=s.base_contribution_id)) THEN
   RAISE EXCEPTION 'finance_cost_slices_foreign_source' USING ERRCODE='23514';END IF;
  SELECT coalesce(jsonb_agg(id ORDER BY id),'[]') INTO unallocated FROM(SELECT DISTINCT base_contribution_id AS id FROM finance_allocated_profit_slices
   WHERE tenant_id=r.tenant_id AND run_id=r.id AND target IS NULL) x;
  FOR key IN SELECT DISTINCT (s.target->>'key') COLLATE "C" FROM finance_allocated_profit_slices s WHERE s.tenant_id=r.tenant_id AND s.run_id=r.id AND s.target IS NOT NULL ORDER BY 1 LOOP
   groups:=groups+1;group_missing:='[]';
   IF (SELECT count(DISTINCT target-'label') FROM finance_allocated_profit_slices WHERE tenant_id=r.tenant_id AND run_id=r.id AND target->>'key'=key)<>1 THEN
    RAISE EXCEPTION 'finance_cost_target_group_mismatch' USING ERRCODE='23514';END IF;
   FOR required IN SELECT value FROM jsonb_array_elements_text(metric.required_fact_types) value ORDER BY value COLLATE "C" LOOP
    IF NOT EXISTS(SELECT 1 FROM finance_allocated_profit_slices s JOIN finance_facts f ON f.tenant_id=s.tenant_id AND f.id=s.source_fact_id
     WHERE s.tenant_id=r.tenant_id AND s.run_id=r.id AND s.target->>'key'=key AND s.fact_type=required AND f.correction_kind<>'reversal'
     AND NOT EXISTS(SELECT 1 FROM finance_profit_contributions bc JOIN finance_facts reversal ON reversal.tenant_id=bc.tenant_id AND reversal.id=bc.fact_id
      WHERE bc.tenant_id=r.tenant_id AND bc.run_id=r.base_run_id AND reversal.corrects_fact_id=f.id AND reversal.correction_kind='reversal')) THEN
     group_missing:=group_missing||to_jsonb(required);END IF;
   END LOOP;
   IF group_missing<>'[]'::jsonb THEN missing:=missing||jsonb_build_array(jsonb_build_object('key',key,'missingFactTypes',group_missing));END IF;
   SELECT min(target::text)::jsonb,sum(CASE WHEN bucket='revenue' THEN amount_minor::numeric*effect_sign ELSE 0 END),
    sum(CASE WHEN bucket='cost' THEN amount_minor::numeric*effect_sign ELSE 0 END),count(DISTINCT source_fact_id)
    INTO group_target,group_revenue,group_cost,fact_count FROM finance_allocated_profit_slices WHERE tenant_id=r.tenant_id AND run_id=r.id AND target->>'key'=key;
   IF greatest(abs(group_revenue),abs(group_cost),abs(group_revenue-group_cost))>9007199254740991 THEN
    RAISE EXCEPTION 'finance_money_overflow' USING ERRCODE='23514';END IF;
   breakdowns:=breakdowns||jsonb_build_array(jsonb_build_object('target',group_target,'revenueMinor',group_revenue,'costMinor',group_cost,'profitMinor',group_revenue-group_cost,'factCount',fact_count));
  END LOOP;
  diag:=jsonb_build_object('unallocatedContributionIds',unallocated,'checkedTargetCount',groups,'missingByTarget',missing);
  complete:=unallocated='[]'::jsonb AND groups>0 AND missing='[]'::jsonb;
  SELECT coalesce(sum(CASE WHEN bucket='revenue' THEN amount_minor::numeric*effect_sign ELSE 0 END),0),
   coalesce(sum(CASE WHEN bucket='cost' THEN amount_minor::numeric*effect_sign ELSE 0 END),0) INTO revenue,cost
   FROM finance_allocated_profit_slices WHERE tenant_id=r.tenant_id AND run_id=r.id;
  profit:=revenue-cost;
  IF diag IS DISTINCT FROM r.diagnostics OR revenue IS DISTINCT FROM base.revenue_minor::numeric OR cost IS DISTINCT FROM base.cost_minor::numeric
   OR profit IS DISTINCT FROM base.profit_minor::numeric OR (r.status='complete') IS DISTINCT FROM complete
   OR r.breakdowns IS DISTINCT FROM (CASE WHEN complete THEN breakdowns ELSE '[]'::jsonb END)
   OR (complete AND (r.revenue_minor::numeric IS DISTINCT FROM revenue OR r.cost_minor::numeric IS DISTINCT FROM cost OR r.profit_minor::numeric IS DISTINCT FROM profit
     OR r.margin_bps IS DISTINCT FROM base.margin_bps)) THEN
   RAISE EXCEPTION 'finance_cost_projection_mismatch' USING ERRCODE='23514';END IF;
  expected_action:='finance.cost_allocation.profit_calculated';expected_type:='finance_allocated_profit_run';actor:=r.calculated_by;
  expected_metadata:=jsonb_build_object('baseRunId',r.base_run_id,'dimension',r.dimension,'versionCount',jsonb_array_length(r.version_pins),'sliceCount',slice_count);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.tenant_id=NEW.tenant_id AND a.entity_id=NEW.id AND a.entity_type=expected_type
  AND a.action=expected_action AND a.result='success' AND a.actor_user_id=actor AND a.metadata @> expected_metadata
  AND a.xmin::text=mod(txid_current()::numeric,4294967296)::text) THEN
  RAISE EXCEPTION 'finance_cost_atomic_audit_missing' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER finance_cost_version_guard BEFORE INSERT ON finance_cost_allocation_versions FOR EACH ROW EXECUTE FUNCTION guard_finance_cost_version();
CREATE TRIGGER finance_allocated_run_guard BEFORE INSERT ON finance_allocated_profit_runs FOR EACH ROW EXECUTE FUNCTION guard_finance_allocated_run();
CREATE TRIGGER finance_allocated_slice_guard BEFORE INSERT ON finance_allocated_profit_slices FOR EACH ROW EXECUTE FUNCTION guard_finance_allocated_slice();
CREATE CONSTRAINT TRIGGER finance_cost_version_closed AFTER INSERT ON finance_cost_allocation_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_finance_cost_closed();
CREATE CONSTRAINT TRIGGER finance_allocated_run_closed AFTER INSERT ON finance_allocated_profit_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_finance_cost_closed();
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['finance_cost_allocation_versions','finance_allocated_profit_runs','finance_allocated_profit_slices'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY %I ON %I USING(tenant_id=current_setting(''app.tenant_id'',true)::uuid) WITH CHECK(tenant_id=current_setting(''app.tenant_id'',true)::uuid)',name||'_tenant',name);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO yummyai_app',name);
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION prohibit_finance_evidence_mutation()',name||'_immutable',name);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION finance_cost_hash(jsonb),finance_cost_target_basis(uuid,text,text),finance_cost_fact_root(uuid,uuid),finance_cost_family_facts(uuid,uuid),
 finance_cost_source_chain(uuid,uuid),finance_cost_weight_units(text),finance_cost_expected_shares(bigint,jsonb),finance_cost_base_ready(uuid,uuid,text),
 finance_cost_target_checked(uuid,text,jsonb),finance_cost_target_compatible(finance_facts,jsonb),finance_cost_family_complete(uuid,uuid,uuid),
 finance_cost_validate_preview(uuid,uuid,jsonb,jsonb),guard_finance_cost_version(),guard_finance_allocated_run(),guard_finance_allocated_slice(),require_finance_cost_closed() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finance_cost_hash(jsonb),finance_cost_target_basis(uuid,text,text),finance_cost_fact_root(uuid,uuid),finance_cost_family_facts(uuid,uuid),
 finance_cost_source_chain(uuid,uuid),finance_cost_weight_units(text),finance_cost_expected_shares(bigint,jsonb),finance_cost_base_ready(uuid,uuid,text),
 finance_cost_target_checked(uuid,text,jsonb),finance_cost_target_compatible(finance_facts,jsonb),finance_cost_family_complete(uuid,uuid,uuid),finance_cost_validate_preview(uuid,uuid,jsonb,jsonb) TO yummyai_app;
