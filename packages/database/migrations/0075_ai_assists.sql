CREATE TABLE "ai_assist_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"scope" text NOT NULL,
	"order_line_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"input_fingerprint" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"encrypted_input" text,
	"encrypted_output" text,
	"model_snapshot" jsonb NOT NULL,
	"prompt_version" text NOT NULL,
	"error_code" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" numeric(14, 6),
	"reserved_cost_usd" numeric(14, 6) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ai_assist_runs_kind_check" CHECK ("ai_assist_runs"."kind" in ('creative','order_review','artwork_preflight')),
	CONSTRAINT "ai_assist_runs_status_check" CHECK ("ai_assist_runs"."status" in ('queued','running','completed','failed','cancelled'))
);
--> statement-breakpoint
ALTER TABLE "ai_assist_runs" ADD CONSTRAINT "ai_assist_runs_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_assist_runs" ADD CONSTRAINT "ai_assist_runs_owner_id_app_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_assist_runs" ADD CONSTRAINT "ai_assist_runs_order_line_fk" FOREIGN KEY ("tenant_id","order_line_id") REFERENCES "public"."order_lines"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_assist_runs_tenant_id_unique" ON "ai_assist_runs" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_assist_runs_request_unique" ON "ai_assist_runs" USING btree ("tenant_id","owner_id","request_id");--> statement-breakpoint
CREATE INDEX "ai_assist_runs_scope_idx" ON "ai_assist_runs" USING btree ("tenant_id","owner_id","scope","kind","created_at");
--> statement-breakpoint
ALTER TABLE ai_assist_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ai_assist_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY ai_assist_runs_tenant_policy ON ai_assist_runs FOR ALL TO yummyai_app
USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON ai_assist_runs TO yummyai_app;
--> statement-breakpoint
CREATE FUNCTION protect_ai_assist_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status','encrypted_input','encrypted_output','error_code','input_tokens','output_tokens','cost_usd','started_at','completed_at']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status','encrypted_input','encrypted_output','error_code','input_tokens','output_tokens','cost_usd','started_at','completed_at'])
     OR (NEW.encrypted_input IS DISTINCT FROM OLD.encrypted_input AND NEW.encrypted_input IS NOT NULL)
     OR (OLD.status IN ('completed','failed','cancelled') AND
       (to_jsonb(NEW) - ARRAY['encrypted_input','encrypted_output']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['encrypted_input','encrypted_output']))
     OR (OLD.encrypted_output IS NOT NULL AND NEW.encrypted_output IS DISTINCT FROM OLD.encrypted_output AND NEW.encrypted_output IS NOT NULL)
  THEN RAISE EXCEPTION 'AI assist input and final results are immutable' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ai_assist_runs_immutable BEFORE UPDATE ON ai_assist_runs FOR EACH ROW EXECUTE FUNCTION protect_ai_assist_run();
