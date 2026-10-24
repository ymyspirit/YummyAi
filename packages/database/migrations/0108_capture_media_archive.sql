ALTER TABLE capture_media
  ADD COLUMN object_key text,
  ADD COLUMN checksum_sha256 text,
  ADD COLUMN media_type text,
  ADD COLUMN byte_size integer,
  ADD COLUMN scan_result jsonb,
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN dispatch_count integer NOT NULL DEFAULT 0,
  ADD COLUMN last_dispatched_at timestamptz,
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN lease_token uuid,
  ADD COLUMN lease_expires_at timestamptz;
--> statement-breakpoint
ALTER TABLE capture_media DROP CONSTRAINT capture_media_status_check;
ALTER TABLE capture_media ADD CONSTRAINT capture_media_status_check
  CHECK (status IN ('queued', 'processing', 'archived', 'excluded', 'failed'));
ALTER TABLE capture_media ADD CONSTRAINT capture_media_attempt_check
  CHECK (attempt_count BETWEEN 0 AND 3 AND dispatch_count >= 0);
ALTER TABLE capture_media ADD CONSTRAINT capture_media_lease_check CHECK (
  (status = 'processing' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL) OR
  (status <> 'processing' AND lease_token IS NULL AND lease_expires_at IS NULL)
);
ALTER TABLE capture_media ADD CONSTRAINT capture_media_archive_check CHECK (
  status <> 'archived' OR (
    object_key IS NOT NULL AND checksum_sha256 IS NOT NULL AND checksum_sha256 ~ '^[0-9a-f]{64}$' AND
    object_key LIKE 'tenants/' || tenant_id::text || '/research/' || checksum_sha256 || '/%' AND
    byte_size IS NOT NULL AND byte_size > 0 AND media_type IS NOT NULL AND
    (scan_result->>'result') IS NOT DISTINCT FROM 'clean' AND archived_at IS NOT NULL
  )
);
CREATE INDEX capture_media_pending_idx ON capture_media (tenant_id, status, next_attempt_at);
--> statement-breakpoint
-- Capture identity/source is immutable; archive state is a separate mutable projection.
CREATE FUNCTION protect_capture_media_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.snapshot_id, NEW.source_url, NEW.kind, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.snapshot_id, OLD.source_url, OLD.kind, OLD.created_at) THEN
    RAISE EXCEPTION 'Capture media source is immutable';
  END IF;
  IF OLD.status = 'archived' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Archived capture media is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER capture_media_source_immutable BEFORE UPDATE ON capture_media
  FOR EACH ROW EXECUTE FUNCTION protect_capture_media_source();
