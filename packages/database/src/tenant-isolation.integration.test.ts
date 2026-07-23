import { randomBytes } from "node:crypto";

import type { TenantContext } from "@yummyai/contracts";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assetFiles,
  connectDatabase,
  marketplaceAutomationRules,
  migrateDatabase,
  withTenant,
} from "./index.js";

function uuidV7(): string {
  const bytes = randomBytes(16);
  let timestamp = BigInt(Date.now());

  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function tenantContext(tenantId: string): TenantContext {
  return {
    tenantId,
    userId: uuidV7(),
    permissions: ["assets:read", "assets:write"],
    dataScope: "tenant",
  };
}

describe("tenant isolation", () => {
  const database = connectDatabase();
  const tenantA = tenantContext(uuidV7());
  const tenantB = tenantContext(uuidV7());
  const assetAId = uuidV7();
  const assetBId = uuidV7();
  const automationRuleAId = uuidV7();
  const automationRuleBId = uuidV7();

  beforeAll(async () => {
    await migrateDatabase(database);

    await database.client.unsafe(
      `insert into organizations (id, name, slug) values ($1, $2, $3), ($4, $5, $6)`,
      [tenantA.tenantId, "Tenant A", `tenant-a-${tenantA.tenantId}`, tenantB.tenantId, "Tenant B", `tenant-b-${tenantB.tenantId}`],
    );

    await withTenant(database.db, tenantA, (tx) =>
      tx.insert(assetFiles).values({
        id: assetAId,
        tenantId: tenantA.tenantId,
        objectKey: `authorized/${assetAId}`,
        assetDomain: "authorized",
        fileName: "tenant-a.png",
        mediaType: "image/png",
        byteSize: 10,
        checksumSha256: "a".repeat(64),
      }),
    );

    await withTenant(database.db, tenantB, (tx) =>
      tx.insert(assetFiles).values({
        id: assetBId,
        tenantId: tenantB.tenantId,
        objectKey: `research/${assetBId}`,
        assetDomain: "research",
        fileName: "tenant-b.png",
        mediaType: "image/png",
        byteSize: 20,
        checksumSha256: "b".repeat(64),
      }),
    );

    await withTenant(database.db, tenantA, (tx) => tx.insert(marketplaceAutomationRules).values({
      id: automationRuleAId,
      tenantId: tenantA.tenantId,
      name: "Tenant A approval rule",
      trigger: "listing_approved",
      conditions: { minimumCompleteness: 100 },
      action: { type: "queue_publication", accountId: uuidV7(), marketplaceId: "ATVPDKIKX0DER" },
    }));
    await withTenant(database.db, tenantB, (tx) => tx.insert(marketplaceAutomationRules).values({
      id: automationRuleBId,
      tenantId: tenantB.tenantId,
      name: "Tenant B approval rule",
      trigger: "listing_approved",
      conditions: { minimumCompleteness: 100 },
      action: { type: "queue_publication", accountId: uuidV7(), marketplaceId: "etsy" },
    }));
  });

  afterAll(async () => {
    await database.client.end();
  });

  it("prevents tenant A from reading tenant B records", async () => {
    const rows = await withTenant(database.db, tenantA, (tx) => tx.select().from(assetFiles));

    expect(rows.map((row) => row.id)).toEqual([assetAId]);
  });

  it("rejects a cross-tenant insert", async () => {
    await expect(
      withTenant(database.db, tenantA, (tx) =>
        tx.insert(assetFiles).values({
          id: uuidV7(),
          tenantId: tenantB.tenantId,
          objectKey: `research/${uuidV7()}`,
          assetDomain: "research",
          fileName: "forbidden.png",
          mediaType: "image/png",
          byteSize: 30,
          checksumSha256: "c".repeat(64),
        }),
      ),
    ).rejects.toThrow();
  });

  it("cannot update another tenant's row", async () => {
    const updated = await withTenant(database.db, tenantA, (tx) =>
      tx
        .update(assetFiles)
        .set({ fileName: "stolen.png" })
        .where(eq(assetFiles.id, assetBId))
        .returning({ id: assetFiles.id }),
    );

    expect(updated).toEqual([]);
  });

  it("cannot delete another tenant's row", async () => {
    const deleted = await withTenant(database.db, tenantA, (tx) =>
      tx.delete(assetFiles).where(eq(assetFiles.id, assetBId)).returning({ id: assetFiles.id }),
    );

    expect(deleted).toEqual([]);
  });

  it("applies tenant isolation to raw SQL", async () => {
    const result = await withTenant(database.db, tenantA, (tx) =>
      tx.execute(sql`select id from asset_files order by id`),
    );

    expect(result.map((row) => row.id)).toEqual([assetAId]);
  });

  it("isolates mutable marketplace automation configuration by tenant", async () => {
    const visible = await withTenant(database.db, tenantA, (tx) => tx.select().from(marketplaceAutomationRules));
    expect(visible.map((row) => row.id)).toEqual([automationRuleAId]);

    const updated = await withTenant(database.db, tenantA, (tx) => tx.update(marketplaceAutomationRules)
      .set({ enabled: true })
      .where(eq(marketplaceAutomationRules.id, automationRuleBId))
      .returning({ id: marketplaceAutomationRules.id }));
    expect(updated).toEqual([]);
  });

  it("grants append-only access to marketplace and order evidence", async () => {
    const [privileges] = await withTenant(database.db, tenantA, (tx) => tx.execute(sql`
      select
        has_table_privilege(current_user, 'listing_replications', 'UPDATE') as replication_update,
        has_table_privilege(current_user, 'marketplace_listing_sync_requests', 'UPDATE') as sync_request_update,
        has_table_privilege(current_user, 'marketplace_listing_sync_events', 'DELETE') as sync_event_delete,
        has_table_privilege(current_user, 'marketplace_automation_runs', 'UPDATE') as automation_run_update,
        has_table_privilege(current_user, 'marketplace_automation_rules', 'UPDATE') as automation_rule_update,
        has_table_privilege(current_user, 'order_source_snapshots', 'UPDATE') as order_snapshot_update,
        has_table_privilege(current_user, 'order_lines', 'DELETE') as order_line_delete,
        has_table_privilege(current_user, 'order_events', 'UPDATE') as order_event_update,
        has_table_privilege(current_user, 'order_exception_events', 'DELETE') as order_exception_event_delete,
        has_table_privilege(current_user, 'order_protected_access_events', 'UPDATE') as order_access_event_update,
        has_table_privilege(current_user, 'orders', 'UPDATE') as order_projection_update,
        has_table_privilege(current_user, 'order_protected_details', 'DELETE') as order_protected_delete,
        has_table_privilege(current_user, 'order_ingestion_runs', 'UPDATE') as order_ingestion_run_update,
        has_table_privilege(current_user, 'order_ingestion_runs', 'DELETE') as order_ingestion_run_delete,
        has_table_privilege(current_user, 'order_ingestion_risks', 'UPDATE') as order_ingestion_risk_update,
        has_table_privilege(current_user, 'order_line_catalog_links', 'UPDATE') as order_catalog_link_update
        ,has_table_privilege(current_user, 'order_customization_requirements', 'UPDATE') as customization_requirement_update
        ,has_table_privilege(current_user, 'order_customization_versions', 'UPDATE') as customization_version_update
        ,has_table_privilege(current_user, 'order_customization_versions', 'DELETE') as customization_version_delete
        ,has_table_privilege(current_user, 'order_customization_file_intakes', 'UPDATE') as customization_file_update
        ,has_table_privilege(current_user, 'order_customization_file_scan_events', 'UPDATE') as customization_scan_update
        ,has_table_privilege(current_user, 'order_proof_versions', 'UPDATE') as proof_version_update
        ,has_table_privilege(current_user, 'order_proof_decisions', 'UPDATE') as proof_decision_update
        ,has_table_privilege(current_user, 'fulfillment_suppliers', 'UPDATE') as supplier_projection_update
        ,has_table_privilege(current_user, 'supplier_capability_snapshots', 'UPDATE') as supplier_capability_update
        ,has_table_privilege(current_user, 'supplier_quotes', 'DELETE') as supplier_quote_delete
        ,has_table_privilege(current_user, 'supplier_capacity_windows', 'UPDATE') as supplier_capacity_update
        ,has_table_privilege(current_user, 'routing_policy_versions', 'UPDATE') as routing_policy_update
        ,has_table_privilege(current_user, 'order_routing_decisions', 'UPDATE') as routing_decision_update
        ,has_table_privilege(current_user, 'production_order_candidates', 'UPDATE') as routing_candidate_update
        ,has_table_privilege(current_user, 'order_routing_decision_events', 'DELETE') as routing_event_delete
        ,has_table_privilege(current_user, 'purchase_orders', 'UPDATE') as purchase_order_update
        ,has_table_privilege(current_user, 'purchase_order_versions', 'UPDATE') as purchase_order_version_update
        ,has_table_privilege(current_user, 'production_orders', 'UPDATE') as production_order_update
        ,has_table_privilege(current_user, 'production_order_versions', 'UPDATE') as production_order_version_update
        ,has_table_privilege(current_user, 'production_milestone_events', 'DELETE') as production_milestone_delete
        ,has_table_privilege(current_user, 'quality_standard_versions', 'UPDATE') as quality_standard_update
        ,has_table_privilege(current_user, 'quality_inspections', 'UPDATE') as quality_inspection_update
        ,has_table_privilege(current_user, 'quality_defects', 'DELETE') as quality_defect_delete
        ,has_table_privilege(current_user, 'production_recovery_cases', 'UPDATE') as production_recovery_update
        ,has_table_privilege(current_user, 'production_batches', 'UPDATE') as production_batch_update
        ,has_table_privilege(current_user, 'production_batch_members', 'UPDATE') as production_batch_member_update
        ,has_table_privilege(current_user, 'production_batch_events', 'DELETE') as production_batch_event_delete
        ,has_table_privilege(current_user, 'production_recovery_events', 'UPDATE') as production_recovery_event_update
        ,has_table_privilege(current_user, 'shipments', 'UPDATE') as shipment_update
        ,has_table_privilege(current_user, 'shipment_versions', 'UPDATE') as shipment_version_update
        ,has_table_privilege(current_user, 'shipment_packages', 'DELETE') as shipment_package_delete
        ,has_table_privilege(current_user, 'shipment_package_lines', 'UPDATE') as shipment_package_line_update
        ,has_table_privilege(current_user, 'shipment_version_reviews', 'UPDATE') as shipment_review_update
        ,has_table_privilege(current_user, 'shipment_writeback_requests', 'UPDATE') as shipment_writeback_request_update
        ,has_table_privilege(current_user, 'shipment_writeback_events', 'DELETE') as shipment_writeback_event_delete
        ,has_table_privilege(current_user, 'shipment_tracking_events', 'UPDATE') as shipment_tracking_event_update
        ,has_table_privilege(current_user, 'after_sales_cases', 'UPDATE') as after_sales_case_update
        ,has_table_privilege(current_user, 'after_sales_decisions', 'UPDATE') as after_sales_decision_update
        ,has_table_privilege(current_user, 'after_sales_responsibility_evidence', 'DELETE') as responsibility_evidence_delete
        ,has_table_privilege(current_user, 'customer_contact_records', 'UPDATE') as customer_contact_update
        ,has_table_privilege(current_user, 'replacement_order_links', 'UPDATE') as replacement_link_update
        ,has_table_privilege(current_user, 'return_shipments', 'UPDATE') as return_shipment_update
        ,has_table_privilege(current_user, 'return_tracking_events', 'DELETE') as return_tracking_event_delete
        ,has_table_privilege(current_user, 'fulfillment_automation_policies', 'UPDATE') as fulfillment_automation_policy_update
        ,has_table_privilege(current_user, 'fulfillment_automation_tasks', 'UPDATE') as fulfillment_automation_task_update
        ,has_table_privilege(current_user, 'fulfillment_automation_events', 'UPDATE') as fulfillment_automation_event_update
    `));
    expect(privileges).toMatchObject({
      automation_rule_update: true,
      automation_run_update: false,
      after_sales_case_update: true,
      after_sales_decision_update: false,
      fulfillment_automation_policy_update: true,
      fulfillment_automation_task_update: true,
      fulfillment_automation_event_update: false,
      customization_file_update: true,
      customization_requirement_update: true,
      customization_scan_update: false,
      customization_version_delete: false,
      customization_version_update: false,
      order_access_event_update: false,
      order_event_update: false,
      order_exception_event_delete: false,
      order_catalog_link_update: false,
      order_ingestion_risk_update: false,
      order_ingestion_run_delete: false,
      order_ingestion_run_update: true,
      order_line_delete: false,
      order_projection_update: true,
      order_protected_delete: false,
      order_snapshot_update: false,
      responsibility_evidence_delete: false,
      proof_decision_update: false,
      proof_version_update: false,
      production_milestone_delete: false,
      production_batch_event_delete: false,
      production_batch_member_update: false,
      production_batch_update: true,
      production_order_update: true,
      production_order_version_update: false,
      production_recovery_event_update: false,
      production_recovery_update: true,
      purchase_order_update: true,
      purchase_order_version_update: false,
      replication_update: false,
      routing_candidate_update: false,
      routing_decision_update: true,
      routing_event_delete: false,
      routing_policy_update: false,
      customer_contact_update: false,
      replacement_link_update: false,
      return_shipment_update: true,
      return_tracking_event_delete: false,
      shipment_package_delete: false,
      shipment_package_line_update: false,
      shipment_review_update: false,
      shipment_tracking_event_update: false,
      shipment_update: true,
      shipment_version_update: false,
      shipment_writeback_event_delete: false,
      shipment_writeback_request_update: true,
      quality_defect_delete: false,
      quality_inspection_update: false,
      quality_standard_update: false,
      supplier_capacity_update: false,
      supplier_capability_update: false,
      supplier_projection_update: true,
      supplier_quote_delete: false,
      sync_event_delete: false,
      sync_request_update: false,
    });
  });
});
