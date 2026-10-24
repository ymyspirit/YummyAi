/** Synthetic precision resources belong exclusively to the disposable runner. */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { withTenant, type DatabaseConnection } from "@yummyai/database";
import type { StockQuantity } from "@yummyai/contracts/inventory/quantity";
import type { ProcurementUnit } from "@yummyai/contracts/procurement/measurement";
import { ProcurementService } from "./procurement.service.js";
import { IncomingInspectionService } from "./incoming-inspection.service.js";
import { procurementCommandFixture, procurementFixtureKey, requireProcurementCommandFixture } from "./procurement-command.fixtures.js";

export function requireProcurementPrecisionFixture() {
  requireProcurementCommandFixture();
  if (process.env.E2E_PROCUREMENT_PRECISION_ISOLATED !== "1")
    throw new Error("Procurement precision requires its isolated disposable suite");
}
export const precisionKey = procurementFixtureKey;
export const precisionCode = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`;

export function precisionFixture(database: DatabaseConnection) {
  requireProcurementPrecisionFixture();
  const base = procurementCommandFixture(database), { context, owner, inventory, audit } = base;
  const incoming = new IncomingInspectionService(database, owner, audit);
  async function basis(options: { quantity?: StockQuantity; unit?: ProcurementUnit; stockUnit?: ProcurementUnit;
    unitCostMinor?: number; priceBasisQuantity?: StockQuantity } = {}) {
    const code = precisionCode("PRECISION"), now = await base.clock();
    const stock = await inventory.createStockItem(context, { code: `${code}-MAT`, name: "Synthetic measured procurement material",
      skuId: null, baseUnit: options.stockUnit ?? "gram" });
    const line = { lineKey: "LINE-1", stockItemId: stock.id, destinationLocationId: base.locationId,
      quantity: options.quantity ?? "0.25", unit: options.unit ?? "kilogram", unitCostMinor: options.unitCostMinor ?? 1200,
      ...(options.priceBasisQuantity === undefined ? {} : { priceBasisQuantity: options.priceBasisQuantity }) };
    const future = new Date(now.getTime() + 86_400_000).toISOString();
    const purchaseInput = { code: `${code}-PO`, supplierId: base.supplierId, requisitionId: null, quoteId: null,
      currency: "USD", expectedAt: future, lines: [line], idempotencyKey: precisionKey() };
    return { code, stock, line, future, purchaseInput };
  }
  async function approve(orderId: string, expectedVersion = 1) {
    return owner.reviewPurchaseOrder(context, orderId, { expectedVersion, decision: "approved", reasonCode: "SYNTHETIC_APPROVAL", idempotencyKey: precisionKey() });
  }
  async function receive(orderId: string, stockId: string, quantity: StockQuantity, options: {
    unit?: ProcurementUnit; expectedVersion?: number; accepted?: StockQuantity; rejected?: StockQuantity; postingAccepted?: StockQuantity; postingRejected?: StockQuantity;
  } = {}) {
    const now = await base.clock(), at = now.toISOString();
    const unit = options.unit ?? "gram", accepted = options.accepted ?? quantity, rejected = options.rejected ?? 0;
    const arrival = await incoming.recordArrival(context, orderId, { code: precisionCode("ARR"), expectedPurchaseOrderVersion: options.expectedVersion ?? 1,
      arrivedAt: at, externalReference: "Synthetic precision delivery reference", lines: [{ lineKey: "LINE-1", quantity, unit,
        holdingLocationId: base.locationId, lotCode: precisionCode("SUPPLIER-LOT"), expiresAt: null }], idempotencyKey: precisionKey() });
    const line = arrival.lines[0]!;
    const standard = await incoming.publishStandard(context, { code: precisionCode("STD"), stockItemId: stockId, expectedVersion: 0,
      title: "Synthetic inspected precision material", sourceReference: "Isolated synthetic specification, no actual supplier contact",
      criteria: [{ code: "WIDTH", label: "Synthetic width", kind: "numeric_range", unit: "mm", minimum: "9.999999999", maximum: "10.000000001" }], idempotencyKey: precisionKey() });
    const inspected = await incoming.recordInspection(context, line.id, { expectedInspectionVersion: 0, standardVersionId: standard.id,
      acceptedQuantity: accepted, rejectedQuantity: rejected, sampleQuantity: quantity,
      rejectionReason: rejected === 0 ? null : "Synthetic rejected portion", measuredAt: at,
      readings: [{ criterionCode: "WIDTH", value: "10", unit: "mm" }], notes: null, idempotencyKey: precisionKey() });
    const reviewed = await incoming.reviewInspection(context, line.id, { expectedInspectionVersion: 1, inspectionId: inspected.inspections[0]!.id,
      decision: "approved", reason: "Synthetic original measurements checked", idempotencyKey: precisionKey() });
    const postingInput = { expectedInspectionVersion: 1, approvalId: reviewed.inspections[0]!.review!.id,
      acceptedQuantity: options.postingAccepted ?? accepted, rejectedQuantity: options.postingRejected ?? rejected,
      rejectionLocationId: rejected === 0 ? null : base.locationId, ownershipConfirmation: "merchant_received" as const,
      postedAt: at, idempotencyKey: precisionKey() };
    const posted = await incoming.postInspection(context, line.id, postingInput);
    return { arrival, line, posted, postingInput, reviewed, at };
  }
  function invoice(quantity: StockQuantity = "0.1", options: { unitCostMinor?: number; priceBasisQuantity?: StockQuantity; currency?: string } = {}) {
    const issuedAt = new Date(); issuedAt.setUTCMilliseconds(0);
    return { expectedVersion: 1, invoiceNumber: precisionCode("INV"), currency: options.currency ?? "USD", issuedAt: issuedAt.toISOString(),
      lines: [{ lineKey: "LINE-1", invoicedQuantity: quantity, unitCostMinor: options.unitCostMinor ?? 1200,
        ...(options.priceBasisQuantity === undefined ? {} : { priceBasisQuantity: options.priceBasisQuantity }) }], idempotencyKey: precisionKey() };
  }
  async function state(tables = ["inventory_supplier_invoices", "inventory_supplier_invoice_lines", "inventory_supplier_invoice_requests",
    "inventory_supplier_invoice_allocations", "inventory_purchase_order_events", "inventory_purchase_orders", "audit_events"]) {
    return withTenant(database.db, context, async tx => {
      const result: Record<string, { count: number; digest: string }> = {};
      for (const table of tables) {
        const rows = await tx.execute(sql`select * from ${sql.identifier(table)} order by id`);
        result[table] = { count: rows.length, digest: createHash("sha256").update(JSON.stringify(rows)).digest("hex") };
      }
      return result;
    });
  }
  return { ...base, basis, approve, receive, invoice, state, incoming,
    get locationId() { return base.locationId; }, get supplierId() { return base.supplierId; },
    restartedOwner: () => new ProcurementService(database, inventory, audit) };
}

type ProcessEvent = { type: string; phase?: string; code?: string; url?: string; commandId?: string; action?: string; pid?: number };
export type PrecisionProcess = ReturnType<typeof observePrecisionProcess>;
export function observePrecisionProcess(child: ChildProcess) {
  const events: ProcessEvent[] = [];
  let exited = false;
  const failureDetails = () => {
    const failure = events.findLast(event => event.type === "procurement.precision.legacy.failed");
    if (!failure) return "";
    const phase = typeof failure.phase === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(failure.phase) ? failure.phase : "unknown";
    const code = typeof failure.code === "string" && /^(?:[0-9A-Z]{5}|ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT)$/.test(failure.code) ? failure.code : null;
    return ` (phase=${phase}${code ? ` code=${code}` : ""})`;
  };
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", () => {});
  const closed = new Promise<number>(resolve => {
    child.once("error", () => { exited = true; resolve(-1); });
    child.once("exit", code => { exited = true; resolve(code ?? -1); });
  });
  child.on("message", message => {
    if (message && typeof message === "object" && "type" in message && typeof message.type === "string") events.push(message as ProcessEvent);
  });
  return { child, events, closed,
    wait(type: string, phase?: string, timeoutMs = 35_000): Promise<ProcessEvent> {
      return new Promise((resolve, reject) => {
        const match = () => events.find(event => event.type === type && (!phase || event.phase === phase));
        const known = match(); if (known) { resolve(known); return; }
        if (exited) { reject(new Error(`Precision process exited before ${type}${failureDetails()}`)); return; }
        const clean = () => { clearTimeout(timer); child.off("message", changed); child.off("exit", stopped); child.off("error", stopped); };
        const changed = () => { const event = match(); if (event) { clean(); resolve(event); } };
        const stopped = () => { clean(); reject(new Error(`Precision process exited before ${type}${failureDetails()}`)); };
        const timer = setTimeout(() => { clean(); reject(new Error(`Precision process deadline ${type}${failureDetails()}`)); }, timeoutMs);
        child.on("message", changed); child.once("exit", stopped); child.once("error", stopped);
      });
    },
    async stop(force = false) {
      if (!exited) { if (force || !child.connected) child.kill("SIGKILL"); else child.send("shutdown", () => {}); }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([closed, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Precision process shutdown deadline")); }, 10_000);
      })]); } finally { if (timer) clearTimeout(timer); }
    },
  };
}
export function startPrecisionApi(identity: { baseUrl: string }, key: Buffer, options: { phase?: "before_commit" | "after_commit"; commandId?: string } = {}) {
  requireProcurementPrecisionFixture();
  if (process.env.E2E_PROCUREMENT_PROCESS_ISOLATED !== "1") throw new Error("Precision API restart requires the disposable process guard");
  const cwd = fileURLToPath(new URL("../../", import.meta.url));
  return observePrecisionProcess(spawn(process.execPath, ["--import", "./node_modules/tsx/dist/loader.mjs", "../../tools/testing/procurement-api-process-fixture.mts"], {
    cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, TSX_DISABLE_CACHE: "1", NODE_ENV: "test",
      OIDC_ISSUER: identity.baseUrl, OIDC_JWKS_URI: `${identity.baseUrl}/protocol/openid-connect/certs`,
      PROCUREMENT_COMMAND_ENCRYPTION_KEY: key.toString("base64url"), PROCUREMENT_FIXTURE_GATE: options.phase ?? "none",
      PROCUREMENT_FIXTURE_ACTION: "execute", PROCUREMENT_FIXTURE_COMMAND_ID: options.commandId } }));
}
export async function precisionApiRequest(probe: PrecisionProcess, accessToken: string, path: string, body?: unknown) {
  const { url } = await probe.wait("procurement.fixture.ready");
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url ?? "")) throw new Error("Unsafe precision process origin");
  return fetch(`${url}/v1/procurement/commands${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${accessToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45_000) });
}
