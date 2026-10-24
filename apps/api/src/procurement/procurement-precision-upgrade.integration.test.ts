import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { SecretVault } from "@yummyai/ai-core";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import type { CreateInventoryPurchaseOrderInput, CreateProcurementRequisitionInput, CreateProcurementRfqInput,
  RecordProcurementInvoiceInput, RecordProcurementSupplierQuoteInput, ReviseInventoryPurchaseOrderInput, ReviewInventoryPurchaseOrderInput } from "@yummyai/contracts";
import type { PrepareProcurementCommand } from "@yummyai/contracts/procurement/procurement-command";
import { connectDatabase, withTenant, migrateDatabase, readMigrationEvidence, assertDatabaseMigrationsCurrent,
  procurementCommands, inventoryProcurementWriteRequests, inventorySupplierInvoiceRequests, inventoryPurchaseOrderVersions } from "@yummyai/database";
import { captureLegacyDataCheckpoint } from "../../../../tools/testing/legacy-data-checkpoint.mjs";
import { AuditService } from "../audit/audit.service.js";
import { InventoryService } from "../inventory/inventory.service.js";
import { ProcurementService } from "./procurement.service.js";
import { ProcurementCommandService } from "./procurement-command.service.js";
import { observePrecisionProcess, precisionKey, precisionCode, requireProcurementPrecisionFixture, type PrecisionProcess } from "./precision-fixtures.js";

requireProcurementPrecisionFixture();
if (process.env.E2E_LEGACY_SCHEMA_TARGET !== "pre-0149") throw new Error("Actual 148 precision-upgrade schema required before connecting");

type LegacySeed = {
  context: TenantContext; coworker: TenantContext; locationId: string; supplierId: string;
  raw: { requisition: { id: string; input: CreateProcurementRequisitionInput }; rfq: { id: string; targetId: string; input: CreateProcurementRfqInput };
    quote: { id: string; targetId: string; input: RecordProcurementSupplierQuoteInput }; purchase: { id: string; input: CreateInventoryPurchaseOrderInput };
    revision: { targetId: string; input: ReviseInventoryPurchaseOrderInput }; review: { targetId: string; input: ReviewInventoryPurchaseOrderInput } };
  commands: Array<{ id: string; status: "prepared" | "succeeded"; original: PrepareProcurementCommand; result: unknown }>;
  invoice: { id: string; purchaseOrderId: string; input: RecordProcurementInvoiceInput };
};

// This source is executed by the verified old 148 runtime, with only disposable
// environment values. It imports no current procurement schema or service.
const legacySeedSource = String.raw`
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const root=process.env.E2E_PROCUREMENT_PRECISION_LEGACY_SOURCE;
const load=p=>import(pathToFileURL(resolve(root,p)).href);
const apiRequire=createRequire(pathToFileURL(resolve(root,'apps/api/package.json')));
apiRequire('reflect-metadata');
const {requireDisposableIntegrationEnvironment}=await load('tools/testing/require-disposable-integration.mjs');
requireDisposableIntegrationEnvironment();
if(process.env.E2E_PROCUREMENT_PRECISION_ISOLATED!=='1'||process.env.E2E_LEGACY_SCHEMA_TARGET!=='pre-0149'||!process.connected)throw new Error('Disposable legacy precision child required');
const {connectDatabase,readMigrationEvidence}=await load('packages/database/src/index.ts');
const {SecretVault}=await load('packages/ai-core/src/index.ts');
const {ProcurementCommandService}=await load('apps/api/src/procurement/procurement-command.service.ts');
const {IncomingInspectionService}=await load('apps/api/src/procurement/incoming-inspection.service.ts');
const {procurementCommandFixture,procurementFixtureKey:key}=await load('apps/api/src/procurement/procurement-command.fixtures.ts');
const db=connectDatabase(),secret=Buffer.from(process.env.PRECISION_LEGACY_KEY,'base64url');
let stage='ledger';
try{
 if((await readMigrationEvidence(db)).actualRows.length!==148)throw new Error('Actual old 148 schema required');
 const fixture=procurementCommandFixture(db);await fixture.initialize();
 const {context,coworker,owner,audit}=fixture;
 const commands=new ProcurementCommandService(db,new SecretVault(secret),owner,audit);
 stage='six-actual-owners';
 const raw=await fixture.quoted();
 const purchased=await owner.createPurchaseOrder(context,raw.quotedPurchaseInput);
 const revision={expectedVersion:1,currency:'USD',expectedAt:raw.future,lines:raw.purchaseInput.lines.map(line=>({...line,quantity:21})),idempotencyKey:key()};
 await owner.revisePurchaseOrder(context,purchased.id,revision);
 const review={expectedVersion:2,decision:'approved',reasonCode:'SYNTHETIC',idempotencyKey:key()};
 await owner.reviewPurchaseOrder(context,purchased.id,review);
 const selected={requisition:{id:raw.requisition.id,input:raw.requisitionInput},rfq:{id:raw.rfq.id,targetId:raw.requisition.id,input:raw.rfqInput},
 quote:{id:raw.quote.id,targetId:raw.rfq.id,input:raw.quoteInput},purchase:{id:purchased.id,input:raw.quotedPurchaseInput},
 revision:{targetId:purchased.id,input:revision},review:{targetId:purchased.id,input:review}};
 stage='seven-durable-originals';
 const req=await fixture.basis(),r=await fixture.quoted(),q=await fixture.quoted(),p=await fixture.quoted(),s=await fixture.supplied();
 const rev=await fixture.basis(),revOrder=await owner.createPurchaseOrder(context,rev.purchaseInput);
 const check=await fixture.basis(),checkOrder=await owner.createPurchaseOrder(context,check.purchaseInput);
 const originals=[
 {kind:'requisition_create',targetId:null,input:req.requisitionInput},
 {kind:'rfq_create',targetId:r.requisition.id,input:{...r.rfqInput,idempotencyKey:key()}},
 {kind:'quote_record',targetId:q.rfq.id,input:{...q.quoteInput,idempotencyKey:key()}},
 {kind:'purchase_create',targetId:null,input:p.quotedPurchaseInput},
 {kind:'supply_purchase_create',targetId:s.link.id,input:s.input},
 {kind:'purchase_revise',targetId:revOrder.id,input:{expectedVersion:1,currency:'USD',expectedAt:rev.future,lines:rev.purchaseInput.lines.map(line=>({...line,quantity:21})),idempotencyKey:key()}},
 {kind:'purchase_review',targetId:checkOrder.id,input:{expectedVersion:1,decision:'approved',reasonCode:'SYNTHETIC',idempotencyKey:key()}}
 ];
 const retained=[];
 for(const [index,original] of originals.entries()){
  const prepared=await commands.prepare(context,original),result=index%2===1?await commands.execute(context,prepared.id):prepared;
  retained.push({id:result.id,status:result.status,original:result.original,result:result.result});
 }
 stage='actual-legacy-invoice';
 const legacy=await fixture.basis(),order=await owner.createPurchaseOrder(context,legacy.purchaseInput);
 await owner.reviewPurchaseOrder(context,order.id,{expectedVersion:1,decision:'approved',reasonCode:'SYNTHETIC',idempotencyKey:key()});
 const incoming=new IncomingInspectionService(db,owner,audit),at=(await fixture.clock()).toISOString();
 const arrival=await incoming.recordArrival(context,order.id,{code:'OLD148-ARR',expectedPurchaseOrderVersion:1,arrivedAt:at,externalReference:'Synthetic old148 delivery',
  lines:[{lineKey:'LINE-1',quantity:20,unit:'each',holdingLocationId:fixture.locationId,lotCode:'OLD148-LOT',expiresAt:null}],idempotencyKey:key()});
 const standard=await incoming.publishStandard(context,{code:'OLD148-STD',stockItemId:legacy.stock.id,expectedVersion:0,title:'Synthetic old148 inspection',sourceReference:'Synthetic old148 original specification',
  criteria:[{code:'WIDTH',label:'Synthetic width',kind:'numeric_range',unit:'mm',minimum:'9',maximum:'11'}],idempotencyKey:key()});
 const inspected=await incoming.recordInspection(context,arrival.lines[0].id,{expectedInspectionVersion:0,standardVersionId:standard.id,acceptedQuantity:20,rejectedQuantity:0,sampleQuantity:1,
  rejectionReason:null,measuredAt:at,readings:[{criterionCode:'WIDTH',value:'10',unit:'mm'}],notes:null,idempotencyKey:key()});
 const reviewed=await incoming.reviewInspection(context,arrival.lines[0].id,{expectedInspectionVersion:1,inspectionId:inspected.inspections[0].id,decision:'approved',reason:'Synthetic old148 review',idempotencyKey:key()});
 await incoming.postInspection(context,arrival.lines[0].id,{expectedInspectionVersion:1,approvalId:reviewed.inspections[0].review.id,acceptedQuantity:20,rejectedQuantity:0,
  rejectionLocationId:null,ownershipConfirmation:'merchant_received',postedAt:at,idempotencyKey:key()});
 const invoiceInput={invoiceNumber:'OLD148-INV',currency:'USD',issuedAt:at,lines:[{lineKey:'LINE-1',invoicedQuantity:20,unitCostMinor:123}],idempotencyKey:key()};
 const invoice=await owner.recordInvoice(context,order.id,invoiceInput);
 const result={context,coworker,locationId:fixture.locationId,supplierId:fixture.supplierId,raw:selected,commands:retained,invoice:{id:invoice.id,purchaseOrderId:order.id,input:invoiceInput}};
 await db.client.end();secret.fill(0);
 process.send({type:'procurement.precision.legacy.seeded',seed:result},()=>process.exit(0));
}catch(cause){
 await db.client.end();secret.fill(0);
 const code=[cause?.code,cause?.cause?.code].find(value=>typeof value==='string'&&/^(?:[0-9A-Z]{5}|ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT)$/.test(value));
 process.send({type:'procurement.precision.legacy.failed',phase:stage,...(code?{code}:{})},()=>process.exit(1));
}
`;

describe("genuine 148 precision upgrade with old actual proof and encrypted originals", () => {
  const database = connectDatabase(), audit = new AuditService(database), inventory = new InventoryService(database, audit), owner = new ProcurementService(database, inventory, audit);
  const key = randomBytes(32), commands = new ProcurementCommandService(database, new SecretVault(key), owner, audit);
  const children: PrecisionProcess[] = [];
  afterAll(async () => {
    try {
      const stopped = await Promise.allSettled(children.map(child => child.stop(true)));
      if (stopped.some(result => result.status === "rejected")) throw new Error("Legacy precision seed child cleanup incomplete");
    } finally { key.fill(0); await database.client.end(); }
  }, 30_000);

  it("preserves original columns, ledger, 146 proofs, 147 ciphertext and 148 witnesses, then restores the original requests", async () => {
    const oldLedger = (await readMigrationEvidence(database)).actualRows;
    expect(oldLedger).toHaveLength(148);
    expect((await database.client.unsafe("select to_regclass('inventory_supplier_invoice_requests') as name"))[0]!.name).toBeNull();
    await expect(assertDatabaseMigrationsCurrent(database)).rejects.toMatchObject({ code: "DATABASE_MIGRATIONS_NOT_READY" });
    const root = process.env.E2E_PROCUREMENT_PRECISION_LEGACY_SOURCE;
    if (!root || !isAbsolute(root)) throw new Error("Verified original 148 source root required");
    const workspace = fileURLToPath(new URL("../../../../", import.meta.url));
    const manifest = JSON.parse(await readFile(resolve(workspace, "docs/project-control/checkpoints/2026-10-20-procurement-precision-9a62c173-source-before.json"), "utf8")) as { sha256: string; files: Array<{ path: string; sha256: string }> };
    expect(manifest.sha256).toBe("f2bcaa079b2fe33eda7608e4d96b15d9f8a3ebdcde7135ba8ed087607db52501");
    // Verify only the old backend/package/test dependency tree; no sealed Web
    // files are rewritten, loaded by the child or used as a new build cache.
    const dependencies = manifest.files.filter(file => file.path.startsWith("packages/") || file.path.startsWith("apps/api/") || file.path.startsWith("tools/testing/") || file.path === "tsconfig.base.json");
    expect(dependencies.length).toBeGreaterThan(500);
    for (const file of dependencies) expect(createHash("sha256").update(await readFile(resolve(root, file.path))).digest("hex"), file.path).toBe(file.sha256);
    const child = observePrecisionProcess(spawn(process.execPath, ["--import", "./node_modules/tsx/dist/loader.mjs", "--input-type=module", "--eval", legacySeedSource], {
      cwd: resolve(root, "apps/api"), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env,
        TSX_DISABLE_CACHE: "1", E2E_PROCUREMENT_PRECISION_LEGACY_SOURCE: root, PRECISION_LEGACY_KEY: key.toString("base64url") },
    })); children.push(child);
    const seed = (await child.wait("procurement.precision.legacy.seeded", undefined, 120_000) as unknown as { seed: LegacySeed }).seed;
    expect(await child.closed).toBe(0);
    const checkpoint = await captureLegacyDataCheckpoint(database), original = await checkpoint.snapshot();
    const protectedTables = ["inventory_procurement_write_requests", "inventory_procurement_commands", "inventory_procurement_rfqs"];
    const before = new Map<string, string>();
    for (const table of protectedTables) before.set(table, await digest(table));
    await migrateDatabase(database);
    expect(await checkpoint.snapshot()).toEqual(original);
    const current = await readMigrationEvidence(database);
    expect(current.actualRows).toHaveLength(149); expect(current.actualRows.slice(0, 148)).toEqual(oldLedger);
    expect(current.actualRows[148]).toEqual(current.canonicalRows[148]);
    for (const table of protectedTables) expect(await digest(table), table).toBe(before.get(table));
    const [oldVersion] = await withTenant(database.db, seed.context, tx => tx.select().from(inventoryPurchaseOrderVersions)
      .where(eq(inventoryPurchaseOrderVersions.purchaseOrderId, seed.invoice.purchaseOrderId)));
    expect(oldVersion).toBeDefined();
    await expect(withTenant(database.db, seed.context, tx => tx.insert(inventorySupplierInvoiceRequests).values({
      id: createEntityId(), tenantId: seed.context.tenantId, invoiceId: seed.invoice.id, purchaseOrderId: seed.invoice.purchaseOrderId,
      purchaseOrderVersionId: oldVersion!.id, createdBy: seed.context.userId, evidenceVersion: 1,
      requestChecksum: "a".repeat(64), idempotencyKey: seed.invoice.input.idempotencyKey,
    }))).rejects.toMatchObject({ cause: { code: "23514" } });
    expect(await checkpoint.snapshot()).toEqual(original);
    const proofRows = await withTenant(database.db, seed.context, tx => tx.select().from(inventoryProcurementWriteRequests));
    expect(new Set(proofRows.map(row => row.operation))).toEqual(new Set(["requisition_create", "rfq_create", "quote_record", "purchase_create", "purchase_revise", "purchase_review"]));
    const replay = seed.raw;
    expect((await owner.createRequisition(seed.context, replay.requisition.input)).id).toBe(replay.requisition.id);
    expect((await owner.createRfq(seed.context, replay.rfq.targetId, replay.rfq.input)).id).toBe(replay.rfq.id);
    expect((await owner.recordSupplierQuote(seed.context, replay.quote.targetId, replay.quote.input)).id).toBe(replay.quote.id);
    expect((await owner.createPurchaseOrder(seed.context, replay.purchase.input)).id).toBe(replay.purchase.id);
    expect((await owner.revisePurchaseOrder(seed.context, replay.revision.targetId, replay.revision.input)).id).toBe(replay.revision.targetId);
    expect((await owner.reviewPurchaseOrder(seed.context, replay.review.targetId, replay.review.input)).id).toBe(replay.review.targetId);
    expect(await checkpoint.snapshot()).toEqual(original);
    expect(seed.commands).toHaveLength(7);
    expect(seed.commands.some(command => command.status === "prepared")).toBe(true);
    expect(seed.commands.some(command => command.status === "succeeded")).toBe(true);
    for (const saved of seed.commands) {
      const [protectedBefore] = await withTenant(database.db, seed.context, tx => tx.select().from(procurementCommands).where(eq(procurementCommands.id, saved.id)));
      const restored = await commands.get(seed.context, saved.id);
      expect(restored).toMatchObject({ id: saved.id, original: saved.original, status: saved.status, result: saved.result });
      await expect(commands.get(seed.coworker, saved.id)).rejects.toMatchObject({ status: 404 });
      expect((await commands.prepare(seed.context, saved.original)).id).toBe(saved.id);
      const executed = await commands.execute(seed.context, saved.id);
      expect(executed).toMatchObject({ status: "succeeded", result: { kind: saved.original.kind } });
      const after = await digest("inventory_procurement_write_requests");
      expect((await commands.execute(seed.context, saved.id)).result).toEqual(executed.result);
      expect(await digest("inventory_procurement_write_requests")).toBe(after);
      const [protectedAfter] = await withTenant(database.db, seed.context, tx => tx.select().from(procurementCommands).where(eq(procurementCommands.id, saved.id)));
      for (const field of ["createdBy", "requestKey", "requestChecksum", "authoritySnapshot", "encryptedInput", "contractVersion", "expiresAt"] as const)
        expect(protectedAfter![field], `${saved.original.kind}.${field}`).toEqual(protectedBefore![field]);
      await commands.acknowledge(seed.context, saved.id);
    }
    await expect(owner.recordInvoice(seed.context, seed.invoice.purchaseOrderId, seed.invoice.input)).rejects.toMatchObject({ status: 409,
      response: expect.objectContaining({ code: "procurement_invoice_input_unavailable" }) });
    const unknown = await owner.recordInvoice(seed.context, seed.invoice.purchaseOrderId, { ...seed.invoice.input, expectedVersion: 1,
      invoiceNumber: precisionCode("UNKNOWN-REMAINDER"), lines: [{ lineKey: "LINE-1", invoicedQuantity: 1, unitCostMinor: 123 }], idempotencyKey: precisionKey() });
    expect(unknown).toMatchObject({ status: "reconciliation_required", allocationStatus: "legacy_unknown", comparisonCurrency: "USD", varianceMinor: null,
      lines: [{ allocatedQuantity: null, varianceMinor: null }] });
    const [noAllocation] = await withTenant(database.db, seed.context, tx => tx.execute<{ count: number }>(sql`select count(*)::integer as count
      from inventory_supplier_invoice_allocations allocation join inventory_supplier_invoice_lines line on line.id=allocation.invoice_line_id
      where line.invoice_id=${unknown.id}`));
    expect(noAllocation!.count).toBe(0);
    const stock = await inventory.createStockItem(seed.context, { code: precisionCode("NEW149"), name: "Synthetic new exact material", baseUnit: "meter", skuId: null });
    const fresh = await owner.createPurchaseOrder(seed.context, { code: precisionCode("NEW149-PO"), supplierId: seed.supplierId, requisitionId: null, quoteId: null,
      currency: "USD", expectedAt: replay.purchase.input.expectedAt, lines: [{ lineKey: "LINE-1", stockItemId: stock.id, destinationLocationId: seed.locationId,
        quantity: "1.000000001", unit: "meter", unitCostMinor: 1_000_000_000 }], idempotencyKey: precisionKey() });
    expect(fresh).toMatchObject({ totalMinor: 1_000_000_001, lines: [{ quantity: "1.000000001", stockBasis: { stockQuantity: "1.000000001" } }] });
    process.stdout.write(JSON.stringify({ type: "procurement.precision.upgrade", oldMigrations: 148, newMigrations: 149,
      originalTables: original.length, oldCommands: seed.commands.length, oldProofs: proofRows.length, oldLedgerPreserved: true,
      oldSource: manifest.sha256, childPid: child.child.pid, childExited: true }) + "\n");
  }, 180_000);

  async function digest(table: string) {
    const rows = await database.client.unsafe(`select * from "${table}" order by id`);
    return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  }
});
