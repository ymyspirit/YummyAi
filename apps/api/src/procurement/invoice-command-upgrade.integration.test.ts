import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { SecretVault } from "@yummyai/ai-core";
import type { TenantContext, RecordProcurementInvoiceInput, ProcurementInvoiceView } from "@yummyai/contracts";
import type { PrepareProcurementCommand } from "@yummyai/contracts/procurement/procurement-command";
import { canonicalProcurementInvoiceRequest } from "@yummyai/contracts/procurement/procurement-cycle";
import { connectDatabase, migrateDatabase, withTenant, readMigrationEvidence, assertDatabaseMigrationsCurrent, procurementCommands,
  inventorySupplierInvoiceRequests } from "@yummyai/database";
import { captureLegacyDataCheckpoint } from "../../../../tools/testing/legacy-data-checkpoint.mjs";
import { AuditService } from "../audit/audit.service.js";
import { InventoryService } from "../inventory/inventory.service.js";
import { ProcurementService } from "./procurement.service.js";
import { ProcurementCommandService } from "./procurement-command.service.js";
import { observeInvoiceProcess, invoiceCommandKey, invoiceCommandCode, requireInvoiceCommandFixture, type InvoiceProcess } from "./invoice-command.fixtures.js";

requireInvoiceCommandFixture();
if (process.env.E2E_LEGACY_SCHEMA_TARGET !== "pre-0150") throw new Error("Genuine disposable 149 schema required before connecting");
type Seed = { context: TenantContext; invoiceOrderId: string; freshOrderId: string; commandContext: TenantContext;
  invoices: Array<{ input: RecordProcurementInvoiceInput; result: ProcurementInvoiceView }>;
  commands: Array<{ id: string; original: PrepareProcurementCommand; status: "prepared" | "succeeded"; result: unknown }> };

const seedSource = String.raw`
import { createRequire } from 'node:module';import { resolve } from 'node:path';import { pathToFileURL } from 'node:url';
const root=process.env.E2E_INVOICE_COMMAND_LEGACY_SOURCE,load=p=>import(pathToFileURL(resolve(root,p)).href);
const req=createRequire(pathToFileURL(resolve(root,'apps/api/package.json')));req('reflect-metadata');
const {requireDisposableIntegrationEnvironment}=await load('tools/testing/require-disposable-integration.mjs');requireDisposableIntegrationEnvironment();
if(process.env.E2E_INVOICE_COMMAND_ISOLATED!=='1'||process.env.E2E_LEGACY_SCHEMA_TARGET!=='pre-0150'||!process.connected)throw new Error('Disposable invoice legacy IPC required');
process.env.E2E_PROCUREMENT_PRECISION_ISOLATED='1';
const {connectDatabase,readMigrationEvidence}=await load('packages/database/src/index.ts');
const {SecretVault}=await load('packages/ai-core/src/index.ts');
const {precisionFixture}=await load('apps/api/src/procurement/precision-fixtures.ts');
const {procurementCommandFixture,procurementFixtureKey:key}=await load('apps/api/src/procurement/procurement-command.fixtures.ts');
const {ProcurementCommandService}=await load('apps/api/src/procurement/procurement-command.service.ts');
const db=connectDatabase(),secret=Buffer.from(process.env.INVOICE_LEGACY_KEY,'base64url');let phase='ledger';
try{
 if((await readMigrationEvidence(db)).actualRows.length!==149)throw new Error('Actual 149 schema required');
 phase='actual-149-invoices';const fixture=precisionFixture(db);await fixture.initialize();
 const {context,owner}=fixture,b=await fixture.basis(),order=await owner.createPurchaseOrder(context,b.purchaseInput);
 await fixture.approve(order.id);await fixture.receive(order.id,b.stock.id,200);
 const {expectedVersion:omitted,...firstInput}=fixture.invoice();
 const first=await owner.recordInvoice(context,order.id,firstInput);
 const secondInput=fixture.invoice('0.1',{currency:'EUR'}),second=await owner.recordInvoice(context,order.id,secondInput);
 const unused=await fixture.basis(),fresh=await owner.createPurchaseOrder(context,unused.purchaseInput);
 await fixture.approve(fresh.id);await fixture.receive(fresh.id,unused.stock.id,200);
 phase='old-seven-commands';const old=procurementCommandFixture(db);await old.initialize();
 const commands=new ProcurementCommandService(db,new SecretVault(secret),old.owner,old.audit);
 const a=await old.basis(),r=await old.quoted(),q=await old.quoted(),p=await old.quoted(),s=await old.supplied();
 const v=await old.basis(),vOrder=await old.owner.createPurchaseOrder(old.context,v.purchaseInput);
 const c=await old.basis(),cOrder=await old.owner.createPurchaseOrder(old.context,c.purchaseInput);
 const originals=[{kind:'requisition_create',targetId:null,input:a.requisitionInput},
 {kind:'rfq_create',targetId:r.requisition.id,input:{...r.rfqInput,idempotencyKey:key()}},
 {kind:'quote_record',targetId:q.rfq.id,input:{...q.quoteInput,idempotencyKey:key()}},
 {kind:'purchase_create',targetId:null,input:p.quotedPurchaseInput},
 {kind:'supply_purchase_create',targetId:s.link.id,input:s.input},
 {kind:'purchase_revise',targetId:vOrder.id,input:{expectedVersion:1,currency:'USD',expectedAt:v.future,lines:v.purchaseInput.lines.map(line=>({...line,quantity:21})),idempotencyKey:key()}},
 {kind:'purchase_review',targetId:cOrder.id,input:{expectedVersion:1,decision:'approved',reasonCode:'SYNTHETIC',idempotencyKey:key()}}];
 const saved=[];for(const [index,original]of originals.entries()){
  const prepared=await commands.prepare(old.context,original),done=index%2?await commands.execute(old.context,prepared.id):prepared;
  saved.push({id:done.id,original:done.original,status:done.status,result:done.result});
 }
 const seed={context,invoiceOrderId:order.id,freshOrderId:fresh.id,commandContext:old.context,invoices:[{input:firstInput,result:first},{input:secondInput,result:second}],commands:saved};
 await db.client.end();secret.fill(0);process.send({type:'invoice.command.legacy.seeded',seed},()=>process.exit(0));
}catch(cause){
 await db.client.end();secret.fill(0);const code=[cause?.code,cause?.cause?.code].find(v=>typeof v==='string'&&/^(?:[0-9A-Z]{5}|ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT)$/.test(v));
 process.send({type:'invoice.command.legacy.failed',phase,...(code?{code}:{})},()=>process.exit(1));
}
`;

describe("genuine 149 to 150 durable invoice upgrade", () => {
  const database = connectDatabase(), audit = new AuditService(database), inventory = new InventoryService(database, audit), owner = new ProcurementService(database, inventory, audit);
  const key = randomBytes(32), commands = new ProcurementCommandService(database, new SecretVault(key), owner, audit), children: InvoiceProcess[] = [];
  afterAll(async () => {
    try {
      const stopped = await Promise.allSettled(children.map(child => child.stop(true)));
      if (stopped.some(result => result.status === "rejected")) throw new Error("149 invoice seed process cleanup incomplete");
    } finally { key.fill(0); await database.client.end(); }
  }, 30_000);

  it("preserves actual 149 requests and allocations and seven old encrypted command kinds without inventing invoice originals", async () => {
    const ledger = (await readMigrationEvidence(database)).actualRows; expect(ledger).toHaveLength(149);
    expect((await database.client.unsafe("select count(*)::integer as count from information_schema.columns where table_schema='public' and table_name='inventory_procurement_commands' and column_name='invoice_result_proof_id'"))[0]!.count).toBe(0);
    await expect(assertDatabaseMigrationsCurrent(database)).rejects.toMatchObject({ code: "DATABASE_MIGRATIONS_NOT_READY" });
    const root = process.env.E2E_INVOICE_COMMAND_LEGACY_SOURCE; if (!root || !isAbsolute(root)) throw new Error("Verified original 149 source required");
    const workspace = fileURLToPath(new URL("../../../../", import.meta.url));
    const metadata = JSON.parse(await readFile(resolve(workspace, "docs/project-control/checkpoints/2026-10-20-invoice-command-d7a8e0c2-old149.json"), "utf8")) as { snapshot: string; sourceSha256: string; noEnvironmentCopied: boolean; servicesStarted: boolean };
    expect(resolve(root)).toBe(resolve(metadata.snapshot)); expect(metadata.noEnvironmentCopied).toBe(true); expect(metadata.servicesStarted).toBe(false);
    const source = JSON.parse(await readFile(resolve(workspace, "docs/project-control/checkpoints/2026-10-20-invoice-command-d7a8e0c2-source-before.json"), "utf8")) as { sha256: string; files: Array<{ path: string; sha256: string }> };
    expect(source.sha256).toBe(metadata.sourceSha256); expect(source.sha256).toBe("cf60f5864df994293e36b01f4fa4bbc8c53135fc54d06a7e7c380bfd1f559846");
    const dependencies = source.files.filter(file => file.path.startsWith("packages/") || file.path.startsWith("apps/api/") || file.path.startsWith("tools/testing/") || file.path === "tsconfig.base.json");
    expect(dependencies.length).toBeGreaterThan(500);
    for (const file of dependencies) expect(createHash("sha256").update(await readFile(resolve(root, file.path))).digest("hex"), file.path).toBe(file.sha256);
    const child = observeInvoiceProcess(spawn(process.execPath, ["--import", "./node_modules/tsx/dist/loader.mjs", "--input-type=module", "--eval", seedSource], {
      cwd: resolve(root, "apps/api"), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env,
        TSX_DISABLE_CACHE: "1", E2E_INVOICE_COMMAND_LEGACY_SOURCE: root, INVOICE_LEGACY_KEY: key.toString("base64url") } })); children.push(child);
    const event = await child.wait("invoice.command.legacy.seeded", undefined, 120_000), seed = event.seed as Seed;
    expect(await child.closed).toBe(0); expect(seed.invoices).toHaveLength(2); expect(seed.commands).toHaveLength(7);
    expect(seed.invoices[0]!.input).not.toHaveProperty("expectedVersion");
    const checkpoint = await captureLegacyDataCheckpoint(database), before = await checkpoint.snapshot();
    const protectedTables = ["inventory_supplier_invoices", "inventory_supplier_invoice_lines", "inventory_supplier_invoice_requests",
      "inventory_supplier_invoice_allocations", "inventory_procurement_commands", "inventory_procurement_write_requests", "inventory_procurement_rfqs"];
    const protectedDigests = new Map<string, string>(); for (const table of protectedTables) protectedDigests.set(table, await digest(table));
    await migrateDatabase(database);
    expect(await checkpoint.snapshot()).toEqual(before);
    const current = await readMigrationEvidence(database); expect(current.actualRows).toHaveLength(150);
    expect(current.actualRows.slice(0, 149)).toEqual(ledger); expect(current.actualRows[149]).toEqual(current.canonicalRows[149]);
    // Only the newly added invoice-proof column is outside the old-column
    // checkpoint. All original command fields and rows are checked above.
    for (const table of protectedTables.filter(table => table !== "inventory_procurement_commands")) expect(await digest(table), table).toBe(protectedDigests.get(table));
    const oldCommands = await withTenant(database.db, seed.commandContext, tx => tx.select().from(procurementCommands));
    expect(oldCommands.every(command => command.invoiceResultProofId === null)).toBe(true);
    for (const saved of seed.invoices) {
      const [proof] = await withTenant(database.db, seed.context, tx => tx.select().from(inventorySupplierInvoiceRequests).where(eq(inventorySupplierInvoiceRequests.invoiceId, saved.result.id)));
      expect(proof!.requestChecksum).toBe(createHash("sha256").update(canonicalProcurementInvoiceRequest(seed.invoiceOrderId, saved.input)).digest("hex"));
      expect(await owner.recordInvoice(seed.context, seed.invoiceOrderId, saved.input)).toEqual(saved.result);
      await expect(commands.prepare(seed.context, { kind: "invoice_record", targetId: seed.invoiceOrderId,
        input: { ...saved.input, expectedVersion: 1 } })).rejects.toMatchObject({ status: 409,
          response: expect.objectContaining({ code: "procurement_actual_already_recorded" }) });
    }
    expect(await checkpoint.snapshot()).toEqual(before);
    for (const saved of seed.commands) {
      const restored = await commands.get(seed.commandContext, saved.id);
      expect(restored).toMatchObject({ status: saved.status, original: saved.original, result: saved.result });
      expect(restored.invoiceResult ?? null).toBeNull();
      const [originalRow] = await withTenant(database.db, seed.commandContext, tx => tx.select().from(procurementCommands).where(eq(procurementCommands.id, saved.id)));
      const done = await commands.execute(seed.commandContext, saved.id); expect(done.status).toBe("succeeded");
      expect(done.result!.kind).toBe(saved.original.kind); expect(done.invoiceResult ?? null).toBeNull();
      const [after] = await withTenant(database.db, seed.commandContext, tx => tx.select().from(procurementCommands).where(eq(procurementCommands.id, saved.id)));
      for (const field of ["createdBy", "requestKey", "requestChecksum", "authoritySnapshot", "encryptedInput", "contractVersion", "expiresAt"] as const)
        expect(after![field], `${saved.original.kind}.${field}`).toEqual(originalRow![field]);
      expect(after!.invoiceResultProofId).toBeNull();
      expect((await commands.execute(seed.commandContext, saved.id)).result).toEqual(done.result);
      await commands.acknowledge(seed.commandContext, saved.id);
    }
    const now = new Date(); now.setUTCMilliseconds(0);
    const original = { kind: "invoice_record" as const, targetId: seed.freshOrderId, input: { expectedVersion: 1,
      invoiceNumber: invoiceCommandCode("NEW150"), currency: "USD", issuedAt: now.toISOString(), lines: [{ lineKey: "LINE-1", invoicedQuantity: "0.1", unitCostMinor: 1200 }], idempotencyKey: invoiceCommandKey() } };
    const prepared = await commands.prepare(seed.context, original), done = await commands.execute(seed.context, prepared.id);
    expect(done).toMatchObject({ status: "succeeded", original, result: { kind: "invoice_record", versionId: null, version: null },
      invoiceResult: { purchaseOrderId: seed.freshOrderId, status: "matched", totalMinor: 120, lines: [{ allocatedQuantity: "0.1" }] } });
    const [saved] = await withTenant(database.db, seed.context, tx => tx.select().from(procurementCommands).where(eq(procurementCommands.id, prepared.id)));
    expect(saved!.resultProofId).toBeNull(); expect(saved!.invoiceResultProofId).not.toBeNull();
    expect((await commands.execute(seed.context, prepared.id)).invoiceResult).toEqual(done.invoiceResult); await commands.acknowledge(seed.context, prepared.id);
    process.stdout.write(JSON.stringify({ type: "invoice.command.upgrade", oldMigrations: 149, newMigrations: 150,
      oldInvoices: 2, oldKinds: 7, originalTables: before.length, oldLedgerPreserved: true, oldSource: source.sha256,
      childPid: child.child.pid, childExited: true }) + "\n");
  }, 180_000);
  async function digest(table: string) {
    const rows = await database.client.unsafe(`select * from "${table}" order by id`);
    return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  }
});
