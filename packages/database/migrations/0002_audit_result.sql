ALTER TABLE "audit_events" ADD COLUMN "result" text DEFAULT 'success' NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_result_check"
  CHECK ("result" IN ('success', 'failure', 'denied'));
