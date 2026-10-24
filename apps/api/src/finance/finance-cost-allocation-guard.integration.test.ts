import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import {
  financeCostPreviewChecksumIdentity, financeCostRunRequestIdentity, financeCostTargetBasisIdentity,
  financeCostVersionChecksumIdentity, financeCostVersionRequestIdentity,
  type FinanceCostAllocationPreview, type FinanceCostAllocationVersionInput,
} from "@yummyai/contracts/finance/cost-allocation";
import {
  connectDatabase, financeAllocatedProfitRuns, financeAllocatedProfitSlices, financeCostAllocationVersions,
  migrateDatabase, withTenant, type TenantTransaction,
} from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import {
  costKey, costProtectedTables, costTables, financeCostAllocationFixture, requireFinanceCostAllocationFixture,
} from "./finance-cost-allocation.fixtures.js";

// This must run before constructing a client, including isolated single-file runs.
requireFinanceCostAllocationFixture();

type VersionRow = typeof financeCostAllocationVersions.$inferSelect;
type RunRow = typeof financeAllocatedProfitRuns.$inferSelect;
type SliceRow = typeof financeAllocatedProfitSlices.$inferSelect;
type VersionDraft = { id: string; allocationId: string; versionNumber: number; previousVersionId: string | null;
  preview: FinanceCostAllocationPreview; input: FinanceCostAllocationVersionInput };
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const sqlFailure = <T>(operation: Promise<T>): Promise<T> => operation.catch(error => { throw error.cause ?? error; });
const guard = (message: string) => ({ code: "23514", message: `finance_cost_${message}` });

describe.sequential("cost allocation SQL independently guards real immutable attribution on the non-owner role", () => {
  const database = connectDatabase(), f = financeCostAllocationFixture(database), { context, allocations } = f;
  type Basis = Awaited<ReturnType<typeof f.basis>>;
  type Seed = { basis: Basis; version: VersionRow; run: RunRow; slices: SliceRow[] };
  let original: Seed;
  beforeAll(async () => { await migrateDatabase(database); await f.initialize(); original = await seed(); }, 60_000);
  afterAll(async () => { await database.client.end(); });
  const state = () => f.state([...costProtectedTables, ...costTables, "audit_events"]);

  async function seed(basis?: Basis): Promise<Seed> {
    const actual = basis ?? await f.basis(), { version } = await f.approve(f.previewInput(actual));
    const run = await f.calculate(actual, [version.id]);
    return withTenant(database.db, context, async tx => {
      const [versionRow] = await tx.select().from(financeCostAllocationVersions).where(eq(financeCostAllocationVersions.id, version.id));
      const [runRow] = await tx.select().from(financeAllocatedProfitRuns).where(eq(financeAllocatedProfitRuns.id, run.id));
      const slices = await tx.select().from(financeAllocatedProfitSlices).where(eq(financeAllocatedProfitSlices.runId, run.id));
      expect(versionRow).toBeDefined(); expect(runRow).toBeDefined();
      return { basis: actual, version: versionRow!, run: runRow!, slices };
    });
  }

  function copiedVersion(source: Seed = original, mutate?: (draft: VersionDraft) => void) {
    const id = createEntityId();
    const draft: VersionDraft = { id, allocationId: id, versionNumber: 1, previousVersionId: null,
      preview: structuredClone(source.version.preview), input: { ...structuredClone(source.version.requestIdentity.input), idempotencyKey: costKey() } };
    mutate?.(draft);
    draft.preview.previewChecksum = hash(financeCostPreviewChecksumIdentity(draft.preview));
    draft.input.previewChecksum = draft.preview.previewChecksum;
    const requestIdentity = financeCostVersionRequestIdentity(draft.input);
    return { ...source.version, id: draft.id, allocationId: draft.allocationId, versionNumber: draft.versionNumber,
      previousVersionId: draft.previousVersionId, preview: draft.preview, method: draft.preview.method,
      checksum: hash(financeCostVersionChecksumIdentity(draft)), requestIdentity, requestChecksum: hash(requestIdentity),
      idempotencyKey: draft.input.idempotencyKey, createdAt: undefined };
  }

  function copiedRun(source: Seed = original) {
    const id = createEntityId(), requestIdentity = financeCostRunRequestIdentity({ ...source.run.requestIdentity.input, idempotencyKey: costKey() });
    return { header: { ...source.run, id, requestIdentity, requestChecksum: hash(requestIdentity),
      idempotencyKey: requestIdentity.input.idempotencyKey, createdAt: undefined },
    slices: source.slices.map(slice => ({ ...slice, id: createEntityId(), runId: id, createdAt: undefined })) };
  }

  async function versionAudit(tx: TenantTransaction, row: ReturnType<typeof copiedVersion>, actor: TenantContext = context) {
    await f.audit.recordInTransaction(tx, actor, { action: "finance.cost_allocation.version_approved", resourceType: "finance_cost_allocation_version",
      resourceId: row.id, result: "success", metadata: { baseRunId: row.baseRunId, allocationId: row.allocationId, versionNumber: row.versionNumber } });
  }
  async function runAudit(tx: TenantTransaction, row: ReturnType<typeof copiedRun>, actor: TenantContext = context) {
    await f.audit.recordInTransaction(tx, actor, { action: "finance.cost_allocation.profit_calculated", resourceType: "finance_allocated_profit_run",
      resourceId: row.header.id, result: "success", metadata: { baseRunId: row.header.baseRunId, dimension: row.header.dimension,
        versionCount: row.header.versionPins.length, sliceCount: row.slices.length } });
  }

  async function insertVersion(row: ReturnType<typeof copiedVersion>, audit = true, actor: TenantContext = context) {
    return sqlFailure(withTenant(database.db, actor, async tx => {
      await tx.insert(financeCostAllocationVersions).values(row);
      if (audit) await versionAudit(tx, row, actor);
      await tx.execute(sql`set constraints all immediate`);
    }));
  }
  async function insertRun(row: ReturnType<typeof copiedRun>, audit = true) {
    return sqlFailure(withTenant(database.db, context, async tx => {
      await tx.insert(financeAllocatedProfitRuns).values(row.header);
      if (row.slices.length) await tx.insert(financeAllocatedProfitSlices).values(row.slices);
      if (audit) await runAudit(tx, row);
      await tx.execute(sql`set constraints all immediate`);
    }));
  }

  it("actually exercises a non-owner, non-superuser, forced-RLS application role", async () => {
    const rows = await withTenant(database.db, context, tx => tx.execute<{ superuser: boolean; bypass: boolean; forced: boolean; owns: boolean }>(sql`
      select r.rolsuper as superuser,r.rolbypassrls as bypass,c.relforcerowsecurity as forced,c.relowner=r.oid as owns
      from pg_roles r join pg_class c on c.relname='finance_cost_allocation_versions'
      join pg_namespace n on n.oid=c.relnamespace and n.nspname='public' where r.rolname=current_user`));
    expect([...rows]).toEqual([{ superuser: false, bypass: false, forced: true, owns: false }]);
  });

  it("validates the fully re-bound raw version and full run clone before deliberately rolling both back", async () => {
    const before = await state(), rollback = new Error("Synthetic attribution guard positive control rollback"); let validated = false;
    await expect(sqlFailure(withTenant(database.db, context, async tx => {
      const version = copiedVersion(), run = copiedRun();
      await tx.insert(financeCostAllocationVersions).values(version); await versionAudit(tx, version);
      await tx.insert(financeAllocatedProfitRuns).values(run.header); await tx.insert(financeAllocatedProfitSlices).values(run.slices); await runAudit(tx, run);
      await tx.execute(sql`set constraints all immediate`); validated = true; throw rollback;
    }))).rejects.toBe(rollback);
    expect(validated).toBe(true); expect(await state()).toEqual(before);
  });

  it("rejects a deterministic-tail redistribution even when total money and every outer checksum remain correct", async () => {
    const before = await state(), row = copiedVersion(original, draft => {
      const shares = draft.preview.sources[0]!.shares;
      shares[0]!.amountMinor--; shares[0]!.receivesRemainder = false;
      shares[2]!.amountMinor++; shares[2]!.receivesRemainder = true;
    });
    expect(row.preview.sources[0]!.shares.reduce((sum, share) => sum + share.amountMinor, 0)).toBe(101);
    await expect(insertVersion(row)).rejects.toMatchObject(guard("preview_mismatch"));
    expect(await state()).toEqual(before);
  });

  it("independently recomputes requested exact weights instead of trusting an old equal-weight snapshot", async () => {
    const before = await state(), row = copiedVersion(original, draft => {
      draft.preview.method = "manual_weights"; draft.input.method = "manual_weights";
      const share = draft.preview.sources[0]!.shares[0]!; share.weight = "2";
      draft.input.sources[0]!.targets.find(target => target.key === share.target.key)!.weight = "2";
    });
    await expect(insertVersion(row)).rejects.toMatchObject(guard("preview_mismatch"));
    expect(await state()).toEqual(before);
  });

  it("does not accept caller-supplied weight units despite a valid canonical request and unchanged source amount", async () => {
    const before = await state(), row = copiedVersion(original, draft => { draft.preview.sources[0]!.shares[0]!.weightUnits = "1000000001"; });
    await expect(insertVersion(row)).rejects.toMatchObject(guard("preview_mismatch")); expect(await state()).toEqual(before);
  });

  it("rejects a real line key with a different real parent even after recomputing its tuple and preview hashes", async () => {
    const before = await state(), row = copiedVersion(original, draft => {
      const target = draft.preview.sources[0]!.shares[0]!.target;
      target.orderId = original.basis.targets.find(item => item.orderId !== target.orderId)!.orderId;
      target.basisChecksum = hash(financeCostTargetBasisIdentity(target));
    });
    await expect(insertVersion(row)).rejects.toMatchObject(guard("target_invalid")); expect(await state()).toEqual(before);
  });

  it("requires the source fact's real immutable statement checksum instead of a self-consistent forged preview hash", async () => {
    const before = await state(), row = copiedVersion(original, draft => { draft.preview.sources[0]!.statementChecksum = "b".repeat(64); });
    await expect(insertVersion(row)).rejects.toMatchObject(guard("preview_mismatch")); expect(await state()).toEqual(before);
  });

  it("rejects a retained checksum from another approved allocation identity", async () => {
    const before = await state(), row = { ...copiedVersion(), checksum: original.version.checksum };
    await expect(insertVersion(row)).rejects.toMatchObject(guard("version_checksum_invalid")); expect(await state()).toEqual(before);
  });

  it("rejects omitting a real reversal from a complete family even with normalized request and recomputed hashes", async () => {
    const basis = await f.basis(), reversal = await f.correction(basis, "reversal"), replacement = await f.correction(basis, "replacement", 99);
    const base = await f.finance.calculateProfit(context, { ...basis.input,
      statementIds: [...basis.input.statementIds, reversal.id, replacement.id], idempotencyKey: costKey() });
    const corrected = await seed({ ...basis, base }), before = await state();
    const row = copiedVersion(corrected, draft => { draft.preview.sources = draft.preview.sources.filter(source => source.factId !== reversal.lines[0]!.id); });
    expect(corrected.version.preview.sources).toHaveLength(3); expect(row.preview.sources).toHaveLength(2);
    await expect(insertVersion(row)).rejects.toMatchObject(guard("source_shares_invalid")); expect(await state()).toEqual(before);
  });

  it("checks the actual predecessor and current version instead of trusting only the submitted version number", async () => {
    const nextInput = { ...f.previewInput(original.basis), allocationId: original.version.allocationId, expectedVersion: 1 };
    const next = await f.approve(nextInput), previewInput = { ...nextInput, expectedVersion: 2 };
    const preview = await allocations.preview(context, previewInput), before = await state();
    const row = copiedVersion(original, draft => {
      draft.allocationId = original.version.allocationId; draft.versionNumber = 3; draft.previousVersionId = original.version.id;
      draft.preview = structuredClone(preview); draft.input = { ...previewInput, previewChecksum: preview.previewChecksum, idempotencyKey: costKey() };
    });
    expect(next.version.id).not.toBe(row.previousVersionId);
    await expect(insertVersion(row)).rejects.toMatchObject(guard("version_sequence_invalid")); expect(await state()).toEqual(before);
  });

  it("requires every original contribution to retain a slice rather than allowing a caller to drop a booked cost", async () => {
    const before = await state(), row = copiedRun();
    const omitted = row.slices.find(slice => slice.allocationVersionId === null)!.baseContributionId;
    row.slices = row.slices.filter(slice => slice.baseContributionId !== omitted);
    await expect(insertRun(row)).rejects.toMatchObject(guard("slices_incomplete")); expect(await state()).toEqual(before);
  });

  it.each(["amountMinor", "originalReportingAmountMinor"] as const)("independently protects slice %s against the actual base contribution", async field => {
    const before = await state(), row = copiedRun(); row.slices.find(slice => slice.allocationVersionId !== null)![field]++;
    await expect(insertRun(row)).rejects.toMatchObject(guard(field === "amountMinor" ? "slice_share_invalid" : "slice_source_invalid"));
    expect(await state()).toEqual(before);
  });

  it.each(["version", "run"] as const)("requires the new %s's same-transaction successful audit after otherwise valid raw inserts", async operation => {
    const before = await state();
    await expect(operation === "version" ? insertVersion(copiedVersion(), false) : insertRun(copiedRun(), false)).rejects.toMatchObject(guard("atomic_audit_missing"));
    expect(await state()).toEqual(before);
  });

  it.each(["version", "run"] as const)("cannot reuse an earlier transaction's otherwise matching %s audit", async operation => {
    const version = copiedVersion(), run = copiedRun();
    await withTenant(database.db, context, tx => operation === "version" ? versionAudit(tx, version) : runAudit(tx, run));
    const before = await state();
    await expect(operation === "version" ? insertVersion(version, false) : insertRun(run, false)).rejects.toMatchObject(guard("atomic_audit_missing"));
    expect(await state()).toEqual(before);
  });

  it("cannot forge the reviewer while retaining another actor's valid canonical request", async () => {
    const before = await state(), row = { ...copiedVersion(), reviewedBy: f.coworker.userId };
    await expect(insertVersion(row)).rejects.toMatchObject(guard("version_request_invalid")); expect(await state()).toEqual(before);
  });

  it("cannot forge the calculator while retaining another actor's valid canonical request", async () => {
    const before = await state(), row = copiedRun(); row.header.calculatedBy = f.coworker.userId;
    await expect(insertRun(row)).rejects.toMatchObject(guard("run_request_invalid")); expect(await state()).toEqual(before);
  });

  it("cannot append a contribution slice to an already committed immutable attributed run", async () => {
    const before = await state(), row = { ...original.slices[0]!, id: createEntityId(), createdAt: undefined };
    await expect(sqlFailure(withTenant(database.db, context, tx => tx.insert(financeAllocatedProfitSlices).values(row)))).rejects.toMatchObject(guard("run_sealed"));
    expect(await state()).toEqual(before);
  });

  it("seals the full current run after an early constraint flush, so deferring again cannot authorize late slices", async () => {
    const before = await state(), row = copiedRun(); let closed = false;
    await expect(sqlFailure(withTenant(database.db, context, async tx => {
      await tx.insert(financeAllocatedProfitRuns).values(row.header); await tx.insert(financeAllocatedProfitSlices).values(row.slices); await runAudit(tx, row);
      await tx.execute(sql`set constraints all immediate`); closed = true;
      await tx.execute(sql`set constraints all deferred`);
      await tx.insert(financeAllocatedProfitSlices).values({ ...row.slices[0]!, id: createEntityId() });
    }))).rejects.toMatchObject(guard("run_sealed"));
    expect(closed).toBe(true); expect(await state()).toEqual(before);
  });

  it("cannot use an actual foreign-tenant target tuple even when the client knows all of its IDs", async () => {
    const before = await state(), foreign = f.foreign[0]!, row = copiedVersion(original, draft => {
      const share = draft.preview.sources[0]!.shares[0]!, previousKey = share.target.key;
      share.target = { ...share.target, key: foreign.lineId, orderId: foreign.orderId, orderLineId: foreign.lineId,
        skuId: foreign.skuId, listingId: null, accountId: foreign.accountId, spuId: foreign.spuId, catalogLinkId: foreign.catalogLinkId };
      share.target.basisChecksum = hash(financeCostTargetBasisIdentity(share.target));
      draft.input.sources[0]!.targets.find(target => target.key === previousKey)!.key = foreign.lineId;
    });
    await expect(insertVersion(row)).rejects.toMatchObject(guard("target_invalid")); expect(await state()).toEqual(before);
    for (const [table, id] of [["finance_cost_allocation_versions", original.version.id], ["finance_allocated_profit_runs", original.run.id], ["finance_allocated_profit_slices", original.slices[0]!.id]])
      expect(await withTenant(database.db, f.outsider, tx => tx.execute(sql`select id from ${sql.identifier(table!)} where id=${id}`))).toHaveLength(0);
  });

  it("rejects a numeric version request key even when its textual column and canonical request hash agree", async () => {
    const before = await state(), row = copiedVersion();
    const requestIdentity = { ...row.requestIdentity, input: { ...row.requestIdentity.input, idempotencyKey: 12345678 } };
    const candidate = { ...row, idempotencyKey: "12345678", requestIdentity: requestIdentity as unknown as typeof row.requestIdentity,
      requestChecksum: hash(requestIdentity) };
    await expect(insertVersion(candidate)).rejects.toMatchObject(guard("version_request_invalid"));
    expect(await state()).toEqual(before);
  });

  it("rejects a numeric run request key even when its textual column and canonical request hash agree", async () => {
    const before = await state(), row = copiedRun();
    const requestIdentity = { ...row.header.requestIdentity, input: { ...row.header.requestIdentity.input, idempotencyKey: 12345678 } };
    row.header = { ...row.header, idempotencyKey: "12345678", requestIdentity: requestIdentity as unknown as typeof row.header.requestIdentity,
      requestChecksum: hash(requestIdentity) };
    await expect(insertRun(row)).rejects.toMatchObject(guard("run_request_invalid"));
    expect(await state()).toEqual(before);
  });

  it("rejects a numeric reason code despite a valid string preview, version checksum and canonical request hash", async () => {
    const before = await state(), row = copiedVersion(original, draft => {
      draft.preview.reasonCode = "12345678"; draft.input.reasonCode = "12345678";
    });
    const requestIdentity = { ...row.requestIdentity, input: { ...row.requestIdentity.input, reasonCode: 12345678 } };
    const candidate = { ...row, reasonCode: "12345678", requestIdentity: requestIdentity as unknown as typeof row.requestIdentity,
      requestChecksum: hash(requestIdentity) };
    await expect(insertVersion(candidate)).rejects.toMatchObject(guard("preview_request_invalid"));
    expect(await state()).toEqual(before);
  });
});
