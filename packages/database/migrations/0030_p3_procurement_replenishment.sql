CREATE TABLE "inventory_procurement_receipt_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"line_key" text NOT NULL,
	"stock_item_id" uuid NOT NULL,
	"destination_location_id" uuid NOT NULL,
	"received_quantity" integer NOT NULL,
	"rejected_quantity" integer NOT NULL,
	"rejection_reason_code" text,
	"unit" text NOT NULL,
	"unit_cost_minor" bigint NOT NULL,
	"lot_id" uuid,
	"movement_id" uuid,
	CONSTRAINT "inventory_procurement_receipt_lines_id_check" CHECK (substring("inventory_procurement_receipt_lines"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "inventory_procurement_receipt_lines_quantity_check" CHECK ("inventory_procurement_receipt_lines"."received_quantity" >= 0 and "inventory_procurement_receipt_lines"."rejected_quantity" >= 0 and ("inventory_procurement_receipt_lines"."received_quantity" + "inventory_procurement_receipt_lines"."rejected_quantity") > 0),
	CONSTRAINT "inventory_procurement_receipt_lines_rejection_check" CHECK (("inventory_procurement_receipt_lines"."rejected_quantity" = 0 and "inventory_procurement_receipt_lines"."rejection_reason_code" is null) or ("inventory_procurement_receipt_lines"."rejected_quantity" > 0 and "inventory_procurement_receipt_lines"."rejection_reason_code" is not null)),
	CONSTRAINT "inventory_procurement_receipt_lines_unit_check" CHECK ("inventory_procurement_receipt_lines"."unit" in ('each','pair','set','meter','gram','kilogram')),
	CONSTRAINT "inventory_procurement_receipt_lines_cost_check" CHECK ("inventory_procurement_receipt_lines"."unit_cost_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_procurement_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"purchase_order_version_id" uuid NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"external_reference" text,
	"has_variance" boolean DEFAULT false NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_procurement_receipts_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "inventory_procurement_receipts_id_check" CHECK (substring("inventory_procurement_receipts"."id"::text from 15 for 1) = '7')
);
--> statement-breakpoint
CREATE TABLE "inventory_procurement_requisition_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"requisition_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"reason_code" text NOT NULL,
	"line_snapshot" jsonb NOT NULL,
	"checksum" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_procurement_req_versions_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "inventory_procurement_req_versions_id_check" CHECK (substring("inventory_procurement_requisition_versions"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "inventory_procurement_req_versions_version_check" CHECK ("inventory_procurement_requisition_versions"."version_number" > 0),
	CONSTRAINT "inventory_procurement_req_versions_checksum_check" CHECK ("inventory_procurement_requisition_versions"."checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "inventory_procurement_requisitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_procurement_requisitions_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "inventory_procurement_requisitions_id_check" CHECK (substring("inventory_procurement_requisitions"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "inventory_procurement_requisitions_status_check" CHECK ("inventory_procurement_requisitions"."status" in ('draft','rfq_open','ordered','cancelled')),
	CONSTRAINT "inventory_procurement_requisitions_version_check" CHECK ("inventory_procurement_requisitions"."current_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_procurement_rfqs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"requisition_id" uuid NOT NULL,
	"requisition_version_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"supplier_ids" jsonb NOT NULL,
	"response_due_at" timestamp with time zone NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_procurement_rfqs_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "inventory_procurement_rfqs_id_check" CHECK (substring("inventory_procurement_rfqs"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "inventory_procurement_rfqs_status_check" CHECK ("inventory_procurement_rfqs"."status" in ('open','closed','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "inventory_purchase_order_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"action" text NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"reason_code" text,
	"idempotency_key" text NOT NULL,
	"actor_user_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_purchase_order_events_id_check" CHECK (substring("inventory_purchase_order_events"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "inventory_purchase_order_events_sequence_check" CHECK ("inventory_purchase_order_events"."sequence" > 0),
	CONSTRAINT "inventory_purchase_order_events_action_check" CHECK ("inventory_purchase_order_events"."action" in ('created','revised','approved','rejected','partially_received','received','reconciliation_required','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "inventory_purchase_order_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"currency" text NOT NULL,
	"expected_at" timestamp with time zone NOT NULL,
	"line_snapshot" jsonb NOT NULL,
	"total_minor" bigint NOT NULL,
	"checksum" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_purchase_order_versions_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "inventory_purchase_order_versions_id_check" CHECK (substring("inventory_purchase_order_versions"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "inventory_purchase_order_versions_version_check" CHECK ("inventory_purchase_order_versions"."version_number" > 0),
	CONSTRAINT "inventory_purchase_order_versions_currency_check" CHECK ("inventory_purchase_order_versions"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "inventory_purchase_order_versions_total_check" CHECK ("inventory_purchase_order_versions"."total_minor" >= 0),
	CONSTRAINT "inventory_purchase_order_versions_checksum_check" CHECK ("inventory_purchase_order_versions"."checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "inventory_purchase_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"supplier_id" uuid NOT NULL,
	"requisition_id" uuid,
	"quote_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"expected_at" timestamp with time zone NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_purchase_orders_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "inventory_purchase_orders_id_check" CHECK (substring("inventory_purchase_orders"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "inventory_purchase_orders_status_check" CHECK ("inventory_purchase_orders"."status" in ('draft','approved','rejected','partially_received','received','reconciliation_required','cancelled')),
	CONSTRAINT "inventory_purchase_orders_version_check" CHECK ("inventory_purchase_orders"."current_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_replenishment_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"stock_item_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_replenishment_policies_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "inventory_replenishment_policies_id_check" CHECK (substring("inventory_replenishment_policies"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "inventory_replenishment_policies_version_check" CHECK ("inventory_replenishment_policies"."current_version" > 0),
	CONSTRAINT "inventory_replenishment_policies_status_check" CHECK ("inventory_replenishment_policies"."status" in ('active','inactive'))
);
--> statement-breakpoint
CREATE TABLE "inventory_replenishment_policy_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"reorder_point" integer NOT NULL,
	"safety_stock" integer NOT NULL,
	"minimum_order_quantity" integer NOT NULL,
	"lead_time_days" integer NOT NULL,
	"service_level_bps" integer NOT NULL,
	"review_interval_days" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_replenishment_policy_versions_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "inventory_replenishment_policy_versions_id_check" CHECK (substring("inventory_replenishment_policy_versions"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "inventory_replenishment_policy_versions_version_check" CHECK ("inventory_replenishment_policy_versions"."version_number" > 0),
	CONSTRAINT "inventory_replenishment_policy_versions_quantity_check" CHECK ("inventory_replenishment_policy_versions"."reorder_point" >= 0 and "inventory_replenishment_policy_versions"."safety_stock" >= 0 and "inventory_replenishment_policy_versions"."minimum_order_quantity" > 0),
	CONSTRAINT "inventory_replenishment_policy_versions_days_check" CHECK ("inventory_replenishment_policy_versions"."lead_time_days" >= 0 and "inventory_replenishment_policy_versions"."review_interval_days" > 0),
	CONSTRAINT "inventory_replenishment_policy_versions_service_check" CHECK ("inventory_replenishment_policy_versions"."service_level_bps" between 0 and 10000)
);
--> statement-breakpoint
CREATE TABLE "inventory_replenishment_suggestions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"policy_version_id" uuid NOT NULL,
	"stock_item_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"available_quantity" integer NOT NULL,
	"in_transit_quantity" integer NOT NULL,
	"suggested_quantity" integer NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_replenishment_suggestions_id_check" CHECK (substring("inventory_replenishment_suggestions"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "inventory_replenishment_suggestions_quantity_check" CHECK ("inventory_replenishment_suggestions"."in_transit_quantity" >= 0 and "inventory_replenishment_suggestions"."suggested_quantity" >= 0),
	CONSTRAINT "inventory_replenishment_suggestions_status_check" CHECK ("inventory_replenishment_suggestions"."status" in ('open','converted','dismissed'))
);
--> statement-breakpoint
CREATE TABLE "inventory_supplier_invoice_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"line_key" text NOT NULL,
	"invoiced_quantity" integer NOT NULL,
	"unit_cost_minor" bigint NOT NULL,
	"variance_minor" bigint NOT NULL,
	CONSTRAINT "inventory_supplier_invoice_lines_id_check" CHECK (substring("inventory_supplier_invoice_lines"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "inventory_supplier_invoice_lines_quantity_check" CHECK ("inventory_supplier_invoice_lines"."invoiced_quantity" > 0),
	CONSTRAINT "inventory_supplier_invoice_lines_cost_check" CHECK ("inventory_supplier_invoice_lines"."unit_cost_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_supplier_invoices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"invoice_number" text NOT NULL,
	"currency" text NOT NULL,
	"total_minor" bigint NOT NULL,
	"variance_minor" bigint NOT NULL,
	"status" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_supplier_invoices_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "inventory_supplier_invoices_id_check" CHECK (substring("inventory_supplier_invoices"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "inventory_supplier_invoices_currency_check" CHECK ("inventory_supplier_invoices"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "inventory_supplier_invoices_total_check" CHECK ("inventory_supplier_invoices"."total_minor" >= 0),
	CONSTRAINT "inventory_supplier_invoices_status_check" CHECK ("inventory_supplier_invoices"."status" in ('matched','reconciliation_required'))
);
--> statement-breakpoint
CREATE TABLE "inventory_supplier_quote_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"rfq_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"currency" text NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"line_snapshot" jsonb NOT NULL,
	"total_minor" bigint NOT NULL,
	"checksum" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_supplier_quote_versions_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "inventory_supplier_quote_versions_id_check" CHECK (substring("inventory_supplier_quote_versions"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "inventory_supplier_quote_versions_version_check" CHECK ("inventory_supplier_quote_versions"."version_number" > 0),
	CONSTRAINT "inventory_supplier_quote_versions_currency_check" CHECK ("inventory_supplier_quote_versions"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "inventory_supplier_quote_versions_total_check" CHECK ("inventory_supplier_quote_versions"."total_minor" >= 0),
	CONSTRAINT "inventory_supplier_quote_versions_checksum_check" CHECK ("inventory_supplier_quote_versions"."checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "inventory_procurement_receipt_lines" ADD CONSTRAINT "inventory_procurement_receipt_lines_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_procurement_receipt_lines" ADD CONSTRAINT "inventory_procurement_receipt_lines_receipt_fk" FOREIGN KEY ("tenant_id","receipt_id") REFERENCES "public"."inventory_procurement_receipts"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_procurement_receipt_lines" ADD CONSTRAINT "inventory_procurement_receipt_lines_stock_fk" FOREIGN KEY ("tenant_id","stock_item_id") REFERENCES "public"."inventory_stock_items"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_procurement_receipt_lines" ADD CONSTRAINT "inventory_procurement_receipt_lines_location_fk" FOREIGN KEY ("tenant_id","destination_location_id") REFERENCES "public"."inventory_locations"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_procurement_receipt_lines" ADD CONSTRAINT "inventory_procurement_receipt_lines_lot_fk" FOREIGN KEY ("tenant_id","lot_id") REFERENCES "public"."inventory_lots"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_procurement_receipt_lines" ADD CONSTRAINT "inventory_procurement_receipt_lines_movement_fk" FOREIGN KEY ("tenant_id","movement_id") REFERENCES "public"."inventory_movements"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_procurement_receipts" ADD CONSTRAINT "inventory_procurement_receipts_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_procurement_receipts" ADD CONSTRAINT "inventory_procurement_receipts_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_procurement_receipts" ADD CONSTRAINT "inventory_procurement_receipts_order_fk" FOREIGN KEY ("tenant_id","purchase_order_id") REFERENCES "public"."inventory_purchase_orders"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_procurement_receipts" ADD CONSTRAINT "inventory_procurement_receipts_version_fk" FOREIGN KEY ("tenant_id","purchase_order_version_id") REFERENCES "public"."inventory_purchase_order_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_procurement_requisition_versions" ADD CONSTRAINT "inventory_procurement_requisition_versions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_procurement_requisition_versions" ADD CONSTRAINT "inventory_procurement_requisition_versions_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_procurement_requisition_versions" ADD CONSTRAINT "inventory_procurement_req_versions_req_fk" FOREIGN KEY ("tenant_id","requisition_id") REFERENCES "public"."inventory_procurement_requisitions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_procurement_requisitions" ADD CONSTRAINT "inventory_procurement_requisitions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_procurement_requisitions" ADD CONSTRAINT "inventory_procurement_requisitions_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_procurement_rfqs" ADD CONSTRAINT "inventory_procurement_rfqs_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_procurement_rfqs" ADD CONSTRAINT "inventory_procurement_rfqs_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_procurement_rfqs" ADD CONSTRAINT "inventory_procurement_rfqs_req_fk" FOREIGN KEY ("tenant_id","requisition_id") REFERENCES "public"."inventory_procurement_requisitions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_procurement_rfqs" ADD CONSTRAINT "inventory_procurement_rfqs_req_version_fk" FOREIGN KEY ("tenant_id","requisition_version_id") REFERENCES "public"."inventory_procurement_requisition_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_purchase_order_events" ADD CONSTRAINT "inventory_purchase_order_events_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_purchase_order_events" ADD CONSTRAINT "inventory_purchase_order_events_actor_user_id_app_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_purchase_order_events" ADD CONSTRAINT "inventory_purchase_order_events_order_fk" FOREIGN KEY ("tenant_id","purchase_order_id") REFERENCES "public"."inventory_purchase_orders"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_purchase_order_versions" ADD CONSTRAINT "inventory_purchase_order_versions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_purchase_order_versions" ADD CONSTRAINT "inventory_purchase_order_versions_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_purchase_order_versions" ADD CONSTRAINT "inventory_purchase_order_versions_order_fk" FOREIGN KEY ("tenant_id","purchase_order_id") REFERENCES "public"."inventory_purchase_orders"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_purchase_orders" ADD CONSTRAINT "inventory_purchase_orders_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_purchase_orders" ADD CONSTRAINT "inventory_purchase_orders_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_purchase_orders" ADD CONSTRAINT "inventory_purchase_orders_supplier_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."fulfillment_suppliers"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_purchase_orders" ADD CONSTRAINT "inventory_purchase_orders_req_fk" FOREIGN KEY ("tenant_id","requisition_id") REFERENCES "public"."inventory_procurement_requisitions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_purchase_orders" ADD CONSTRAINT "inventory_purchase_orders_quote_fk" FOREIGN KEY ("tenant_id","quote_id") REFERENCES "public"."inventory_supplier_quote_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_replenishment_policies" ADD CONSTRAINT "inventory_replenishment_policies_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_replenishment_policies" ADD CONSTRAINT "inventory_replenishment_policies_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_replenishment_policies" ADD CONSTRAINT "inventory_replenishment_policies_stock_fk" FOREIGN KEY ("tenant_id","stock_item_id") REFERENCES "public"."inventory_stock_items"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_replenishment_policies" ADD CONSTRAINT "inventory_replenishment_policies_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."inventory_locations"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_replenishment_policy_versions" ADD CONSTRAINT "inventory_replenishment_policy_versions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_replenishment_policy_versions" ADD CONSTRAINT "inventory_replenishment_policy_versions_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_replenishment_policy_versions" ADD CONSTRAINT "inventory_replenishment_policy_versions_policy_fk" FOREIGN KEY ("tenant_id","policy_id") REFERENCES "public"."inventory_replenishment_policies"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_replenishment_suggestions" ADD CONSTRAINT "inventory_replenishment_suggestions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_replenishment_suggestions" ADD CONSTRAINT "inventory_replenishment_suggestions_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_replenishment_suggestions" ADD CONSTRAINT "inventory_replenishment_suggestions_policy_fk" FOREIGN KEY ("tenant_id","policy_id") REFERENCES "public"."inventory_replenishment_policies"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_replenishment_suggestions" ADD CONSTRAINT "inventory_replenishment_suggestions_version_fk" FOREIGN KEY ("tenant_id","policy_version_id") REFERENCES "public"."inventory_replenishment_policy_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_replenishment_suggestions" ADD CONSTRAINT "inventory_replenishment_suggestions_stock_fk" FOREIGN KEY ("tenant_id","stock_item_id") REFERENCES "public"."inventory_stock_items"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_replenishment_suggestions" ADD CONSTRAINT "inventory_replenishment_suggestions_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."inventory_locations"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_supplier_invoice_lines" ADD CONSTRAINT "inventory_supplier_invoice_lines_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_supplier_invoice_lines" ADD CONSTRAINT "inventory_supplier_invoice_lines_invoice_fk" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."inventory_supplier_invoices"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_supplier_invoices" ADD CONSTRAINT "inventory_supplier_invoices_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_supplier_invoices" ADD CONSTRAINT "inventory_supplier_invoices_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_supplier_invoices" ADD CONSTRAINT "inventory_supplier_invoices_order_fk" FOREIGN KEY ("tenant_id","purchase_order_id") REFERENCES "public"."inventory_purchase_orders"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_supplier_quote_versions" ADD CONSTRAINT "inventory_supplier_quote_versions_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_supplier_quote_versions" ADD CONSTRAINT "inventory_supplier_quote_versions_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_supplier_quote_versions" ADD CONSTRAINT "inventory_supplier_quote_versions_rfq_fk" FOREIGN KEY ("tenant_id","rfq_id") REFERENCES "public"."inventory_procurement_rfqs"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_supplier_quote_versions" ADD CONSTRAINT "inventory_supplier_quote_versions_supplier_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."fulfillment_suppliers"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_procurement_receipt_lines_tenant_id_unique" ON "inventory_procurement_receipt_lines" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_procurement_receipt_lines_line_unique" ON "inventory_procurement_receipt_lines" USING btree ("tenant_id","receipt_id","line_key");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_procurement_receipts_idempotency_unique" ON "inventory_procurement_receipts" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "inventory_procurement_receipts_order_idx" ON "inventory_procurement_receipts" USING btree ("tenant_id","purchase_order_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_procurement_req_versions_number_unique" ON "inventory_procurement_requisition_versions" USING btree ("tenant_id","requisition_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_procurement_requisitions_code_unique" ON "inventory_procurement_requisitions" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_procurement_requisitions_idempotency_unique" ON "inventory_procurement_requisitions" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "inventory_procurement_requisitions_status_idx" ON "inventory_procurement_requisitions" USING btree ("tenant_id","status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_procurement_rfqs_idempotency_unique" ON "inventory_procurement_rfqs" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "inventory_procurement_rfqs_status_idx" ON "inventory_procurement_rfqs" USING btree ("tenant_id","status","response_due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_purchase_order_events_tenant_id_unique" ON "inventory_purchase_order_events" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_purchase_order_events_sequence_unique" ON "inventory_purchase_order_events" USING btree ("tenant_id","purchase_order_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_purchase_order_events_idempotency_unique" ON "inventory_purchase_order_events" USING btree ("tenant_id","purchase_order_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_purchase_order_versions_number_unique" ON "inventory_purchase_order_versions" USING btree ("tenant_id","purchase_order_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_purchase_orders_code_unique" ON "inventory_purchase_orders" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_purchase_orders_idempotency_unique" ON "inventory_purchase_orders" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "inventory_purchase_orders_status_idx" ON "inventory_purchase_orders" USING btree ("tenant_id","status","expected_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_replenishment_policies_dimension_unique" ON "inventory_replenishment_policies" USING btree ("tenant_id","stock_item_id","location_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_replenishment_policy_versions_number_unique" ON "inventory_replenishment_policy_versions" USING btree ("tenant_id","policy_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_replenishment_policy_versions_idempotency_unique" ON "inventory_replenishment_policy_versions" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_replenishment_suggestions_tenant_id_unique" ON "inventory_replenishment_suggestions" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_replenishment_suggestions_idempotency_unique" ON "inventory_replenishment_suggestions" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "inventory_replenishment_suggestions_status_idx" ON "inventory_replenishment_suggestions" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_supplier_invoice_lines_tenant_id_unique" ON "inventory_supplier_invoice_lines" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_supplier_invoice_lines_line_unique" ON "inventory_supplier_invoice_lines" USING btree ("tenant_id","invoice_id","line_key");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_supplier_invoices_number_unique" ON "inventory_supplier_invoices" USING btree ("tenant_id","purchase_order_id","invoice_number");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_supplier_invoices_idempotency_unique" ON "inventory_supplier_invoices" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_supplier_quote_versions_number_unique" ON "inventory_supplier_quote_versions" USING btree ("tenant_id","rfq_id","supplier_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_supplier_quote_versions_idempotency_unique" ON "inventory_supplier_quote_versions" USING btree ("tenant_id","idempotency_key");
--> statement-breakpoint
ALTER TABLE "inventory_procurement_requisitions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_procurement_requisitions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "inventory_procurement_requisitions_tenant_policy" ON "inventory_procurement_requisitions" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE ON "inventory_procurement_requisitions" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "inventory_procurement_requisition_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_procurement_requisition_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "inventory_procurement_requisition_versions_tenant_policy" ON "inventory_procurement_requisition_versions" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "inventory_procurement_requisition_versions" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "inventory_procurement_rfqs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_procurement_rfqs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "inventory_procurement_rfqs_tenant_policy" ON "inventory_procurement_rfqs" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE ON "inventory_procurement_rfqs" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "inventory_supplier_quote_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_supplier_quote_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "inventory_supplier_quote_versions_tenant_policy" ON "inventory_supplier_quote_versions" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "inventory_supplier_quote_versions" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "inventory_purchase_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_purchase_orders" FORCE ROW LEVEL SECURITY;
CREATE POLICY "inventory_purchase_orders_tenant_policy" ON "inventory_purchase_orders" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE ON "inventory_purchase_orders" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "inventory_purchase_order_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_purchase_order_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "inventory_purchase_order_versions_tenant_policy" ON "inventory_purchase_order_versions" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "inventory_purchase_order_versions" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "inventory_purchase_order_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_purchase_order_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "inventory_purchase_order_events_tenant_policy" ON "inventory_purchase_order_events" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "inventory_purchase_order_events" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "inventory_procurement_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_procurement_receipts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "inventory_procurement_receipts_tenant_policy" ON "inventory_procurement_receipts" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "inventory_procurement_receipts" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "inventory_procurement_receipt_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_procurement_receipt_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY "inventory_procurement_receipt_lines_tenant_policy" ON "inventory_procurement_receipt_lines" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "inventory_procurement_receipt_lines" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "inventory_supplier_invoices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_supplier_invoices" FORCE ROW LEVEL SECURITY;
CREATE POLICY "inventory_supplier_invoices_tenant_policy" ON "inventory_supplier_invoices" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "inventory_supplier_invoices" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "inventory_supplier_invoice_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_supplier_invoice_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY "inventory_supplier_invoice_lines_tenant_policy" ON "inventory_supplier_invoice_lines" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "inventory_supplier_invoice_lines" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "inventory_replenishment_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_replenishment_policies" FORCE ROW LEVEL SECURITY;
CREATE POLICY "inventory_replenishment_policies_tenant_policy" ON "inventory_replenishment_policies" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE ON "inventory_replenishment_policies" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "inventory_replenishment_policy_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_replenishment_policy_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "inventory_replenishment_policy_versions_tenant_policy" ON "inventory_replenishment_policy_versions" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "inventory_replenishment_policy_versions" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "inventory_replenishment_suggestions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_replenishment_suggestions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "inventory_replenishment_suggestions_tenant_policy" ON "inventory_replenishment_suggestions" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "inventory_replenishment_suggestions" TO yummyai_app;
