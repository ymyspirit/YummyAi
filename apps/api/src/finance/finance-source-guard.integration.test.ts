import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createEntityId } from "@yummyai/contracts";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { connectDatabase, withTenant, financeStatements, financeFacts, financeProfitRuns,
  financeProfitContributions, financeProfitMetrics, financeProfitMetricVersions } from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { financeMonetaryFixture, monetaryFact, monetaryKey } from "./finance-monetary.fixtures.js";

if (process.env.E2E_FINANCE_AUTHORITY_ISOLATED !== "1") throw new Error("Finance source SQL suite requires its own isolated runner");
// The fixture independently rejects a missing isolation flag/non-disposable DB
// before using the connection. All business rows still use the application role.
describe.sequential("finance source SQL boundaries on the non-owner role", () => {
  const database = connectDatabase(), f = financeMonetaryFixture(database);
  beforeAll(() => f.initialize()); afterAll(() => database.client.end());
  async function basis() {
    const statement = await f.statement("USD", [monetaryFact("USD", 10000, { factType: "sale_revenue", direction: "credit" }), monetaryFact("USD", 2000)]);
    return withTenant(database.db, f.context, async tx => {
      const [header] = await tx.select().from(financeStatements).where(eq(financeStatements.id, statement.id));
      const facts = await tx.select().from(financeFacts).where(eq(financeFacts.statementId, statement.id));
      return { header: header!, facts };
    });
  }
  async function copyStatement(b: Awaited<ReturnType<typeof basis>>, change: Partial<typeof financeStatements.$inferInsert> = {},
    mutate?: (row: typeof financeFacts.$inferInsert) => typeof financeFacts.$inferInsert, audit = true) {
    return unwrapSqlFailure(withTenant(database.db, f.context, async tx => {
      const { header, facts } = copiedEvidence(b, change, mutate);
      await tx.insert(financeStatements).values(header);
      await tx.insert(financeFacts).values(facts);
      if (audit) await f.audit.recordInTransaction(tx, f.context, { action: "finance.statement.record", resourceType: "finance_statement", resourceId: header.id, result: "success", metadata: { lineCount: facts.length } });
    }));
  }
  function copiedEvidence(b: Awaited<ReturnType<typeof basis>>, change: Partial<typeof financeStatements.$inferInsert> = {},
    mutate?: (row: typeof financeFacts.$inferInsert) => typeof financeFacts.$inferInsert) {
    const id = createEntityId(), header = { ...b.header, id, idempotencyKey: monetaryKey(), externalStatementId: monetaryKey(), recordedAt: undefined, ...change };
    const facts = b.facts.map(row => {
      const next = { ...row, id: createEntityId(), statementId: id, sourceEntryId: monetaryKey(), recordedAt: undefined };
      return mutate ? mutate(next) : next;
    });
    const sourceInput = { accountId: header.accountId, provider: header.provider, statementKind: header.statementKind,
      externalStatementId: header.externalStatementId, periodStart: header.periodStart.toISOString(), periodEnd: header.periodEnd.toISOString(),
      sourceCurrency: header.sourceCurrency, observedAt: header.observedAt.toISOString(), sourceIdentity: header.sourceIdentity,
      lines: facts.map(row => ({ sourceEntryId: row.sourceEntryId, lineKey: row.lineKey, factType: row.factType, direction: row.direction,
        amountMinor: row.amountMinor, currency: row.currency, occurredAt: row.occurredAt.toISOString(), externalReference: row.externalReference ?? null,
        orderId: row.orderId ?? null, orderLineId: row.orderLineId ?? null, skuId: row.skuId ?? null, listingId: row.listingId ?? null,
        supplierId: row.supplierId ?? null, correctionKind: row.correctionKind, correctsFactId: row.correctsFactId ?? null }))
        .sort((left, right) => left.lineKey.localeCompare(right.lineKey)) };
    return { header: { ...header, sourceInput, checksum: checksum(sourceInput) }, facts };
  }
  const checksum = (body: unknown) => createHash("sha256").update(canonicalJson(body)).digest("hex");
  const unwrapSqlFailure = <T>(operation: Promise<T>): Promise<T> => operation.catch(error => { throw error.cause ?? error; });
  const guard = (message: string) => ({ code: "23514", message });
  it("rejects omitted, JSON-null or forged-kind source metadata without adding history", async () => {
    const b = await basis(), before = await f.state();
    for (const sourceIdentity of [null, { schemaVersion: 2, kind: null }, { schemaVersion: 2, kind: "supplier", supplierId: null }]) {
      await expect(copyStatement(b, { sourceIdentity: sourceIdentity as typeof b.header.sourceIdentity }))
        .rejects.toMatchObject({ code: "23514" });
    }
    expect(await f.state()).toEqual(before);
  });
  it("binds each entry to the immutable statement provider, scope and currency", async () => {
    const b = await basis(), before = await f.state();
    for (const change of [{ sourceScopeKey: "source:OTHER" }, { sourceProvider: "carrier" as const }, { sourceEntryId: null }, { sourceEntryId: "" }, { currency: "JPY" }])
      await expect(copyStatement(b, {}, row => ({ ...row, ...change }))).rejects.toMatchObject(guard("finance_source_entry_invalid"));
    expect(await f.state()).toEqual(before);
  });
  it("rejects the same source component in a different statement even with another document/line key", async () => {
    const b = await basis(), before = await f.state();
    await expect(copyStatement(b, {}, row => ({ ...row, lineKey: monetaryKey(), sourceEntryId: b.facts[0]!.sourceEntryId })))
      .rejects.toMatchObject({ code: "23505", constraint_name: "finance_facts_source_entry_unique" });
    expect(await f.state()).toEqual(before);
  });
  it("rejects source-entry edge whitespace that JavaScript trim would hide on a read", async () => {
    const b = await basis(), before = await f.state();
    for (const edge of ["\u00a0", "\ufeff", "\u1680", "\u2000", "\u200a", "\u2028", "\u2029", "\u202f", "\u205f", "\u3000"])
      await expect(copyStatement(b, {}, row => ({ ...row, sourceEntryId: `${edge}SYNTHETIC-COMPONENT${edge}` })))
        .rejects.toMatchObject(guard("finance_source_entry_invalid"));
    await expect(copyStatement(b, {}, row => ({ ...row, sourceEntryId: "\u{20000}".repeat(151) })))
      .rejects.toMatchObject(guard("finance_source_entry_invalid"));
    expect(await f.state()).toEqual(before);
  });
  it("binds the stored source body and checksum to both its header and every financial amount", async () => {
    const b = await basis(), before = await f.state();
    await expect(unwrapSqlFailure(withTenant(database.db, f.context, async tx => {
      const { header } = copiedEvidence(b);
      await tx.insert(financeStatements).values({ ...header, checksum: b.header.checksum });
    }))).rejects.toMatchObject(guard("finance_source_input_mismatch"));
    await expect(unwrapSqlFailure(withTenant(database.db, f.context, async tx => {
      const { header, facts } = copiedEvidence(b);
      await tx.insert(financeStatements).values(header);
      await tx.insert(financeFacts).values({ ...facts[0]!, amountMinor: facts[0]!.amountMinor + 1 });
    }))).rejects.toMatchObject(guard("finance_source_line_mismatch"));
    expect(await f.state()).toEqual(before);
  });
  it("rejects sub-microsecond source text instead of silently rounding away original evidence", async () => {
    const b = await basis(), before = await f.state();
    for (const target of ["header", "fact"] as const) await expect(unwrapSqlFailure(withTenant(database.db, f.context, async tx => {
      const { header, facts } = copiedEvidence(b);
      const sourceInput = target === "header" ? { ...header.sourceInput, observedAt: "2026-08-01T00:00:00.0000001Z" }
        : { ...header.sourceInput, lines: header.sourceInput.lines.map(line => ({ ...line, occurredAt: "2026-07-15T00:00:00.0000001Z" })) };
      await tx.insert(financeStatements).values({ ...header, sourceInput, checksum: checksum(sourceInput) });
      await tx.insert(financeFacts).values(facts);
    }))).rejects.toMatchObject(guard("finance_source_date_invalid"));
    expect(await f.state()).toEqual(before);
  });
  it("rejects source text that would make a valid import unreadable through the public contract", async () => {
    const b = await basis(), before = await f.state();
    for (const change of [{ externalStatementId: "" }, { externalStatementId: "X".repeat(301) }, { externalStatementId: "\u00a0DOC\u00a0" }])
      await expect(copyStatement(b, change)).rejects.toMatchObject(guard("finance_source_reference_invalid"));
    for (const change of [{ lineKey: "" }, { lineKey: "X".repeat(301) }, { lineKey: "\ufeffLINE\ufeff" },
      { externalReference: "" }, { externalReference: "X".repeat(301) }, { externalReference: "\u00a0ORDER\u00a0" }])
      await expect(copyStatement(b, {}, row => ({ ...row, ...change }))).rejects.toMatchObject(guard("finance_source_reference_invalid"));
    expect(await f.state()).toEqual(before);
  });
  it("requires the full declared line set and cannot append facts after the successful import audit", async () => {
    const b = await basis(), before = await f.state(); let closed = false;
    await expect(unwrapSqlFailure(withTenant(database.db, f.context, async tx => {
      const { header, facts } = copiedEvidence(b);
      await tx.insert(financeStatements).values(header); await tx.insert(financeFacts).values(facts.slice(0, 1));
      await f.audit.recordInTransaction(tx, f.context, { action: "finance.statement.record", resourceType: "finance_statement", resourceId: header.id,
        result: "success", metadata: { lineCount: 1 } });
      await tx.execute(sql`set constraints all immediate`);
    }))).rejects.toMatchObject(guard("finance_statement_entries_incomplete"));
    await expect(unwrapSqlFailure(withTenant(database.db, f.context, async tx => {
      const { header, facts } = copiedEvidence(b);
      await tx.insert(financeStatements).values(header); await tx.insert(financeFacts).values(facts);
      await f.audit.recordInTransaction(tx, f.context, { action: "finance.statement.record", resourceType: "finance_statement", resourceId: header.id,
        result: "success", metadata: { lineCount: facts.length } });
      await tx.execute(sql`set constraints all immediate`); closed = true;
      await tx.execute(sql`set constraints all deferred`);
      await tx.insert(financeFacts).values({ ...facts[0]!, id: createEntityId(), sourceEntryId: monetaryKey(), lineKey: monetaryKey() });
    }))).rejects.toMatchObject(guard("finance_statement_is_sealed"));
    expect(closed).toBe(true); expect(await f.state()).toEqual(before);
  });
  it("cannot commit new statement facts without their same-transaction successful audit", async () => {
    const b = await basis(), before = await f.state();
    await expect(copyStatement(b, {}, undefined, false)).rejects.toMatchObject(guard("finance_atomic_audit_missing"));
    expect(await f.state()).toEqual(before);
  });
  it("rejects an empty statement even when the caller inserts a success audit", async () => {
    const b = await basis(), before = await f.state();
    await expect(unwrapSqlFailure(withTenant(database.db, f.context, async tx => {
      const { header } = copiedEvidence(b);
      await tx.insert(financeStatements).values(header);
      await f.audit.recordInTransaction(tx, f.context, { action: "finance.statement.record", resourceType: "finance_statement", resourceId: header.id, result: "success", metadata: { lineCount: 0 } });
    }))).rejects.toMatchObject(guard("finance_statement_entries_required"));
    expect(await f.state()).toEqual(before);
  });
  it("rejects unversioned or false profit source diagnostics with exact original contributions present", async () => {
    const b = await basis(), metric = await f.metric("USD");
    const run = await f.service.calculateProfit(f.context, { metricId: metric.id, expectedMetricVersion: 1,
      statementIds: [b.header.id], fxRateIds: [], coverageDimension: "aggregate", idempotencyKey: monetaryKey() });
    const before = await f.state();
    for (const missingVersion of [true, false]) await expect(unwrapSqlFailure(withTenant(database.db, f.context, async tx => {
      const [original] = await tx.select().from(financeProfitRuns).where(eq(financeProfitRuns.id, run.id));
      const contributions = await tx.select().from(financeProfitContributions).where(eq(financeProfitContributions.runId, run.id));
      const id = createEntityId();
      await tx.insert(financeProfitRuns).values({ ...original!, id, idempotencyKey: monetaryKey(), calculatedAt: undefined,
        sourceIdentityVersion: missingVersion ? null : 1,
        diagnostics: { ...original!.diagnostics, sourceIdentity: { schemaVersion: 1, unidentifiedFactIds: missingVersion ? [] : [createEntityId()] } } });
      await tx.insert(financeProfitContributions).values(contributions.map(row => ({ ...row, id: createEntityId(), runId: id, createdAt: undefined })));
      await f.audit.recordInTransaction(tx, f.context, { action: "finance.profit.calculate", resourceType: "finance_profit_run", resourceId: id, result: "success" });
    }))).rejects.toMatchObject(guard(missingVersion ? "finance_profit_source_version_required" : "finance_profit_source_diagnostics_invalid"));
    expect(await f.state()).toEqual(before);
  });
  it("cannot rename/advance the metric projection without its pinned request and new version", async () => {
    const metric = await f.metric("USD"), before = await f.state();
    for (const change of [{ name: "SYNTHETIC-UNBACKED-RENAME" }, { currentVersion: 2 }])
      await expect(unwrapSqlFailure(withTenant(database.db, f.context, tx => tx.update(financeProfitMetrics).set(change).where(eq(financeProfitMetrics.id, metric.id)))))
        .rejects.toMatchObject(guard("finance_metric_projection_mismatch"));
    expect(await f.state()).toEqual(before);
  });
  it("cannot change metric rules while retaining another version's checksum and valid request identity", async () => {
    const metric = await f.metric("USD"), before = await f.state();
    await expect(unwrapSqlFailure(withTenant(database.db, f.context, async tx => {
      const [version] = await tx.select().from(financeProfitMetricVersions).where(eq(financeProfitMetricVersions.id, metric.version.id));
      await tx.insert(financeProfitMetricVersions).values({ ...version!, id: createEntityId(), versionNumber: 2, idempotencyKey: monetaryKey(),
        costFactTypes: ["procurement_cost"], requiredFactTypes: ["sale_revenue", "procurement_cost"],
        requestIdentity: { metricId: metric.id, expectedVersion: 1, name: metric.name }, createdAt: undefined });
    }))).rejects.toMatchObject(guard("finance_metric_checksum_mismatch"));
    expect(await f.state()).toEqual(before);
  });
  it("cannot reuse the first version's audit after flushing and deferring constraints in the same transaction", async () => {
    const metric = await f.metric("USD"), before = await f.state(); let firstVersionClosed = false;
    await expect(unwrapSqlFailure(withTenant(database.db, f.context, async tx => {
      const [header] = await tx.select().from(financeProfitMetrics).where(eq(financeProfitMetrics.id, metric.id));
      const [version] = await tx.select().from(financeProfitMetricVersions).where(eq(financeProfitMetricVersions.id, metric.version.id));
      const metricId = createEntityId(), name = `SYNTHETIC-CLOSED-${monetaryKey()}`;
      const versionChecksum = checksum({ name, reportingCurrency: version!.reportingCurrency,
        revenueFactTypes: [...version!.revenueFactTypes].sort(), costFactTypes: [...version!.costFactTypes].sort(),
        requiredFactTypes: [...version!.requiredFactTypes].sort(), reasonCode: version!.reasonCode });
      await tx.insert(financeProfitMetrics).values({ ...header!, id: metricId, name, createdAt: undefined, updatedAt: undefined });
      await tx.insert(financeProfitMetricVersions).values({ ...version!, id: createEntityId(), metricId, idempotencyKey: monetaryKey(),
        requestIdentity: { metricId: null, name }, checksum: versionChecksum, createdAt: undefined });
      await f.audit.recordInTransaction(tx, f.context, { action: "finance.profit_metric.version", resourceType: "finance_profit_metric", resourceId: metricId,
        result: "success", metadata: { version: 1 } });
      await tx.execute(sql`set constraints all immediate`); firstVersionClosed = true;
      await tx.execute(sql`set constraints all deferred`);
      await tx.insert(financeProfitMetricVersions).values({ ...version!, id: createEntityId(), metricId, versionNumber: 2, idempotencyKey: monetaryKey(),
        requestIdentity: { metricId, expectedVersion: 1, name }, checksum: versionChecksum, createdAt: undefined });
      await tx.update(financeProfitMetrics).set({ currentVersion: 2 }).where(eq(financeProfitMetrics.id, metricId));
    }))).rejects.toMatchObject(guard("finance_atomic_audit_missing"));
    expect(firstVersionClosed).toBe(true); expect(await f.state()).toEqual(before);
  });
  it("retains forced RLS, no application update grants and immutable evidence triggers", async () => {
    await withTenant(database.db, f.context, async tx => {
      const rows = await tx.execute(sql`select c.relname,c.relrowsecurity,c.relforcerowsecurity,
        has_table_privilege(current_user,c.oid,'UPDATE') as can_update,
        exists(select 1 from pg_trigger t where t.tgrelid=c.oid and t.tgname=c.relname||'_immutable') as immutable
        from pg_class c where c.relname=any(string_to_array('finance_statements,finance_facts,finance_fx_rates,finance_profit_metric_versions,finance_profit_runs,finance_profit_contributions',','))`);
      expect(rows).toHaveLength(6);
      expect(rows.every(row => row.relrowsecurity === true && row.relforcerowsecurity === true && row.can_update === false && row.immutable === true)).toBe(true);
    });
  });
});
