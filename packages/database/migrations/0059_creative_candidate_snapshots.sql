ALTER TABLE "creative_design_candidates" ADD COLUMN "parameter_snapshot" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "creative_design_candidates" ADD COLUMN "input_checksum" text NOT NULL;--> statement-breakpoint
ALTER TABLE "creative_design_candidates" ADD CONSTRAINT "creative_design_candidates_input_checksum_check" CHECK ("creative_design_candidates"."input_checksum" ~ '^[0-9a-f]{64}$');