-- Working-list visibility is mutable; pinned versions and ledger history remain intact.
ALTER TABLE creative_design_batches ADD COLUMN archived_at timestamptz;
ALTER TABLE production_editor_projects ADD COLUMN archived_at timestamptz;
ALTER TABLE print_profiles ADD COLUMN archived_at timestamptz;
ALTER TABLE inventory_purchase_orders ADD COLUMN archived_at timestamptz;
