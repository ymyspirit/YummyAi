import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { TenantContext } from "@yummyai/contracts";
import { createEntityId } from "@yummyai/contracts";
import { canonicalFinancePayablesRequest, type RecordFinanceBillInput } from "@yummyai/contracts/finance/payables";
import { connectDatabase, migrateDatabase, readMigrationEvidence, assertDatabaseMigrationsCurrent, withTenant } from "@yummyai/database";
import { sql } from "drizzle-orm";
import { captureLegacyDataCheckpoint } from "../../../../tools/testing/legacy-data-checkpoint.mjs";
import { observeInvoiceProcess, type InvoiceProcess } from "../procurement/invoice-command.fixtures.js";
import { AuditService } from "../audit/audit.service.js";
import { FinancePayablesService } from "./finance-payables.service.js";

const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid");
if (process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_FINANCE_PAYABLES_ISOLATED !== "1"
  || process.env.E2E_LEGACY_SCHEMA_TARGET !== "pre-0153" || !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(url.pathname))
  throw new Error("Real152 finance payables upgrade requires its own disposable database before connection");

const seed148Source = String.raw`
import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';import {resolve} from 'node:path';
const root=process.env.PAYABLES_148_SOURCE,load=p=>import(pathToFileURL(resolve(root,p)).href);
createRequire(pathToFileURL(resolve(root,'apps/api/package.json')))('reflect-metadata');
if(!process.connected||process.env.E2E_FINANCE_PAYABLES_ISOLATED!=='1'||process.env.E2E_LEGACY_SCHEMA_TARGET!=='pre-0153')throw Error('Original148 disposable IPC required');
const {connectDatabase,readMigrationEvidence}=await load('packages/database/src/index.ts');
const {procurementCommandFixture,procurementFixtureKey:key}=await load('apps/api/src/procurement/procurement-command.fixtures.ts');
const db=connectDatabase();
try {
 if((await readMigrationEvidence(db)).actualRows.length!==148)throw Error('Actual148 required');
 const f=procurementCommandFixture(db);await f.initialize();const b=await f.basis(),o=await f.owner.createPurchaseOrder(f.context,b.purchaseInput);
 await f.owner.reviewPurchaseOrder(f.context,o.id,{expectedVersion:1,decision:'approved',reasonCode:'SYNTHETIC',idempotencyKey:key()});
 const input={invoiceNumber:'GENUINE148-PAYABLES',currency:'USD',issuedAt:'2026-07-01T00:00:00.000Z',lines:[{lineKey:'LINE-1',invoicedQuantity:1,unitCostMinor:123}],idempotencyKey:key()};
 const invoice=await f.owner.recordInvoice(f.context,o.id,input);
 process.send({type:'seeded148',context:f.context,supplierId:f.supplierId,roleId:f.roleIds.get(f.context.userId),orderId:o.id,invoiceId:invoice.id});
}finally{await db.client.end();}
`;
const seedSource = String.raw`
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const root=process.env.E2E_FINANCE_PAYABLES_LEGACY_SOURCE,load=p=>import(pathToFileURL(resolve(root,p)).href);
if(!process.connected||process.env.E2E_FINANCE_PAYABLES_ISOLATED!=='1'||process.env.E2E_LEGACY_SCHEMA_TARGET!=='pre-0153')throw Error('Isolated original152 IPC required');
const require=createRequire(pathToFileURL(resolve(root,'apps/api/package.json')));require('reflect-metadata');const {eq}=require('drizzle-orm');
const {connectDatabase,readMigrationEvidence,migrateDatabase,withTenant,roles}=await load('packages/database/src/index.ts');
const {financeMonetaryFixture,monetaryFact,monetaryRate,monetaryKey}=await load('apps/api/src/finance/finance-monetary.fixtures.ts');
const db=connectDatabase();
try {
 await migrateDatabase(db);const migrations=(await readMigrationEvidence(db)).actualRows.length;if(migrations!==152)throw Error('Expected real152 schema');
 const legacy=JSON.parse(process.env.PAYABLES_148_SEED);
 const {AuditService}=await load('apps/api/src/audit/audit.service.ts'),{InventoryService}=await load('apps/api/src/inventory/inventory.service.ts'),{ProcurementService}=await load('apps/api/src/procurement/procurement.service.ts');
 const audit=new AuditService(db),owner=new ProcurementService(db,new InventoryService(db,audit),audit);
 const legacyInput={expectedVersion:1,invoiceNumber:'GENUINE152-UNKNOWN',currency:'USD',issuedAt:'2026-07-01T00:00:00.000Z',lines:[{lineKey:'LINE-1',invoicedQuantity:1,unitCostMinor:123}],idempotencyKey:monetaryKey()};
 const unknown=await owner.recordInvoice(legacy.context,legacy.orderId,legacyInput);
 if(unknown.allocationStatus!=='legacy_unknown')throw Error('Genuine old invoice must retain unknown basis');
 legacy.context.permissions=[...legacy.context.permissions,'finance:read','finance:write','finance:review'];
 await withTenant(db.db,legacy.context,tx=>tx.update(roles).set({permissions:legacy.context.permissions}).where(eq(roles.id,legacy.roleId)));
 const fixture=financeMonetaryFixture(db);await fixture.initialize();
 const revenue=await fixture.statement('JPY',[monetaryFact('JPY',10000,{factType:'sale_revenue',direction:'credit'})]);
 const cost=await fixture.statement('EUR',[monetaryFact('EUR',2000)]);
 const rate=await fixture.service.recordFxRate(fixture.context,monetaryRate('EUR','JPY',160,1));
 const metric=await fixture.metric('JPY');
 const run=await fixture.service.calculateProfit(fixture.context,{metricId:metric.id,expectedMetricVersion:1,statementIds:[revenue.id,cost.id],fxRateIds:[rate.id],coverageDimension:'aggregate',idempotencyKey:monetaryKey()});
 if(run.status!=='complete'||run.costMinor!==3200||run.profitMinor!==6800)throw Error('Original152 major-unit calculation failed');
 process.send({type:'seeded',context:fixture.context,runId:run.id,legacy:{...legacy,unknown},sourceSha256:'8c084af5a428c1334c2125fdd754b948deb8a01e6c8308413e58d41c77355005'});
}finally{await db.client.end();}
`;

describe.sequential("actual152 to153 introduces empty payment ledger and preserves all old business evidence", () => {
  const database = connectDatabase(); let processHandle: InvoiceProcess | undefined;
  afterAll(async () => {
    if (processHandle && processHandle.child.exitCode === null) await processHandle.stop(true);
    await database.client.end();
  });
  it("preserves every original table column and migration while creating no historical bills or payments", async () => {
    const workspace = fileURLToPath(new URL("../../../../", import.meta.url)), root = process.env.E2E_FINANCE_PAYABLES_LEGACY_SOURCE;
    if (!root || !isAbsolute(root)) throw new Error("Original152 source path required");
    const prefix = resolve(workspace, "docs/project-control/checkpoints/2026-10-21-finance-payables-e35b7c92");
    const metadata = JSON.parse(await readFile(prefix + "-old152.json", "utf8"));
    const manifest = JSON.parse(await readFile(prefix + "-source-before.json", "utf8"));
    expect(resolve(root)).toBe(resolve(metadata.snapshot)); expect(metadata.noEnvironmentCopied).toBe(true);
    expect(metadata.ordinaryServicesStarted).toBe(false); expect(manifest.files).toHaveLength(2648);
    expect(manifest.sha256).toBe("8c084af5a428c1334c2125fdd754b948deb8a01e6c8308413e58d41c77355005");
    expect(metadata.sourceSha256).toBe(manifest.sha256);
    for (const file of manifest.files) expect(createHash("sha256").update(await readFile(resolve(root, file.path))).digest("hex"), file.path).toBe(file.sha256);
    const source148 = resolve(workspace, ".artifacts/ordinary-api-source-148-41d9bb72"), manifest148 = JSON.parse(await readFile(resolve(workspace,
      "docs/project-control/checkpoints/2026-10-20-procurement-precision-9a62c173-source-before.json"), "utf8"));
    expect(manifest148.sha256).toBe("f2bcaa079b2fe33eda7608e4d96b15d9f8a3ebdcde7135ba8ed087607db52501"); expect(manifest148.files).toHaveLength(2598);
    for (const file of manifest148.files) expect(createHash("sha256").update(await readFile(resolve(source148, file.path))).digest("hex"), file.path).toBe(file.sha256);
    const old = observeInvoiceProcess(spawn(process.execPath, ["--import", "./node_modules/tsx/dist/loader.mjs", "--input-type=module", "--eval", seed148Source], {
      cwd: resolve(source148, "apps/api"), env: { ...process.env, TSX_DISABLE_CACHE: "1", PAYABLES_148_SOURCE: source148 },
      stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true,
    })); processHandle = old;
    const seed148 = await old.wait("seeded148", undefined, 120_000); expect(await old.closed).toBe(0);
    const child = observeInvoiceProcess(spawn(process.execPath, ["--import", "./node_modules/tsx/dist/loader.mjs", "--input-type=module", "--eval", seedSource], {
      cwd: resolve(root, "apps/api"), env: { ...process.env, TSX_DISABLE_CACHE: "1", E2E_FINANCE_MONETARY_ISOLATED: "1", PAYABLES_148_SEED: JSON.stringify(seed148) },
      stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true,
    })); processHandle = child;
    const seeded = await child.wait("seeded", undefined, 120_000) as unknown as { context: TenantContext; runId: string; sourceSha256: string;
      legacy: { context: TenantContext; supplierId: string; unknown: { id: string; totalMinor: number; allocationStatus: string } } };
    expect(await child.closed).toBe(0); expect(seeded.sourceSha256).toBe(manifest.sha256);
    const ledger = (await readMigrationEvidence(database)).actualRows; expect(ledger).toHaveLength(152);
    const checkpoint = await captureLegacyDataCheckpoint(database), before = await checkpoint.snapshot();
    await migrateDatabase(database); expect(await checkpoint.snapshot()).toEqual(before);
    await assertDatabaseMigrationsCurrent(database);
    expect((await readMigrationEvidence(database)).actualRows.slice(0, 152)).toEqual(ledger);
    const tables = ["finance_payable_bills", "finance_payable_payments", "finance_payment_allocation_batches", "finance_payment_allocations", "finance_allocation_releases"];
    await withTenant(database.db, seeded.context, async tx => {
      for (const table of tables) expect((await tx.execute(sql`select count(*)::int as n from ${sql.identifier(table)}`))[0]?.n).toBe(0);
      const flags = await tx.execute(sql`select relname,relrowsecurity,relforcerowsecurity from pg_class where relname=any(string_to_array(${tables.join(",")},','))`);
      expect(flags).toHaveLength(5); expect(flags.every(row => row.relrowsecurity === true && row.relforcerowsecurity === true)).toBe(true);
      const [old] = await tx.execute(sql`select status,cost_minor,profit_minor,monetary_basis from finance_profit_runs where id=${seeded.runId}`);
      expect(old.status).toBe("complete"); expect(String(old.cost_minor)).toBe("3200"); expect(String(old.profit_minor)).toBe("6800"); expect(old.monetary_basis).not.toBeNull();
    });
    const view = await new FinancePayablesService(database, new AuditService(database)).workspace(seeded.context);
    expect(view).toMatchObject({ bills: [], payments: [], allocations: [], releases: [], truncated: false });
    const body: RecordFinanceBillInput = { supplierId: seeded.legacy.supplierId, kind: "procurement_invoice", externalBillId: "GENUINE152-UNKNOWN", currency: "USD",
      amountMinor: seeded.legacy.unknown.totalMinor, issuedAt: "2026-07-01T00:00:00.000Z", dueAt: null, procurementInvoiceId: seeded.legacy.unknown.id,
      idempotencyKey: `synthetic-unknown-${createEntityId()}` };
    expect(seeded.legacy.unknown.allocationStatus).toBe("legacy_unknown");
    await expect(new FinancePayablesService(database, new AuditService(database)).recordBill(seeded.legacy.context, body))
      .rejects.toMatchObject({ response: { code: "finance_payables_source_unavailable" } });
    const checksum = createHash("sha256").update(canonicalFinancePayablesRequest("bill", body)).digest("hex");
    await expect(withTenant(database.db, seeded.legacy.context, async tx => {
      const [proof] = await tx.execute(sql`select id from inventory_supplier_invoice_requests where invoice_id=${body.procurementInvoiceId}`);
      const id = createEntityId();
      await tx.execute(sql`insert into finance_payable_bills(id,tenant_id,supplier_id,kind,external_bill_id,currency,amount_minor,issued_at,due_at,procurement_invoice_id,procurement_proof_id,idempotency_key,request_checksum,recorded_by)
       values(${id},${seeded.legacy.context.tenantId},${body.supplierId},${body.kind},${body.externalBillId},${body.currency},${body.amountMinor},${body.issuedAt},null,
        ${body.procurementInvoiceId},${proof.id},${body.idempotencyKey},${checksum},${seeded.legacy.context.userId})`);
      await new AuditService(database).recordInTransaction(tx, seeded.legacy.context, { action: "finance.payables.bill_recorded", resourceType: "finance_payable_bill", resourceId: id, result: "success" });
    })).rejects.toMatchObject({ cause: { code: "23514", message: "finance_payables_procurement_source_invalid" } });
    expect(await checkpoint.snapshot()).toEqual(before);
  }, 180_000);
});
