/** Disposable-only actual invoices; never connects or starts an API at import. */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { withTenant, type DatabaseConnection } from "@yummyai/database";
import type { StockQuantity } from "@yummyai/contracts/inventory/quantity";
import { PrepareProcurementCommandSchema } from "@yummyai/contracts/procurement/procurement-command";
import { IncomingInspectionService } from "./incoming-inspection.service.js";
import { procurementCommandFixture, procurementFixtureKey, requireProcurementCommandFixture } from "./procurement-command.fixtures.js";

export function requireInvoiceCommandFixture() {
  requireProcurementCommandFixture();
  if (process.env.E2E_INVOICE_COMMAND_ISOLATED !== "1") throw new Error("Invoice commands require their own disposable acceptance suite");
}
export const invoiceCommandKey = procurementFixtureKey;
export const invoiceCommandCode = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`;
export const invoiceFactTables = ["inventory_supplier_invoices", "inventory_supplier_invoice_lines", "inventory_supplier_invoice_requests",
  "inventory_supplier_invoice_allocations", "inventory_purchase_orders", "inventory_purchase_order_events", "inventory_procurement_write_requests",
  "inventory_lots", "inventory_movements", "inventory_balances"];

export function invoiceCommandFixture(database: DatabaseConnection) {
  requireInvoiceCommandFixture();
  const fixture = procurementCommandFixture(database), { context, owner, audit, inventory } = fixture;
  const incoming = new IncomingInspectionService(database, owner, audit);
  async function basis(receive = true) {
    const code = invoiceCommandCode("INVCMD"), now = await fixture.clock(), future = new Date(now.getTime() + 86_400_000).toISOString();
    const stock = await inventory.createStockItem(context, { code: `${code}-MAT`, name: "Synthetic invoice measured material", skuId: null, baseUnit: "gram" });
    const purchaseInput = { code: `${code}-PO`, supplierId: fixture.supplierId, requisitionId: null, quoteId: null,
      currency: "USD", expectedAt: future, lines: [{ lineKey: "LINE-1", stockItemId: stock.id, destinationLocationId: fixture.locationId,
        quantity: "0.25", unit: "kilogram" as const, unitCostMinor: 1200, priceBasisQuantity: 1 }], idempotencyKey: invoiceCommandKey() };
    const order = await owner.createPurchaseOrder(context, purchaseInput);
    if (receive) {
      await owner.reviewPurchaseOrder(context, order.id, { expectedVersion: 1, decision: "approved", reasonCode: "SYNTHETIC", idempotencyKey: invoiceCommandKey() });
      const at = (await fixture.clock()).toISOString();
      const arrival = await incoming.recordArrival(context, order.id, { code: `${code}-ARR`, expectedPurchaseOrderVersion: 1, arrivedAt: at,
        externalReference: "Synthetic actual invoice receipt basis", lines: [{ lineKey: "LINE-1", quantity: 200, unit: "gram",
          holdingLocationId: fixture.locationId, lotCode: `${code}-LOT`, expiresAt: null }], idempotencyKey: invoiceCommandKey() });
      const standard = await incoming.publishStandard(context, { code: `${code}-STD`, stockItemId: stock.id, expectedVersion: 0,
        title: "Synthetic actual receiving observations", sourceReference: "Isolated synthetic standard, no external supplier operation",
        criteria: [{ code: "WIDTH", label: "Synthetic width", kind: "numeric_range", unit: "mm", minimum: "9", maximum: "11" }], idempotencyKey: invoiceCommandKey() });
      const inspected = await incoming.recordInspection(context, arrival.lines[0]!.id, { expectedInspectionVersion: 0, standardVersionId: standard.id,
        acceptedQuantity: 200, rejectedQuantity: 0, sampleQuantity: 1, rejectionReason: null, measuredAt: at,
        readings: [{ criterionCode: "WIDTH", value: "10", unit: "mm" }], notes: null, idempotencyKey: invoiceCommandKey() });
      const reviewed = await incoming.reviewInspection(context, arrival.lines[0]!.id, { expectedInspectionVersion: 1, inspectionId: inspected.inspections[0]!.id,
        decision: "approved", reason: "Synthetic original measurements checked", idempotencyKey: invoiceCommandKey() });
      await incoming.postInspection(context, arrival.lines[0]!.id, { expectedInspectionVersion: 1, approvalId: reviewed.inspections[0]!.review!.id,
        acceptedQuantity: 200, rejectedQuantity: 0, rejectionLocationId: null, ownershipConfirmation: "merchant_received", postedAt: at, idempotencyKey: invoiceCommandKey() });
    }
    return { stock, order, code, purchaseInput };
  }
  function original(orderId: string, options: { quantity?: StockQuantity; unitCostMinor?: number; priceBasisQuantity?: StockQuantity; currency?: string; expectedVersion?: number } = {}) {
    const date = new Date(); date.setUTCMilliseconds(0);
    const value = PrepareProcurementCommandSchema.parse({ kind: "invoice_record", targetId: orderId,
      input: { expectedVersion: options.expectedVersion ?? 1, invoiceNumber: invoiceCommandCode("INV"), currency: options.currency ?? "USD", issuedAt: date.toISOString(),
        lines: [{ lineKey: "LINE-1", invoicedQuantity: options.quantity ?? "0.1", unitCostMinor: options.unitCostMinor ?? 1200,
          ...(options.priceBasisQuantity === undefined ? {} : { priceBasisQuantity: options.priceBasisQuantity }) }], idempotencyKey: invoiceCommandKey() } });
    if (value.kind !== "invoice_record") throw new Error("Synthetic invoice command was parsed as another operation");
    return value;
  }
  async function state(tables = invoiceFactTables) {
    return withTenant(database.db, context, async tx => {
      const result: Record<string, { count: number; digest: string }> = {};
      for (const table of tables) {
        const rows = await tx.execute(sql`select * from ${sql.identifier(table)} order by id`);
        result[table] = { count: rows.length, digest: createHash("sha256").update(JSON.stringify(rows)).digest("hex") };
      }
      return result;
    });
  }
  return { ...fixture, basis, original, state, incoming,
    get locationId() { return fixture.locationId; }, get supplierId() { return fixture.supplierId; } };
}

type Event = { type: string; phase?: string; code?: string; url?: string; pid?: number; commandId?: string; seed?: unknown };
const safeCode = /^(?:[0-9A-Z]{5}|ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT)$/;
export function observeInvoiceProcess(child: ChildProcess) {
  const events: Event[] = []; let exited = false;
  child.stdout?.on("data", () => {}); child.stderr?.on("data", () => {});
  const closed = new Promise<number>(resolve => { child.once("error", () => { exited = true; resolve(-1); }); child.once("exit", code => { exited = true; resolve(code ?? -1); }); });
  child.on("message", event => { if (event && typeof event === "object" && "type" in event && typeof event.type === "string") events.push(event as Event); });
  const diagnostics = () => {
    const failure = events.findLast(event => event.type.endsWith(".failed"));
    if (!failure) return "";
    const phase = /^[a-z][a-z0-9-]{0,63}$/.test(failure.phase ?? "") ? failure.phase : "unknown";
    return ` (phase=${phase}${safeCode.test(failure.code ?? "") ? ` code=${failure.code}` : ""})`;
  };
  return { child, events, closed,
    wait(type: string, phase?: string, timeoutMs = 35_000): Promise<Event> {
      return new Promise((resolve, reject) => {
        const find = () => events.find(event => event.type === type && (!phase || event.phase === phase));
        const current = find(); if (current) { resolve(current); return; }
        if (exited) { reject(new Error(`Invoice process exited before ${type}${diagnostics()}`)); return; }
        const clean = () => { clearTimeout(timer); child.off("message", changed); child.off("exit", stopped); child.off("error", stopped); };
        const changed = () => { const current = find(); if (current) { clean(); resolve(current); } };
        const stopped = () => { clean(); reject(new Error(`Invoice process exited before ${type}${diagnostics()}`)); };
        const timer = setTimeout(() => { clean(); reject(new Error(`Invoice process deadline ${type}${diagnostics()}`)); }, timeoutMs);
        child.on("message", changed); child.once("exit", stopped); child.once("error", stopped);
      });
    },
    async stop(force = false) {
      if (!exited) { if (force || !child.connected) child.kill("SIGKILL"); else child.send("shutdown", () => {}); }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Invoice process shutdown deadline")); }, 10_000); })]); }
      finally { if (timer) clearTimeout(timer); }
    },
  };
}
export type InvoiceProcess = ReturnType<typeof observeInvoiceProcess>;
export function startInvoiceApi(identity: { baseUrl: string }, key: Buffer, options: { phase?: "before_commit" | "after_commit"; commandId?: string } = {}) {
  requireInvoiceCommandFixture();
  if (process.env.E2E_PROCUREMENT_PROCESS_ISOLATED !== "1") throw new Error("Invoice API restart requires the disposable process guard");
  return observeInvoiceProcess(spawn(process.execPath, ["--import", "./node_modules/tsx/dist/loader.mjs", "../../tools/testing/procurement-api-process-fixture.mts"], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env,
      TSX_DISABLE_CACHE: "1", NODE_ENV: "test", OIDC_ISSUER: identity.baseUrl, OIDC_JWKS_URI: `${identity.baseUrl}/protocol/openid-connect/certs`,
      PROCUREMENT_COMMAND_ENCRYPTION_KEY: key.toString("base64url"), PROCUREMENT_FIXTURE_GATE: options.phase ?? "none",
      PROCUREMENT_FIXTURE_ACTION: "execute", PROCUREMENT_FIXTURE_COMMAND_ID: options.commandId } }));
}
export async function invoiceApiRequest(probe: InvoiceProcess, token: string, path: string, body?: unknown) {
  const { url } = await probe.wait("procurement.fixture.ready");
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url ?? "")) throw new Error("Unsafe synthetic invoice API origin");
  return fetch(`${url}/v1/procurement/commands${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`,
    ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45_000) });
}
