import { createHash } from "node:crypto";

/** Pure metadata/identifier planner. It never connects, writes, deletes or emits row contents. */
export class OrderResetPlanError extends Error {
  constructor(code, table, column) {
    super(code);
    this.name = "OrderResetPlanError";
    this.code = code;
    if (table !== undefined) this.table = table;
    if (column !== undefined) this.column = column;
  }
}

export const PRESERVED_AUDIT_TABLES = Object.freeze(["audit_events"]);
export const PROTECTED_TABLES = Object.freeze([
  ...PRESERVED_AUDIT_TABLES,
  "organizations", "app_users", "memberships", "organization_memberships", "roles", "permissions",
  "marketplace_accounts", "skus", "listings", "listing_versions", "assets", "asset_versions",
  "product_spus", "product_specifications", "product_specification_versions", "product_sku_mappings",
  "print_profiles", "print_profile_versions", "sales_recipes", "sales_recipe_versions",
  "sales_packages", "sales_package_versions", "sales_channel_bindings", "sales_recipe_print_bindings",
  "manufacturing_recipes", "manufacturing_recipe_versions", "manufacturing_recipe_reviews",
  "manufacturing_recipe_commands", "manufacturing_bom_lines", "manufacturing_operations",
  "fulfillment_suppliers", "fulfillment_supplier_versions", "fulfillment_factories", "fulfillment_factory_versions",
  "factory_capability_versions", "factory_capacity_pools", "factory_capacity_versions",
  "factory_capacity_reservations", "factory_capacity_events", "factory_capacity_owner_proofs",
  "inventory_warehouses", "inventory_locations", "inventory_stock_items", "inventory_lots",
  "inventory_movements", "inventory_reservations", "inventory_reservation_events", "inventory_balances",
  "finance_payments", "finance_payment_allocations", "finance_allocation_releases", "finance_bank_accounts",
  "business_rule_sets", "business_rule_versions", "business_rule_snapshots", "schema_adoption_receipts",
]);

const ROOT_COLUMNS = Object.freeze({
  orders: ["tenant_id", "id", "source_snapshot_id"],
  amazon_order_report_batches: ["tenant_id", "id"],
  order_source_snapshots: ["tenant_id", "id", "normalized_order_id"],
});

const resourceTargets = Object.freeze({
  order: "orders", order_line: "order_lines", order_work_item: "order_work_items",
  production_order: "production_orders", shipment: "shipments",
  amazon_order_report: "amazon_order_report_batches", amazon_order_report_line: "amazon_order_report_lines",
  production_editor_project: "production_editor_projects", production_delivery: "production_delivery_packages",
  after_sales_case: "after_sales_cases", return_shipment: "return_shipments",
  factory_task: "factory_task_assignments", order_design_run: "order_design_agent_runs",
});

/** Exact typed references only. Unknown types and arbitrary text/JSON are never searched. */
export const BUSINESS_REFERENCE_RULES = Object.freeze([
  ...["inventory_lots", "inventory_movements", "inventory_reservations"].map(table => Object.freeze({
    table, typeColumn: "source_type", idColumn: "source_id",
    targets: Object.freeze({ order: "orders", order_line: "order_lines" }),
  })),
  ...["notifications", "webhook_events"].map(table => Object.freeze({
    table, typeColumn: "resource_type", idColumn: "resource_id", targets: resourceTargets,
  })),
]);

/** Remove a containing result only when it actually had children and every child is excluded. */
export const ORPHAN_CONTAINER_RULES = Object.freeze([
  { parent: "production_delivery_packages", child: "production_delivery_items", column: "package_id" },
  { parent: "production_batches", child: "production_batch_members", column: "batch_id" },
  { parent: "order_personalization_batches", child: "order_personalization_batch_items", column: "batch_id" },
  { parent: "finance_profit_runs", child: "finance_profit_contributions", column: "run_id" },
  { parent: "finance_allocated_profit_runs", child: "finance_allocated_profit_slices", column: "run_id" },
].map(Object.freeze));

const fail = (code, table, column) => { throw new OrderResetPlanError(code, table, column); };
const identifier = value => typeof value === "string" && /^[a-z_][a-z0-9_]*$/.test(value);
const own = (object, key) => Object.hasOwn(object, key);
const scalar = value => value === null || typeof value === "string" || typeof value === "boolean" ||
  typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
const tuple = (row, columns) => JSON.stringify(columns.map(column => row[column]));
const keyObject = (row, columns) => Object.fromEntries(columns.map(column => [column, row[column]]));
const sorted = values => [...values].sort();
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function identifiers(values, table, empty = false) {
  if (!Array.isArray(values) || !empty && !values.length || values.some(value => !identifier(value)) || new Set(values).size !== values.length)
    fail("invalid_metadata", table);
  return [...values];
}

function normalizeTables(input) {
  if (!Array.isArray(input)) fail("invalid_metadata");
  const result = new Map();
  for (const table of input) {
    if (!table || !identifier(table.name) || result.has(table.name)) fail("invalid_metadata");
    const columns = identifiers(table.columns?.map(column => typeof column === "string" ? column : column?.name), table.name, true);
    const primaryKey = identifiers(table.primaryKey, table.name, true);
    if (primaryKey.some(column => !columns.includes(column))) fail("missing_column", table.name);
    result.set(table.name, { name: table.name, columns, primaryKey });
  }
  for (const name of Object.keys(ROOT_COLUMNS)) if (!result.has(name)) fail("missing_root_table", name);
  return result;
}

function normalizeForeignKeys(input, tables) {
  if (!Array.isArray(input)) fail("invalid_metadata");
  const result = [], seen = new Set();
  for (const raw of input) {
    if (!raw || !identifier(raw.child) || !identifier(raw.parent) || !identifier(raw.name) || !tables.has(raw.child) || !tables.has(raw.parent))
      fail("invalid_foreign_key");
    let columns = raw.columns, referencedColumns = raw.referencedColumns;
    if (columns === undefined && referencedColumns === undefined && typeof raw.definition === "string") {
      const match = /^FOREIGN KEY\s*\(([^)]+)\)\s+REFERENCES\s+(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?\s*\(([^)]+)\)(?:\s|$)/.exec(raw.definition);
      if (!match || match[2] !== raw.parent) fail("invalid_foreign_key", raw.child);
      const parse = value => value.split(",").map(column => column.trim().replace(/^"([a-z_][a-z0-9_]*)"$/, "$1"));
      columns = parse(match[1]); referencedColumns = parse(match[3]);
    }
    columns = identifiers(columns, raw.child);
    referencedColumns = identifiers(referencedColumns, raw.parent);
    if (columns.length !== referencedColumns.length || columns.some(column => !tables.get(raw.child).columns.includes(column)) ||
      referencedColumns.some(column => !tables.get(raw.parent).columns.includes(column))) fail("invalid_foreign_key", raw.child);
    const signature = JSON.stringify([raw.child, raw.name]);
    if (seen.has(signature)) fail("duplicate_foreign_key", raw.child);
    seen.add(signature);
    result.push({ name: raw.name, child: raw.child, parent: raw.parent, columns, referencedColumns });
  }
  return result.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
}

function projectionColumns(tables, foreignKeys) {
  const required = new Map([...tables].map(([name, table]) => [name, new Set([
    ...table.primaryKey, ...(table.columns.includes("tenant_id") ? ["tenant_id"] : []),
  ])]));
  const add = (table, columns) => {
    if (!tables.has(table)) return;
    for (const column of columns) {
      if (!tables.get(table).columns.includes(column)) fail("missing_column", table, column);
      required.get(table).add(column);
    }
  };
  for (const [table, columns] of Object.entries(ROOT_COLUMNS)) add(table, columns);
  for (const fk of foreignKeys) { add(fk.child, fk.columns); add(fk.parent, fk.referencedColumns); }
  for (const rule of BUSINESS_REFERENCE_RULES) add(rule.table, [rule.typeColumn, rule.idColumn]);
  for (const rule of ORPHAN_CONTAINER_RULES) if (tables.has(rule.parent) && tables.has(rule.child)) {
    add(rule.parent, ["tenant_id", "id"]); add(rule.child, ["tenant_id", rule.column]);
  }
  return Object.fromEntries(sorted(required.keys()).map(table => [table, sorted(required.get(table))]));
}

/** Metadata-only helper for the authenticated, read-only projection exporter. */
export function orderResetProjectionColumns(rawTables, rawForeignKeys) {
  const tables = normalizeTables(rawTables), foreignKeys = normalizeForeignKeys(rawForeignKeys, tables);
  return projectionColumns(tables, foreignKeys);
}

/**
 * rows is a map of table names to scalar projections; table.rows is also accepted.
 * primaryKey must be an actual PK or a separately verified non-null unique tuple.
 * Missing non-tenant/global rows are deliberately preserved, never selected.
 */
export function planOrderReset(input) {
  if (!input || typeof input.tenantId !== "string" || !input.tenantId || input.tenantId.trim() !== input.tenantId) fail("invalid_tenant");
  const tenantId = input.tenantId, tables = normalizeTables(input.tables);
  const foreignKeys = normalizeForeignKeys(input.foreignKeys, tables);
  const requiredColumns = projectionColumns(tables, foreignKeys);
  if (input.rows !== undefined && (!input.rows || typeof input.rows !== "object" || Array.isArray(input.rows))) fail("invalid_rows");
  for (const name of Object.keys(input.rows ?? {})) if (!tables.has(name)) fail("unknown_table", name);
  const protectedTables = new Set(PROTECTED_TABLES);
  if (input.protectedTables !== undefined) for (const name of identifiers(input.protectedTables, undefined, true)) protectedTables.add(name);
  const rows = new Map(), excluded = new Map(), reasons = new Map();
  for (const [name, table] of tables) {
    const embedded = input.tables.find(value => value.name === name).rows;
    if (own(input.rows ?? {}, name) && embedded !== undefined) fail("ambiguous_rows", name);
    const projected = own(input.rows ?? {}, name) ? input.rows[name] : embedded;
    if (projected === undefined && table.columns.includes("tenant_id")) fail("missing_rows", name);
    if (projected !== undefined && !Array.isArray(projected)) fail("invalid_rows", name);
    const entries = projected ?? [], seen = new Set();
    if (entries.length && !table.primaryKey.length) fail("missing_primary_key", name);
    for (const row of entries) {
      if (!row || typeof row !== "object" || Array.isArray(row)) fail("invalid_rows", name);
      for (const column of requiredColumns[name]) if (!own(row, column)) fail("missing_column", name, column);
      for (const [column, value] of Object.entries(row)) if (!table.columns.includes(column) || !scalar(value)) fail("invalid_projection", name, column);
      if (table.primaryKey.some(column => row[column] === null)) fail("null_primary_key", name);
      const key = tuple(row, table.primaryKey);
      if (seen.has(key)) fail("duplicate_primary_key", name);
      seen.add(key);
    }
    rows.set(name, entries); excluded.set(name, new Map()); reasons.set(name, new Set());
  }
  let changed = false;
  const mark = (table, row, reason) => {
    if (row.tenant_id !== tenantId) fail("cross_tenant_reference", table);
    if (protectedTables.has(table)) fail("protected_table_hit", table);
    const key = tuple(row, tables.get(table).primaryKey);
    reasons.get(table).add(reason);
    if (!excluded.get(table).has(key)) { excluded.get(table).set(key, row); changed = true; }
  };
  for (const table of ["orders", "amazon_order_report_batches"])
    for (const row of rows.get(table)) if (row.tenant_id === tenantId) mark(table, row, "seed");
  const seedCounts = Object.fromEntries(["orders", "amazon_order_report_batches"].map(table => [table, excluded.get(table).size]));
  do {
    changed = false;
    const indexes = new Map();
    const index = (table, columns) => {
      const signature = JSON.stringify([table, columns]);
      if (!indexes.has(signature)) indexes.set(signature, new Set([...(excluded.get(table)?.values() ?? [])]
        .filter(row => columns.every(column => row[column] !== null && row[column] !== undefined)).map(row => tuple(row, columns))));
      return indexes.get(signature);
    };
    const orderIds = index("orders", ["id"]), snapshotIds = index("orders", ["source_snapshot_id"]);
    for (const row of rows.get("order_source_snapshots")) if (
      orderIds.has(tuple(row, ["normalized_order_id"])) || snapshotIds.has(tuple(row, ["id"]))) mark("order_source_snapshots", row, "order_source");
    for (const fk of foreignKeys) {
      if (!excluded.get(fk.parent).size) continue;
      const selected = index(fk.parent, fk.referencedColumns);
      for (const row of rows.get(fk.child)) if (fk.columns.every(column => row[column] !== null) && selected.has(tuple(row, fk.columns))) mark(fk.child, row, `fk:${fk.name}`);
    }
    for (const rule of BUSINESS_REFERENCE_RULES) for (const row of rows.get(rule.table) ?? []) {
      const target = own(rule.targets, row[rule.typeColumn]) ? rule.targets[row[rule.typeColumn]] : undefined;
      if (target && row[rule.idColumn] !== null && index(target, ["id"]).has(tuple(row, [rule.idColumn]))) mark(rule.table, row, `business:${rule.typeColumn}:${row[rule.typeColumn]}`);
    }
    for (const rule of ORPHAN_CONTAINER_RULES) {
      if (!tables.has(rule.parent) || !tables.has(rule.child)) continue;
      for (const row of rows.get(rule.parent)) if (row.tenant_id === tenantId) {
        const children = rows.get(rule.child).filter(child => child.tenant_id === tenantId && child[rule.column] === row.id);
        if (children.length && children.every(child => excluded.get(rule.child).has(tuple(child, tables.get(rule.child).primaryKey)))) mark(rule.parent, row, `container:${rule.child}`);
      }
    }
  } while (changed);
  const selected = sorted(tables.keys()).filter(table => excluded.get(table).size);
  const counts = Object.fromEntries(selected.map(table => [table, excluded.get(table).size]));
  const exclusions = selected.map(table => ({
    table, primaryKey: [...tables.get(table).primaryKey],
    keys: [...excluded.get(table)].sort(([a], [b]) => compare(a, b)).map(([, row]) => keyObject(row, tables.get(table).primaryKey)),
  }));
  const projectionRequirements = selected.filter(table => table.startsWith("finance_")).length ? ["verify_remaining_finance_result_sources"] : [];
  const fingerprint = createHash("sha256").update(JSON.stringify({ tenantId, excluded: exclusions })).digest("hex");
  return {
    version: 1, tenantId, excluded: exclusions, counts, totalRows: Object.values(counts).reduce((sum, count) => sum + count, 0),
    seedCounts, reasons: selected.map(table => ({ table, reasons: sorted(reasons.get(table)) })),
    requiredColumns, preservedAuditTables: [...PRESERVED_AUDIT_TABLES], projectionRequirements, fingerprint,
  };
}
