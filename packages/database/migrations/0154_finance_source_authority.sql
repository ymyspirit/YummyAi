-- Add provenance only to future writes. No historical evidence is backfilled.
ALTER TABLE finance_statements ADD COLUMN source_identity jsonb;
ALTER TABLE finance_statements ADD COLUMN source_input jsonb;
ALTER TABLE finance_facts ADD COLUMN source_entry_id text;
ALTER TABLE finance_facts ADD COLUMN source_scope_key text;
ALTER TABLE finance_facts ADD COLUMN source_provider text;
ALTER TABLE finance_profit_runs ADD COLUMN source_identity_version integer;
ALTER TABLE finance_profit_metric_versions ADD COLUMN request_identity jsonb;
CREATE UNIQUE INDEX finance_facts_source_entry_unique ON finance_facts(tenant_id,source_provider,source_scope_key,source_entry_id);
--> statement-breakpoint
CREATE FUNCTION finance_source_entry_trim(value text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT btrim(value,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
$$;
GRANT EXECUTE ON FUNCTION finance_source_entry_trim(text) TO yummyai_app;
CREATE FUNCTION finance_source_entry_utf16_length(value text) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT coalesce(sum(CASE WHEN character='' THEN 0 WHEN ascii(character)>65535 THEN 2 ELSE 1 END),0)::integer
 FROM regexp_split_to_table(value,'') parts(character)
$$;
GRANT EXECUTE ON FUNCTION finance_source_entry_utf16_length(text) TO yummyai_app;
CREATE FUNCTION finance_source_date_supported(value text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT value ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?Z$'
  AND value !~ '^0000-' AND value !~ '\.[0-9]{3}[0-9]*[1-9][0-9]*Z$'
$$;
GRANT EXECUTE ON FUNCTION finance_source_date_supported(text) TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION guard_finance_source_statement() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE s jsonb; expected_scope text; keys text[]; account_platform text; body jsonb; field text;
BEGIN
 s:=NEW.source_identity;
 IF NOT isfinite(NEW.period_start) OR NOT isfinite(NEW.period_end) OR NOT isfinite(NEW.observed_at)
  OR extract(year from NEW.period_start AT TIME ZONE 'UTC') NOT BETWEEN 1 AND 9999 OR extract(year from NEW.period_end AT TIME ZONE 'UTC') NOT BETWEEN 1 AND 9999
  OR extract(year from NEW.observed_at AT TIME ZONE 'UTC') NOT BETWEEN 1 AND 9999
  OR date_trunc('milliseconds',NEW.period_start)<>NEW.period_start OR date_trunc('milliseconds',NEW.period_end)<>NEW.period_end
  OR date_trunc('milliseconds',NEW.observed_at)<>NEW.observed_at THEN
  RAISE EXCEPTION 'finance_source_date_invalid' USING ERRCODE='23514'; END IF;
 IF jsonb_typeof(s) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'finance_source_identity_required' USING ERRCODE='23514'; END IF;
 SELECT array_agg(key ORDER BY key COLLATE "C") INTO keys FROM jsonb_object_keys(s) key;
 IF s->'schemaVersion' IS DISTINCT FROM '2'::jsonb OR jsonb_typeof(s->'kind') IS DISTINCT FROM 'string' THEN
  RAISE EXCEPTION 'finance_source_identity_invalid' USING ERRCODE='23514'; END IF;
 IF s->>'kind'='marketplace_account' THEN
  IF keys IS DISTINCT FROM ARRAY['kind','schemaVersion']::text[] OR NEW.account_id IS NULL
   OR NEW.provider NOT IN ('amazon','etsy','advertising') THEN RAISE EXCEPTION 'finance_source_account_mismatch' USING ERRCODE='23514'; END IF;
  SELECT platform INTO account_platform FROM marketplace_accounts WHERE tenant_id=NEW.tenant_id AND id=NEW.account_id AND deleted_at IS NULL;
  IF account_platform IS NULL OR (NEW.provider IN ('amazon','etsy') AND account_platform<>NEW.provider) THEN
   RAISE EXCEPTION 'finance_source_account_mismatch' USING ERRCODE='23514'; END IF;
  expected_scope:='account:'||NEW.account_id;
 ELSIF s->>'kind'='supplier' THEN
  IF keys IS DISTINCT FROM ARRAY['kind','schemaVersion','supplierId']::text[] OR NEW.provider<>'supplier' OR NEW.account_id IS NOT NULL
   OR jsonb_typeof(s->'supplierId') IS DISTINCT FROM 'string' OR s->>'supplierId' !~* '^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' THEN
   RAISE EXCEPTION 'finance_source_supplier_mismatch' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM fulfillment_suppliers WHERE tenant_id=NEW.tenant_id AND id=(s->>'supplierId')::uuid) THEN
   RAISE EXCEPTION 'finance_source_supplier_missing' USING ERRCODE='23514'; END IF;
  expected_scope:='supplier:'||((s->>'supplierId')::uuid)::text;
 ELSIF s->>'kind'='named_source' THEN
  IF keys IS DISTINCT FROM ARRAY['kind','schemaVersion','sourceName']::text[] OR NEW.account_id IS NOT NULL OR NEW.provider IN ('amazon','etsy','supplier')
   OR jsonb_typeof(s->'sourceName') IS DISTINCT FROM 'string' OR length(s->>'sourceName') NOT BETWEEN 1 AND 160
   OR s->>'sourceName' !~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$' THEN
   RAISE EXCEPTION 'finance_source_named_mismatch' USING ERRCODE='23514'; END IF;
  expected_scope:='source:'||(s->>'sourceName');
 ELSE RAISE EXCEPTION 'finance_source_identity_invalid' USING ERRCODE='23514'; END IF;
 IF NEW.scope_key IS DISTINCT FROM expected_scope OR NEW.recorded_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid THEN
  RAISE EXCEPTION 'finance_source_scope_mismatch' USING ERRCODE='23514'; END IF;
 body:=NEW.source_input;
 IF jsonb_typeof(body) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'finance_source_input_required' USING ERRCODE='23514'; END IF;
 IF (SELECT array_agg(key ORDER BY key COLLATE "C") FROM jsonb_object_keys(body) key) IS DISTINCT FROM
  ARRAY['accountId','externalStatementId','lines','observedAt','periodEnd','periodStart','provider','sourceCurrency','sourceIdentity','statementKind']::text[]
  OR jsonb_typeof(body->'lines') IS DISTINCT FROM 'array' OR body->'sourceIdentity' IS DISTINCT FROM s THEN
  RAISE EXCEPTION 'finance_source_input_invalid' USING ERRCODE='23514'; END IF;
 FOREACH field IN ARRAY ARRAY['externalStatementId','observedAt','periodEnd','periodStart','provider','sourceCurrency','statementKind'] LOOP
  IF jsonb_typeof(body->field) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'finance_source_input_invalid' USING ERRCODE='23514'; END IF;
 END LOOP;
 FOREACH field IN ARRAY ARRAY['periodStart','periodEnd','observedAt'] LOOP
  IF finance_source_date_supported(body->>field) IS DISTINCT FROM true THEN RAISE EXCEPTION 'finance_source_date_invalid' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF finance_source_entry_utf16_length(NEW.external_statement_id) NOT BETWEEN 1 AND 300
  OR NEW.external_statement_id<>finance_source_entry_trim(NEW.external_statement_id) THEN
  RAISE EXCEPTION 'finance_source_reference_invalid' USING ERRCODE='23514'; END IF;
 IF jsonb_typeof(body->'accountId') NOT IN ('string','null') OR jsonb_array_length(body->'lines') NOT BETWEEN 1 AND 20000
  OR (body->>'accountId')::uuid IS DISTINCT FROM NEW.account_id OR body->>'provider' IS DISTINCT FROM NEW.provider
  OR body->>'statementKind' IS DISTINCT FROM NEW.statement_kind OR body->>'externalStatementId' IS DISTINCT FROM NEW.external_statement_id
  OR (body->>'periodStart')::timestamptz IS DISTINCT FROM NEW.period_start OR (body->>'periodEnd')::timestamptz IS DISTINCT FROM NEW.period_end
  OR (body->>'observedAt')::timestamptz IS DISTINCT FROM NEW.observed_at OR body->>'sourceCurrency' IS DISTINCT FROM NEW.source_currency
  OR NEW.checksum IS DISTINCT FROM encode(sha256(convert_to(invoice_reconciliation_canonical(body),'UTF8')),'hex') THEN
  RAISE EXCEPTION 'finance_source_input_mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER finance_source_statement_insert BEFORE INSERT ON finance_statements
 FOR EACH ROW EXECUTE FUNCTION guard_finance_source_statement();
--> statement-breakpoint
CREATE FUNCTION guard_finance_source_fact() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE s record; root finance_facts; source_statement finance_statements;
 parent_order orders; parent_line order_lines; sku skus; listing listings; link order_line_catalog_links; item jsonb; field text;
BEGIN
 SELECT source.*,source.xmin::text::bigint AS source_xid INTO s FROM finance_statements source WHERE tenant_id=NEW.tenant_id AND id=NEW.statement_id;
 IF NOT isfinite(NEW.occurred_at) OR extract(year from NEW.occurred_at AT TIME ZONE 'UTC') NOT BETWEEN 1 AND 9999 OR date_trunc('milliseconds',NEW.occurred_at)<>NEW.occurred_at THEN
  RAISE EXCEPTION 'finance_source_date_invalid' USING ERRCODE='23514'; END IF;
 IF s.id IS NULL OR s.source_identity IS NULL OR s.source_xid<>mod(txid_current(),4294967296)
  OR NEW.source_entry_id IS NULL OR NEW.source_entry_id='' OR finance_source_entry_utf16_length(NEW.source_entry_id) NOT BETWEEN 1 AND 300
  OR NEW.source_entry_id<>finance_source_entry_trim(NEW.source_entry_id) OR NEW.source_entry_id ~ '[[:cntrl:]]'
  OR NEW.source_provider IS DISTINCT FROM s.provider OR NEW.source_scope_key IS DISTINCT FROM s.scope_key
  OR NEW.account_id IS DISTINCT FROM s.account_id OR NEW.currency<>s.source_currency THEN
  RAISE EXCEPTION 'finance_source_entry_invalid' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM audit_events a WHERE a.tenant_id=NEW.tenant_id AND a.entity_id=s.id AND a.entity_type='finance_statement'
  AND a.action='finance.statement.record' AND a.result='success' AND a.xmin::text::bigint=mod(txid_current(),4294967296)) THEN
  RAISE EXCEPTION 'finance_statement_is_sealed' USING ERRCODE='23514'; END IF;
 SELECT value INTO item FROM jsonb_array_elements(s.source_input->'lines') WHERE value->>'lineKey'=NEW.line_key LIMIT 1;
 IF jsonb_typeof(item) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'finance_source_line_missing' USING ERRCODE='23514'; END IF;
 IF (SELECT array_agg(key ORDER BY key COLLATE "C") FROM jsonb_object_keys(item) key) IS DISTINCT FROM
  ARRAY['amountMinor','correctionKind','correctsFactId','currency','direction','externalReference','factType','lineKey','listingId','occurredAt','orderId','orderLineId','skuId','sourceEntryId','supplierId']::text[] THEN
  RAISE EXCEPTION 'finance_source_line_invalid' USING ERRCODE='23514'; END IF;
 FOREACH field IN ARRAY ARRAY['correctionKind','currency','direction','factType','lineKey','occurredAt','sourceEntryId'] LOOP
  IF jsonb_typeof(item->field) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'finance_source_line_invalid' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF finance_source_date_supported(item->>'occurredAt') IS DISTINCT FROM true THEN RAISE EXCEPTION 'finance_source_date_invalid' USING ERRCODE='23514'; END IF;
 IF finance_source_entry_utf16_length(NEW.line_key) NOT BETWEEN 1 AND 300 OR NEW.line_key<>finance_source_entry_trim(NEW.line_key)
  OR (NEW.external_reference IS NOT NULL AND (finance_source_entry_utf16_length(NEW.external_reference) NOT BETWEEN 1 AND 300
   OR NEW.external_reference<>finance_source_entry_trim(NEW.external_reference))) THEN
  RAISE EXCEPTION 'finance_source_reference_invalid' USING ERRCODE='23514'; END IF;
 FOREACH field IN ARRAY ARRAY['correctsFactId','externalReference','listingId','orderId','orderLineId','skuId','supplierId'] LOOP
  IF jsonb_typeof(item->field) NOT IN ('string','null') THEN RAISE EXCEPTION 'finance_source_line_invalid' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF jsonb_typeof(item->'amountMinor') IS DISTINCT FROM 'number' OR item->>'amountMinor' !~ '^[0-9]+$'
  OR (item->>'amountMinor')::numeric IS DISTINCT FROM NEW.amount_minor::numeric OR item->>'sourceEntryId' IS DISTINCT FROM NEW.source_entry_id
  OR item->>'factType' IS DISTINCT FROM NEW.fact_type OR item->>'direction' IS DISTINCT FROM NEW.direction OR item->>'currency' IS DISTINCT FROM NEW.currency
  OR (item->>'occurredAt')::timestamptz IS DISTINCT FROM NEW.occurred_at OR item->>'externalReference' IS DISTINCT FROM NEW.external_reference
  OR (item->>'orderId')::uuid IS DISTINCT FROM NEW.order_id OR (item->>'orderLineId')::uuid IS DISTINCT FROM NEW.order_line_id
  OR (item->>'skuId')::uuid IS DISTINCT FROM NEW.sku_id OR (item->>'listingId')::uuid IS DISTINCT FROM NEW.listing_id
  OR (item->>'supplierId')::uuid IS DISTINCT FROM NEW.supplier_id OR item->>'correctionKind' IS DISTINCT FROM NEW.correction_kind
  OR (item->>'correctsFactId')::uuid IS DISTINCT FROM NEW.corrects_fact_id THEN
  RAISE EXCEPTION 'finance_source_line_mismatch' USING ERRCODE='23514'; END IF;
 IF s.source_identity->>'kind'='supplier' AND NEW.supplier_id IS DISTINCT FROM (s.source_identity->>'supplierId')::uuid THEN
  RAISE EXCEPTION 'finance_source_supplier_mismatch' USING ERRCODE='23514'; END IF;
 IF NEW.order_id IS NOT NULL THEN
  SELECT * INTO parent_order FROM orders WHERE tenant_id=NEW.tenant_id AND id=NEW.order_id;
  IF parent_order.id IS NULL OR (s.account_id IS NOT NULL AND (parent_order.account_id IS DISTINCT FROM s.account_id
   OR NOT EXISTS(SELECT 1 FROM marketplace_accounts a WHERE a.tenant_id=NEW.tenant_id AND a.id=s.account_id AND a.platform=parent_order.platform))) THEN
   RAISE EXCEPTION 'finance_order_account_mismatch' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.order_line_id IS NOT NULL THEN
  SELECT * INTO parent_line FROM order_lines WHERE tenant_id=NEW.tenant_id AND id=NEW.order_line_id;
  IF parent_line.id IS NULL OR parent_line.order_id IS DISTINCT FROM NEW.order_id THEN
   RAISE EXCEPTION 'finance_order_line_mismatch' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.sku_id IS NOT NULL THEN SELECT * INTO sku FROM skus WHERE tenant_id=NEW.tenant_id AND id=NEW.sku_id; END IF;
 IF NEW.listing_id IS NOT NULL THEN SELECT * INTO listing FROM listings WHERE tenant_id=NEW.tenant_id AND id=NEW.listing_id; END IF;
 IF (NEW.sku_id IS NOT NULL AND sku.id IS NULL) OR (NEW.listing_id IS NOT NULL AND listing.id IS NULL) THEN
  RAISE EXCEPTION 'finance_catalog_reference_missing' USING ERRCODE='23514'; END IF;
 IF NEW.correction_kind='original' THEN
  IF sku.id IS NOT NULL AND listing.id IS NOT NULL AND sku.spu_id<>listing.spu_id THEN
   RAISE EXCEPTION 'finance_sku_listing_mismatch' USING ERRCODE='23514'; END IF;
  IF listing.id IS NOT NULL AND coalesce(s.account_id,parent_order.account_id) IS NOT NULL
   AND NOT EXISTS(SELECT 1 FROM marketplace_accounts a WHERE a.tenant_id=NEW.tenant_id AND a.id=coalesce(s.account_id,parent_order.account_id) AND a.platform=listing.platform) THEN
   RAISE EXCEPTION 'finance_listing_account_mismatch' USING ERRCODE='23514'; END IF;
  IF parent_line.id IS NOT NULL THEN
   SELECT * INTO link FROM order_line_catalog_links WHERE tenant_id=NEW.tenant_id AND order_line_id=parent_line.id;
   IF (link.id IS NOT NULL AND ((NEW.sku_id IS NOT NULL AND link.sku_id IS NOT NULL AND link.sku_id<>NEW.sku_id)
    OR (NEW.listing_id IS NOT NULL AND link.listing_id IS NOT NULL AND link.listing_id<>NEW.listing_id)))
    OR (link.sku_id IS NULL AND sku.id IS NOT NULL AND parent_line.sku_code IS NOT NULL
     AND EXISTS(SELECT 1 FROM skus known WHERE known.tenant_id=NEW.tenant_id AND known.code=parent_line.sku_code AND known.id<>sku.id)) THEN
    RAISE EXCEPTION 'finance_order_catalog_mismatch' USING ERRCODE='23514'; END IF;
   IF (listing.id IS NOT NULL AND link.sku_id IS NOT NULL AND EXISTS(SELECT 1 FROM skus known WHERE known.tenant_id=NEW.tenant_id AND known.id=link.sku_id AND known.spu_id<>listing.spu_id))
    OR (sku.id IS NOT NULL AND link.listing_id IS NOT NULL AND EXISTS(SELECT 1 FROM listings known WHERE known.tenant_id=NEW.tenant_id AND known.id=link.listing_id AND known.spu_id<>sku.spu_id)) THEN
    RAISE EXCEPTION 'finance_order_catalog_mismatch' USING ERRCODE='23514'; END IF;
  END IF;
 ELSE
  PERFORM pg_advisory_xact_lock(hashtextextended('finance-correction:'||NEW.tenant_id||':'||NEW.corrects_fact_id,0));
  SELECT * INTO root FROM finance_facts WHERE tenant_id=NEW.tenant_id AND id=NEW.corrects_fact_id;
  SELECT * INTO source_statement FROM finance_statements WHERE tenant_id=NEW.tenant_id AND id=root.statement_id;
  IF root.id IS NULL OR root.correction_kind<>'original' OR root.source_entry_id IS NULL
   OR source_statement.provider IS DISTINCT FROM s.provider OR source_statement.scope_key IS DISTINCT FROM s.scope_key
   OR root.fact_type<>NEW.fact_type OR root.currency<>NEW.currency OR root.direction<>NEW.direction
   OR root.order_id IS DISTINCT FROM NEW.order_id OR root.order_line_id IS DISTINCT FROM NEW.order_line_id
   OR root.sku_id IS DISTINCT FROM NEW.sku_id OR root.listing_id IS DISTINCT FROM NEW.listing_id
   OR root.account_id IS DISTINCT FROM NEW.account_id OR root.supplier_id IS DISTINCT FROM NEW.supplier_id
   OR (NEW.correction_kind='reversal' AND root.amount_minor<>NEW.amount_minor)
   OR (NEW.correction_kind='replacement' AND NOT EXISTS(SELECT 1 FROM finance_facts WHERE tenant_id=NEW.tenant_id
    AND corrects_fact_id=root.id AND correction_kind='reversal')) THEN
   RAISE EXCEPTION 'finance_correction_root_mismatch' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER finance_source_fact_insert BEFORE INSERT ON finance_facts
 FOR EACH ROW EXECUTE FUNCTION guard_finance_source_fact();
--> statement-breakpoint
CREATE FUNCTION guard_finance_metric_request() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE body jsonb; keys text[]; field text; item jsonb; sorted_revenue jsonb; sorted_cost jsonb; sorted_required jsonb; checksum_body jsonb;
BEGIN
 body:=NEW.request_identity;
 IF jsonb_typeof(body) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'finance_metric_request_required' USING ERRCODE='23514'; END IF;
 SELECT array_agg(key ORDER BY key COLLATE "C") INTO keys FROM jsonb_object_keys(body) key;
 IF jsonb_typeof(body->'name') IS DISTINCT FROM 'string' OR length(body->>'name') NOT BETWEEN 1 AND 160 OR body->>'name'<>btrim(body->>'name')
  OR NEW.created_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid THEN
  RAISE EXCEPTION 'finance_metric_request_invalid' USING ERRCODE='23514'; END IF;
 IF NEW.version_number=1 THEN
  IF keys IS DISTINCT FROM ARRAY['metricId','name']::text[] OR body->'metricId' IS DISTINCT FROM 'null'::jsonb THEN
   RAISE EXCEPTION 'finance_metric_request_invalid' USING ERRCODE='23514'; END IF;
 ELSE
  IF keys IS DISTINCT FROM ARRAY['expectedVersion','metricId','name']::text[] OR body->'metricId' IS DISTINCT FROM to_jsonb(NEW.metric_id::text)
   OR body->'expectedVersion' IS DISTINCT FROM to_jsonb(NEW.version_number-1)
   OR NOT EXISTS(SELECT 1 FROM finance_profit_metric_versions WHERE tenant_id=NEW.tenant_id AND metric_id=NEW.metric_id AND version_number=NEW.version_number-1) THEN
   RAISE EXCEPTION 'finance_metric_request_invalid' USING ERRCODE='23514'; END IF;
 END IF;
 FOREACH field IN ARRAY ARRAY['revenue_fact_types','cost_fact_types','required_fact_types'] LOOP
  item:=to_jsonb(NEW)->field;
  IF jsonb_typeof(item) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'finance_metric_rules_invalid' USING ERRCODE='23514'; END IF;
  IF jsonb_array_length(item)>15 OR (field<>'required_fact_types' AND jsonb_array_length(item)=0)
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(item) value WHERE jsonb_typeof(value)<>'string' OR value #>> '{}' NOT IN
    ('sale_revenue','shipping_revenue','marketplace_commission','advertising_spend','fulfillment_fee','storage_fee','refund','chargeback','procurement_cost','production_cost','freight_cost','carrier_cost','tax','other_fee'))
   OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(item) value)<>jsonb_array_length(item) THEN
   RAISE EXCEPTION 'finance_metric_rules_invalid' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.revenue_fact_types) value WHERE NEW.cost_fact_types @> jsonb_build_array(value))
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.required_fact_types) value WHERE NOT (NEW.revenue_fact_types||NEW.cost_fact_types) @> jsonb_build_array(value))
  OR NEW.reason_code !~ '^[A-Z0-9][A-Z0-9._-]{0,99}$' THEN
  RAISE EXCEPTION 'finance_metric_rules_invalid' USING ERRCODE='23514'; END IF;
 SELECT coalesce(jsonb_agg(value ORDER BY (value #>> '{}') COLLATE "C"),'[]'::jsonb) INTO sorted_revenue FROM jsonb_array_elements(NEW.revenue_fact_types) value;
 SELECT coalesce(jsonb_agg(value ORDER BY (value #>> '{}') COLLATE "C"),'[]'::jsonb) INTO sorted_cost FROM jsonb_array_elements(NEW.cost_fact_types) value;
 SELECT coalesce(jsonb_agg(value ORDER BY (value #>> '{}') COLLATE "C"),'[]'::jsonb) INTO sorted_required FROM jsonb_array_elements(NEW.required_fact_types) value;
 checksum_body:=jsonb_build_object('name',body->>'name','reportingCurrency',NEW.reporting_currency,
  'revenueFactTypes',sorted_revenue,'costFactTypes',sorted_cost,'requiredFactTypes',sorted_required,'reasonCode',NEW.reason_code);
 IF NEW.checksum IS DISTINCT FROM encode(sha256(convert_to(invoice_reconciliation_canonical(checksum_body),'UTF8')),'hex') THEN
  RAISE EXCEPTION 'finance_metric_checksum_mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER finance_metric_request_insert BEFORE INSERT ON finance_profit_metric_versions
 FOR EACH ROW EXECUTE FUNCTION guard_finance_metric_request();
--> statement-breakpoint
CREATE FUNCTION require_finance_metric_projection() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE m finance_profit_metrics; v record;
BEGIN
 SELECT * INTO m FROM finance_profit_metrics WHERE tenant_id=NEW.tenant_id AND id=NEW.id;
 SELECT version.*,version.xmin::text::bigint AS source_xid INTO v FROM finance_profit_metric_versions version WHERE tenant_id=NEW.tenant_id AND metric_id=NEW.id AND version_number=m.current_version;
 IF v.id IS NULL OR v.request_identity IS NULL OR v.request_identity->>'name' IS DISTINCT FROM m.name
  OR v.source_xid<>mod(txid_current(),4294967296) THEN
  RAISE EXCEPTION 'finance_metric_projection_mismatch' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER finance_metric_projection_insert AFTER INSERT ON finance_profit_metrics DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION require_finance_metric_projection();
CREATE CONSTRAINT TRIGGER finance_metric_projection_update AFTER UPDATE OF name,current_version ON finance_profit_metrics DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION require_finance_metric_projection();
--> statement-breakpoint
CREATE FUNCTION require_finance_source_transaction() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE expected_action text; expected_type text; entity uuid; actor uuid; missing jsonb; diag jsonb; m record; expected_version integer; line_count integer;
BEGIN
 IF TG_TABLE_NAME='finance_statements' THEN
  SELECT count(*) INTO line_count FROM finance_facts WHERE tenant_id=NEW.tenant_id AND statement_id=NEW.id;
  IF line_count=0 THEN
   RAISE EXCEPTION 'finance_statement_entries_required' USING ERRCODE='23514'; END IF;
  IF line_count<>jsonb_array_length(NEW.source_input->'lines') THEN RAISE EXCEPTION 'finance_statement_entries_incomplete' USING ERRCODE='23514'; END IF;
  expected_action:='finance.statement.record'; expected_type:='finance_statement'; entity:=NEW.id; actor:=NEW.recorded_by;
 ELSIF TG_TABLE_NAME='finance_fx_rates' THEN
  expected_action:='finance.fx_rate.record'; expected_type:='finance_fx_rate'; entity:=NEW.id; actor:=NEW.recorded_by;
 ELSIF TG_TABLE_NAME='finance_profit_metric_versions' THEN
  SELECT metric.*,metric.xmin::text::bigint AS source_xid INTO m FROM finance_profit_metrics metric WHERE tenant_id=NEW.tenant_id AND id=NEW.metric_id;
  IF m.current_version IS DISTINCT FROM NEW.version_number OR m.name IS DISTINCT FROM NEW.request_identity->>'name'
   OR m.source_xid<>mod(txid_current(),4294967296) THEN
   RAISE EXCEPTION 'finance_metric_projection_mismatch' USING ERRCODE='23514'; END IF;
  expected_action:='finance.profit_metric.version'; expected_type:='finance_profit_metric'; entity:=NEW.metric_id; actor:=NEW.created_by;
  expected_version:=NEW.version_number;
 ELSE
  IF NEW.source_identity_version IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'finance_profit_source_version_required' USING ERRCODE='23514'; END IF;
  SELECT coalesce(jsonb_agg(f.id::text ORDER BY f.id),'[]'::jsonb) INTO missing
   FROM finance_facts f JOIN finance_statements s ON s.tenant_id=f.tenant_id AND s.id=f.statement_id
   WHERE f.tenant_id=NEW.tenant_id AND f.statement_id=ANY(ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(NEW.statement_ids)))
   AND (s.source_identity IS NULL OR f.source_entry_id IS NULL OR f.source_scope_key IS DISTINCT FROM s.scope_key OR f.source_provider IS DISTINCT FROM s.provider);
  diag:=NEW.diagnostics->'sourceIdentity';
  IF jsonb_typeof(diag) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'finance_profit_source_diagnostics_invalid' USING ERRCODE='23514'; END IF;
  IF (SELECT array_agg(key ORDER BY key COLLATE "C") FROM jsonb_object_keys(diag) key) IS DISTINCT FROM ARRAY['schemaVersion','unidentifiedFactIds']::text[]
   OR diag->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR diag->'unidentifiedFactIds' IS DISTINCT FROM missing
   OR (NEW.status='complete' AND missing<>'[]'::jsonb) THEN
   RAISE EXCEPTION 'finance_profit_source_diagnostics_invalid' USING ERRCODE='23514'; END IF;
  expected_action:='finance.profit.calculate'; expected_type:='finance_profit_run'; entity:=NEW.id; actor:=NEW.calculated_by;
 END IF;
 IF actor IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid OR NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.tenant_id=NEW.tenant_id
  AND a.entity_id=entity AND a.entity_type=expected_type AND a.action=expected_action AND a.result='success' AND a.actor_user_id=actor
  AND (expected_version IS NULL OR a.metadata->'version'=to_jsonb(expected_version))
  AND (line_count IS NULL OR a.metadata->'lineCount'=to_jsonb(line_count))
  AND a.xmin::text::bigint=mod(txid_current(),4294967296)) THEN
  RAISE EXCEPTION 'finance_atomic_audit_missing' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER finance_statement_source_closed AFTER INSERT ON finance_statements DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION require_finance_source_transaction();
CREATE CONSTRAINT TRIGGER finance_fx_source_closed AFTER INSERT ON finance_fx_rates DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION require_finance_source_transaction();
CREATE CONSTRAINT TRIGGER finance_metric_source_closed AFTER INSERT ON finance_profit_metric_versions DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION require_finance_source_transaction();
CREATE CONSTRAINT TRIGGER finance_profit_source_closed AFTER INSERT ON finance_profit_runs DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION require_finance_source_transaction();
--> statement-breakpoint
CREATE FUNCTION prohibit_finance_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'finance_evidence_immutable' USING ERRCODE='23514'; END $$;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['finance_statements','finance_facts','finance_fx_rates','finance_profit_metric_versions','finance_profit_runs','finance_profit_contributions'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION prohibit_finance_evidence_mutation()',name||'_immutable',name);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION finance_source_entry_trim(text),finance_source_entry_utf16_length(text),finance_source_date_supported(text),guard_finance_source_statement(),guard_finance_source_fact(),guard_finance_metric_request(),require_finance_metric_projection(),require_finance_source_transaction(),prohibit_finance_evidence_mutation() FROM PUBLIC;
