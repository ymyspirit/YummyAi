import assert from "node:assert/strict";
import test from "node:test";
import { OrderResetPlanError, planOrderReset } from "../scripts/order-reset-plan.mjs";

// Synthetic relational snapshots only. These tests never connect to a database,
// restore a dump, touch a queue, or certify an actual business reset.
const id = value => `00000000-0000-7000-8000-${value.toString(16).padStart(12, "0")}`;
const tenant = id(1), otherTenant = id(2);
const order = id(10), otherOrder = id(11), snapshot = id(20), otherSnapshot = id(21);
const batch = id(30), otherBatch = id(31), line = id(40), otherLine = id(41);

function table(name, rows, { primaryKey = ["tenant_id", "id"], columns = [] } = {}) {
  return {
    name,
    primaryKey,
    columns: [...new Set([...primaryKey, ...columns, ...rows.flatMap(row => Object.keys(row))])].sort(),
    rows,
  };
}

function fk(child, parent, columns, referencedColumns, name = `${child}_${parent}_fk`) {
  return { name, child, parent, columns, referencedColumns };
}

function fixture({ tables = [], foreignKeys = [] } = {}) {
  return {
    tenantId: tenant,
    tables: [
      table("orders", [
        { tenant_id: tenant, id: order, source_snapshot_id: snapshot, account_id: id(100), external_order_id: "synthetic-same-external-order" },
        { tenant_id: otherTenant, id: otherOrder, source_snapshot_id: otherSnapshot, account_id: id(101), external_order_id: "synthetic-same-external-order" },
      ]),
      table("amazon_order_report_batches", [
        { tenant_id: tenant, id: batch },
        { tenant_id: otherTenant, id: otherBatch },
      ]),
      table("order_source_snapshots", [
        { tenant_id: tenant, id: snapshot, normalized_order_id: order },
        { tenant_id: otherTenant, id: otherSnapshot, normalized_order_id: otherOrder },
      ]),
      ...tables,
    ],
    foreignKeys: [
      fk("orders", "order_source_snapshots", ["tenant_id", "source_snapshot_id"], ["tenant_id", "id"]),
      fk("order_source_snapshots", "orders", ["tenant_id", "normalized_order_id"], ["tenant_id", "id"]),
      ...foreignKeys,
    ],
  };
}

const keys = (plan, name) => plan.excluded.find(entry => entry.table === name)?.keys ?? [];
const count = (plan, name) => plan.counts[name] ?? 0;

function rejectPlan(input) {
  assert.throws(() => planOrderReset(input), error => {
    assert.ok(error instanceof OrderResetPlanError);
    assert.equal(typeof error.code, "string");
    assert.ok(error.code.length > 0);
    // Diagnostics identify the structural problem rather than private row values.
    assert.ok(!String(error.message).includes("private-synthetic-sentinel"));
    return true;
  });
}

test("reset plans exact target-tenant root and dependent primary keys while preserving the other tenant", () => {
  const input = fixture({
    tables: [table("order_lines", [
      { tenant_id: tenant, id: line, order_id: order },
      { tenant_id: otherTenant, id: otherLine, order_id: otherOrder },
    ])],
    foreignKeys: [fk("order_lines", "orders", ["tenant_id", "order_id"], ["tenant_id", "id"])],
  });
  const plan = planOrderReset(input);
  assert.equal(plan.version, 1);
  assert.equal(plan.tenantId, tenant);
  assert.deepEqual(keys(plan, "orders"), [{ tenant_id: tenant, id: order }]);
  assert.deepEqual(keys(plan, "order_source_snapshots"), [{ tenant_id: tenant, id: snapshot }]);
  assert.deepEqual(keys(plan, "amazon_order_report_batches"), [{ tenant_id: tenant, id: batch }]);
  assert.deepEqual(keys(plan, "order_lines"), [{ tenant_id: tenant, id: line }]);
  assert.equal(plan.totalRows, 4);
});

test("composite foreign keys compare the complete tuple rather than a coincidentally equal ID", () => {
  const sharedPart = id(45);
  const input = fixture({
    tables: [
      table("synthetic_composite_parent", [
        { tenant_id: tenant, id: sharedPart, order_id: order },
        { tenant_id: otherTenant, id: sharedPart, order_id: otherOrder },
      ]),
      table("synthetic_composite_child", [
        { tenant_id: tenant, id: line, parent_id: sharedPart },
        { tenant_id: otherTenant, id: otherLine, parent_id: sharedPart },
      ]),
    ],
    foreignKeys: [
      fk("synthetic_composite_parent", "orders", ["tenant_id", "order_id"], ["tenant_id", "id"]),
      fk("synthetic_composite_child", "synthetic_composite_parent", ["tenant_id", "parent_id"], ["tenant_id", "id"]),
    ],
  });
  const plan = planOrderReset(input);
  assert.deepEqual(keys(plan, "synthetic_composite_parent"), [{ tenant_id: tenant, id: sharedPart }]);
  assert.deepEqual(keys(plan, "synthetic_composite_child"), [{ tenant_id: tenant, id: line }]);
  assert.equal(count(plan, "orders"), 1);
});

test("nullable composite foreign keys do not match a selected parent when any component is NULL", () => {
  const input = fixture({
    tables: [table("order_lines", [
      { tenant_id: tenant, id: line, order_id: null },
      { tenant_id: tenant, id: otherLine, order_id: order },
    ])],
    foreignKeys: [fk("order_lines", "orders", ["tenant_id", "order_id"], ["tenant_id", "id"])],
  });
  assert.deepEqual(keys(planOrderReset(input), "order_lines"), [{ tenant_id: tenant, id: otherLine }]);
});

test("a real cross-tenant child dependency fails closed rather than deleting or silently ignoring the foreign row", () => {
  rejectPlan(fixture({
    tables: [table("order_lines", [{ tenant_id: otherTenant, id: line, order_id: order }])],
    foreignKeys: [fk("order_lines", "orders", ["order_id"], ["id"])],
  }));
});

test("dependency closure never traverses backwards into store or SKU master records", () => {
  const input = fixture({
    tables: [
      table("marketplace_accounts", [{ tenant_id: tenant, id: id(100) }, { tenant_id: otherTenant, id: id(101) }]),
      table("skus", [{ tenant_id: tenant, id: id(110) }]),
      table("order_lines", [{ tenant_id: tenant, id: line, order_id: order, sku_id: id(110) }]),
    ],
    foreignKeys: [
      fk("orders", "marketplace_accounts", ["tenant_id", "account_id"], ["tenant_id", "id"]),
      fk("order_lines", "orders", ["tenant_id", "order_id"], ["tenant_id", "id"]),
      fk("order_lines", "skus", ["tenant_id", "sku_id"], ["tenant_id", "id"]),
    ],
  });
  const plan = planOrderReset(input);
  assert.equal(count(plan, "order_lines"), 1);
  assert.equal(count(plan, "marketplace_accounts"), 0);
  assert.equal(count(plan, "skus"), 0);
});

test("an unexpected FK-dependent protected master record blocks the reset instead of expanding its scope", () => {
  rejectPlan(fixture({
    tables: [table("product_spus", [{ tenant_id: tenant, id: id(120), order_id: order }])],
    foreignKeys: [fk("product_spus", "orders", ["tenant_id", "order_id"], ["tenant_id", "id"])],
  }));
});

test("cyclic dependent rows reach a finite deduplicated closure", () => {
  const first = id(130), second = id(131);
  const input = fixture({
    tables: [table("order_reset_cycle_fixture", [
      { tenant_id: tenant, id: first, order_id: order, peer_id: second },
      { tenant_id: tenant, id: second, order_id: null, peer_id: first },
    ])],
    foreignKeys: [
      fk("order_reset_cycle_fixture", "orders", ["tenant_id", "order_id"], ["tenant_id", "id"]),
      fk("order_reset_cycle_fixture", "order_reset_cycle_fixture", ["tenant_id", "peer_id"], ["tenant_id", "id"]),
    ],
  });
  const plan = planOrderReset(input);
  assert.equal(count(plan, "order_reset_cycle_fixture"), 2);
  assert.deepEqual(new Set(keys(plan, "order_reset_cycle_fixture").map(key => key.id)), new Set([first, second]));
  assert.equal(plan.totalRows, 5);
});

test("same-external-number restart includes old immutable source and report linkage without touching the other store tenant", () => {
  const reportLine = id(140), theirReportLine = id(141);
  const input = fixture({
    tables: [
      table("order_lines", [
        { tenant_id: tenant, id: line, order_id: order },
        { tenant_id: otherTenant, id: otherLine, order_id: otherOrder },
      ]),
      table("amazon_order_report_lines", [
        { tenant_id: tenant, id: reportLine, order_id: order, order_line_id: line },
        { tenant_id: otherTenant, id: theirReportLine, order_id: otherOrder, order_line_id: otherLine },
      ]),
      table("amazon_order_report_batch_items", [
        { tenant_id: tenant, batch_id: batch, line_id: reportLine },
        { tenant_id: otherTenant, batch_id: otherBatch, line_id: theirReportLine },
      ], { primaryKey: ["tenant_id", "batch_id", "line_id"] }),
    ],
    foreignKeys: [
      fk("order_lines", "orders", ["tenant_id", "order_id"], ["tenant_id", "id"]),
      fk("amazon_order_report_lines", "order_lines", ["tenant_id", "order_line_id"], ["tenant_id", "id"]),
      fk("amazon_order_report_batch_items", "amazon_order_report_batches", ["tenant_id", "batch_id"], ["tenant_id", "id"]),
      fk("amazon_order_report_batch_items", "amazon_order_report_lines", ["tenant_id", "line_id"], ["tenant_id", "id"]),
    ],
  });
  const plan = planOrderReset(input);
  assert.deepEqual(keys(plan, "order_source_snapshots"), [{ tenant_id: tenant, id: snapshot }]);
  assert.deepEqual(keys(plan, "amazon_order_report_batch_items"), [{ tenant_id: tenant, batch_id: batch, line_id: reportLine }]);
  assert.equal(count(plan, "amazon_order_report_lines"), 1);
  assert.equal(plan.totalRows, 6);
});

test("declared non-FK resource identity requires the correct entity type and exact ID and preserves audit history", () => {
  const orderNotice = id(150), lineNotice = id(151), wrongType = id(152), unrelated = id(153);
  const input = fixture({
    tables: [
      table("order_lines", [{ tenant_id: tenant, id: line, order_id: order }]),
      table("notifications", [
        { tenant_id: tenant, id: orderNotice, resource_type: "order", resource_id: order },
        { tenant_id: tenant, id: lineNotice, resource_type: "order_line", resource_id: line },
        { tenant_id: tenant, id: wrongType, resource_type: "unknown_synthetic_entity", resource_id: order },
        { tenant_id: tenant, id: unrelated, resource_type: "order", resource_id: otherOrder },
        { tenant_id: tenant, id: id(155), resource_type: "order_line", resource_id: order },
        { tenant_id: tenant, id: id(156), resource_type: "order", resource_id: `${order} ` },
      ]),
      table("audit_events", [{ tenant_id: tenant, id: id(154), resource_type: "order", resource_id: order }]),
      table("synthetic_notes", [{ tenant_id: tenant, id: id(157), body: JSON.stringify({ orderId: order }) }]),
    ],
    foreignKeys: [fk("order_lines", "orders", ["tenant_id", "order_id"], ["tenant_id", "id"])],
  });
  const plan = planOrderReset(input);
  assert.deepEqual(new Set(keys(plan, "notifications").map(key => key.id)), new Set([orderNotice, lineNotice]));
  assert.equal(count(plan, "audit_events"), 0);
  assert.equal(count(plan, "synthetic_notes"), 0);
  assert.ok(plan.preservedAuditTables.includes("audit_events"));
});

test("PostgreSQL FK definitions use the same complete-tuple closure as explicit column arrays", () => {
  const input = fixture({ tables: [table("order_lines", [{ tenant_id: tenant, id: line, order_id: order }])] });
  const explicit = { ...input, foreignKeys: [...input.foreignKeys, fk("order_lines", "orders", ["tenant_id", "order_id"], ["tenant_id", "id"], "synthetic_definition_fk")] };
  const defined = { ...input, foreignKeys: [...input.foreignKeys, {
    name: "synthetic_definition_fk", child: "order_lines", parent: "orders",
    definition: "FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id) ON DELETE RESTRICT",
  }] };
  assert.deepEqual(planOrderReset(defined), planOrderReset(explicit));
});

test("identical empty roots produce an empty plan rather than a guessed deletion", () => {
  const input = fixture();
  for (const item of input.tables) item.rows = [];
  const plan = planOrderReset(input);
  assert.equal(plan.totalRows, 0);
  assert.deepEqual(plan.excluded, []);
});

test("missing roots, incomplete projections, duplicate primary keys and invalid FK metadata fail closed", () => {
  const missingRoot = fixture();
  missingRoot.tables = missingRoot.tables.filter(item => item.name !== "order_source_snapshots");
  rejectPlan(missingRoot);

  const missingColumn = fixture();
  missingColumn.tables[0].columns = missingColumn.tables[0].columns.filter(column => column !== "source_snapshot_id");
  rejectPlan(missingColumn);

  const missingRowValue = fixture();
  delete missingRowValue.tables[0].rows[0].source_snapshot_id;
  rejectPlan(missingRowValue);

  const duplicateKey = fixture();
  duplicateKey.tables[0].rows.push({ ...duplicateKey.tables[0].rows[0], external_order_id: "private-synthetic-sentinel" });
  rejectPlan(duplicateKey);

  const missingParent = fixture({ foreignKeys: [fk("orders", "unprovided_parent", ["account_id"], ["id"])] });
  rejectPlan(missingParent);

  const wrongArity = fixture({ foreignKeys: [fk("orders", "order_source_snapshots", ["tenant_id", "source_snapshot_id"], ["id"])] });
  rejectPlan(wrongArity);
});

test("a caller-declared extra protected table cannot be silently included in the removal plan", () => {
  const input = fixture({
    tables: [table("synthetic_retained_master", [{ tenant_id: tenant, id: id(160), order_id: order }])],
    foreignKeys: [fk("synthetic_retained_master", "orders", ["tenant_id", "order_id"], ["tenant_id", "id"])],
  });
  input.protectedTables = ["synthetic_retained_master"];
  rejectPlan(input);
});

test("planning is deterministic across repeats, row/table/FK input order and does not mutate its source", () => {
  const input = fixture({
    tables: [table("order_lines", [
      { tenant_id: tenant, id: otherLine, order_id: order },
      { tenant_id: tenant, id: line, order_id: order },
    ])],
    foreignKeys: [fk("order_lines", "orders", ["tenant_id", "order_id"], ["tenant_id", "id"])],
  });
  const before = globalThis.structuredClone(input);
  const first = planOrderReset(input), second = planOrderReset(input);
  assert.deepEqual(input, before);
  assert.deepEqual(second, first);
  const reordered = globalThis.structuredClone(input);
  reordered.tables.reverse();
  reordered.foreignKeys.reverse();
  for (const item of reordered.tables) {
    item.rows.reverse();
    item.columns.reverse();
  }
  assert.deepEqual(planOrderReset(reordered), first);
});

test("inventory metadata projections with separate rows and column descriptors preserve the same plan", () => {
  const input = fixture();
  const described = {
    ...input,
    tables: input.tables.map(item => ({ ...item, rows: undefined, columns: item.columns.map(name => ({ name, type: "text", nullable: true })) })),
    rows: Object.fromEntries(input.tables.map(item => [item.name, item.rows])),
  };
  assert.deepEqual(planOrderReset(described), planOrderReset(input));
});

test("actual inventory source references block the reset while unrelated opening stock stays preserved", () => {
  for (const name of ["inventory_lots", "inventory_movements", "inventory_reservations"]) {
    const input = fixture({ tables: [table(name, [{ tenant_id: tenant, id: id(170), source_type: "order", source_id: order }])] });
    assert.throws(() => planOrderReset(input), error => error instanceof OrderResetPlanError && error.code === "protected_table_hit" && error.table === name);
    // Callers can add protection but cannot remove the built-in inventory gate.
    input.protectedTables = [];
    rejectPlan(input);
  }
  const retained = fixture({ tables: [table("inventory_lots", [{ tenant_id: tenant, id: id(171), source_type: "opening", source_id: order }])] });
  assert.equal(count(planOrderReset(retained), "inventory_lots"), 0);
});

test("capacity reservations and booked payment dependencies fail closed without manufacturing a release or adjustment", () => {
  for (const name of ["factory_capacity_reservations", "finance_payments", "finance_payment_allocations"]) {
    const input = fixture({
      tables: [table(name, [{ tenant_id: tenant, id: id(180), order_id: order }])],
      foreignKeys: [fk(name, "orders", ["tenant_id", "order_id"], ["tenant_id", "id"])],
    });
    assert.throws(() => planOrderReset(input), error => error instanceof OrderResetPlanError && error.code === "protected_table_hit" && error.table === name);
  }
});

test("containing delivery packages are removed only with real children all selected, preserving mixed and empty packages", () => {
  const allOld = id(190), mixed = id(191), empty = id(192), notice = id(193);
  const input = fixture({
    tables: [
      table("production_delivery_packages", [allOld, mixed, empty].map(packageId => ({ tenant_id: tenant, id: packageId }))),
      table("production_delivery_items", [
        { tenant_id: tenant, id: id(194), package_id: allOld, order_id: order },
        { tenant_id: tenant, id: id(195), package_id: mixed, order_id: order },
        { tenant_id: tenant, id: id(196), package_id: mixed, order_id: null },
      ]),
      table("notifications", [{ tenant_id: tenant, id: notice, resource_type: "production_delivery", resource_id: allOld }]),
    ],
    foreignKeys: [
      fk("production_delivery_items", "orders", ["tenant_id", "order_id"], ["tenant_id", "id"]),
      fk("production_delivery_items", "production_delivery_packages", ["tenant_id", "package_id"], ["tenant_id", "id"]),
    ],
  });
  const plan = planOrderReset(input);
  assert.deepEqual(keys(plan, "production_delivery_packages"), [{ tenant_id: tenant, id: allOld }]);
  assert.equal(count(plan, "production_delivery_items"), 2);
  // The package becomes selected after the first reference pass; its notice
  // must still be found by the fixed point rather than left dangling.
  assert.deepEqual(keys(plan, "notifications"), [{ tenant_id: tenant, id: notice }]);
});

test("source cleanup includes every old normalized snapshot and the pinned source while preserving an unrelated tenant-local source", () => {
  const input = fixture();
  input.foreignKeys = [];
  const sources = input.tables.find(item => item.name === "order_source_snapshots");
  sources.rows.push({ tenant_id: tenant, id: id(200), normalized_order_id: order });
  sources.rows.push({ tenant_id: tenant, id: id(201), normalized_order_id: id(202) });
  // The current pinned source is still selected even with an inconsistent old
  // normalized ID; no FK is assumed for this explicit source identity rule.
  sources.rows[0].normalized_order_id = id(203);
  const plan = planOrderReset(input);
  assert.deepEqual(new Set(keys(plan, "order_source_snapshots").map(key => key.id)), new Set([snapshot, id(200)]));
});

test("typed non-FK references do not cross a tenant silently", () => {
  rejectPlan(fixture({ tables: [table("notifications", [{ tenant_id: otherTenant, id: id(210), resource_type: "order", resource_id: order }])] }));
});

test("a foreign-tenant soft source reference to the globally identified order blocks reset even without an FK", () => {
  const input = fixture();
  input.foreignKeys = [];
  input.tables.find(item => item.name === "order_source_snapshots").rows[1].normalized_order_id = order;
  assert.throws(() => planOrderReset(input), error => error instanceof OrderResetPlanError && error.code === "cross_tenant_reference" && error.table === "order_source_snapshots");
});

test("nonempty tables need a stable non-null unique key even when the requested deletion would otherwise be empty", () => {
  const noKey = fixture({ tables: [table("synthetic_child", [{ tenant_id: tenant, order_id: order }], { primaryKey: [] })] });
  rejectPlan(noKey);

  const nullKey = fixture();
  nullKey.tables[0].rows[0].id = null;
  rejectPlan(nullKey);
});

test("ambiguous row sources, unsupported scalar values and absent declared business columns are rejected", () => {
  const ambiguous = fixture();
  ambiguous.rows = { orders: ambiguous.tables[0].rows };
  rejectPlan(ambiguous);

  const missingReference = fixture({ tables: [table("notifications", [{ tenant_id: tenant, id: id(220), resource_type: "order" }])] });
  rejectPlan(missingReference);

  const unsafeInteger = fixture();
  unsafeInteger.tables[0].rows[0].id = Number.MAX_SAFE_INTEGER + 1;
  rejectPlan(unsafeInteger);
});
