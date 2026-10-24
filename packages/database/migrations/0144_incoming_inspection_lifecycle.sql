-- Independent immutable arrival, measurement, approval and disposition facts.
-- Old receipts are not fabricated into inspections or arrivals.
CREATE TABLE "inventory_incoming_standards" (
 "id" uuid PRIMARY KEY NOT NULL,
 "tenant_id" uuid NOT NULL,
 "created_by" uuid NOT NULL,
 "created_at" timestamp with time zone NOT NULL DEFAULT now(),
 "request_checksum" text NOT NULL,
 "idempotency_key" text NOT NULL,
 "stock_item_id" uuid NOT NULL,
 "code" text NOT NULL,
 "version_number" integer NOT NULL,
 "title" text NOT NULL,
 "source_reference" text NOT NULL,
 "criteria" jsonb NOT NULL,
 CONSTRAINT "incoming_standards_tenant_id_unique" UNIQUE("tenant_id","id"),
 CONSTRAINT "incoming_standards_version_check" CHECK("inventory_incoming_standards"."version_number">0),
 CONSTRAINT "inventory_incoming_standards_tenant_id_organizations_id_fk" FOREIGN KEY("tenant_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
 CONSTRAINT "inventory_incoming_standards_created_by_app_users_id_fk" FOREIGN KEY("created_by") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "incoming_standards_stock_fk" FOREIGN KEY("tenant_id","stock_item_id") REFERENCES "inventory_stock_items"("tenant_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION
);
--> statement-breakpoint
CREATE UNIQUE INDEX "incoming_standards_version_unique" ON "inventory_incoming_standards"("tenant_id","stock_item_id","code","version_number");
--> statement-breakpoint
CREATE UNIQUE INDEX "incoming_standards_request_unique" ON "inventory_incoming_standards"("tenant_id","idempotency_key");
--> statement-breakpoint
ALTER TABLE "inventory_incoming_standards" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_incoming_standards" FORCE ROW LEVEL SECURITY;
CREATE POLICY incoming_tenant ON "inventory_incoming_standards" USING(tenant_id=current_setting('app.tenant_id',true)::uuid) WITH CHECK(tenant_id=current_setting('app.tenant_id',true)::uuid);
GRANT SELECT,INSERT ON "inventory_incoming_standards" TO yummyai_app;
--> statement-breakpoint
CREATE TABLE "inventory_procurement_arrivals" (
 "id" uuid PRIMARY KEY NOT NULL,
 "tenant_id" uuid NOT NULL,
 "created_by" uuid NOT NULL,
 "created_at" timestamp with time zone NOT NULL DEFAULT now(),
 "request_checksum" text NOT NULL,
 "idempotency_key" text NOT NULL,
 "code" text NOT NULL,
 "purchase_order_id" uuid NOT NULL,
 "purchase_order_version_id" uuid NOT NULL,
 "arrived_at" timestamp with time zone NOT NULL,
 "external_reference" text NOT NULL,
 CONSTRAINT "procurement_arrivals_tenant_id_unique" UNIQUE("tenant_id","id"),
 CONSTRAINT "inventory_procurement_arrivals_tenant_id_organizations_id_fk" FOREIGN KEY("tenant_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
 CONSTRAINT "inventory_procurement_arrivals_created_by_app_users_id_fk" FOREIGN KEY("created_by") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "procurement_arrivals_order_fk" FOREIGN KEY("tenant_id","purchase_order_id") REFERENCES "inventory_purchase_orders"("tenant_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "procurement_arrivals_version_fk" FOREIGN KEY("tenant_id","purchase_order_version_id") REFERENCES "inventory_purchase_order_versions"("tenant_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION
);
--> statement-breakpoint
CREATE UNIQUE INDEX "procurement_arrivals_code_unique" ON "inventory_procurement_arrivals"("tenant_id","code");
--> statement-breakpoint
CREATE UNIQUE INDEX "procurement_arrivals_request_unique" ON "inventory_procurement_arrivals"("tenant_id","idempotency_key");
--> statement-breakpoint
ALTER TABLE "inventory_procurement_arrivals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_procurement_arrivals" FORCE ROW LEVEL SECURITY;
CREATE POLICY incoming_tenant ON "inventory_procurement_arrivals" USING(tenant_id=current_setting('app.tenant_id',true)::uuid) WITH CHECK(tenant_id=current_setting('app.tenant_id',true)::uuid);
GRANT SELECT,INSERT ON "inventory_procurement_arrivals" TO yummyai_app;
--> statement-breakpoint
CREATE TABLE "inventory_procurement_arrival_lines" (
 "id" uuid PRIMARY KEY NOT NULL,
 "tenant_id" uuid NOT NULL,
 "created_by" uuid NOT NULL,
 "created_at" timestamp with time zone NOT NULL DEFAULT now(),
 "arrival_id" uuid NOT NULL,
 "line_key" text NOT NULL,
 "stock_item_id" uuid NOT NULL,
 "holding_location_id" uuid NOT NULL,
 "quantity" numeric NOT NULL,
 "unit" text NOT NULL,
 "supplier_lot_code" text NOT NULL,
 "expires_at" timestamp with time zone,
 CONSTRAINT "procurement_arrival_lines_tenant_id_unique" UNIQUE("tenant_id","id"),
 CONSTRAINT "procurement_arrival_lines_quantity_check" CHECK("inventory_procurement_arrival_lines"."quantity">0 and "inventory_procurement_arrival_lines"."quantity" between -2147483647 and 2147483647 and scale("inventory_procurement_arrival_lines"."quantity") <= 9
    and ("inventory_procurement_arrival_lines"."unit" not in ('each','pair','set') or trunc("inventory_procurement_arrival_lines"."quantity") = "inventory_procurement_arrival_lines"."quantity")),
 CONSTRAINT "procurement_arrival_lines_unit_check" CHECK("inventory_procurement_arrival_lines"."unit" in ('each','pair','set','meter','gram','kilogram')),
 CONSTRAINT "inventory_procurement_arrival_lines_tenant_id_organizations_id_fk" FOREIGN KEY("tenant_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
 CONSTRAINT "inventory_procurement_arrival_lines_created_by_app_users_id_fk" FOREIGN KEY("created_by") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "procurement_arrival_lines_arrival_fk" FOREIGN KEY("tenant_id","arrival_id") REFERENCES "inventory_procurement_arrivals"("tenant_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "procurement_arrival_lines_stock_fk" FOREIGN KEY("tenant_id","stock_item_id") REFERENCES "inventory_stock_items"("tenant_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "procurement_arrival_lines_location_fk" FOREIGN KEY("tenant_id","holding_location_id") REFERENCES "inventory_locations"("tenant_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION
);
--> statement-breakpoint
CREATE UNIQUE INDEX "procurement_arrival_lines_line_unique" ON "inventory_procurement_arrival_lines"("tenant_id","arrival_id","line_key");
--> statement-breakpoint
ALTER TABLE "inventory_procurement_arrival_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_procurement_arrival_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY incoming_tenant ON "inventory_procurement_arrival_lines" USING(tenant_id=current_setting('app.tenant_id',true)::uuid) WITH CHECK(tenant_id=current_setting('app.tenant_id',true)::uuid);
GRANT SELECT,INSERT ON "inventory_procurement_arrival_lines" TO yummyai_app;
--> statement-breakpoint
CREATE TABLE "inventory_incoming_inspections" (
 "id" uuid PRIMARY KEY NOT NULL,
 "tenant_id" uuid NOT NULL,
 "created_by" uuid NOT NULL,
 "created_at" timestamp with time zone NOT NULL DEFAULT now(),
 "request_checksum" text NOT NULL,
 "idempotency_key" text NOT NULL,
 "arrival_line_id" uuid NOT NULL,
 "version_number" integer NOT NULL,
 "standard_version_id" uuid NOT NULL,
 "accepted_quantity" numeric NOT NULL,
 "rejected_quantity" numeric NOT NULL,
 "sample_quantity" numeric NOT NULL,
 "unit" text NOT NULL,
 "rejection_reason" text,
 "measured_at" timestamp with time zone NOT NULL,
 "readings" jsonb NOT NULL,
 "evaluation" jsonb NOT NULL,
 "notes" text,
 CONSTRAINT "incoming_inspections_tenant_id_unique" UNIQUE("tenant_id","id"),
 CONSTRAINT "incoming_inspections_version_check" CHECK("inventory_incoming_inspections"."version_number">0),
 CONSTRAINT "incoming_inspections_quantity_check" CHECK("inventory_incoming_inspections"."accepted_quantity">=0 and "inventory_incoming_inspections"."rejected_quantity">=0 and "inventory_incoming_inspections"."accepted_quantity"+"inventory_incoming_inspections"."rejected_quantity">0 and "inventory_incoming_inspections"."sample_quantity">0 and "inventory_incoming_inspections"."sample_quantity"<="inventory_incoming_inspections"."accepted_quantity"+"inventory_incoming_inspections"."rejected_quantity"),
 CONSTRAINT "incoming_inspections_accepted_exact" CHECK("inventory_incoming_inspections"."accepted_quantity" between -2147483647 and 2147483647 and scale("inventory_incoming_inspections"."accepted_quantity") <= 9
    and ("inventory_incoming_inspections"."unit" not in ('each','pair','set') or trunc("inventory_incoming_inspections"."accepted_quantity") = "inventory_incoming_inspections"."accepted_quantity")),
 CONSTRAINT "incoming_inspections_rejected_exact" CHECK("inventory_incoming_inspections"."rejected_quantity" between -2147483647 and 2147483647 and scale("inventory_incoming_inspections"."rejected_quantity") <= 9
    and ("inventory_incoming_inspections"."unit" not in ('each','pair','set') or trunc("inventory_incoming_inspections"."rejected_quantity") = "inventory_incoming_inspections"."rejected_quantity")),
 CONSTRAINT "incoming_inspections_sample_exact" CHECK("inventory_incoming_inspections"."sample_quantity" between -2147483647 and 2147483647 and scale("inventory_incoming_inspections"."sample_quantity") <= 9
    and ("inventory_incoming_inspections"."unit" not in ('each','pair','set') or trunc("inventory_incoming_inspections"."sample_quantity") = "inventory_incoming_inspections"."sample_quantity")),
 CONSTRAINT "incoming_inspections_rejection_check" CHECK(("inventory_incoming_inspections"."rejected_quantity">0)=("inventory_incoming_inspections"."rejection_reason" is not null)),
 CONSTRAINT "inventory_incoming_inspections_tenant_id_organizations_id_fk" FOREIGN KEY("tenant_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
 CONSTRAINT "inventory_incoming_inspections_created_by_app_users_id_fk" FOREIGN KEY("created_by") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "incoming_inspections_line_fk" FOREIGN KEY("tenant_id","arrival_line_id") REFERENCES "inventory_procurement_arrival_lines"("tenant_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "incoming_inspections_standard_fk" FOREIGN KEY("tenant_id","standard_version_id") REFERENCES "inventory_incoming_standards"("tenant_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION
);
--> statement-breakpoint
CREATE UNIQUE INDEX "incoming_inspections_version_unique" ON "inventory_incoming_inspections"("tenant_id","arrival_line_id","version_number");
--> statement-breakpoint
CREATE UNIQUE INDEX "incoming_inspections_request_unique" ON "inventory_incoming_inspections"("tenant_id","idempotency_key");
--> statement-breakpoint
ALTER TABLE "inventory_incoming_inspections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_incoming_inspections" FORCE ROW LEVEL SECURITY;
CREATE POLICY incoming_tenant ON "inventory_incoming_inspections" USING(tenant_id=current_setting('app.tenant_id',true)::uuid) WITH CHECK(tenant_id=current_setting('app.tenant_id',true)::uuid);
GRANT SELECT,INSERT ON "inventory_incoming_inspections" TO yummyai_app;
--> statement-breakpoint
CREATE TABLE "inventory_incoming_inspection_reviews" (
 "id" uuid PRIMARY KEY NOT NULL,
 "tenant_id" uuid NOT NULL,
 "created_by" uuid NOT NULL,
 "created_at" timestamp with time zone NOT NULL DEFAULT now(),
 "request_checksum" text NOT NULL,
 "idempotency_key" text NOT NULL,
 "inspection_id" uuid NOT NULL,
 "decision" text NOT NULL,
 "reason" text NOT NULL,
 CONSTRAINT "incoming_reviews_tenant_id_unique" UNIQUE("tenant_id","id"),
 CONSTRAINT "incoming_reviews_decision_check" CHECK("inventory_incoming_inspection_reviews"."decision" in ('approved','rejected')),
 CONSTRAINT "inventory_incoming_inspection_reviews_tenant_id_organizations_id_fk" FOREIGN KEY("tenant_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
 CONSTRAINT "inventory_incoming_inspection_reviews_created_by_app_users_id_fk" FOREIGN KEY("created_by") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "incoming_reviews_inspection_fk" FOREIGN KEY("tenant_id","inspection_id") REFERENCES "inventory_incoming_inspections"("tenant_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION
);
--> statement-breakpoint
CREATE UNIQUE INDEX "incoming_reviews_inspection_unique" ON "inventory_incoming_inspection_reviews"("tenant_id","inspection_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "incoming_reviews_request_unique" ON "inventory_incoming_inspection_reviews"("tenant_id","idempotency_key");
--> statement-breakpoint
ALTER TABLE "inventory_incoming_inspection_reviews" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_incoming_inspection_reviews" FORCE ROW LEVEL SECURITY;
CREATE POLICY incoming_tenant ON "inventory_incoming_inspection_reviews" USING(tenant_id=current_setting('app.tenant_id',true)::uuid) WITH CHECK(tenant_id=current_setting('app.tenant_id',true)::uuid);
GRANT SELECT,INSERT ON "inventory_incoming_inspection_reviews" TO yummyai_app;
--> statement-breakpoint
CREATE TABLE "inventory_incoming_postings" (
 "id" uuid PRIMARY KEY NOT NULL,
 "tenant_id" uuid NOT NULL,
 "created_by" uuid NOT NULL,
 "created_at" timestamp with time zone NOT NULL DEFAULT now(),
 "request_checksum" text NOT NULL,
 "idempotency_key" text NOT NULL,
 "arrival_line_id" uuid NOT NULL,
 "approval_id" uuid NOT NULL,
 "receipt_id" uuid NOT NULL,
 "accepted_quantity" numeric NOT NULL,
 "rejected_quantity" numeric NOT NULL,
 "unit" text NOT NULL,
 "rejection_location_id" uuid,
 "merchant_ownership_confirmed" boolean NOT NULL,
 "posted_at" timestamp with time zone NOT NULL,
 CONSTRAINT "incoming_postings_tenant_id_unique" UNIQUE("tenant_id","id"),
 CONSTRAINT "incoming_postings_quantity_check" CHECK("inventory_incoming_postings"."accepted_quantity">=0 and "inventory_incoming_postings"."rejected_quantity">=0 and "inventory_incoming_postings"."accepted_quantity"+"inventory_incoming_postings"."rejected_quantity">0),
 CONSTRAINT "incoming_postings_accepted_exact" CHECK("inventory_incoming_postings"."accepted_quantity" between -2147483647 and 2147483647 and scale("inventory_incoming_postings"."accepted_quantity") <= 9
    and ("inventory_incoming_postings"."unit" not in ('each','pair','set') or trunc("inventory_incoming_postings"."accepted_quantity") = "inventory_incoming_postings"."accepted_quantity")),
 CONSTRAINT "incoming_postings_rejected_exact" CHECK("inventory_incoming_postings"."rejected_quantity" between -2147483647 and 2147483647 and scale("inventory_incoming_postings"."rejected_quantity") <= 9
    and ("inventory_incoming_postings"."unit" not in ('each','pair','set') or trunc("inventory_incoming_postings"."rejected_quantity") = "inventory_incoming_postings"."rejected_quantity")),
 CONSTRAINT "incoming_postings_rejection_check" CHECK(("inventory_incoming_postings"."rejected_quantity">0)=("inventory_incoming_postings"."rejection_location_id" is not null)),
 CONSTRAINT "incoming_postings_ownership_check" CHECK(("inventory_incoming_postings"."accepted_quantity">0)="inventory_incoming_postings"."merchant_ownership_confirmed"),
 CONSTRAINT "inventory_incoming_postings_tenant_id_organizations_id_fk" FOREIGN KEY("tenant_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
 CONSTRAINT "inventory_incoming_postings_created_by_app_users_id_fk" FOREIGN KEY("created_by") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "incoming_postings_line_fk" FOREIGN KEY("tenant_id","arrival_line_id") REFERENCES "inventory_procurement_arrival_lines"("tenant_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "incoming_postings_approval_fk" FOREIGN KEY("tenant_id","approval_id") REFERENCES "inventory_incoming_inspection_reviews"("tenant_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "incoming_postings_receipt_fk" FOREIGN KEY("tenant_id","receipt_id") REFERENCES "inventory_procurement_receipts"("tenant_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "incoming_postings_location_fk" FOREIGN KEY("tenant_id","rejection_location_id") REFERENCES "inventory_locations"("tenant_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION
);
--> statement-breakpoint
CREATE UNIQUE INDEX "incoming_postings_request_unique" ON "inventory_incoming_postings"("tenant_id","idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "incoming_postings_receipt_unique" ON "inventory_incoming_postings"("tenant_id","receipt_id");
--> statement-breakpoint
ALTER TABLE "inventory_incoming_postings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_incoming_postings" FORCE ROW LEVEL SECURITY;
CREATE POLICY incoming_tenant ON "inventory_incoming_postings" USING(tenant_id=current_setting('app.tenant_id',true)::uuid) WITH CHECK(tenant_id=current_setting('app.tenant_id',true)::uuid);
GRANT SELECT,INSERT ON "inventory_incoming_postings" TO yummyai_app;
--> statement-breakpoint
CREATE TABLE "inventory_incoming_returns" (
 "id" uuid PRIMARY KEY NOT NULL,
 "tenant_id" uuid NOT NULL,
 "created_by" uuid NOT NULL,
 "created_at" timestamp with time zone NOT NULL DEFAULT now(),
 "request_checksum" text NOT NULL,
 "idempotency_key" text NOT NULL,
 "posting_id" uuid NOT NULL,
 "quantity" numeric NOT NULL,
 "unit" text NOT NULL,
 "returned_at" timestamp with time zone NOT NULL,
 "external_reference" text NOT NULL,
 "reason" text NOT NULL,
 CONSTRAINT "incoming_returns_tenant_id_unique" UNIQUE("tenant_id","id"),
 CONSTRAINT "incoming_returns_quantity_check" CHECK("inventory_incoming_returns"."quantity">0 and "inventory_incoming_returns"."quantity" between -2147483647 and 2147483647 and scale("inventory_incoming_returns"."quantity") <= 9
    and ("inventory_incoming_returns"."unit" not in ('each','pair','set') or trunc("inventory_incoming_returns"."quantity") = "inventory_incoming_returns"."quantity")),
 CONSTRAINT "inventory_incoming_returns_tenant_id_organizations_id_fk" FOREIGN KEY("tenant_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
 CONSTRAINT "inventory_incoming_returns_created_by_app_users_id_fk" FOREIGN KEY("created_by") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "incoming_returns_posting_fk" FOREIGN KEY("tenant_id","posting_id") REFERENCES "inventory_incoming_postings"("tenant_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION
);
--> statement-breakpoint
CREATE UNIQUE INDEX "incoming_returns_request_unique" ON "inventory_incoming_returns"("tenant_id","idempotency_key");
--> statement-breakpoint
ALTER TABLE "inventory_incoming_returns" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_incoming_returns" FORCE ROW LEVEL SECURITY;
CREATE POLICY incoming_tenant ON "inventory_incoming_returns" USING(tenant_id=current_setting('app.tenant_id',true)::uuid) WITH CHECK(tenant_id=current_setting('app.tenant_id',true)::uuid);
GRANT SELECT,INSERT ON "inventory_incoming_returns" TO yummyai_app;
--> statement-breakpoint
-- Only newly created purchase orders require this workflow by default. NULL on
-- an original order is explicitly legacy, not an invented historical inspection.
ALTER TABLE inventory_purchase_orders ADD COLUMN receiving_policy text;
ALTER TABLE inventory_purchase_orders ALTER COLUMN receiving_policy SET DEFAULT 'inspection_required';
ALTER TABLE inventory_purchase_orders ADD CONSTRAINT purchase_order_receiving_policy_check
 CHECK(receiving_policy IS NULL OR receiving_policy='inspection_required');
CREATE FUNCTION guard_purchase_receiving_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (TG_OP='INSERT' AND NEW.receiving_policy IS DISTINCT FROM 'inspection_required')
 OR (TG_OP='UPDATE' AND NEW.receiving_policy IS DISTINCT FROM OLD.receiving_policy) THEN
  RAISE EXCEPTION 'purchase receiving policy cannot bypass inspection' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER purchase_receiving_policy_guard BEFORE INSERT OR UPDATE ON inventory_purchase_orders
 FOR EACH ROW EXECUTE FUNCTION guard_purchase_receiving_policy();
--> statement-breakpoint
CREATE FUNCTION evaluate_incoming_readings(criteria jsonb, readings jsonb) RETURNS jsonb
 LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE c jsonb; r jsonb; result text; items jsonb:='[]'; complete boolean:=true; passed boolean:=true;
 numeric_pattern text:='^-?(0|[1-9][0-9]{0,11})(\.[0-9]{1,9})?$';
BEGIN
 IF jsonb_typeof(criteria) IS DISTINCT FROM 'array' OR jsonb_array_length(criteria) NOT BETWEEN 1 AND 40
 OR jsonb_typeof(readings) IS DISTINCT FROM 'array' OR jsonb_array_length(readings)>40 THEN
  RAISE EXCEPTION 'incoming criteria or readings invalid' USING ERRCODE='23514';
 END IF;
 IF (SELECT count(DISTINCT x->>'code') FROM jsonb_array_elements(criteria) x)<>jsonb_array_length(criteria)
 OR (SELECT count(DISTINCT x->>'criterionCode') FROM jsonb_array_elements(readings) x)<>jsonb_array_length(readings)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(readings) x WHERE NOT EXISTS(
  SELECT 1 FROM jsonb_array_elements(criteria) y WHERE y->>'code'=x->>'criterionCode')) THEN
  RAISE EXCEPTION 'incoming criterion identity invalid' USING ERRCODE='23514';
 END IF;
 FOR c IN SELECT value FROM jsonb_array_elements(criteria) LOOP
  IF coalesce(c->>'code','') !~ '^[A-Z0-9][A-Z0-9._-]{0,63}$'
  OR length(btrim(coalesce(c->>'label',''))) NOT BETWEEN 1 AND 120 THEN
   RAISE EXCEPTION 'incoming criterion definition missing' USING ERRCODE='23514';
  END IF;
  IF c->>'kind'='numeric_range' THEN
   IF length(btrim(coalesce(c->>'unit',''))) NOT BETWEEN 1 AND 32
   OR (c->>'minimum' IS NULL AND c->>'maximum' IS NULL)
   OR (c->>'minimum' IS NOT NULL AND c->>'minimum' !~ numeric_pattern)
   OR (c->>'maximum' IS NOT NULL AND c->>'maximum' !~ numeric_pattern) THEN
    RAISE EXCEPTION 'incoming numeric standard invalid' USING ERRCODE='23514';
   END IF;
   IF (c->>'minimum')::numeric > (c->>'maximum')::numeric THEN
    RAISE EXCEPTION 'incoming numeric bounds reversed' USING ERRCODE='23514';
   END IF;
  ELSIF c->>'kind'='one_of' THEN
   IF jsonb_typeof(c->'acceptedValues') IS DISTINCT FROM 'array'
   OR jsonb_array_length(c->'acceptedValues') NOT BETWEEN 1 AND 30
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(c->'acceptedValues') x
    WHERE jsonb_typeof(x) IS DISTINCT FROM 'string' OR length(btrim(x#>>'{}')) NOT BETWEEN 1 AND 120)
   OR (SELECT count(DISTINCT x) FROM jsonb_array_elements(c->'acceptedValues') x)<>jsonb_array_length(c->'acceptedValues') THEN
    RAISE EXCEPTION 'incoming choice standard invalid' USING ERRCODE='23514';
   END IF;
  ELSE RAISE EXCEPTION 'unsupported incoming criterion' USING ERRCODE='23514';
  END IF;
  SELECT value INTO r FROM jsonb_array_elements(readings) WHERE value->>'criterionCode'=c->>'code';
  result:='missing';
  IF r IS NOT NULL THEN
   IF jsonb_typeof(r->'value') IS DISTINCT FROM 'string' OR length(btrim(r->>'value')) NOT BETWEEN 1 AND 120 THEN result:='invalid';
   ELSIF c->>'kind'='one_of' THEN
    IF r->'unit' IS DISTINCT FROM 'null'::jsonb THEN result:='invalid';
    ELSIF c->'acceptedValues' @> jsonb_build_array(r->>'value') THEN result:='pass'; ELSE result:='fail'; END IF;
   ELSIF r->>'value' !~ numeric_pattern OR r->>'unit' IS DISTINCT FROM c->>'unit' THEN result:='invalid';
   ELSIF (r->>'value')::numeric < (c->>'minimum')::numeric OR (r->>'value')::numeric > (c->>'maximum')::numeric THEN result:='fail';
   ELSE result:='pass'; END IF;
  END IF;
  items:=items||jsonb_build_array(jsonb_build_object('code',c->>'code','result',result));
  complete:=complete AND result IN ('pass','fail'); passed:=passed AND result='pass';
 END LOOP;
 RETURN jsonb_build_object('items',items,'complete',complete,'passed',passed);
END $$;
REVOKE ALL ON FUNCTION evaluate_incoming_readings(jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION evaluate_incoming_readings(jsonb,jsonb) TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION lock_incoming_line(tenant uuid, line_id uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF tenant::text IS DISTINCT FROM current_setting('app.tenant_id',true) THEN
  RAISE EXCEPTION 'incoming lock requires authenticated tenant' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM inventory_purchase_orders p JOIN inventory_procurement_arrivals a ON a.tenant_id=p.tenant_id AND a.purchase_order_id=p.id
  JOIN inventory_procurement_arrival_lines l ON l.tenant_id=a.tenant_id AND l.arrival_id=a.id
  WHERE p.tenant_id=tenant AND l.id=line_id FOR UPDATE OF p;
 IF NOT FOUND THEN RAISE EXCEPTION 'incoming line missing in authenticated tenant' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('incoming-line:'||tenant::text||':'||line_id::text,0));
END $$;
REVOKE ALL ON FUNCTION lock_incoming_line(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lock_incoming_line(uuid,uuid) TO yummyai_app;
CREATE FUNCTION guard_incoming_fact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line_row inventory_procurement_arrival_lines%ROWTYPE; arrival_row inventory_procurement_arrivals%ROWTYPE;
 inspection_row inventory_incoming_inspections%ROWTYPE; standard_row inventory_incoming_standards%ROWTYPE;
 review_row inventory_incoming_inspection_reviews%ROWTYPE; posting_row inventory_incoming_postings%ROWTYPE;
 receipt_row inventory_procurement_receipts%ROWTYPE; order_line jsonb;
 expected_version integer; used_accepted numeric; used_rejected numeric; used_returned numeric; result jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'incoming facts are immutable' USING ERRCODE='23514'; END IF;
 IF substring(NEW.id::text from 15 for 1)<>'7' OR NEW.created_by::text IS DISTINCT FROM current_setting('app.user_id',true) THEN
  RAISE EXCEPTION 'incoming fact requires its actual actor' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME<>'inventory_procurement_arrival_lines' THEN
  IF NEW.request_checksum !~ '^[a-f0-9]{64}$' OR length(NEW.idempotency_key) NOT BETWEEN 8 AND 200 THEN
   RAISE EXCEPTION 'incoming original request missing' USING ERRCODE='23514';
  END IF;
 END IF;
 NEW.created_at=clock_timestamp();
 IF TG_TABLE_NAME IN ('inventory_incoming_standards','inventory_procurement_arrivals') THEN
  IF NEW.code !~ '^[A-Z0-9][A-Z0-9._-]{0,63}$' THEN
   RAISE EXCEPTION 'incoming business code invalid' USING ERRCODE='23514'; END IF;
 END IF;
 IF TG_TABLE_NAME='inventory_incoming_standards' THEN
  PERFORM 1 FROM inventory_stock_items WHERE tenant_id=NEW.tenant_id AND id=NEW.stock_item_id FOR UPDATE;
  SELECT coalesce(max(version_number),0)+1 INTO expected_version FROM inventory_incoming_standards
   WHERE tenant_id=NEW.tenant_id AND stock_item_id=NEW.stock_item_id AND code=NEW.code;
  IF NEW.version_number<>expected_version OR length(btrim(NEW.title)) NOT BETWEEN 1 AND 160
  OR length(btrim(NEW.source_reference)) NOT BETWEEN 1 AND 2000 THEN
   RAISE EXCEPTION 'incoming standard revision or source invalid' USING ERRCODE='23514'; END IF;
  PERFORM evaluate_incoming_readings(NEW.criteria,'[]'::jsonb);
 ELSIF TG_TABLE_NAME='inventory_procurement_arrivals' THEN
  PERFORM 1 FROM inventory_purchase_orders WHERE tenant_id=NEW.tenant_id AND id=NEW.purchase_order_id FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM inventory_purchase_orders p JOIN inventory_purchase_order_versions v ON v.tenant_id=p.tenant_id AND v.purchase_order_id=p.id
   WHERE p.tenant_id=NEW.tenant_id AND p.id=NEW.purchase_order_id AND v.id=NEW.purchase_order_version_id
   AND p.current_version=v.version_number AND p.archived_at IS NULL AND p.status IN ('approved','partially_received','reconciliation_required','received'))
  OR length(btrim(NEW.external_reference)) NOT BETWEEN 1 AND 2000 OR NEW.arrived_at>clock_timestamp() THEN
   RAISE EXCEPTION 'arrival requires its actual approved purchase basis' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='inventory_procurement_arrival_lines' THEN
  SELECT * INTO arrival_row FROM inventory_procurement_arrivals WHERE tenant_id=NEW.tenant_id AND id=NEW.arrival_id;
  SELECT x INTO order_line FROM inventory_purchase_order_versions v, jsonb_array_elements(v.line_snapshot) x
   WHERE v.tenant_id=NEW.tenant_id AND v.id=arrival_row.purchase_order_version_id AND x->>'lineKey'=NEW.line_key;
  IF order_line IS NULL OR order_line->>'stockItemId'<>NEW.stock_item_id::text OR order_line->>'unit'<>NEW.unit
  OR arrival_row.created_by IS DISTINCT FROM NEW.created_by OR NOT EXISTS(
   SELECT 1 FROM inventory_procurement_arrivals a WHERE a.id=NEW.arrival_id AND a.tenant_id=NEW.tenant_id
   AND a.xmin::text=mod(pg_current_xact_id()::text::numeric,4294967296)::bigint::text)
  OR length(btrim(NEW.supplier_lot_code)) NOT BETWEEN 1 AND 200 THEN
   RAISE EXCEPTION 'arrival line must retain its original stock and unit' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='inventory_incoming_inspections' THEN
  PERFORM lock_incoming_line(NEW.tenant_id,NEW.arrival_line_id);
  SELECT * INTO line_row FROM inventory_procurement_arrival_lines WHERE tenant_id=NEW.tenant_id AND id=NEW.arrival_line_id;
  PERFORM 1 FROM inventory_stock_items WHERE tenant_id=NEW.tenant_id AND id=line_row.stock_item_id FOR UPDATE;
  SELECT * INTO arrival_row FROM inventory_procurement_arrivals WHERE tenant_id=NEW.tenant_id AND id=line_row.arrival_id;
  SELECT * INTO standard_row FROM inventory_incoming_standards WHERE tenant_id=NEW.tenant_id AND id=NEW.standard_version_id;
  SELECT coalesce(max(version_number),0)+1 INTO expected_version FROM inventory_incoming_inspections WHERE tenant_id=NEW.tenant_id AND arrival_line_id=NEW.arrival_line_id;
  SELECT coalesce(sum(accepted_quantity),0),coalesce(sum(rejected_quantity),0) INTO used_accepted,used_rejected
   FROM inventory_incoming_postings WHERE tenant_id=NEW.tenant_id AND arrival_line_id=NEW.arrival_line_id;
  IF line_row.id IS NULL OR standard_row.id IS NULL OR standard_row.stock_item_id<>line_row.stock_item_id OR NEW.unit<>line_row.unit
  OR NEW.version_number<>expected_version OR NEW.accepted_quantity+NEW.rejected_quantity>line_row.quantity-used_accepted-used_rejected
  OR standard_row.version_number<>(SELECT max(version_number) FROM inventory_incoming_standards WHERE tenant_id=NEW.tenant_id AND stock_item_id=standard_row.stock_item_id AND code=standard_row.code)
  OR NEW.measured_at<arrival_row.arrived_at OR NEW.measured_at>clock_timestamp()
  OR (NEW.version_number>1 AND coalesce(length(btrim(NEW.notes)),0)=0) THEN
   RAISE EXCEPTION 'incoming inspection basis, remaining quantity or revision changed' USING ERRCODE='23514'; END IF;
  NEW.evaluation=evaluate_incoming_readings(standard_row.criteria,NEW.readings);
 ELSIF TG_TABLE_NAME='inventory_incoming_inspection_reviews' THEN
  SELECT * INTO inspection_row FROM inventory_incoming_inspections WHERE tenant_id=NEW.tenant_id AND id=NEW.inspection_id;
  PERFORM lock_incoming_line(NEW.tenant_id,inspection_row.arrival_line_id);
  IF inspection_row.id IS NULL OR inspection_row.version_number<>(SELECT max(version_number) FROM inventory_incoming_inspections WHERE tenant_id=NEW.tenant_id AND arrival_line_id=inspection_row.arrival_line_id)
  OR length(btrim(NEW.reason)) NOT BETWEEN 1 AND 2000 THEN
   RAISE EXCEPTION 'inspection review must retain the current original inspection' USING ERRCODE='23514'; END IF;
  IF NEW.decision='approved' AND ((inspection_row.evaluation->>'complete')::boolean IS DISTINCT FROM true
   OR (inspection_row.accepted_quantity>0 AND (inspection_row.evaluation->>'passed')::boolean IS DISTINCT FROM true)) THEN
   RAISE EXCEPTION 'missing or failing measurements cannot approve accepted stock' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='inventory_incoming_postings' THEN
  PERFORM lock_incoming_line(NEW.tenant_id,NEW.arrival_line_id);
  SELECT * INTO line_row FROM inventory_procurement_arrival_lines WHERE tenant_id=NEW.tenant_id AND id=NEW.arrival_line_id;
  SELECT * INTO arrival_row FROM inventory_procurement_arrivals WHERE tenant_id=NEW.tenant_id AND id=line_row.arrival_id;
  SELECT * INTO review_row FROM inventory_incoming_inspection_reviews WHERE tenant_id=NEW.tenant_id AND id=NEW.approval_id;
  SELECT * INTO inspection_row FROM inventory_incoming_inspections WHERE tenant_id=NEW.tenant_id AND id=review_row.inspection_id;
  SELECT * INTO receipt_row FROM inventory_procurement_receipts WHERE tenant_id=NEW.tenant_id AND id=NEW.receipt_id;
  IF line_row.id IS NULL OR review_row.decision IS DISTINCT FROM 'approved' OR inspection_row.arrival_line_id<>NEW.arrival_line_id
  OR NEW.unit<>line_row.unit OR inspection_row.version_number<>(SELECT max(version_number) FROM inventory_incoming_inspections WHERE tenant_id=NEW.tenant_id AND arrival_line_id=NEW.arrival_line_id)
  OR receipt_row.purchase_order_id IS DISTINCT FROM arrival_row.purchase_order_id OR receipt_row.purchase_order_version_id IS DISTINCT FROM arrival_row.purchase_order_version_id
  OR receipt_row.created_by IS DISTINCT FROM NEW.created_by OR receipt_row.idempotency_key IS DISTINCT FROM NEW.idempotency_key
  OR NOT EXISTS(SELECT 1 FROM inventory_purchase_orders p JOIN inventory_purchase_order_versions v ON v.purchase_order_id=p.id AND v.tenant_id=p.tenant_id
   WHERE p.tenant_id=NEW.tenant_id AND p.id=arrival_row.purchase_order_id AND v.id=arrival_row.purchase_order_version_id AND v.version_number=p.current_version)
  OR NOT EXISTS(SELECT 1 FROM inventory_procurement_receipts r WHERE r.id=NEW.receipt_id AND r.tenant_id=NEW.tenant_id
   AND r.xmin::text=mod(pg_current_xact_id()::text::numeric,4294967296)::bigint::text)
  OR (SELECT count(*) FROM inventory_procurement_receipt_lines WHERE tenant_id=NEW.tenant_id AND receipt_id=NEW.receipt_id)<>1
  OR NOT EXISTS(SELECT 1 FROM inventory_procurement_receipt_lines l WHERE l.tenant_id=NEW.tenant_id AND l.receipt_id=NEW.receipt_id
   AND l.line_key=line_row.line_key AND l.stock_item_id=line_row.stock_item_id AND l.unit=NEW.unit
   AND l.received_quantity=NEW.accepted_quantity AND l.rejected_quantity=NEW.rejected_quantity
   AND l.destination_location_id=(SELECT (x->>'destinationLocationId')::uuid FROM inventory_purchase_order_versions v,
     jsonb_array_elements(v.line_snapshot) x WHERE v.tenant_id=NEW.tenant_id AND v.id=arrival_row.purchase_order_version_id AND x->>'lineKey'=line_row.line_key)
   AND ((NEW.accepted_quantity=0 AND l.lot_id IS NULL AND l.movement_id IS NULL) OR (NEW.accepted_quantity>0 AND EXISTS(
    SELECT 1 FROM inventory_movements m JOIN inventory_lots b ON b.tenant_id=m.tenant_id AND b.id=m.lot_id
    WHERE m.tenant_id=NEW.tenant_id AND m.id=l.movement_id AND m.lot_id=l.lot_id AND m.stock_item_id=l.stock_item_id
    AND m.location_id=l.destination_location_id AND m.unit=NEW.unit AND m.quantity_delta=NEW.accepted_quantity
    AND m.type='receipt' AND m.bucket='physical' AND m.source_type='receipt' AND m.source_id=NEW.receipt_id::text
    AND b.stock_item_id=line_row.stock_item_id AND b.source_type='receipt' AND b.source_id=NEW.receipt_id::text))))
  OR NEW.posted_at<inspection_row.measured_at OR NEW.posted_at>clock_timestamp()
  OR (NEW.accepted_quantity>0 AND line_row.expires_at IS NOT NULL AND line_row.expires_at<=NEW.posted_at) THEN
   RAISE EXCEPTION 'incoming posting requires its actual approval and same-transaction receipt' USING ERRCODE='23514'; END IF;
  SELECT coalesce(sum(accepted_quantity),0),coalesce(sum(rejected_quantity),0) INTO used_accepted,used_rejected
   FROM inventory_incoming_postings WHERE tenant_id=NEW.tenant_id AND approval_id=NEW.approval_id;
  IF NEW.accepted_quantity+used_accepted>inspection_row.accepted_quantity OR NEW.rejected_quantity+used_rejected>inspection_row.rejected_quantity THEN
   RAISE EXCEPTION 'incoming disposition exceeds its approved remainder' USING ERRCODE='23514'; END IF;
  SELECT coalesce(sum(accepted_quantity+rejected_quantity),0) INTO used_accepted FROM inventory_incoming_postings WHERE tenant_id=NEW.tenant_id AND arrival_line_id=NEW.arrival_line_id;
  IF used_accepted+NEW.accepted_quantity+NEW.rejected_quantity>line_row.quantity THEN
   RAISE EXCEPTION 'incoming disposition exceeds actual arrival' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='inventory_incoming_returns' THEN
  SELECT * INTO posting_row FROM inventory_incoming_postings WHERE tenant_id=NEW.tenant_id AND id=NEW.posting_id;
  PERFORM lock_incoming_line(NEW.tenant_id,posting_row.arrival_line_id);
  SELECT coalesce(sum(quantity),0) INTO used_returned FROM inventory_incoming_returns WHERE tenant_id=NEW.tenant_id AND posting_id=NEW.posting_id;
  IF posting_row.id IS NULL OR NEW.unit<>posting_row.unit OR used_returned+NEW.quantity>posting_row.rejected_quantity
  OR NEW.returned_at<posting_row.posted_at OR NEW.returned_at>clock_timestamp()
  OR length(btrim(NEW.external_reference)) NOT BETWEEN 1 AND 2000 OR length(btrim(NEW.reason)) NOT BETWEEN 1 AND 2000 THEN
   RAISE EXCEPTION 'return exceeds rejected custody or lacks its actual evidence' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_incoming_fact() FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_purchase_receiving_policy() FROM PUBLIC;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['inventory_incoming_standards','inventory_procurement_arrivals','inventory_procurement_arrival_lines',
  'inventory_incoming_inspections','inventory_incoming_inspection_reviews','inventory_incoming_postings','inventory_incoming_returns'] LOOP
  EXECUTE format('CREATE TRIGGER incoming_fact_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION guard_incoming_fact()',t);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION lock_incoming_receipt_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM inventory_purchase_orders WHERE tenant_id=NEW.tenant_id AND id=NEW.purchase_order_id FOR UPDATE;
 RETURN NEW;
END $$;
CREATE TRIGGER incoming_receipt_order_lock BEFORE INSERT ON inventory_procurement_receipts
 FOR EACH ROW EXECUTE FUNCTION lock_incoming_receipt_order();
CREATE FUNCTION require_incoming_posting() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (EXISTS(SELECT 1 FROM inventory_purchase_orders WHERE tenant_id=NEW.tenant_id AND id=NEW.purchase_order_id AND receiving_policy='inspection_required')
 OR EXISTS(SELECT 1 FROM inventory_procurement_arrivals WHERE tenant_id=NEW.tenant_id AND purchase_order_id=NEW.purchase_order_id))
 AND NOT EXISTS(SELECT 1 FROM inventory_incoming_postings WHERE tenant_id=NEW.tenant_id AND receipt_id=NEW.id) THEN
  RAISE EXCEPTION 'this purchase requires actual incoming inspection and posting' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER incoming_receipt_posting_required AFTER INSERT ON inventory_procurement_receipts
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_incoming_posting();
REVOKE ALL ON FUNCTION lock_incoming_receipt_order() FROM PUBLIC;
REVOKE ALL ON FUNCTION require_incoming_posting() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION require_arrival_lines() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line_count integer;
BEGIN
 SELECT count(*) INTO line_count FROM inventory_procurement_arrival_lines WHERE tenant_id=NEW.tenant_id AND arrival_id=NEW.id;
 IF line_count NOT BETWEEN 1 AND 200 THEN
  RAISE EXCEPTION 'arrival and its actual lines must commit together' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER incoming_arrival_lines_required AFTER INSERT ON inventory_procurement_arrivals
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_arrival_lines();
REVOKE ALL ON FUNCTION require_arrival_lines() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION guard_receipt_original_line() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM inventory_procurement_receipts r JOIN inventory_purchase_order_versions v
  ON v.tenant_id=r.tenant_id AND v.id=r.purchase_order_version_id,
  jsonb_array_elements(v.line_snapshot) x
  WHERE r.tenant_id=NEW.tenant_id AND r.id=NEW.receipt_id
   AND r.created_by::text=current_setting('app.user_id',true)
   AND r.xmin::text=mod(pg_current_xact_id()::text::numeric,4294967296)::bigint::text
   AND x->>'lineKey'=NEW.line_key AND x->>'stockItemId'=NEW.stock_item_id::text
   AND x->>'destinationLocationId'=NEW.destination_location_id::text AND x->>'unit'=NEW.unit) THEN
  RAISE EXCEPTION 'receipt lines require their original same-transaction header and purchase basis' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER receipt_original_line_guard BEFORE INSERT ON inventory_procurement_receipt_lines
 FOR EACH ROW EXECUTE FUNCTION guard_receipt_original_line();
REVOKE ALL ON FUNCTION guard_receipt_original_line() FROM PUBLIC;
