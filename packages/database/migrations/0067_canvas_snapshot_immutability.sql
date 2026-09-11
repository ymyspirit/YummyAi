CREATE FUNCTION prevent_canvas_workflow_snapshot_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.canvas_workflow IS DISTINCT FROM NEW.canvas_workflow THEN
    RAISE EXCEPTION 'Canvas workflow snapshots are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER canvas_workflow_snapshot_immutable BEFORE UPDATE OF canvas_workflow ON creative_design_batches
FOR EACH ROW EXECUTE FUNCTION prevent_canvas_workflow_snapshot_mutation();
