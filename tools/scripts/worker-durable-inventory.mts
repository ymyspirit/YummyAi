import { connectDatabase } from "../../packages/database/src/client.ts";

/** ADR-002 offline operations: aggregate state only, never a tenant request path. */
export async function inspectLocalDurableWorkerState() {
  const url = new URL(process.env.DATABASE_URL!);
  if (!new Set(["localhost", "127.0.0.1", "[::1]"]).has(url.hostname) || !["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("durable_inspection_requires_local_database");
  const database = connectDatabase();
  try {
    return await database.client.begin("isolation level repeatable read read only", async transaction => {
      const columns = await transaction.unsafe("select table_name,column_name from information_schema.columns where table_schema='public' and column_name in ('status','state','phase','submission_state') order by table_name,column_name");
      const groups = new Map<string, string[]>();
      for (const column of columns) {
        if (!/^(?:ai_assist|pod_|order_design|production_.*render|workflow_|marketplace_publication|marketplace_listing_sync|shipment_writeback|logistics_|webhook_|creative_design_batch|mockup_batch|studio_generation|capture_media|amazon_order_report|order_personalization|personalization_template_source|knowledge_maintenance|fulfillment_automation)/.test(column.table_name)) continue;
        if (!/^[a-z_]+$/.test(column.table_name) || !/^[a-z_]+$/.test(column.column_name)) throw new Error("durable_inspection_invalid_metadata");
        groups.set(column.table_name, [...(groups.get(column.table_name) ?? []), column.column_name]);
      }
      const tables = [];
      for (const [table, fields] of groups) {
        const identifiers = fields.map(field => '"' + field + '"').join(",");
        const rows = await transaction.unsafe('select ' + identifiers + ',count(*)::int as count from public."' + table + '" group by ' + identifiers + ' order by ' + identifiers);
        tables.push({ table, states: rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, key === "count" || value === null || /^[a-z_]{1,60}$/.test(String(value)) ? value : "unrecognized_state"]))) });
      }
      return { transactionReadOnly: true, databaseSnapshotConsistent: true, coverage: "Aggregate state columns in declared execution domains; owner-specific dispatch eligibility requires separate review", rowPayloadsRead: false, workerStartAuthorized: false, tables };
    });
  } finally { await database.client.end(); }
}
