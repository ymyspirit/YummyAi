-- Pin the original draft position for new media. Legacy rows remain explicitly
-- unpinned; no inference or backfill from UUID order is performed.
ALTER TABLE capture_media ADD COLUMN source_index integer;
--> statement-breakpoint
ALTER TABLE capture_media ADD CONSTRAINT capture_media_source_index_check CHECK (source_index IS NULL OR source_index >= 0);
--> statement-breakpoint
CREATE UNIQUE INDEX capture_media_source_index_unique ON capture_media(tenant_id,snapshot_id,source_index) WHERE source_index IS NOT NULL;
--> statement-breakpoint
CREATE INDEX capture_media_source_order_idx ON capture_media(tenant_id,snapshot_id,source_index,id);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_capture_media_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.snapshot_id, NEW.source_url, NEW.kind, NEW.source_index, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.snapshot_id, OLD.source_url, OLD.kind, OLD.source_index, OLD.created_at) THEN
    RAISE EXCEPTION 'Capture media source is immutable';
  END IF;
  IF OLD.status = 'archived' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Archived capture media is immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION validate_capture_media_source_index() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original jsonb;
BEGIN
  IF NEW.source_index IS NOT NULL THEN
    SELECT draft->'media'->NEW.source_index INTO original FROM capture_snapshots WHERE tenant_id=NEW.tenant_id AND id=NEW.snapshot_id;
    IF original IS NULL OR original->>'sourceUrl' IS DISTINCT FROM NEW.source_url OR original->>'kind' IS DISTINCT FROM NEW.kind THEN
      RAISE EXCEPTION 'Capture media does not match its pinned source position';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER capture_media_source_index_valid BEFORE INSERT ON capture_media FOR EACH ROW EXECUTE FUNCTION validate_capture_media_source_index();
