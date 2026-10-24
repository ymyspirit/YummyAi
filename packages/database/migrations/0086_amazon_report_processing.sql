CREATE TABLE amazon_order_report_processing_requests (
  report_line_id uuid PRIMARY KEY NOT NULL,
  tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  dispatch_id uuid,
  batch_id uuid NOT NULL,
  source_checksum text NOT NULL,
  expected_version_id uuid,
  requested_by uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT amazon_report_processing_line_fk FOREIGN KEY (tenant_id, report_line_id)
    REFERENCES amazon_order_report_lines(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT amazon_report_processing_batch_fk FOREIGN KEY (tenant_id, batch_id)
    REFERENCES amazon_order_report_batches(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT amazon_report_processing_version_fk FOREIGN KEY (tenant_id, report_line_id, expected_version_id)
    REFERENCES amazon_order_report_versions(tenant_id, report_line_id, id) ON DELETE RESTRICT,
  CONSTRAINT amazon_report_processing_request_id_check CHECK (substring(request_id::text FROM 15 FOR 1) = '7' AND (dispatch_id IS NULL OR substring(dispatch_id::text FROM 15 FOR 1) = '7')),
  CONSTRAINT amazon_report_processing_status_check CHECK (status IN ('pending','processing','completed','failed','superseded')),
  CONSTRAINT amazon_report_processing_attempt_check CHECK (attempt_count BETWEEN 0 AND 3),
  CONSTRAINT amazon_report_processing_checksum_check CHECK (source_checksum ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX amazon_report_processing_request_unique ON amazon_order_report_processing_requests(tenant_id, request_id);
CREATE INDEX amazon_report_processing_batch_idx ON amazon_order_report_processing_requests(tenant_id, batch_id, status);
--> statement-breakpoint
ALTER TABLE amazon_order_report_processing_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE amazon_order_report_processing_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY amazon_report_processing_tenant_policy ON amazon_order_report_processing_requests
  FOR ALL TO yummyai_app
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE ON amazon_order_report_processing_requests TO yummyai_app;
