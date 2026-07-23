CREATE TABLE "inventory_balances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"dimension_key" text NOT NULL,
	"stock_item_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"lot_id" uuid,
	"unit" text NOT NULL,
	"physical_quantity" integer DEFAULT 0 NOT NULL,
	"reserved_quantity" integer DEFAULT 0 NOT NULL,
	"in_transit_quantity" integer DEFAULT 0 NOT NULL,
	"provider_quantity" integer DEFAULT 0 NOT NULL,
	"virtual_quantity" integer DEFAULT 0 NOT NULL,
	"projection_version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_balances_id_uuidv7_check" CHECK (substring("inventory_balances"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "inventory_balances_unit_check" CHECK ("inventory_balances"."unit" in ('each','pair','set','meter','gram','kilogram')),
	CONSTRAINT "inventory_balances_quantities_check" CHECK ("inventory_balances"."physical_quantity" >= 0 and "inventory_balances"."reserved_quantity" >= 0 and "inventory_balances"."physical_quantity" >= "inventory_balances"."reserved_quantity" and "inventory_balances"."in_transit_quantity" >= 0 and "inventory_balances"."provider_quantity" >= 0 and "inventory_balances"."virtual_quantity" >= 0),
	CONSTRAINT "inventory_balances_version_check" CHECK ("inventory_balances"."projection_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_locations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_locations_id_uuidv7_check" CHECK (substring("inventory_locations"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "inventory_locations_status_check" CHECK ("inventory_locations"."status" in ('active','inactive'))
);
--> statement-breakpoint
CREATE TABLE "inventory_lots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"stock_item_id" uuid NOT NULL,
	"code" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"unit_cost_minor" bigint,
	"unit_cost_currency" text,
	"received_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_lots_id_uuidv7_check" CHECK (substring("inventory_lots"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "inventory_lots_source_check" CHECK ("inventory_lots"."source_type" in ('opening','order','order_line','receipt','return','transfer','adjustment','reconciliation','manual')),
	CONSTRAINT "inventory_lots_cost_check" CHECK (("inventory_lots"."unit_cost_minor" is null and "inventory_lots"."unit_cost_currency" is null) or ("inventory_lots"."unit_cost_minor" >= 0 and "inventory_lots"."unit_cost_currency" ~ '^[A-Z]{3}$')),
	CONSTRAINT "inventory_lots_expiry_check" CHECK ("inventory_lots"."expires_at" is null or "inventory_lots"."received_at" is null or "inventory_lots"."expires_at" > "inventory_lots"."received_at")
);
--> statement-breakpoint
CREATE TABLE "inventory_movements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"stock_item_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"lot_id" uuid,
	"bucket" text NOT NULL,
	"type" text NOT NULL,
	"quantity_delta" integer NOT NULL,
	"unit" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"reason_code" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"recorded_by" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_movements_id_uuidv7_check" CHECK (substring("inventory_movements"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "inventory_movements_bucket_check" CHECK ("inventory_movements"."bucket" in ('physical','in_transit','provider','virtual')),
	CONSTRAINT "inventory_movements_type_check" CHECK ("inventory_movements"."type" in ('opening','receipt','allocation','release','pick','ship','return','adjustment','transfer_outbound','transfer_inbound','damage','reconciliation')),
	CONSTRAINT "inventory_movements_quantity_check" CHECK ("inventory_movements"."quantity_delta" <> 0),
	CONSTRAINT "inventory_movements_unit_check" CHECK ("inventory_movements"."unit" in ('each','pair','set','meter','gram','kilogram')),
	CONSTRAINT "inventory_movements_source_check" CHECK ("inventory_movements"."source_type" in ('opening','order','order_line','receipt','return','transfer','adjustment','reconciliation','manual'))
);
--> statement-breakpoint
CREATE TABLE "inventory_projection_rebuilds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"balance_count" integer NOT NULL,
	"aggregate_checksum" text NOT NULL,
	"initiated_by" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_projection_rebuilds_id_uuidv7_check" CHECK (substring("inventory_projection_rebuilds"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "inventory_projection_rebuilds_count_check" CHECK ("inventory_projection_rebuilds"."balance_count" >= 0),
	CONSTRAINT "inventory_projection_rebuilds_checksum_check" CHECK ("inventory_projection_rebuilds"."aggregate_checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "inventory_reservation_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"action" text NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"reason_code" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"actor_user_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_reservation_events_id_uuidv7_check" CHECK (substring("inventory_reservation_events"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "inventory_reservation_events_sequence_check" CHECK ("inventory_reservation_events"."sequence" > 0),
	CONSTRAINT "inventory_reservation_events_action_check" CHECK ("inventory_reservation_events"."action" in ('reserved','released','fulfilled','cancelled')),
	CONSTRAINT "inventory_reservation_events_status_check" CHECK ("inventory_reservation_events"."to_status" in ('active','released','fulfilled','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "inventory_reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"stock_item_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"lot_id" uuid,
	"quantity" integer NOT NULL,
	"unit" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"idempotency_key" text NOT NULL,
	"expires_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_reservations_id_uuidv7_check" CHECK (substring("inventory_reservations"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "inventory_reservations_quantity_check" CHECK ("inventory_reservations"."quantity" > 0),
	CONSTRAINT "inventory_reservations_unit_check" CHECK ("inventory_reservations"."unit" in ('each','pair','set','meter','gram','kilogram')),
	CONSTRAINT "inventory_reservations_source_check" CHECK ("inventory_reservations"."source_type" in ('order','order_line','transfer','manual')),
	CONSTRAINT "inventory_reservations_status_check" CHECK ("inventory_reservations"."status" in ('active','released','fulfilled','cancelled')),
	CONSTRAINT "inventory_reservations_version_check" CHECK ("inventory_reservations"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_stock_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sku_id" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"base_unit" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_stock_items_id_uuidv7_check" CHECK (substring("inventory_stock_items"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "inventory_stock_items_unit_check" CHECK ("inventory_stock_items"."base_unit" in ('each','pair','set','meter','gram','kilogram')),
	CONSTRAINT "inventory_stock_items_status_check" CHECK ("inventory_stock_items"."status" in ('active','inactive'))
);
--> statement-breakpoint
CREATE TABLE "inventory_transfer_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"transfer_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"action" text NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"reason_code" text NOT NULL,
	"debit_movement_id" uuid,
	"credit_movement_id" uuid,
	"idempotency_key" text NOT NULL,
	"actor_user_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_transfer_events_id_uuidv7_check" CHECK (substring("inventory_transfer_events"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "inventory_transfer_events_sequence_check" CHECK ("inventory_transfer_events"."sequence" > 0),
	CONSTRAINT "inventory_transfer_events_action_check" CHECK ("inventory_transfer_events"."action" in ('created','dispatched','received','cancelled')),
	CONSTRAINT "inventory_transfer_events_status_check" CHECK ("inventory_transfer_events"."to_status" in ('draft','in_transit','received','cancelled')),
	CONSTRAINT "inventory_transfer_events_movements_check" CHECK ((("inventory_transfer_events"."action" in ('dispatched','received')) and "inventory_transfer_events"."debit_movement_id" is not null and "inventory_transfer_events"."credit_movement_id" is not null) or (("inventory_transfer_events"."action" in ('created','cancelled')) and "inventory_transfer_events"."debit_movement_id" is null and "inventory_transfer_events"."credit_movement_id" is null))
);
--> statement-breakpoint
CREATE TABLE "inventory_transfers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"stock_item_id" uuid NOT NULL,
	"lot_id" uuid,
	"source_location_id" uuid NOT NULL,
	"destination_location_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"unit" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_transfers_id_uuidv7_check" CHECK (substring("inventory_transfers"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "inventory_transfers_locations_check" CHECK ("inventory_transfers"."source_location_id" <> "inventory_transfers"."destination_location_id"),
	CONSTRAINT "inventory_transfers_quantity_check" CHECK ("inventory_transfers"."quantity" > 0),
	CONSTRAINT "inventory_transfers_unit_check" CHECK ("inventory_transfers"."unit" in ('each','pair','set','meter','gram','kilogram')),
	CONSTRAINT "inventory_transfers_status_check" CHECK ("inventory_transfers"."status" in ('draft','in_transit','received','cancelled')),
	CONSTRAINT "inventory_transfers_version_check" CHECK ("inventory_transfers"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_warehouses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"country_code" text,
	"time_zone" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_warehouses_id_uuidv7_check" CHECK (substring("inventory_warehouses"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "inventory_warehouses_type_check" CHECK ("inventory_warehouses"."type" in ('owned','third_party','fba','supplier','virtual')),
	CONSTRAINT "inventory_warehouses_country_check" CHECK ("inventory_warehouses"."country_code" is null or "inventory_warehouses"."country_code" ~ '^[A-Z]{2}$'),
	CONSTRAINT "inventory_warehouses_status_check" CHECK ("inventory_warehouses"."status" in ('active','inactive'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_warehouses_tenant_id_unique" ON "inventory_warehouses" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_locations_tenant_id_unique" ON "inventory_locations" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_stock_items_tenant_id_unique" ON "inventory_stock_items" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_lots_tenant_id_unique" ON "inventory_lots" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_lots_stock_item_id_unique" ON "inventory_lots" USING btree ("tenant_id","stock_item_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_movements_tenant_id_unique" ON "inventory_movements" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_reservations_tenant_id_unique" ON "inventory_reservations" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_transfers_tenant_id_unique" ON "inventory_transfers" USING btree ("tenant_id","id");--> statement-breakpoint
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_stock_item_fk" FOREIGN KEY ("tenant_id","stock_item_id") REFERENCES "public"."inventory_stock_items"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."inventory_locations"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_lot_fk" FOREIGN KEY ("tenant_id","stock_item_id","lot_id") REFERENCES "public"."inventory_lots"("tenant_id","stock_item_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_locations" ADD CONSTRAINT "inventory_locations_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_locations" ADD CONSTRAINT "inventory_locations_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_locations" ADD CONSTRAINT "inventory_locations_warehouse_fk" FOREIGN KEY ("tenant_id","warehouse_id") REFERENCES "public"."inventory_warehouses"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_stock_item_fk" FOREIGN KEY ("tenant_id","stock_item_id") REFERENCES "public"."inventory_stock_items"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_recorded_by_app_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_stock_item_fk" FOREIGN KEY ("tenant_id","stock_item_id") REFERENCES "public"."inventory_stock_items"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."inventory_locations"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_lot_fk" FOREIGN KEY ("tenant_id","stock_item_id","lot_id") REFERENCES "public"."inventory_lots"("tenant_id","stock_item_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_projection_rebuilds" ADD CONSTRAINT "inventory_projection_rebuilds_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_projection_rebuilds" ADD CONSTRAINT "inventory_projection_rebuilds_initiated_by_app_users_id_fk" FOREIGN KEY ("initiated_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservation_events" ADD CONSTRAINT "inventory_reservation_events_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservation_events" ADD CONSTRAINT "inventory_reservation_events_actor_user_id_app_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservation_events" ADD CONSTRAINT "inventory_reservation_events_reservation_fk" FOREIGN KEY ("tenant_id","reservation_id") REFERENCES "public"."inventory_reservations"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_stock_item_fk" FOREIGN KEY ("tenant_id","stock_item_id") REFERENCES "public"."inventory_stock_items"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."inventory_locations"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_lot_fk" FOREIGN KEY ("tenant_id","stock_item_id","lot_id") REFERENCES "public"."inventory_lots"("tenant_id","stock_item_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_stock_items" ADD CONSTRAINT "inventory_stock_items_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_stock_items" ADD CONSTRAINT "inventory_stock_items_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_stock_items" ADD CONSTRAINT "inventory_stock_items_sku_fk" FOREIGN KEY ("tenant_id","sku_id") REFERENCES "public"."skus"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transfer_events" ADD CONSTRAINT "inventory_transfer_events_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transfer_events" ADD CONSTRAINT "inventory_transfer_events_actor_user_id_app_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transfer_events" ADD CONSTRAINT "inventory_transfer_events_transfer_fk" FOREIGN KEY ("tenant_id","transfer_id") REFERENCES "public"."inventory_transfers"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transfer_events" ADD CONSTRAINT "inventory_transfer_events_debit_movement_fk" FOREIGN KEY ("tenant_id","debit_movement_id") REFERENCES "public"."inventory_movements"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transfer_events" ADD CONSTRAINT "inventory_transfer_events_credit_movement_fk" FOREIGN KEY ("tenant_id","credit_movement_id") REFERENCES "public"."inventory_movements"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transfers" ADD CONSTRAINT "inventory_transfers_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transfers" ADD CONSTRAINT "inventory_transfers_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transfers" ADD CONSTRAINT "inventory_transfers_stock_item_fk" FOREIGN KEY ("tenant_id","stock_item_id") REFERENCES "public"."inventory_stock_items"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transfers" ADD CONSTRAINT "inventory_transfers_lot_fk" FOREIGN KEY ("tenant_id","stock_item_id","lot_id") REFERENCES "public"."inventory_lots"("tenant_id","stock_item_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transfers" ADD CONSTRAINT "inventory_transfers_source_location_fk" FOREIGN KEY ("tenant_id","source_location_id") REFERENCES "public"."inventory_locations"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transfers" ADD CONSTRAINT "inventory_transfers_destination_location_fk" FOREIGN KEY ("tenant_id","destination_location_id") REFERENCES "public"."inventory_locations"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_warehouses" ADD CONSTRAINT "inventory_warehouses_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_warehouses" ADD CONSTRAINT "inventory_warehouses_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_balances_tenant_id_unique" ON "inventory_balances" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_balances_dimension_unique" ON "inventory_balances" USING btree ("tenant_id","dimension_key");--> statement-breakpoint
CREATE INDEX "inventory_balances_stock_idx" ON "inventory_balances" USING btree ("tenant_id","stock_item_id","location_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_locations_code_unique" ON "inventory_locations" USING btree ("tenant_id","warehouse_id","code");--> statement-breakpoint
CREATE INDEX "inventory_locations_warehouse_idx" ON "inventory_locations" USING btree ("tenant_id","warehouse_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_lots_code_unique" ON "inventory_lots" USING btree ("tenant_id","stock_item_id","code");--> statement-breakpoint
CREATE INDEX "inventory_lots_expiry_idx" ON "inventory_lots" USING btree ("tenant_id","stock_item_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_movements_idempotency_unique" ON "inventory_movements" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "inventory_movements_dimension_idx" ON "inventory_movements" USING btree ("tenant_id","stock_item_id","location_id","lot_id","occurred_at");--> statement-breakpoint
CREATE INDEX "inventory_movements_source_idx" ON "inventory_movements" USING btree ("tenant_id","source_type","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_projection_rebuilds_tenant_id_unique" ON "inventory_projection_rebuilds" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_projection_rebuilds_idempotency_unique" ON "inventory_projection_rebuilds" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "inventory_projection_rebuilds_time_idx" ON "inventory_projection_rebuilds" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_reservation_events_tenant_id_unique" ON "inventory_reservation_events" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_reservation_events_sequence_unique" ON "inventory_reservation_events" USING btree ("tenant_id","reservation_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_reservation_events_idempotency_unique" ON "inventory_reservation_events" USING btree ("tenant_id","reservation_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_reservations_idempotency_unique" ON "inventory_reservations" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "inventory_reservations_dimension_idx" ON "inventory_reservations" USING btree ("tenant_id","stock_item_id","location_id","lot_id","status");--> statement-breakpoint
CREATE INDEX "inventory_reservations_expiry_idx" ON "inventory_reservations" USING btree ("tenant_id","status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_stock_items_code_unique" ON "inventory_stock_items" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_stock_items_sku_unique" ON "inventory_stock_items" USING btree ("tenant_id","sku_id") WHERE "inventory_stock_items"."sku_id" is not null;--> statement-breakpoint
CREATE INDEX "inventory_stock_items_status_idx" ON "inventory_stock_items" USING btree ("tenant_id","status","name");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_transfer_events_tenant_id_unique" ON "inventory_transfer_events" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_transfer_events_sequence_unique" ON "inventory_transfer_events" USING btree ("tenant_id","transfer_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_transfer_events_idempotency_unique" ON "inventory_transfer_events" USING btree ("tenant_id","transfer_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_transfers_idempotency_unique" ON "inventory_transfers" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "inventory_transfers_status_idx" ON "inventory_transfers" USING btree ("tenant_id","status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_warehouses_code_unique" ON "inventory_warehouses" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "inventory_warehouses_status_idx" ON "inventory_warehouses" USING btree ("tenant_id","status","name");
--> statement-breakpoint
ALTER TABLE "inventory_warehouses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_warehouses" FORCE ROW LEVEL SECURITY;
CREATE POLICY "inventory_warehouses_tenant_policy" ON "inventory_warehouses" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE ON "inventory_warehouses" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "inventory_locations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_locations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "inventory_locations_tenant_policy" ON "inventory_locations" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE ON "inventory_locations" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "inventory_stock_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_stock_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "inventory_stock_items_tenant_policy" ON "inventory_stock_items" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE ON "inventory_stock_items" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "inventory_lots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_lots" FORCE ROW LEVEL SECURITY;
CREATE POLICY "inventory_lots_tenant_policy" ON "inventory_lots" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "inventory_lots" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "inventory_movements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_movements" FORCE ROW LEVEL SECURITY;
CREATE POLICY "inventory_movements_tenant_policy" ON "inventory_movements" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "inventory_movements" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "inventory_balances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_balances" FORCE ROW LEVEL SECURITY;
CREATE POLICY "inventory_balances_tenant_policy" ON "inventory_balances" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE, DELETE ON "inventory_balances" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "inventory_reservations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_reservations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "inventory_reservations_tenant_policy" ON "inventory_reservations" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE ON "inventory_reservations" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "inventory_reservation_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_reservation_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "inventory_reservation_events_tenant_policy" ON "inventory_reservation_events" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "inventory_reservation_events" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "inventory_transfers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_transfers" FORCE ROW LEVEL SECURITY;
CREATE POLICY "inventory_transfers_tenant_policy" ON "inventory_transfers" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE ON "inventory_transfers" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "inventory_transfer_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_transfer_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "inventory_transfer_events_tenant_policy" ON "inventory_transfer_events" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "inventory_transfer_events" TO yummyai_app;
--> statement-breakpoint
ALTER TABLE "inventory_projection_rebuilds" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_projection_rebuilds" FORCE ROW LEVEL SECURITY;
CREATE POLICY "inventory_projection_rebuilds_tenant_policy" ON "inventory_projection_rebuilds" FOR ALL TO yummyai_app USING ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenant_id" = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT ON "inventory_projection_rebuilds" TO yummyai_app;
