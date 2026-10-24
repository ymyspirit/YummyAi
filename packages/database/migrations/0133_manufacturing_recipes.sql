CREATE TABLE manufacturing_recipes (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
 spu_id uuid NOT NULL, specification_id uuid NOT NULL, code text NOT NULL CHECK(length(trim(code)) BETWEEN 1 AND 64),
 version_number integer NOT NULL DEFAULT 1 CHECK(version_number>0), archived_at timestamptz,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,id,specification_id),
 FOREIGN KEY(tenant_id,spu_id) REFERENCES spus(tenant_id,id),
 FOREIGN KEY(tenant_id,spu_id,specification_id) REFERENCES product_specifications(tenant_id,spu_id,id)
);
CREATE UNIQUE INDEX manufacturing_recipes_code ON manufacturing_recipes(tenant_id,spu_id,lower(code));
--> statement-breakpoint
CREATE TABLE manufacturing_recipe_versions (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
 recipe_id uuid NOT NULL, specification_id uuid NOT NULL, specification_version_id uuid NOT NULL, version_number integer NOT NULL CHECK(version_number>0),
 creation_transaction bigint NOT NULL DEFAULT txid_current(), name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
 output_quantity integer NOT NULL CHECK(output_quantity BETWEEN 1 AND 1000000), output_unit text NOT NULL CHECK(output_unit IN ('each','pair','set')), notes text NOT NULL,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,recipe_id,id), UNIQUE(tenant_id,recipe_id,version_number),
 FOREIGN KEY(tenant_id,recipe_id,specification_id) REFERENCES manufacturing_recipes(tenant_id,id,specification_id),
 FOREIGN KEY(tenant_id,specification_id,specification_version_id) REFERENCES product_specification_versions(tenant_id,specification_id,id)
);
--> statement-breakpoint
CREATE TABLE manufacturing_operations (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
 version_id uuid NOT NULL, position integer NOT NULL CHECK(position BETWEEN 1 AND 200), code text NOT NULL, payload jsonb NOT NULL,
 UNIQUE(tenant_id,version_id,code), UNIQUE(tenant_id,version_id,position),
 CHECK(payload->>'code'=code),
 FOREIGN KEY(tenant_id,version_id) REFERENCES manufacturing_recipe_versions(tenant_id,id)
);
--> statement-breakpoint
CREATE TABLE manufacturing_bom_lines (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
 version_id uuid NOT NULL, position integer NOT NULL CHECK(position BETWEEN 1 AND 200), code text NOT NULL, stock_item_id uuid, operation_code text, payload jsonb NOT NULL,
 UNIQUE(tenant_id,version_id,code), UNIQUE(tenant_id,version_id,position),
 CHECK(payload->>'code'=code AND coalesce(payload->>'stockItemId','')=coalesce(stock_item_id::text,'') AND coalesce(payload->>'operationCode','')=coalesce(operation_code,'')),
 FOREIGN KEY(tenant_id,version_id) REFERENCES manufacturing_recipe_versions(tenant_id,id),
 FOREIGN KEY(tenant_id,stock_item_id) REFERENCES inventory_stock_items(tenant_id,id),
 FOREIGN KEY(tenant_id,version_id,operation_code) REFERENCES manufacturing_operations(tenant_id,version_id,code)
);
--> statement-breakpoint
CREATE TABLE manufacturing_recipe_reviews (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
 recipe_id uuid NOT NULL, version_id uuid NOT NULL, decision text NOT NULL CHECK(decision IN ('approved','rejected')), note text NOT NULL CHECK(length(trim(note)) BETWEEN 1 AND 2000),
 UNIQUE(tenant_id,version_id), UNIQUE(tenant_id,version_id,id),
 FOREIGN KEY(tenant_id,recipe_id,version_id) REFERENCES manufacturing_recipe_versions(tenant_id,recipe_id,id)
);
--> statement-breakpoint
CREATE TABLE manufacturing_recipe_commands (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id), created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
 request_key text NOT NULL CHECK(length(request_key) BETWEEN 8 AND 200), request_checksum text NOT NULL CHECK(request_checksum~'^[a-f0-9]{64}$'),
 operation text NOT NULL CHECK(operation IN ('create','revise','review')), recipe_id uuid NOT NULL, version_id uuid NOT NULL, response jsonb NOT NULL,
 CHECK(response->>'recipeId'=recipe_id::text AND response->>'versionId'=version_id::text),
 UNIQUE(tenant_id,request_key), FOREIGN KEY(tenant_id,recipe_id,version_id) REFERENCES manufacturing_recipe_versions(tenant_id,recipe_id,id)
);
--> statement-breakpoint
DO $$ DECLARE relation_name text; BEGIN
 FOREACH relation_name IN ARRAY ARRAY['manufacturing_recipes','manufacturing_recipe_versions','manufacturing_operations','manufacturing_bom_lines','manufacturing_recipe_reviews','manufacturing_recipe_commands'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation_name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation_name);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING(tenant_id=current_setting(''app.tenant_id'',true)::uuid) WITH CHECK(tenant_id=current_setting(''app.tenant_id'',true)::uuid)',relation_name);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO yummyai_app',relation_name);
 END LOOP;
 GRANT UPDATE ON manufacturing_recipes TO yummyai_app;
END $$;
--> statement-breakpoint
CREATE FUNCTION prevent_manufacturing_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'manufacturing evidence is immutable' USING ERRCODE='55000'; END $$;
DO $$ DECLARE relation_name text; BEGIN
 FOREACH relation_name IN ARRAY ARRAY['manufacturing_recipe_versions','manufacturing_operations','manufacturing_bom_lines','manufacturing_recipe_reviews','manufacturing_recipe_commands'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_evidence BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION prevent_manufacturing_evidence_mutation()',relation_name);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION require_manufacturing_version_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM manufacturing_recipe_versions v WHERE v.tenant_id=NEW.tenant_id AND v.id=NEW.version_id
  AND v.creation_transaction=txid_current() AND v.created_at=transaction_timestamp()) THEN
  RAISE EXCEPTION 'manufacturing lines must be sealed in their original version transaction' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION set_manufacturing_version_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_user='yummyai_app' THEN NEW.creation_transaction:=txid_current(); NEW.created_at:=transaction_timestamp(); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER version_origin BEFORE INSERT ON manufacturing_recipe_versions FOR EACH ROW EXECUTE FUNCTION set_manufacturing_version_origin();
CREATE TRIGGER version_seal BEFORE INSERT ON manufacturing_operations FOR EACH ROW EXECUTE FUNCTION require_manufacturing_version_transaction();
CREATE TRIGGER version_seal BEFORE INSERT ON manufacturing_bom_lines FOR EACH ROW EXECUTE FUNCTION require_manufacturing_version_transaction();
--> statement-breakpoint
CREATE FUNCTION guard_manufacturing_root() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'manufacturing identity is retained' USING ERRCODE='55000'; END IF;
 IF ROW(NEW.id,NEW.tenant_id,NEW.spu_id,NEW.specification_id,NEW.code,NEW.created_by,NEW.created_at)
  IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.spu_id,OLD.specification_id,OLD.code,OLD.created_by,OLD.created_at)
  OR NEW.version_number NOT BETWEEN OLD.version_number AND OLD.version_number+1 THEN
  RAISE EXCEPTION 'manufacturing identity or version sequence cannot be rewritten' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER retained_identity BEFORE UPDATE OR DELETE ON manufacturing_recipes FOR EACH ROW EXECUTE FUNCTION guard_manufacturing_root();
--> statement-breakpoint
CREATE FUNCTION require_complete_manufacturing_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.decision<>'approved' THEN RETURN NEW; END IF;
 IF NOT EXISTS(SELECT 1 FROM manufacturing_recipe_versions v JOIN manufacturing_recipes r ON r.tenant_id=v.tenant_id AND r.id=v.recipe_id
  JOIN product_specification_versions pv ON pv.tenant_id=v.tenant_id AND pv.id=v.specification_version_id
  JOIN product_specifications p ON p.tenant_id=pv.tenant_id AND p.id=pv.specification_id
  WHERE v.tenant_id=NEW.tenant_id AND v.id=NEW.version_id AND v.recipe_id=NEW.recipe_id AND r.archived_at IS NULL
   AND r.version_number=v.version_number AND p.version_number=pv.version_number AND pv.facts->>'factsConfirmed'='true')
 OR NOT EXISTS(SELECT 1 FROM manufacturing_bom_lines l WHERE l.tenant_id=NEW.tenant_id AND l.version_id=NEW.version_id)
 OR NOT EXISTS(SELECT 1 FROM manufacturing_operations o WHERE o.tenant_id=NEW.tenant_id AND o.version_id=NEW.version_id)
 OR EXISTS(SELECT 1 FROM manufacturing_bom_lines l LEFT JOIN inventory_stock_items i ON i.tenant_id=l.tenant_id AND i.id=l.stock_item_id
  WHERE l.tenant_id=NEW.tenant_id AND l.version_id=NEW.version_id AND (
   i.id IS NULL OR i.status<>'active' OR l.payload->>'unit' IS DISTINCT FROM i.base_unit
   OR coalesce(l.payload->>'responsibility','unknown') NOT IN ('merchant','factory')
   OR jsonb_typeof(l.payload->'quantityNumerator') IS DISTINCT FROM 'number' OR (l.payload->>'quantityNumerator')::numeric NOT BETWEEN 1 AND 1000000000
   OR (l.payload->>'quantityNumerator')::numeric<>trunc((l.payload->>'quantityNumerator')::numeric)
   OR jsonb_typeof(l.payload->'quantityDenominator') IS DISTINCT FROM 'number' OR (l.payload->>'quantityDenominator')::numeric NOT BETWEEN 1 AND 1000000000
   OR (l.payload->>'quantityDenominator')::numeric<>trunc((l.payload->>'quantityDenominator')::numeric)
   OR jsonb_typeof(l.payload->'lossBps') IS DISTINCT FROM 'number' OR (l.payload->>'lossBps')::numeric NOT BETWEEN 0 AND 100000
   OR (l.payload->>'lossBps')::numeric<>trunc((l.payload->>'lossBps')::numeric)
   OR coalesce(l.payload->>'lossBasis','') NOT IN ('add_to_net','fraction_of_input')
   OR (l.payload->>'lossBasis'='fraction_of_input' AND (l.payload->>'lossBps')::numeric>=10000)))
 OR EXISTS(SELECT 1 FROM manufacturing_operations o WHERE o.tenant_id=NEW.tenant_id AND o.version_id=NEW.version_id
  AND (coalesce(o.payload->>'responsibility','unknown') NOT IN ('merchant','factory') OR length(trim(coalesce(o.payload->>'processCode','')))=0)) THEN
  RAISE EXCEPTION 'manufacturing approval requires complete current material and operation evidence' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER complete_review BEFORE INSERT ON manufacturing_recipe_reviews FOR EACH ROW EXECUTE FUNCTION require_complete_manufacturing_review();
--> statement-breakpoint
CREATE FUNCTION check_manufacturing_version_projection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE root_id uuid; actual_count bigint; latest integer; projection integer;
BEGIN
 IF TG_TABLE_NAME='manufacturing_recipes' THEN root_id:=NEW.id; ELSE root_id:=NEW.recipe_id; END IF;
 SELECT version_number INTO projection FROM manufacturing_recipes WHERE tenant_id=NEW.tenant_id AND id=root_id;
 SELECT count(*),max(version_number) INTO actual_count,latest FROM manufacturing_recipe_versions WHERE tenant_id=NEW.tenant_id AND recipe_id=root_id;
 IF projection IS DISTINCT FROM latest OR actual_count<>projection THEN
  RAISE EXCEPTION 'manufacturing projection requires the complete immutable version sequence' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER complete_version_projection AFTER INSERT OR UPDATE ON manufacturing_recipes
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_manufacturing_version_projection();
CREATE CONSTRAINT TRIGGER complete_version_projection AFTER INSERT ON manufacturing_recipe_versions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_manufacturing_version_projection();
