-- Nullable additions preserve original amounts, checksums and unknown legacy units.
ALTER TABLE finance_fx_rates ADD COLUMN monetary_basis jsonb;
--> statement-breakpoint
ALTER TABLE finance_profit_runs ADD COLUMN monetary_basis jsonb;
--> statement-breakpoint
-- The frozen ISO table is inserted below by the source generator. Never use a
-- server locale or a mutable system currency table to interpret old facts.
CREATE FUNCTION finance_minor_digits_20260917(currency_code text) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT ('{"AED":2,"AFN":2,"ALL":2,"AMD":2,"AOA":2,"ARS":2,"AUD":2,"AWG":2,"AZN":2,"BAM":2,"BBD":2,"BDT":2,"BHD":3,"BIF":0,"BMD":2,"BND":2,"BOB":2,"BOV":2,"BRL":2,"BSD":2,"BTN":2,"BWP":2,"BYN":2,"BZD":2,"CAD":2,"CDF":2,"CHE":2,"CHF":2,"CHW":2,"CLF":4,"CLP":0,"CNY":2,"COP":2,"COU":2,"CRC":2,"CUP":2,"CVE":2,"CZK":2,"DJF":0,"DKK":2,"DOP":2,"DZD":2,"EGP":2,"ERN":2,"ETB":2,"EUR":2,"FJD":2,"FKP":2,"GBP":2,"GEL":2,"GHS":2,"GIP":2,"GMD":2,"GNF":0,"GTQ":2,"GYD":2,"HKD":2,"HNL":2,"HTG":2,"HUF":2,"IDR":2,"ILS":2,"INR":2,"IQD":3,"IRR":2,"ISK":0,"JMD":2,"JOD":3,"JPY":0,"KES":2,"KGS":2,"KHR":2,"KMF":0,"KPW":2,"KRW":0,"KWD":3,"KYD":2,"KZT":2,"LAK":2,"LBP":2,"LKR":2,"LRD":2,"LSL":2,"LYD":3,"MAD":2,"MDL":2,"MGA":2,"MKD":2,"MMK":2,"MNT":2,"MOP":2,"MRU":2,"MUR":2,"MVR":2,"MWK":2,"MXN":2,"MXV":2,"MYR":2,"MZN":2,"NAD":2,"NGN":2,"NIO":2,"NOK":2,"NPR":2,"NZD":2,"OMR":3,"PAB":2,"PEN":2,"PGK":2,"PHP":2,"PKR":2,"PLN":2,"PYG":0,"QAR":2,"RON":2,"RSD":2,"RUB":2,"RWF":0,"SAR":2,"SBD":2,"SCR":2,"SDG":2,"SEK":2,"SGD":2,"SHP":2,"SLE":2,"SOS":2,"SRD":2,"SSP":2,"STN":2,"SVC":2,"SYP":2,"SZL":2,"THB":2,"TJS":2,"TMT":2,"TND":3,"TOP":2,"TRY":2,"TTD":2,"TWD":2,"TZS":2,"UAH":2,"UGX":0,"USD":2,"USN":2,"UYI":0,"UYU":2,"UYW":4,"UZS":2,"VED":2,"VES":2,"VND":0,"VUV":0,"WST":2,"XAD":2,"XAF":0,"XAG":null,"XAU":null,"XBA":null,"XBB":null,"XBC":null,"XBD":null,"XCD":2,"XCG":2,"XDR":null,"XOF":0,"XPD":null,"XPF":0,"XPT":null,"XSU":null,"XTS":null,"XUA":null,"XXX":null,"YER":2,"ZAR":2,"ZMW":2,"ZWG":2}'::jsonb ->> currency_code)::integer
$$;
--> statement-breakpoint
CREATE FUNCTION finance_round_ratio_exact(n numeric,d numeric) RETURNS numeric
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT CASE WHEN d=0 THEN NULL ELSE sign(n)*sign(d)*
 (div(abs(n),abs(d))+CASE WHEN mod(abs(n),abs(d))*2>=abs(d) THEN 1 ELSE 0 END) END
$$;
--> statement-breakpoint
CREATE FUNCTION guard_finance_monetary_basis() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE b jsonb; item jsonb; previous_code text; code text; expected_digits integer;
 selected_statement_ids uuid[]; selected_rate_ids uuid[];
BEGIN
 b:=NEW.monetary_basis;
 IF TG_TABLE_NAME='finance_fx_rates' THEN
  IF NEW.rate_numerator NOT BETWEEN 1 AND 9007199254740991 OR NEW.rate_denominator NOT BETWEEN 1 AND 9007199254740991 THEN
   RAISE EXCEPTION 'finance_money_overflow' USING ERRCODE='23514';
  END IF;
  IF b IS NULL THEN RETURN NEW; END IF;
  IF jsonb_typeof(b) IS DISTINCT FROM 'object' THEN
   RAISE EXCEPTION 'finance_fx_monetary_basis_invalid' USING ERRCODE='23514';
  END IF;
  IF b->'schemaVersion' IS DISTINCT FROM '1'::jsonb
   OR b->>'rateUnit' IS DISTINCT FROM 'major_to_major' OR b->>'currencyTableVersion' IS DISTINCT FROM 'iso4217-2026-09-17-v1'
   OR (SELECT count(*) FROM jsonb_object_keys(b))<>5
   OR finance_minor_digits_20260917(NEW.base_currency) IS NULL
   OR finance_minor_digits_20260917(NEW.quote_currency) IS NULL
   OR b->'baseMinorDigits' IS DISTINCT FROM to_jsonb(finance_minor_digits_20260917(NEW.base_currency))
   OR b->'quoteMinorDigits' IS DISTINCT FROM to_jsonb(finance_minor_digits_20260917(NEW.quote_currency)) THEN
    RAISE EXCEPTION 'finance_fx_monetary_basis_invalid' USING ERRCODE='23514';
  END IF;
 ELSE
  IF jsonb_typeof(NEW.statement_ids) IS DISTINCT FROM 'array' OR jsonb_typeof(NEW.fx_rate_ids) IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION 'finance_selected_evidence_invalid' USING ERRCODE='23514';
  END IF;
  IF jsonb_array_length(NEW.statement_ids) NOT BETWEEN 1 AND 500 OR jsonb_array_length(NEW.fx_rate_ids)>500 THEN
   RAISE EXCEPTION 'finance_selected_evidence_invalid' USING ERRCODE='23514';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(NEW.statement_ids) UNION ALL SELECT value FROM jsonb_array_elements(NEW.fx_rate_ids) LOOP
   IF jsonb_typeof(item) IS DISTINCT FROM 'string' OR (item #>> '{}')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'finance_selected_evidence_invalid' USING ERRCODE='23514';
   END IF;
  END LOOP;
  selected_statement_ids:=ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(NEW.statement_ids));
  selected_rate_ids:=ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(NEW.fx_rate_ids));
  IF (SELECT count(DISTINCT id) FROM unnest(selected_statement_ids) ids(id))<>cardinality(selected_statement_ids)
   OR (SELECT count(DISTINCT id) FROM unnest(selected_rate_ids) ids(id))<>cardinality(selected_rate_ids) THEN
   RAISE EXCEPTION 'finance_selected_evidence_invalid' USING ERRCODE='23514';
  END IF;
  -- Validate existence before the sealed-source check too: a future ID must
  -- not evade that check by creating its statement after the run insertion.
  IF (SELECT count(*) FROM finance_statements s WHERE s.tenant_id=NEW.tenant_id AND s.id=ANY(selected_statement_ids))<>cardinality(selected_statement_ids)
   OR (SELECT count(*) FROM finance_fx_rates f WHERE f.tenant_id=NEW.tenant_id AND f.id=ANY(selected_rate_ids))<>cardinality(selected_rate_ids) THEN
   RAISE EXCEPTION 'finance_selected_evidence_missing' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM finance_statements s WHERE s.tenant_id=NEW.tenant_id AND s.id=ANY(selected_statement_ids)
    AND s.xmin::text::bigint=mod(txid_current(),4294967296)) THEN
   RAISE EXCEPTION 'finance_profit_requires_sealed_statements' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM finance_fx_rates f WHERE f.tenant_id=NEW.tenant_id AND f.id=ANY(selected_rate_ids)
    AND (f.rate_numerator NOT BETWEEN 1 AND 9007199254740991 OR f.rate_denominator NOT BETWEEN 1 AND 9007199254740991)) THEN
   RAISE EXCEPTION 'finance_money_overflow' USING ERRCODE='23514';
  END IF;
  IF jsonb_typeof(b) IS DISTINCT FROM 'object' THEN
   RAISE EXCEPTION 'finance_calculation_basis_required' USING ERRCODE='23514';
  END IF;
  IF b->'schemaVersion' IS DISTINCT FROM '2'::jsonb
   OR b->>'algorithm' IS DISTINCT FROM 'iso_minor_fx_v2'
   OR b->>'rounding' IS DISTINCT FROM 'half_away_from_zero_per_fact'
   OR b->>'currencyTableVersion' IS DISTINCT FROM 'iso4217-2026-09-17-v1'
   OR (SELECT count(*) FROM jsonb_object_keys(b))<>5
   OR jsonb_typeof(b->'currencies') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'finance_calculation_basis_required' USING ERRCODE='23514';
  END IF;
  IF jsonb_array_length(b->'currencies') NOT BETWEEN 1 AND 501 THEN
   RAISE EXCEPTION 'finance_calculation_basis_invalid' USING ERRCODE='23514';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(b->'currencies') LOOP
   IF jsonb_typeof(item) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'finance_calculation_precision_invalid' USING ERRCODE='23514';
   END IF;
   code:=item->>'currency'; expected_digits:=finance_minor_digits_20260917(code);
   IF (SELECT count(*) FROM jsonb_object_keys(item))<>2
    OR code IS NULL OR code!~'^[A-Z]{3}$' OR (previous_code IS NOT NULL AND code COLLATE "C"<=previous_code COLLATE "C")
    OR item->'minorDigits' IS DISTINCT FROM coalesce(to_jsonb(expected_digits),'null'::jsonb) THEN
    RAISE EXCEPTION 'finance_calculation_precision_invalid' USING ERRCODE='23514';
   END IF;
   previous_code:=code;
  END LOOP;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER finance_fx_monetary_basis_insert BEFORE INSERT ON finance_fx_rates
 FOR EACH ROW EXECUTE FUNCTION guard_finance_monetary_basis();
--> statement-breakpoint
CREATE TRIGGER finance_profit_monetary_basis_insert BEFORE INSERT ON finance_profit_runs
 FOR EACH ROW EXECUTE FUNCTION guard_finance_monetary_basis();
--> statement-breakpoint
-- A financial statement's facts are one immutable import. A later correction
-- is a new statement. Profit calculation consumes already committed imports.
CREATE FUNCTION guard_finance_fact_transaction() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.amount_minor NOT BETWEEN 0 AND 9007199254740991 THEN
  RAISE EXCEPTION 'finance_money_overflow' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM finance_statements s WHERE s.tenant_id=NEW.tenant_id AND s.id=NEW.statement_id
  AND s.xmin::text::bigint=mod(txid_current(),4294967296)) THEN
  RAISE EXCEPTION 'finance_statement_is_sealed' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER finance_fact_monetary_transaction BEFORE INSERT ON finance_facts
 FOR EACH ROW EXECUTE FUNCTION guard_finance_fact_transaction();
--> statement-breakpoint
-- Deferred validation sees the run and all contributions in the same tenant
-- transaction. It does not update or reinterpret any pre-0152 history.
CREATE FUNCTION require_finance_monetary_contributions() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE r finance_profit_runs; v finance_profit_metric_versions; c record; fx finance_fx_rates;
 expected_currencies jsonb; unknown_codes jsonb; ambiguous_ids uuid[]:='{}';
 expected_amount numeric; numerator numeric; denominator numeric; source_digits integer; target_digits integer;
 expected_bucket text; expected_sign integer; expected_count integer; actual_count integer;
 selected_statement_ids uuid[]; selected_rate_ids uuid[];
 revenue numeric:=0; cost numeric:=0; profit numeric; margin numeric; has_unknown boolean:=false; has_unclassified boolean:=false;
BEGIN
 IF TG_TABLE_NAME='finance_profit_runs' THEN r:=NEW;
 ELSE SELECT * INTO r FROM finance_profit_runs WHERE tenant_id=NEW.tenant_id AND id=NEW.run_id; END IF;
 IF r.id IS NULL OR r.monetary_basis IS NULL THEN
  RAISE EXCEPTION 'finance_legacy_run_is_sealed' USING ERRCODE='23514';
 END IF;
 selected_statement_ids:=ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(r.statement_ids));
 selected_rate_ids:=ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(r.fx_rate_ids));
 SELECT * INTO v FROM finance_profit_metric_versions WHERE tenant_id=r.tenant_id AND id=r.metric_version_id;
 IF v.id IS NULL OR v.metric_id<>r.metric_id OR v.reporting_currency<>r.reporting_currency THEN
  RAISE EXCEPTION 'finance_metric_basis_mismatch' USING ERRCODE='23514';
 END IF;
 IF (SELECT count(*) FROM finance_statements WHERE tenant_id=r.tenant_id AND id=ANY(selected_statement_ids))<>cardinality(selected_statement_ids)
  OR (SELECT count(*) FROM finance_fx_rates WHERE tenant_id=r.tenant_id AND id=ANY(selected_rate_ids))<>cardinality(selected_rate_ids) THEN
  RAISE EXCEPTION 'finance_selected_evidence_missing' USING ERRCODE='23514';
 END IF;
 SELECT jsonb_agg(jsonb_build_object('currency',code,'minorDigits',finance_minor_digits_20260917(code)) ORDER BY code COLLATE "C"),
  coalesce(jsonb_agg(code ORDER BY code COLLATE "C") FILTER(WHERE finance_minor_digits_20260917(code) IS NULL),'[]'::jsonb)
 INTO expected_currencies,unknown_codes FROM (
  SELECT r.reporting_currency AS code UNION
  SELECT currency FROM finance_facts WHERE tenant_id=r.tenant_id AND statement_id=ANY(selected_statement_ids)
 ) codes;
 IF r.monetary_basis->'currencies' IS DISTINCT FROM expected_currencies THEN
  RAISE EXCEPTION 'finance_calculation_currency_set_mismatch' USING ERRCODE='23514';
 END IF;
 SELECT count(*) INTO expected_count FROM finance_facts WHERE tenant_id=r.tenant_id AND statement_id=ANY(selected_statement_ids);
 SELECT count(*) INTO actual_count FROM finance_profit_contributions WHERE tenant_id=r.tenant_id AND run_id=r.id;
 IF expected_count=0 OR actual_count<>expected_count THEN
  RAISE EXCEPTION 'finance_contributions_incomplete' USING ERRCODE='23514';
 END IF;
 target_digits:=finance_minor_digits_20260917(r.reporting_currency);
 FOR c IN SELECT p.*,f.amount_minor,f.currency,f.direction,f.correction_kind,f.fact_type,f.occurred_at,f.statement_id
  FROM finance_profit_contributions p JOIN finance_facts f ON f.tenant_id=p.tenant_id AND f.id=p.fact_id
  WHERE p.tenant_id=r.tenant_id AND p.run_id=r.id LOOP
  expected_bucket:=CASE WHEN v.revenue_fact_types ? c.fact_type THEN 'revenue'
   WHEN v.cost_fact_types ? c.fact_type THEN 'cost' ELSE 'unclassified' END;
  IF expected_bucket='unclassified' THEN has_unclassified:=true; END IF;
  expected_sign:=CASE WHEN (expected_bucket='revenue' AND c.direction='credit') OR
   (expected_bucket<>'revenue' AND c.direction='debit') THEN 1 ELSE -1 END;
  IF c.correction_kind='reversal' THEN expected_sign:=-expected_sign; END IF;
  IF NOT (c.statement_id=ANY(selected_statement_ids)) OR c.source_amount_minor<>c.amount_minor
   OR c.source_currency<>c.currency OR c.reporting_currency<>r.reporting_currency
   OR c.bucket<>expected_bucket OR c.effect_sign<>expected_sign THEN
   RAISE EXCEPTION 'finance_contribution_source_mismatch' USING ERRCODE='23514';
  END IF;
  fx:=NULL;
  IF c.currency<>r.reporting_currency THEN
   SELECT * INTO fx FROM finance_fx_rates WHERE tenant_id=r.tenant_id AND id=ANY(selected_rate_ids)
    AND base_currency=c.currency AND quote_currency=r.reporting_currency AND effective_at<=c.occurred_at
    ORDER BY effective_at DESC,retrieved_at DESC,id ASC LIMIT 1;
  END IF;
  IF c.fx_rate_id IS DISTINCT FROM fx.id THEN
   RAISE EXCEPTION 'finance_contribution_fx_mismatch' USING ERRCODE='23514';
  END IF;
  -- Pre-0152 evidence is retained untouched. It cannot enter a new calculation
  -- through values the shared JavaScript monetary contract cannot represent.
  IF c.amount_minor NOT BETWEEN 0 AND 9007199254740991
   OR fx.id IS NOT NULL AND (fx.rate_numerator NOT BETWEEN 1 AND 9007199254740991 OR fx.rate_denominator NOT BETWEEN 1 AND 9007199254740991) THEN
   RAISE EXCEPTION 'finance_money_overflow' USING ERRCODE='23514';
  END IF;
  expected_amount:=NULL; source_digits:=finance_minor_digits_20260917(c.currency);
  IF source_digits IS NULL OR target_digits IS NULL THEN has_unknown:=true;
  ELSIF c.currency=r.reporting_currency THEN expected_amount:=c.amount_minor;
  ELSIF fx.id IS NOT NULL THEN
   IF fx.monetary_basis IS NULL AND source_digits<>target_digits THEN
    ambiguous_ids:=array_append(ambiguous_ids,fx.id); has_unknown:=true;
   ELSE
    numerator:=c.amount_minor::numeric*fx.rate_numerator::numeric*power(10::numeric,target_digits);
    denominator:=fx.rate_denominator::numeric*power(10::numeric,source_digits);
    expected_amount:=finance_round_ratio_exact(numerator,denominator);
   END IF;
  ELSE has_unknown:=true;
  END IF;
  IF expected_amount>9007199254740991 OR c.reporting_amount_minor::numeric IS DISTINCT FROM expected_amount THEN
   RAISE EXCEPTION 'finance_contribution_amount_mismatch' USING ERRCODE='23514';
  END IF;
  IF expected_bucket='revenue' THEN revenue:=revenue+coalesce(expected_amount,0)*expected_sign;
  ELSIF expected_bucket='cost' THEN cost:=cost+coalesce(expected_amount,0)*expected_sign; END IF;
 END LOOP;
 IF r.diagnostics->'monetary'->'unknownCurrencies' IS DISTINCT FROM unknown_codes
  OR r.diagnostics->'monetary'->'ambiguousFxRateIds' IS DISTINCT FROM
   (SELECT coalesce(jsonb_agg(id ORDER BY id),'[]'::jsonb) FROM (SELECT DISTINCT unnest(ambiguous_ids) id) ids) THEN
  RAISE EXCEPTION 'finance_monetary_diagnostics_mismatch' USING ERRCODE='23514';
 END IF;
 IF r.status='complete' THEN
  profit:=revenue-cost; margin:=finance_round_ratio_exact(profit*10000,revenue);
  IF has_unknown OR jsonb_array_length(unknown_codes)>0 OR has_unclassified
   OR abs(revenue)>9007199254740991 OR abs(cost)>9007199254740991 OR abs(profit)>9007199254740991
   OR (margin IS NOT NULL AND (margin < -2147483648 OR margin > 2147483647))
   OR r.revenue_minor::numeric IS DISTINCT FROM revenue OR r.cost_minor::numeric IS DISTINCT FROM cost
   OR r.profit_minor::numeric IS DISTINCT FROM profit OR r.margin_bps::numeric IS DISTINCT FROM margin THEN
   RAISE EXCEPTION 'finance_profit_monetary_totals_mismatch' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER finance_profit_monetary_complete AFTER INSERT ON finance_profit_runs
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_finance_monetary_contributions();
--> statement-breakpoint
CREATE FUNCTION guard_finance_contribution_transaction() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.source_amount_minor NOT BETWEEN 0 AND 9007199254740991
  OR (NEW.reporting_amount_minor IS NOT NULL AND NEW.reporting_amount_minor NOT BETWEEN 0 AND 9007199254740991) THEN
  RAISE EXCEPTION 'finance_money_overflow' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM finance_profit_runs r JOIN finance_facts f ON f.tenant_id=r.tenant_id
  AND f.id=NEW.fact_id AND f.statement_id=ANY(ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(r.statement_ids)))
  WHERE r.tenant_id=NEW.tenant_id AND r.id=NEW.run_id
  AND r.monetary_basis IS NOT NULL AND r.xmin::text::bigint=mod(txid_current(),4294967296)) THEN
  RAISE EXCEPTION 'finance_legacy_run_is_sealed' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER finance_contribution_monetary_transaction BEFORE INSERT ON finance_profit_contributions
 FOR EACH ROW EXECUTE FUNCTION guard_finance_contribution_transaction();
--> statement-breakpoint
REVOKE ALL ON FUNCTION finance_minor_digits_20260917(text),finance_round_ratio_exact(numeric,numeric),
 guard_finance_monetary_basis(),require_finance_monetary_contributions(),guard_finance_contribution_transaction(),guard_finance_fact_transaction() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finance_minor_digits_20260917(text),finance_round_ratio_exact(numeric,numeric) TO yummyai_app;
