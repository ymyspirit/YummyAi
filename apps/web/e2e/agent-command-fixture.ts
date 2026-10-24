import { randomUUID } from "node:crypto";
import { createEntityId, TenantContextSchema } from "@yummyai/contracts";
import { AgentCommandOwnerReferenceSchema, type AgentCommandOriginal } from "@yummyai/contracts/ai/agent-command";
import { PrepareProcurementCommandSchema, ProcurementCommandViewSchema } from "@yummyai/contracts/procurement/procurement-command";
import { FinanceCommandDetailSchema, PrepareFinanceCommandSchema } from "@yummyai/contracts/finance/finance-command";
import { connectDatabase, roles, withTenant } from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { requireDisposableIntegrationEnvironment } from "../../../tools/testing/require-disposable-integration.mjs";
import { actors, changeErpRights } from "./erp-identity-fixture";
import { centerApi } from "./order-centers-fixture";

export function requireAgentCommandBrowser() {
  const url = new URL(requireDisposableIntegrationEnvironment()), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  const api = new URL(process.env.API_BASE_URL ?? "https://invalid.invalid");
  if (!nonce || process.env.E2E_AGENT_COMMAND_ISOLATED !== "1" || process.env.E2E_ISOLATED_DAILY !== "1" ||
    process.env.E2E_COMPILED_WEB !== "1" || process.env.WEB_AUTH_MODE !== "personal" || process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" ||
    process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(api.hostname) || api.port !== "8130" || !process.env.ERP_FIXTURE_ACTORS)
    throw new Error("Agent command browser requires exact compiled personal3130/8130 current nonce resources before connection");
  return { url: url.href, nonce };
}

/** Node-side source setup uses actual HTTP business owners for the same real
 * personal actor later used by the browser. It makes no command outcome,
 * approval, model response or business proof directly in the database. */
export async function agentCommandBrowserFixture() {
  const isolated = requireAgentCommandBrowser(), actor = actors().operator;
  const context = TenantContextSchema.parse(await centerApi("identity/session"));
  if (context.tenantId !== actor.tenantId || context.userId !== actor.userId) throw new Error("Agent command fixture and personal browser actors differ");
  const database = connectDatabase(isolated.url);
  let originalRole: { permissions: string[]; dataScope: "self" | "team" | "tenant" };
  try {
    const [row] = await withTenant(database.db, context, tx => tx.select({ permissions: roles.permissions, dataScope: roles.dataScope }).from(roles).where(eq(roles.id, actor.roleId)));
    if (!row) throw new Error("Actual personal role unavailable");
    const parsed = TenantContextSchema.parse({ ...context, permissions: [...row.permissions], dataScope: row.dataScope });
    originalRole = { permissions: [...parsed.permissions], dataScope: parsed.dataScope };
  } catch (error) { await database.client.end(); throw error; }
  let closed = false;
  async function source(domain: "procurement" | "finance") {
    const marker = "AGENT-" + createEntityId().slice(-8).toUpperCase();
    const supplier = await centerApi<{ id: string }>("sourcing/suppliers", { name: "Synthetic " + marker, kind: "manual", regionCode: "US", settlementCurrency: "USD" });
    let original: AgentCommandOriginal, commandId: string;
    if (domain === "procurement") {
      const warehouse = await centerApi<{ id: string }>("inventory/warehouses", { code: marker + "-WH", name: "Synthetic Agent warehouse", type: "owned", countryCode: "US", timeZone: "UTC" });
      const location = await centerApi<{ id: string }>("inventory/locations", { warehouseId: warehouse.id, code: marker + "-LOC", name: "Synthetic Agent location" });
      const stock = await centerApi<{ id: string }>("inventory/stock-items", { code: marker + "-MAT", name: "Synthetic Agent material", skuId: null, baseUnit: "each", materialKind: "material" });
      const command = PrepareProcurementCommandSchema.parse({ kind: "requisition_create", targetId: null, input: { code: marker, reasonCode: "SYNTHETIC",
        lines: [{ lineKey: "LINE-1", stockItemId: stock.id, destinationLocationId: location.id, quantity: 20, unit: "each" }], idempotencyKey: randomUUID() } });
      original = { domain, command }; commandId = ProcurementCommandViewSchema.parse(await centerApi("procurement/commands", command)).id;
    } else {
      const command = PrepareFinanceCommandSchema.parse({ kind: "bill_record", targetId: null, input: { supplierId: supplier.id, kind: "factory_invoice",
        externalBillId: marker, currency: "USD", amountMinor: 12345, issuedAt: "2026-07-01T00:00:00.000Z", dueAt: null,
        procurementInvoiceId: null, idempotencyKey: randomUUID() } });
      original = { domain, command }; commandId = FinanceCommandDetailSchema.parse(await centerApi("finance/commands", command)).id;
    }
    return { marker, domain, original, reference: AgentCommandOwnerReferenceSchema.parse({ domain, commandId, accountId: null }) };
  }
  async function state() {
    return withTenant(database.db, context, async tx => {
      const result: Record<string, { count: number; hash: string }> = {};
      for (const table of ["inventory_procurement_requisitions", "inventory_procurement_write_requests", "finance_payable_bills", "finance_original_write_proofs",
        "inventory_movements", "inventory_reservations", "orders", "production_orders", "agent_command_requests", "ai_budget_ledger", "ai_assist_runs", "agent_loop_runs"])
        result[table] = (await tx.execute<{ count: number; hash: string }>(sql`select count(*)::int as count,
          md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) as hash from ${sql.identifier(table)} t`))[0]!;
      return result;
    });
  }
  async function native(domain: "procurement" | "finance", id: string) {
    return domain === "procurement" ? ProcurementCommandViewSchema.parse(await centerApi("procurement/commands/" + id))
      : FinanceCommandDetailSchema.parse(await centerApi("finance/commands/" + id));
  }
  async function close() {
    if (closed) return; closed = true; const failures: unknown[] = [];
    try {
      await changeErpRights("operator", originalRole.permissions);
      const [actual] = await withTenant(database.db, context, tx => tx.select({ permissions: roles.permissions, dataScope: roles.dataScope }).from(roles).where(eq(roles.id, actor.roleId)));
      if (!actual || actual.dataScope !== originalRole.dataScope || JSON.stringify([...actual.permissions].sort()) !== JSON.stringify([...originalRole.permissions].sort()))
        throw new Error("Original personal role restoration differs");
    } catch (error) { failures.push(error); }
    try { await database.client.end(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Agent command browser fixture cleanup failed");
  }
  return { context, nonce: isolated.nonce, originalPermissions: [...originalRole.permissions], source, state, native,
    grant: (permissions: string[]) => changeErpRights("operator", permissions), close };
}
export type AgentCommandBrowserFixture = Awaited<ReturnType<typeof agentCommandBrowserFixture>>;
