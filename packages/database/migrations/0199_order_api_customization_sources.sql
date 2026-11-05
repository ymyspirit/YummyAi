ALTER TABLE amazon_order_report_batches
 ADD COLUMN source_type text NOT NULL DEFAULT 'report_file',
 ADD COLUMN dispatched_at timestamptz,
 ADD CONSTRAINT amazon_order_report_batches_source_type_check CHECK(source_type IN ('report_file','orders_api'));
CREATE INDEX amazon_order_report_batches_dispatch_idx ON amazon_order_report_batches(tenant_id,created_at,id)
 WHERE source_type='orders_api' AND dispatched_at IS NULL;
