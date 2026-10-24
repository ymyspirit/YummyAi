import { createHash } from "node:crypto";
import type { DatabaseClient } from "./client.js";
const sections = {
  columns: "select c.relname as table_name,a.attname as name,format_type(a.atttypid,a.atttypmod) as type,a.attnotnull as required,a.attidentity as identity,a.attgenerated as generated,pg_get_expr(d.adbin,d.adrelid) as default_value from pg_catalog.pg_attribute a join pg_catalog.pg_class c on c.oid=a.attrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace left join pg_catalog.pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum where n.nspname='public' and c.relkind in ('r','p','v','m') and a.attnum>0 and not a.attisdropped order by c.relname,a.attname",
  tables: "select c.relname as name,c.relkind as kind,pg_get_userbyid(c.relowner) as owner,c.relrowsecurity as rls,c.relforcerowsecurity as forced from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p','v','m') order by c.relname",
  // PostgreSQL preserves SQL precedence while removing redundant AND grouping
  // introduced by a pg_dump/pg_restore round trip; do not strip SQL with regex.
  constraints: "select t.relname as table_name,c.conname as name,c.contype as type,c.condeferrable as deferrable,c.condeferred as deferred,c.convalidated as validated,pg_get_constraintdef(c.oid,true) as definition from pg_catalog.pg_constraint c join pg_catalog.pg_class t on t.oid=c.conrelid join pg_catalog.pg_namespace n on n.oid=t.relnamespace where n.nspname='public' order by t.relname,c.conname",
  indexes: "select tablename as table_name,indexname as name,indexdef as definition from pg_catalog.pg_indexes where schemaname='public' order by tablename,indexname",
  policies: "select tablename as table_name,policyname as name,permissive,roles,cmd,qual,with_check from pg_catalog.pg_policies where schemaname='public' order by tablename,policyname",
  triggers: "select c.relname as table_name,t.tgname as name,t.tgenabled as enabled,pg_get_triggerdef(t.oid,false) as definition from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid=t.tgrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal order by c.relname,t.tgname",
  routines: "select p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' as name,pg_get_functiondef(p.oid) as definition,p.prosecdef as security_definer,case when p.prosecdef then pg_get_userbyid(p.proowner) else null end as definer_owner,has_function_privilege('yummyai_app',p.oid,'EXECUTE') as application_execute from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind in ('f','p') order by name",
  enums: "select t.typname as name,array_agg(e.enumlabel order by e.enumsortorder) as labels from pg_catalog.pg_type t join pg_catalog.pg_namespace n on n.oid=t.typnamespace join pg_catalog.pg_enum e on e.enumtypid=t.oid where n.nspname='public' group by t.typname order by t.typname",
  sequences: "select sequencename as name,data_type,start_value::text,min_value::text,max_value::text,increment_by::text,cycle,cache_size::text from pg_catalog.pg_sequences where schemaname='public' order by sequencename",
  grants: "select table_name,grantee,privilege_type as name,is_grantable from information_schema.role_table_grants where table_schema='public' and grantee in ('yummyai_app','PUBLIC') order by table_name,grantee,privilege_type",
  columnGrants: "select table_name,column_name,grantee,privilege_type as name,is_grantable from information_schema.column_privileges where table_schema='public' and grantee in ('yummyai_app','PUBLIC') order by table_name,column_name,grantee,privilege_type",
  schemaAccess: "select has_schema_privilege('yummyai_app','public','USAGE') as usage,has_schema_privilege('yummyai_app','public','CREATE') as can_create",
  migrationAccess: "select has_schema_privilege('yummyai_app','drizzle','USAGE') as usage,has_schema_privilege('yummyai_app','drizzle','CREATE') as can_create,has_table_privilege('yummyai_app','drizzle.__drizzle_migrations','SELECT') as can_read,has_table_privilege('yummyai_app','drizzle.__drizzle_migrations','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as can_mutate",
} as const;
export type SchemaSection = keyof typeof sections;
export type SchemaRow = Record<string, unknown>;
export type SchemaShape = Record<SchemaSection, SchemaRow[]>;
export interface SchemaSnapshot { algorithm: "postgres-public-schema-v1"; sha256: string; shape: SchemaShape }
export async function inspectDatabaseSchemaShape(client: DatabaseClient): Promise<SchemaSnapshot> {
  return client.begin("isolation level repeatable read read only", async tx => {
    const shape = {} as SchemaShape;
    await tx.unsafe("set local search_path to pg_catalog,public");
    for (const [name, query] of Object.entries(sections)) shape[name as SchemaSection] = JSON.parse(JSON.stringify(await tx.unsafe(query)));
    return { algorithm: "postgres-public-schema-v1" as const, sha256: schemaShapeHash(shape), shape };
  });
}
export function schemaShapeHash(shape: unknown) { return createHash("sha256").update(JSON.stringify(shape)).digest("hex"); }
function identity(section: SchemaSection, row: SchemaRow) {
  if (section === "schemaAccess" || section === "migrationAccess") return section;
  return [row.table_name || "", row.column_name || "", row.grantee || "", row.name || ""].join("/");
}
export function compareSchemaShapes(actual: SchemaSnapshot, expected: SchemaSnapshot) {
  const differences: Array<{ section: SchemaSection; name: string; disposition: "missing" | "unexpected" | "changed"; actual: SchemaRow | null; expected: SchemaRow | null }> = [];
  for (const section of Object.keys(sections) as SchemaSection[]) {
    const a = new Map(actual.shape[section].map(row => [identity(section, row), row] as const));
    const b = new Map(expected.shape[section].map(row => [identity(section, row), row]));
    for (const name of [...new Set([...a.keys(), ...b.keys()])].sort()) {
      if (JSON.stringify(a.get(name)) !== JSON.stringify(b.get(name))) differences.push({ section, name, disposition: !a.has(name) ? "missing" : !b.has(name) ? "unexpected" : "changed", actual: a.get(name) || null, expected: b.get(name) || null });
    }
  }
  return { equal: differences.length === 0, actualSha256: actual.sha256, expectedSha256: expected.sha256, differences };
}
