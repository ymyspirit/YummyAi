import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { SecretVault } from "@yummyai/ai-core";
import type { TenantContext, RecordProcurementInvoiceInput, ProcurementInvoiceView } from "@yummyai/contracts";
import { PrepareProcurementCommandSchema, type PrepareProcurementCommand } from "@yummyai/contracts/procurement/procurement-command";
import { canonicalProcurementInvoiceRequest } from "@yummyai/contracts/procurement/procurement-cycle";
import { connectDatabase, migrateDatabase, withTenant, readMigrationEvidence, assertDatabaseMigrationsCurrent, procurementCommands,
  inventorySupplierInvoiceRequests, inventorySupplierInvoiceLines, inventorySupplierInvoices, invoiceAllocationEffects } from "@yummyai/database";
import { captureLegacyDataCheckpoint } from "../../../../tools/testing/legacy-data-checkpoint.mjs";
import { AuditService } from "../audit/audit.service.js";
import { InventoryService } from "../inventory/inventory.service.js";
import { ProcurementService } from "./procurement.service.js";
import { ProcurementCommandService } from "./procurement-command.service.js";
import { InvoiceReconciliationService } from "./invoice-reconciliation.service.js";
import { observeInvoiceProcess, type InvoiceProcess } from "./invoice-command.fixtures.js";
import { requireInvoiceReconciliationFixture, reconciliationKey, reconciliationCode } from "./invoice-reconciliation.fixtures.js";

requireInvoiceReconciliationFixture();
if (process.env.E2E_LEGACY_SCHEMA_TARGET !== "pre-0151") throw new Error("Genuine disposable 150 schema required before connecting");
type Seed = { context: TenantContext; invoices: Array<{ input: RecordProcurementInvoiceInput; result: ProcurementInvoiceView }>;
  legacyUnknown: { input: RecordProcurementInvoiceInput; result: ProcurementInvoiceView };
  commands: Array<{ context: TenantContext; id: string; original: PrepareProcurementCommand; status: "prepared" | "succeeded"; result: unknown }> };
type Seed148 = { context: TenantContext; invoice: { id: string; purchaseOrderId: string; input: RecordProcurementInvoiceInput } };
const seed148Source = String.raw`
import {createRequire} from 'node:module';import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';
const root=process.env.RECONCILIATION_LEGACY_148_SOURCE,load=p=>import(pathToFileURL(resolve(root,p)).href);
createRequire(pathToFileURL(resolve(root,'apps/api/package.json')))('reflect-metadata');
const {requireDisposableIntegrationEnvironment}=await load('tools/testing/require-disposable-integration.mjs');requireDisposableIntegrationEnvironment();
if(process.env.E2E_INVOICE_RECONCILIATION_ISOLATED!=='1'||process.env.E2E_LEGACY_SCHEMA_TARGET!=='pre-0151'||!process.connected)throw new Error('Disposable actual148 reconciliation IPC required');
const {connectDatabase,readMigrationEvidence}=await load('packages/database/src/index.ts');
const {procurementCommandFixture,procurementFixtureKey:key}=await load('apps/api/src/procurement/procurement-command.fixtures.ts');
const {IncomingInspectionService}=await load('apps/api/src/procurement/incoming-inspection.service.ts');
const db=connectDatabase();let phase='ledger';
try{
 if((await readMigrationEvidence(db)).actualRows.length!==148)throw new Error('Actual148 required');
 const f=procurementCommandFixture(db);await f.initialize();const b=await f.basis(),o=await f.owner.createPurchaseOrder(f.context,b.purchaseInput);
 phase='actual-148-receiving';await f.owner.reviewPurchaseOrder(f.context,o.id,{expectedVersion:1,decision:'approved',reasonCode:'SYNTHETIC',idempotencyKey:key()});
 const incoming=new IncomingInspectionService(db,f.owner,f.audit),at=(await f.clock()).toISOString();
 const arrival=await incoming.recordArrival(f.context,o.id,{code:'OLD148-RECON-ARR',expectedPurchaseOrderVersion:1,arrivedAt:at,externalReference:'Synthetic actual148 receiving',
  lines:[{lineKey:'LINE-1',quantity:20,unit:'each',holdingLocationId:f.locationId,lotCode:'OLD148-RECON-LOT',expiresAt:null}],idempotencyKey:key()});
 const standard=await incoming.publishStandard(f.context,{code:'OLD148-RECON-STD',stockItemId:b.stock.id,expectedVersion:0,title:'Synthetic actual148 observations',sourceReference:'Synthetic original148 specification',
  criteria:[{code:'WIDTH',label:'Synthetic width',kind:'numeric_range',unit:'mm',minimum:'9',maximum:'11'}],idempotencyKey:key()});
 const inspected=await incoming.recordInspection(f.context,arrival.lines[0].id,{expectedInspectionVersion:0,standardVersionId:standard.id,acceptedQuantity:20,rejectedQuantity:0,sampleQuantity:1,
  rejectionReason:null,measuredAt:at,readings:[{criterionCode:'WIDTH',value:'10',unit:'mm'}],notes:null,idempotencyKey:key()});
 const reviewed=await incoming.reviewInspection(f.context,arrival.lines[0].id,{expectedInspectionVersion:1,inspectionId:inspected.inspections[0].id,decision:'approved',reason:'Synthetic actual148 evidence checked',idempotencyKey:key()});
 await incoming.postInspection(f.context,arrival.lines[0].id,{expectedInspectionVersion:1,approvalId:reviewed.inspections[0].review.id,acceptedQuantity:20,rejectedQuantity:0,
  rejectionLocationId:null,ownershipConfirmation:'merchant_received',postedAt:at,idempotencyKey:key()});
 phase='actual-148-invoice';const input={invoiceNumber:'OLD148-RECON-INV',currency:'USD',issuedAt:at,lines:[{lineKey:'LINE-1',invoicedQuantity:20,unitCostMinor:123}],idempotencyKey:key()};
 const invoice=await f.owner.recordInvoice(f.context,o.id,input),seed={context:f.context,invoice:{id:invoice.id,purchaseOrderId:o.id,input}};
 await db.client.end();process.send({type:'invoice.reconciliation.148.seeded',seed},()=>process.exit(0));
}catch(cause){await db.client.end();const code=[cause?.code,cause?.cause?.code].find(v=>typeof v==='string'&&/^(?:[0-9A-Z]{5}|ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT)$/.test(v));
 process.send({type:'invoice.reconciliation.148.failed',phase,...(code?{code}:{})},()=>process.exit(1));}
`;
const seedSource = String.raw`
import {createRequire} from 'node:module';import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';
const root=process.env.E2E_INVOICE_RECONCILIATION_LEGACY_SOURCE,load=p=>import(pathToFileURL(resolve(root,p)).href);
const req=createRequire(pathToFileURL(resolve(root,'apps/api/package.json')));req('reflect-metadata');
const {requireDisposableIntegrationEnvironment}=await load('tools/testing/require-disposable-integration.mjs');requireDisposableIntegrationEnvironment();
if(process.env.E2E_INVOICE_RECONCILIATION_ISOLATED!=='1'||process.env.E2E_LEGACY_SCHEMA_TARGET!=='pre-0151'||!process.connected)throw new Error('Disposable reconciliation legacy IPC required');
process.env.E2E_INVOICE_COMMAND_ISOLATED='1';
const {connectDatabase,readMigrationEvidence,migrateDatabase}=await load('packages/database/src/index.ts');
const {SecretVault}=await load('packages/ai-core/src/index.ts');
const {invoiceCommandFixture}=await load('apps/api/src/procurement/invoice-command.fixtures.ts');
const {procurementCommandFixture,procurementFixtureKey:key}=await load('apps/api/src/procurement/procurement-command.fixtures.ts');
const {ProcurementCommandService}=await load('apps/api/src/procurement/procurement-command.service.ts');
const db=connectDatabase(),secret=Buffer.from(process.env.RECONCILIATION_LEGACY_KEY,'base64url');let phase='ledger';
try{
 if((await readMigrationEvidence(db)).actualRows.length!==148)throw new Error('Actual148 before original150 upgrade required');
 phase='original150-migration';await migrateDatabase(db);
 if((await readMigrationEvidence(db)).actualRows.length!==150)throw new Error('Actual 150 schema required');
 phase='actual-150-invoices';const f=invoiceCommandFixture(db);await f.initialize();const invoices=[];
 for(const options of [{quantity:'0.2'},{quantity:'0.2',unitCostMinor:1300},{quantity:'0.2',unitCostMinor:1300,currency:'EUR'}]){
  const b=await f.basis(),full=f.original(b.order.id,options).input;
  const {expectedVersion:omitted,...input}=full,result=await f.owner.recordInvoice(f.context,b.order.id,input);invoices.push({input,result});
 }
 phase='old-eight-commands';const old=procurementCommandFixture(db);await old.initialize();
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
  saved.push({context:old.context,id:done.id,original:done.original,status:done.status,result:done.result});
 }
 const invoiceBasis=await f.basis(),invoiceOriginal=f.original(invoiceBasis.order.id),invoiceCommands=new ProcurementCommandService(db,new SecretVault(secret),f.owner,f.audit);
 const ip=await invoiceCommands.prepare(f.context,invoiceOriginal),done=await invoiceCommands.execute(f.context,ip.id);
 saved.push({context:f.context,id:done.id,original:done.original,status:done.status,result:done.result});
 phase='actual150-legacy-unknown';const previous=JSON.parse(process.env.RECONCILIATION_148_SEED);
 const legacyInput={...previous.invoice.input,invoiceNumber:'OLD150-RECON-LEGACY-UNKNOWN',lines:[{lineKey:'LINE-1',invoicedQuantity:1,unitCostMinor:123}],idempotencyKey:key()};
 const legacyResult=await f.owner.recordInvoice(previous.context,previous.invoice.purchaseOrderId,legacyInput);
 const seed={context:f.context,invoices,commands:saved,legacyUnknown:{input:legacyInput,result:legacyResult}};
 await db.client.end();secret.fill(0);process.send({type:'invoice.reconciliation.legacy.seeded',seed},()=>process.exit(0));
}catch(cause){
 await db.client.end();secret.fill(0);const code=[cause?.code,cause?.cause?.code].find(v=>typeof v==='string'&&/^(?:[0-9A-Z]{5}|ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT)$/.test(v));
 process.send({type:'invoice.reconciliation.legacy.failed',phase,...(code?{code}:{})},()=>process.exit(1));
}
`;

describe("genuine 150 to 151 immutable supplier correction upgrade", () => {
  const database = connectDatabase(), audit = new AuditService(database), inventory = new InventoryService(database, audit), owner = new ProcurementService(database, inventory, audit);
  const key = randomBytes(32), commands = new ProcurementCommandService(database, new SecretVault(key), owner, audit), reconciliation = new InvoiceReconciliationService(database, audit);
  const children: InvoiceProcess[] = [];
  afterAll(async () => {
    try {
      const stopped = await Promise.allSettled(children.map(child => child.stop(true)));
      if (stopped.some(result => result.status === "rejected")) throw new Error("150 reconciliation seed process cleanup incomplete");
    } finally { key.fill(0); await database.client.end(); }
  }, 30_000);
  it("preserves actual 150 invoices, 149 evidence and eight original command kinds before appending a new approved correction", async () => {
    const ledger148 = (await readMigrationEvidence(database)).actualRows; expect(ledger148).toHaveLength(148);
    await expect(assertDatabaseMigrationsCurrent(database)).rejects.toMatchObject({ code: "DATABASE_MIGRATIONS_NOT_READY" });
    const root = process.env.E2E_INVOICE_RECONCILIATION_LEGACY_SOURCE; if (!root || !isAbsolute(root)) throw new Error("Verified original 150 source required");
    const workspace = fileURLToPath(new URL("../../../../", import.meta.url));
    const metadata = JSON.parse(await readFile(resolve(workspace, "docs/project-control/checkpoints/2026-10-20-procurement-resolution-6f24ac90-old150.json"), "utf8")) as { snapshot: string; sourceSha256: string; sourceFiles: number; noEnvironmentCopied: boolean; servicesStarted: boolean };
    expect(resolve(root)).toBe(resolve(metadata.snapshot)); expect(metadata.noEnvironmentCopied).toBe(true); expect(metadata.servicesStarted).toBe(false); expect(metadata.sourceFiles).toBe(2622);
    const source = JSON.parse(await readFile(resolve(workspace, "docs/project-control/checkpoints/2026-10-20-procurement-resolution-6f24ac90-source-before.json"), "utf8")) as { sha256: string; files: Array<{ path: string; sha256: string }> };
    expect(source.sha256).toBe(metadata.sourceSha256); expect(source.sha256).toBe("b561e1781ebd1ae52464c2f63492ef0e04afd3f064a97d2e6a8f1ee02bed9a25");
    const dependencies = source.files.filter(file => file.path.startsWith("packages/") || file.path.startsWith("apps/api/") || file.path.startsWith("tools/testing/") || file.path === "tsconfig.base.json");
    expect(dependencies.length).toBeGreaterThan(500);
    for (const file of dependencies) expect(createHash("sha256").update(await readFile(resolve(root, file.path))).digest("hex"), file.path).toBe(file.sha256);
    const root148 = resolve(workspace, ".artifacts/ordinary-api-source-148-41d9bb72");
    const source148 = JSON.parse(await readFile(resolve(workspace, "docs/project-control/checkpoints/2026-10-20-procurement-recovery-72c396a4-source-final-r2.json"), "utf8")) as { sha256: string; files: Array<{ path: string; sha256: string }> };
    expect(source148.sha256).toBe("f2bcaa079b2fe33eda7608e4d96b15d9f8a3ebdcde7135ba8ed087607db52501"); expect(source148.files).toHaveLength(2598);
    for (const file of source148.files.filter(file => file.path.startsWith("packages/") || file.path.startsWith("apps/api/") || file.path.startsWith("tools/testing/") || file.path === "tsconfig.base.json"))
      expect(createHash("sha256").update(await readFile(resolve(root148, file.path))).digest("hex"), `148:${file.path}`).toBe(file.sha256);
    const child148 = observeInvoiceProcess(spawn(process.execPath, ["--import", "./node_modules/tsx/dist/loader.mjs", "--input-type=module", "--eval", seed148Source], {
      cwd: resolve(root148, "apps/api"), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env,
        TSX_DISABLE_CACHE: "1", RECONCILIATION_LEGACY_148_SOURCE: root148 } })); children.push(child148);
    const event148 = await child148.wait("invoice.reconciliation.148.seeded", undefined, 120_000), legacy = event148.seed as Seed148; expect(await child148.closed).toBe(0);
    const oldInvoiceProjection: Array<{ table: string; columnNames: string[]; field: string; id: string; rows: unknown }> = [];
    for (const [table, field] of [["inventory_supplier_invoices", "id"], ["inventory_supplier_invoice_lines", "invoice_id"]] as const) {
      const columns = await database.client.unsafe("select column_name from information_schema.columns where table_schema='public' and table_name=$1 order by ordinal_position", [table]);
      const columnNames = columns.map(row => String(row.column_name));
      const rows = await project(table, columnNames, field, legacy.invoice.id, legacy.context);
      oldInvoiceProjection.push({ table, columnNames, field, id: legacy.invoice.id, rows });
    }
    const child = observeInvoiceProcess(spawn(process.execPath, ["--import", "./node_modules/tsx/dist/loader.mjs", "--input-type=module", "--eval", seedSource], {
      cwd: resolve(root, "apps/api"), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env,
        TSX_DISABLE_CACHE: "1", E2E_INVOICE_RECONCILIATION_LEGACY_SOURCE: root, RECONCILIATION_LEGACY_KEY: key.toString("base64url"), RECONCILIATION_148_SEED: JSON.stringify(legacy) } })); children.push(child);
    const seeded = await child.wait("invoice.reconciliation.legacy.seeded", undefined, 150_000), seed = seeded.seed as Seed;
    expect(await child.closed).toBe(0); expect(seed.invoices).toHaveLength(3); expect(seed.commands).toHaveLength(8);
    expect(seed.invoices.every(invoice => !("expectedVersion" in invoice.input))).toBe(true);
    const ledger = (await readMigrationEvidence(database)).actualRows; expect(ledger).toHaveLength(150); expect(ledger.slice(0, 148)).toEqual(ledger148);
    for (const saved of oldInvoiceProjection) expect(await project(saved.table, saved.columnNames, saved.field, saved.id, legacy.context)).toEqual(saved.rows);
    const checkpoint = await captureLegacyDataCheckpoint(database), before = await checkpoint.snapshot();
    const oldRows = new Map<string, Record<string, unknown>>();
    for (const saved of seed.commands) {
      const [row] = await withTenant(database.db, saved.context, tx => tx.execute(sql`select * from inventory_procurement_commands where id=${saved.id}::uuid`));
      // Read only old columns; the new schema's extra column does not exist yet.
      expect(row).toBeDefined(); oldRows.set(saved.id, row!);
    }
    await migrateDatabase(database); expect(await checkpoint.snapshot()).toEqual(before);
    const current = await readMigrationEvidence(database); expect(current.actualRows).toHaveLength(151);
    expect(current.actualRows.slice(0, 150)).toEqual(ledger); expect(current.actualRows[150]).toEqual(current.canonicalRows[150]);
    for (const saved of oldInvoiceProjection) expect(await project(saved.table, saved.columnNames, saved.field, saved.id, legacy.context)).toEqual(saved.rows);
    const oldLegacy = await reconciliation.detail(legacy.context, legacy.invoice.id);
    expect(oldLegacy).toMatchObject({ originalProofId: null, canRecord: false, canApprove: false,
      balance: { status: "unknown", varianceMinor: null, unknownReasons: ["legacy_basis_missing"], lines: [{ unit: null, allocatedQuantity: null, expectedAmountMinor: null, varianceMinor: null }] } });
    const legacyUnknown = await reconciliation.detail(legacy.context, seed.legacyUnknown.result.id);
    expect(seed.legacyUnknown.result).toMatchObject({ allocationStatus: "legacy_unknown", varianceMinor: null });
    expect(legacyUnknown).toMatchObject({ canRecord: false, canApprove: false, balance: { status: "unknown", varianceMinor: null, unknownReasons: ["legacy_basis_missing"] } });
    for (const blocked of [oldLegacy, legacyUnknown]) {
      const original = { kind: "invoice_reconcile" as const, targetId: blocked.invoiceId, input: { action: "adjustment_record" as const,
        expectedFingerprint: blocked.fingerprint, reason: "Synthetic legacy unknown must stay unknown", idempotencyKey: reconciliationKey(),
        document: { kind: "credit_note" as const, number: reconciliationCode("LEGACY-BLOCKED"), currency: "USD", issuedAt: new Date().toISOString(), evidenceReference: "Synthetic reference cannot replace missing original evidence" },
        lines: [{ invoiceLineId: blocked.balance.lines[0]!.invoiceLineId, quantity: 0, unit: "each" as const, amountMinor: 1 }] } };
      await expect(commands.prepare(legacy.context, original)).rejects.toMatchObject({ status: 409, response: expect.objectContaining({ code: "invoice_reconciliation_legacy_basis_missing" }) });
      expect((await reconciliation.detail(legacy.context, blocked.invoiceId)).events).toEqual([]);
    }
    const oldInvoiceRows = await withTenant(database.db, seed.context, tx => tx.select().from(inventorySupplierInvoices));
    for (const saved of seed.invoices) {
      const [proof] = await withTenant(database.db, seed.context, tx => tx.select().from(inventorySupplierInvoiceRequests).where(eq(inventorySupplierInvoiceRequests.invoiceId, saved.result.id)));
      expect(proof!.requestChecksum).toBe(createHash("sha256").update(canonicalProcurementInvoiceRequest(saved.result.purchaseOrderId, saved.input)).digest("hex"));
      expect(await owner.recordInvoice(seed.context, saved.result.purchaseOrderId, saved.input)).toEqual(saved.result);
      const detail = await reconciliation.detail(seed.context, saved.result.id);
      expect(detail.originalProofId).toBe(proof!.id); expect(detail.events).toEqual([]); expect(detail.adjustments).toEqual([]);
      expect(detail.balance.varianceMinor).toBe(saved.result.varianceMinor);
      if (saved.result.currency === "EUR") expect(detail.balance).toMatchObject({ status: "unknown", varianceMinor: null, unknownReasons: ["currency_mismatch"] });
    }
    expect(await checkpoint.snapshot()).toEqual(before);
    for (const saved of seed.commands) {
      const restored = await commands.get(saved.context, saved.id); expect(restored).toMatchObject({ original: saved.original, status: saved.status, result: saved.result });
      const [row] = await withTenant(database.db, saved.context, tx => tx.select().from(procurementCommands).where(eq(procurementCommands.id, saved.id)));
      expect(row!.reconciliationResultProofId).toBeNull();
      const [raw] = await withTenant(database.db, saved.context, tx => tx.execute(sql`select * from inventory_procurement_commands where id=${saved.id}::uuid`));
      for (const field of ["created_by", "request_key", "request_checksum", "authority_snapshot", "encrypted_input", "contract_version", "expires_at"] as const)
        expect(raw![field], `${saved.original.kind}.${field}`).toEqual(oldRows.get(saved.id)![field]);
      const done = await commands.execute(saved.context, saved.id); expect(done.status).toBe("succeeded"); expect(done.result!.kind).toBe(saved.original.kind);
      expect((await commands.execute(saved.context, saved.id)).result).toEqual(done.result); await commands.acknowledge(saved.context, saved.id);
    }
    const invoice = seed.invoices[1]!.result, originalDetail = await reconciliation.detail(seed.context, invoice.id);
    const [line] = await withTenant(database.db, seed.context, tx => tx.select().from(inventorySupplierInvoiceLines).where(eq(inventorySupplierInvoiceLines.invoiceId, invoice.id)));
    const original = PrepareProcurementCommandSchema.parse({ kind: "invoice_reconcile", targetId: invoice.id, input: {
      action: "adjustment_record", expectedFingerprint: originalDetail.fingerprint, idempotencyKey: reconciliationKey(), reason: "Synthetic correction of original 150 invoice price",
      document: { kind: "credit_note", number: reconciliationCode("NEW151-CREDIT"), issuedAt: new Date().toISOString(), currency: "USD", evidenceReference: "Synthetic recorded supplier price correction, no external verification" },
      lines: [{ invoiceLineId: line!.id, quantity: 0, unit: "kilogram", amountMinor: 20 }] } });
    const prepared = await commands.prepare(seed.context, original), record = await commands.execute(seed.context, prepared.id); await commands.acknowledge(seed.context, prepared.id);
    expect(record.reconciliationResult).toMatchObject({ action: "adjustment_record", originalProofId: originalDetail.originalProofId, balance: { varianceMinor: 20 } });
    const pending = await reconciliation.detail(seed.context, invoice.id);
    const review = await commands.prepare(seed.context, { kind: "invoice_reconcile", targetId: invoice.id, input: { action: "adjustment_review", expectedFingerprint: pending.fingerprint,
      adjustmentId: record.result!.id, decision: "approved", reason: "Synthetic current authority reviewed original supplier document", idempotencyKey: reconciliationKey() } });
    const approved = await commands.execute(seed.context, review.id); expect(approved.reconciliationResult!.balance).toMatchObject({ status: "matched", netAmountMinor: 240, varianceMinor: 0 });
    await commands.acknowledge(seed.context, review.id);
    expect(await withTenant(database.db, seed.context, tx => tx.select().from(inventorySupplierInvoices))).toEqual(oldInvoiceRows);
    expect(await withTenant(database.db, seed.context, tx => tx.select().from(invoiceAllocationEffects))).toEqual([]);
    process.stdout.write(JSON.stringify({ type: "invoice.reconciliation.upgrade", oldMigrations: 150, newMigrations: 151, oldInvoices: 3, oldKinds: 8,
      originalTables: before.length, oldLedgerPreserved: true, oldSource: source.sha256, actual148Source: source148.sha256,
      legacy148InvoicePreserved: true, legacyUnknown150Preserved: true, childPids: [child148.child.pid, child.child.pid], childrenExited: true }) + "\n");
  }, 240_000);
  async function project(table: string, columns: string[], field: string, id: string, current: TenantContext) {
    return withTenant(database.db, current, tx => tx.execute(sql`select ${sql.join(columns.map(column => sql`${sql.identifier(column)}::text as ${sql.identifier(column)}`), sql`, `)}
      from ${sql.identifier(table)} where ${sql.identifier(field)}=${id}::uuid order by id`));
  }
});
