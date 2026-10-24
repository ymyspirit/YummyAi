import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { type RecordFinanceBillInput, type RecordFinancePaymentInput } from "@yummyai/contracts/finance/payables";
import { connectDatabase, migrateDatabase, readMigrationEvidence, assertDatabaseMigrationsCurrent, withTenant } from "@yummyai/database";
import { sql } from "drizzle-orm";
import { captureLegacyDataCheckpoint } from "../../../../tools/testing/legacy-data-checkpoint.mjs";
import { observeInvoiceProcess, type InvoiceProcess } from "../procurement/invoice-command.fixtures.js";
import { AuditService } from "../audit/audit.service.js";
import { FinancePayablesService } from "./finance-payables.service.js";
import { FinancePayablesAdjustmentsService } from "./finance-payables-adjustments.service.js";

const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid");
if (process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_FINANCE_PAYABLES_ADJUSTMENTS_ISOLATED !== "1"
  || process.env.E2E_LEGACY_SCHEMA_TARGET !== "pre-0155" || !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(url.pathname))
  throw new Error("Real154 payable upgrade requires its dedicated disposable database before connection");

// This child imports only byte-verified original154 owners and contracts. It
// creates actual original invoices, receiving, financial rows and 151 reviews.
const seed = String.raw`
import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';import {resolve} from 'node:path';import {randomBytes} from 'node:crypto';
const root=process.env.E2E_FINANCE_PAYABLES_ADJUSTMENTS_LEGACY_SOURCE,load=p=>import(pathToFileURL(resolve(root,p)).href);
if(!process.connected||process.env.E2E_FINANCE_PAYABLES_ADJUSTMENTS_ISOLATED!=='1'||process.env.E2E_LEGACY_SCHEMA_TARGET!=='pre-0155')throw Error('Original154 isolated IPC required');
const require=createRequire(pathToFileURL(resolve(root,'apps/api/package.json')));require('reflect-metadata');const {eq}=require('drizzle-orm');
const {connectDatabase,readMigrationEvidence,withTenant,roles}=await load('packages/database/src/index.ts');
const {Permission}=await load('packages/authz/src/index.ts');const {createEntityId}=await load('packages/contracts/src/index.ts');
const {invoiceReconciliationFixture,protectedInvoiceTables}=await load('apps/api/src/procurement/invoice-reconciliation.fixtures.ts');
const {FinancePayablesService}=await load('apps/api/src/finance/finance-payables.service.ts');
const {ProcurementCommandService}=await load('apps/api/src/procurement/procurement-command.service.ts');const {SecretVault}=await load('packages/ai-core/src/secrets.ts');
const db=connectDatabase();try{
 if((await readMigrationEvidence(db)).actualRows.length!==154)throw Error('Actual154 schema required');
 const f=invoiceReconciliationFixture(db);await f.initialize();
 const permissions=[...new Set([...f.context.permissions,Permission.FinanceRead,Permission.FinanceWrite,Permission.FinanceReview])];
 const context={...f.context,permissions};await withTenant(db.db,context,tx=>tx.update(roles).set({permissions,dataScope:'tenant'}).where(eq(roles.id,f.roleIds.get(context.userId))));
 const source=await f.basis();const owner=new FinancePayablesService(db,f.audit),key=()=> 'actual154-upgrade-'+createEntityId();
 const billInput={supplierId:f.supplierId,kind:'procurement_invoice',externalBillId:source.invoice.invoiceNumber,currency:source.invoice.currency,amountMinor:source.invoice.totalMinor,
  issuedAt:source.invoice.issuedAt,dueAt:null,procurementInvoiceId:source.invoice.id,idempotencyKey:key()};
 const bill=await owner.recordBill(context,billInput);
 const paymentInput={supplierId:f.supplierId,externalPaymentId:'ACTUAL154-'+createEntityId(),currency:bill.currency,amountMinor:240,paidAt:bill.issuedAt,
  method:'bank_transfer',evidenceReference:'SYNTHETIC-ORIGINAL154-PAYMENT',idempotencyKey:key()};
 const payment=await owner.recordPayment(context,paymentInput);
 const first=await owner.allocate(context,{paymentId:payment.id,allocations:[{billId:bill.id,amountMinor:60}],idempotencyKey:key()});
 await owner.release(context,first.allocations[0].id,{reasonCode:'SYNTHETIC_ORIGINAL_MAPPING_ERROR',idempotencyKey:key()});
 const originalBatchInput={paymentId:payment.id,allocations:[{billId:bill.id,amountMinor:240}],idempotencyKey:key()};
 const originalBatch=await owner.allocate(context,originalBatchInput);
 const secret=randomBytes(32),commands=new ProcurementCommandService(db,new SecretVault(secret),f.owner,f.audit);
 const execute=async prepared=>{const intent=await commands.prepare(context,prepared);const result=await commands.execute(context,intent.id);await commands.acknowledge(context,intent.id);if(!result.reconciliationResult)throw Error('Actual151 result missing');return result.reconciliationResult;};
 const credit=await execute(await f.record(source.invoice.id,source.invoiceLine.id,{quantity:'0.05',amountMinor:60}));
 const review=await execute(await f.review(source.invoice.id,credit.id));secret.fill(0);
 const workspace=await owner.workspace(context);if(workspace.bills.find(row=>row.id===bill.id).sourceStatus!=='source_adjusted')throw Error('Original154 source gate must hold');
 process.send({type:'seeded154',context,billInput,paymentInput,bill,payment,originalBatchInput,originalBatch,creditId:credit.id,reviewId:review.id,
  invoiceId:source.invoice.id,protectedTables:[...protectedInvoiceTables,'inventory_invoice_reconciliations','inventory_invoice_allocation_effects','finance_facts','finance_profit_contributions']});
}finally{await db.client.end();}
`;

describe.sequential("actual154 to155 retains original evidence and adds explicit corrections", () => {
  const database = connectDatabase(); let processHandle: InvoiceProcess | undefined;
  afterAll(async () => { if (processHandle && processHandle.child.exitCode === null) await processHandle.stop(true); await database.client.end(); });
  it("preserves every old column and ledger, replays old keys, then corrects a paid genuine procurement invoice explicitly", async () => {
    const workspace = fileURLToPath(new URL("../../../../", import.meta.url)), root = process.env.E2E_FINANCE_PAYABLES_ADJUSTMENTS_LEGACY_SOURCE;
    if (!root || !isAbsolute(root)) throw new Error("Original154 source path required");
    const prefix = resolve(workspace, "docs/project-control/checkpoints/2026-10-21-finance-adjustments-a96c21f4");
    const metadata = JSON.parse(await readFile(prefix + "-old154.json", "utf8"));
    const manifest = JSON.parse(await readFile(prefix + "-source-before.json", "utf8"));
    expect(resolve(root)).toBe(resolve(metadata.snapshot)); expect(metadata.noEnvironmentCopied).toBe(true); expect(metadata.ordinaryServicesStarted).toBe(false);
    expect(manifest.files).toHaveLength(2672); expect(manifest.sha256).toBe("d2de8489437eadc1fb46ac27cc1dc1703e4f996f86736a4c04899425894e6326");
    expect(metadata.sourceSha256).toBe(manifest.sha256);
    for (const file of manifest.files) expect(createHash("sha256").update(await readFile(resolve(root, file.path))).digest("hex"), file.path).toBe(file.sha256);
    const child = observeInvoiceProcess(spawn(process.execPath, ["--import", "./node_modules/tsx/dist/loader.mjs", "--input-type=module", "--eval", seed], {
      cwd: resolve(root, "apps/api"), env: { ...process.env, TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(root, "apps/api/tsconfig.json") },
      stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true,
    })); processHandle = child;
    const seeded = await child.wait("seeded154", undefined, 120_000) as unknown as {
      context: TenantContext; billInput: RecordFinanceBillInput; paymentInput: RecordFinancePaymentInput;
      bill: { id: string }; payment: { id: string }; originalBatchInput: { paymentId: string; allocations: { billId: string; amountMinor: number }[]; idempotencyKey: string };
      originalBatch: { id: string; allocations: { id: string }[] }; creditId: string; reviewId: string; protectedTables: string[];
    };
    expect(await child.closed).toBe(0);
    const ledger = (await readMigrationEvidence(database)).actualRows; expect(ledger).toHaveLength(154);
    const checkpoint = await captureLegacyDataCheckpoint(database), before = await checkpoint.snapshot();
    await migrateDatabase(database); expect(await checkpoint.snapshot()).toEqual(before); await assertDatabaseMigrationsCurrent(database);
    expect((await readMigrationEvidence(database)).actualRows.slice(0, 154)).toEqual(ledger);
    const audit = new AuditService(database), owner = new FinancePayablesService(database, audit), corrections = new FinancePayablesAdjustmentsService(database, audit);
    const originalTables = ["finance_payable_bills", "finance_payable_payments", "finance_payment_allocation_batches", "finance_payment_allocations", "finance_allocation_releases"];
    const rows = (tables: string[]) => withTenant(database.db, seeded.context, async tx => {
      const output: Record<string, Array<Record<string, unknown>>> = {};
      for (const table of tables) output[table] = await tx.execute(sql`select * from ${sql.identifier(table)} order by id`);
      return output;
    });
    const oldRows = await rows(originalTables), protectedRows = await rows(seeded.protectedTables);
    const originalAudit = (await rows(["audit_events"])).audit_events;
    expect((await owner.recordBill(seeded.context, seeded.billInput))).toMatchObject({ id: seeded.bill.id, amountMinor: 240, netAmountMinor: 240, sourceStatus: "source_adjusted", creditMinor: 0 });
    expect((await owner.recordPayment(seeded.context, seeded.paymentInput))).toMatchObject({ id: seeded.payment.id, amountMinor: 240, netAmountMinor: 240, allocatedMinor: 240 });
    expect((await owner.allocate(seeded.context, seeded.originalBatchInput)).id).toBe(seeded.originalBatch.id);
    expect(await rows(originalTables)).toEqual(oldRows); expect((await rows(["audit_events"])).audit_events).toEqual(originalAudit);
    const input = { kind: "procurement_sync", procurementAdjustmentId: seeded.creditId, procurementReviewId: seeded.reviewId, expectedNetAmountMinor: 240, idempotencyKey: `upgrade-correction-${createEntityId()}` };
    await expect(corrections.recordBillAdjustment(seeded.context, seeded.bill.id, input)).rejects.toMatchObject({ response: { code: "finance_payables_adjustment_requires_release" } });
    await owner.release(seeded.context, seeded.originalBatch.allocations[0]!.id, { reasonCode: "SYNTHETIC_APPROVED_CREDIT_REMAP", idempotencyKey: `upgrade-release-${createEntityId()}` });
    const adjusted = await corrections.recordBillAdjustment(seeded.context, seeded.bill.id, input);
    expect(adjusted.balanceAfter).toMatchObject({ amountMinor: 240, creditMinor: 60, netAmountMinor: 180, allocatedMinor: 0, outstandingMinor: 180 });
    expect(await corrections.recordBillAdjustment(seeded.context, seeded.bill.id, input)).toEqual(adjusted);
    await owner.allocate(seeded.context, { paymentId: seeded.payment.id, allocations: [{ billId: seeded.bill.id, amountMinor: 180 }], idempotencyKey: `upgrade-remap-${createEntityId()}` });
    const refund = await corrections.recordPaymentAdjustment(seeded.context, seeded.payment.id, { kind: "refund", amountMinor: 60, expectedNetAmountMinor: 240,
      externalDocumentId: `UPGRADE-REFUND-${createEntityId()}`, evidenceReference: "SYNTHETIC-ACTUAL-SUPPLIER-REFUND", occurredAt: new Date().toISOString(), reasonCode: "APPROVED_RETURN", idempotencyKey: `upgrade-refund-${createEntityId()}` });
    expect(refund.balanceAfter).toMatchObject({ amountMinor: 240, refundedMinor: 60, netAmountMinor: 180, allocatedMinor: 180, unallocatedMinor: 0 });
    const current = await owner.workspace(seeded.context);
    expect(current.bills.find(row => row.id === seeded.bill.id)).toMatchObject({ amountMinor: 240, netAmountMinor: 180, allocatedMinor: 180, sourceStatus: "current" });
    expect(current.billAdjustments).toEqual([adjusted]); expect(current.paymentAdjustments).toEqual([refund]);
    expect(await rows(seeded.protectedTables)).toEqual(protectedRows);
    const after = await rows(originalTables);
    for (const table of originalTables) for (const old of oldRows[table]!) expect(after[table]!.find(row => row.id === old.id)).toEqual(old);
  }, 180_000);
});
