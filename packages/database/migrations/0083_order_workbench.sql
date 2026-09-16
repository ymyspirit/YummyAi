ALTER TABLE order_work_items ADD COLUMN search_revision integer NOT NULL DEFAULT -1,
  ADD COLUMN search_specification_version_id uuid,
  ADD COLUMN search_design_executor text,
  ADD COLUMN archived_at timestamptz;
--> statement-breakpoint
ALTER TABLE order_work_items ADD CONSTRAINT order_work_search_executor_check
  CHECK (search_design_executor IS NULL OR search_design_executor IN ('human', 'agent'));
--> statement-breakpoint
CREATE INDEX order_work_search_idx ON order_work_items(tenant_id, archived_at, search_specification_version_id);
