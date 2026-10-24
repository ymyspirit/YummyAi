CREATE UNIQUE INDEX IF NOT EXISTS production_delivery_feedback_tenant_id_unique ON production_delivery_feedback(tenant_id,id);
CREATE TABLE factory_access_grants (
 id uuid PRIMARY KEY CHECK(substring(id::text from 15 for 1)='7'), tenant_id uuid NOT NULL REFERENCES organizations(id),
 factory_id uuid NOT NULL, membership_id uuid NOT NULL, can_respond boolean NOT NULL,
 expires_at timestamptz NOT NULL, idempotency_key uuid NOT NULL, request_checksum text NOT NULL CHECK(request_checksum ~ '^[a-f0-9]{64}$'),
 created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 revoked_at timestamptz, revoked_by uuid REFERENCES app_users(id), revocation_key uuid, revocation_reason text,
 CONSTRAINT factory_access_grants_factory_fk FOREIGN KEY(tenant_id,factory_id) REFERENCES fulfillment_factories(tenant_id,id),
 CONSTRAINT factory_access_grants_member_fk FOREIGN KEY(tenant_id,membership_id) REFERENCES memberships(tenant_id,id),
 CONSTRAINT factory_access_grants_expiry_check CHECK(expires_at>created_at),
 CONSTRAINT factory_access_grants_closure_check CHECK((revoked_at IS NULL AND revoked_by IS NULL AND revocation_key IS NULL AND revocation_reason IS NULL) OR (revoked_at>=created_at AND revoked_by IS NOT NULL AND revocation_key IS NOT NULL AND revocation_reason IS NOT NULL AND length(revocation_reason) BETWEEN 5 AND 500))
);
CREATE UNIQUE INDEX factory_access_grants_tenant_id_unique ON factory_access_grants(tenant_id,id);
CREATE UNIQUE INDEX factory_access_grants_request_unique ON factory_access_grants(tenant_id,idempotency_key);
CREATE UNIQUE INDEX factory_access_grants_active_unique ON factory_access_grants(tenant_id,factory_id,membership_id) WHERE revoked_at IS NULL;
CREATE INDEX factory_access_grants_member_idx ON factory_access_grants(tenant_id,membership_id);
CREATE TABLE factory_task_assignments (
 id uuid PRIMARY KEY CHECK(substring(id::text from 15 for 1)='7'), tenant_id uuid NOT NULL REFERENCES organizations(id),
 grant_id uuid NOT NULL, delivery_item_id uuid NOT NULL, file_checksum text NOT NULL CHECK(file_checksum ~ '^[a-f0-9]{64}$'),
 expires_at timestamptz NOT NULL, idempotency_key uuid NOT NULL, request_checksum text NOT NULL CHECK(request_checksum ~ '^[a-f0-9]{64}$'),
 created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 revoked_at timestamptz, revoked_by uuid REFERENCES app_users(id), revocation_key uuid, revocation_reason text,
 CONSTRAINT factory_task_assignments_grant_fk FOREIGN KEY(tenant_id,grant_id) REFERENCES factory_access_grants(tenant_id,id),
 CONSTRAINT factory_task_assignments_item_fk FOREIGN KEY(tenant_id,delivery_item_id) REFERENCES production_delivery_items(tenant_id,id),
 CONSTRAINT factory_task_assignments_expiry_check CHECK(expires_at>created_at),
 CONSTRAINT factory_task_assignments_closure_check CHECK((revoked_at IS NULL AND revoked_by IS NULL AND revocation_key IS NULL AND revocation_reason IS NULL) OR (revoked_at>=created_at AND revoked_by IS NOT NULL AND revocation_key IS NOT NULL AND revocation_reason IS NOT NULL AND length(revocation_reason) BETWEEN 5 AND 500))
);
CREATE UNIQUE INDEX factory_task_assignments_tenant_id_unique ON factory_task_assignments(tenant_id,id);
CREATE UNIQUE INDEX factory_task_assignments_request_unique ON factory_task_assignments(tenant_id,idempotency_key);
CREATE UNIQUE INDEX factory_task_assignments_active_unique ON factory_task_assignments(tenant_id,grant_id,delivery_item_id) WHERE revoked_at IS NULL;
CREATE INDEX factory_task_assignments_grant_idx ON factory_task_assignments(tenant_id,grant_id,created_at,id);
CREATE TABLE factory_task_receipts (
 id uuid PRIMARY KEY CHECK(substring(id::text from 15 for 1)='7'), tenant_id uuid NOT NULL REFERENCES organizations(id),
 assignment_id uuid NOT NULL, feedback_id uuid NOT NULL, recorded_by uuid NOT NULL REFERENCES app_users(id), recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT factory_task_receipts_assignment_fk FOREIGN KEY(tenant_id,assignment_id) REFERENCES factory_task_assignments(tenant_id,id),
 CONSTRAINT factory_task_receipts_feedback_fk FOREIGN KEY(tenant_id,feedback_id) REFERENCES production_delivery_feedback(tenant_id,id)
);
CREATE UNIQUE INDEX factory_task_receipts_feedback_unique ON factory_task_receipts(tenant_id,feedback_id);
ALTER TABLE factory_access_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE factory_access_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY factory_access_grants_tenant ON factory_access_grants FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
ALTER TABLE factory_task_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE factory_task_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY factory_task_assignments_tenant ON factory_task_assignments FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
ALTER TABLE factory_task_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE factory_task_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY factory_task_receipts_tenant ON factory_task_receipts FOR ALL TO yummyai_app USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')::uuid));
GRANT SELECT,INSERT,UPDATE ON factory_access_grants,factory_task_assignments TO yummyai_app;
GRANT SELECT,INSERT ON factory_task_receipts TO yummyai_app;

CREATE FUNCTION factory_portal_operator_authorized(p_tenant uuid,p_user uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM memberships m JOIN membership_roles mr ON mr.tenant_id=m.tenant_id AND mr.membership_id=m.id JOIN roles r ON r.tenant_id=mr.tenant_id AND r.id=mr.role_id
 WHERE m.tenant_id=p_tenant AND m.user_id=p_user AND m.status='active' GROUP BY m.id
 HAVING bool_or(r.data_scope='tenant') AND bool_or(r.permissions ? 'membership:manage') AND bool_or(r.permissions ? 'order:read') AND bool_or(r.permissions ? 'order:write'))
$$;
REVOKE ALL ON FUNCTION factory_portal_operator_authorized(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION factory_portal_operator_authorized(uuid,uuid) TO yummyai_app;

CREATE FUNCTION guard_factory_collaboration() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE v_actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid; v_grant factory_access_grants%ROWTYPE; v_factory uuid; v_checksum text;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Factory collaboration history cannot be deleted'; END IF;
 IF NOT factory_portal_operator_authorized(NEW.tenant_id,v_actor) THEN RAISE EXCEPTION 'Factory collaboration operator authority required'; END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR NEW.revoked_by IS DISTINCT FROM v_actor OR NEW.revocation_key IS NULL OR NEW.revocation_reason IS NULL OR length(NEW.revocation_reason) NOT BETWEEN 5 AND 500 OR
   (to_jsonb(NEW)-ARRAY['revoked_at','revoked_by','revocation_key','revocation_reason']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revoked_at','revoked_by','revocation_key','revocation_reason']) THEN RAISE EXCEPTION 'Factory collaboration identity is immutable; only first revocation is allowed'; END IF;
  NEW.revoked_at:=clock_timestamp(); RETURN NEW;
 END IF;
 IF NEW.created_by IS DISTINCT FROM v_actor OR NEW.revoked_at IS NOT NULL OR NEW.revoked_by IS NOT NULL OR NEW.revocation_key IS NOT NULL OR NEW.revocation_reason IS NOT NULL THEN RAISE EXCEPTION 'Original active factory collaboration required'; END IF;
 NEW.created_at:=clock_timestamp();
 IF TG_TABLE_NAME='factory_access_grants' THEN
  IF NOT EXISTS(SELECT 1 FROM memberships WHERE tenant_id=NEW.tenant_id AND id=NEW.membership_id AND status='active') OR NOT EXISTS(SELECT 1 FROM fulfillment_factories f JOIN fulfillment_suppliers s ON s.tenant_id=f.tenant_id AND s.id=f.supplier_id WHERE f.tenant_id=NEW.tenant_id AND f.id=NEW.factory_id AND f.status='active' AND s.status='active') THEN RAISE EXCEPTION 'Current member and factory required'; END IF;
 ELSE
  SELECT * INTO v_grant FROM factory_access_grants WHERE tenant_id=NEW.tenant_id AND id=NEW.grant_id FOR SHARE;
  SELECT p.factory_id,i.file_checksum INTO v_factory,v_checksum FROM production_delivery_items i JOIN production_delivery_packages p ON p.tenant_id=i.tenant_id AND p.id=i.package_id WHERE i.tenant_id=NEW.tenant_id AND i.id=NEW.delivery_item_id;
  IF v_grant.id IS NULL OR v_grant.revoked_at IS NOT NULL OR v_grant.expires_at<=clock_timestamp() OR NEW.expires_at>v_grant.expires_at OR v_factory IS DISTINCT FROM v_grant.factory_id OR v_checksum IS DISTINCT FROM NEW.file_checksum OR NOT EXISTS(SELECT 1 FROM memberships m JOIN fulfillment_factories fc ON fc.tenant_id=m.tenant_id AND fc.id=v_grant.factory_id JOIN fulfillment_suppliers s ON s.tenant_id=fc.tenant_id AND s.id=fc.supplier_id WHERE m.tenant_id=NEW.tenant_id AND m.id=v_grant.membership_id AND m.status='active' AND fc.status='active' AND s.status='active') THEN RAISE EXCEPTION 'Current same-factory grant and original file required'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER factory_access_grants_guard BEFORE INSERT OR UPDATE OR DELETE ON factory_access_grants FOR EACH ROW EXECUTE FUNCTION guard_factory_collaboration();
CREATE TRIGGER factory_task_assignments_guard BEFORE INSERT OR UPDATE OR DELETE ON factory_task_assignments FOR EACH ROW EXECUTE FUNCTION guard_factory_collaboration();

CREATE FUNCTION guard_factory_task_receipt() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE v_actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Factory task receipt is immutable'; END IF;
 IF NEW.recorded_by IS DISTINCT FROM v_actor OR NOT EXISTS(
  SELECT 1 FROM factory_task_assignments a JOIN factory_access_grants g ON g.tenant_id=a.tenant_id AND g.id=a.grant_id JOIN memberships m ON m.tenant_id=g.tenant_id AND m.id=g.membership_id
  JOIN production_delivery_feedback f ON f.tenant_id=a.tenant_id AND f.id=NEW.feedback_id AND f.item_id=a.delivery_item_id
  JOIN production_delivery_items i ON i.tenant_id=a.tenant_id AND i.id=a.delivery_item_id JOIN production_delivery_packages p ON p.tenant_id=i.tenant_id AND p.id=i.package_id
  JOIN order_work_items w ON w.tenant_id=i.tenant_id AND w.id=i.work_item_id JOIN order_lines ol ON ol.tenant_id=w.tenant_id AND ol.id=w.id JOIN orders o ON o.tenant_id=ol.tenant_id AND o.id=ol.order_id
  JOIN production_editor_projects ep ON ep.tenant_id=i.tenant_id AND ep.id=i.editor_project_id
  JOIN fulfillment_factories fc ON fc.tenant_id=g.tenant_id AND fc.id=g.factory_id JOIN fulfillment_suppliers s ON s.tenant_id=fc.tenant_id AND s.id=fc.supplier_id
  WHERE a.tenant_id=NEW.tenant_id AND a.id=NEW.assignment_id AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp() AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp() AND g.can_respond
   AND m.user_id=v_actor AND m.status='active' AND fc.status='active' AND s.status='active' AND p.factory_id=g.factory_id AND i.file_checksum=a.file_checksum AND f.recorded_by=v_actor AND f.kind IN ('received','accepted','rejected')
   AND w.encrypted_data_key IS NOT NULL AND w.expires_at>clock_timestamp() AND w.pushed_revision_id=i.work_revision_id AND o.address_status<>'anonymized'
   AND ep.status='active' AND ep.encrypted_data_key IS NOT NULL AND (ep.expires_at IS NULL OR ep.expires_at>clock_timestamp()) AND ep.current_version_id=i.editor_version_id AND ep.reviewed_version_id=i.editor_version_id)
 THEN RAISE EXCEPTION 'Current factory assignment and own original receipt required'; END IF;
 NEW.recorded_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER factory_task_receipts_guard BEFORE INSERT OR UPDATE OR DELETE ON factory_task_receipts FOR EACH ROW EXECUTE FUNCTION guard_factory_task_receipt();
