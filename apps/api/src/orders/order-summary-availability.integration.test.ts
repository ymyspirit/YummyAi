import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Permission } from "@yummyai/authz";
import { createEntityId } from "@yummyai/contracts";
import { OrderWorkSummariesSchema, type OrderWorkSummary, type OrderWorkSummaryAvailability } from "@yummyai/contracts/order/workspace";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrderSummaryFixture, type OrderSummaryCase } from "./order-summary-availability.test-fixture.js";

type Fixture = Awaited<ReturnType<typeof createOrderSummaryFixture>>;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function unavailable(value: OrderWorkSummary, availability: Exclude<OrderWorkSummaryAvailability, "available">, source: OrderSummaryCase) {
  expect(value.availability).toBe(availability);
  expect(typeof value.error === "string" && value.error.length > 0).toBe(true);
  expect(value.sourceVersionId === null && value.designExecutor === null && value.spu === null && value.specification === null).toBe(true);
  expect(value.fields.length === 0 && value.images.length === 0 && value.blockers.length === 0 && value.instructions === "").toBe(true);
  expect(JSON.stringify(value).includes(source.fixtureSentinel)).toBe(false);
}
function available(value: OrderWorkSummary, source: OrderSummaryCase, saved = true) {
  expect(value.availability).toBe("available"); expect(value.error).toBeNull();
  expect(value.sourceVersionId).toBe(source.reportVersionId);
  if (source.reportLineId) {
    expect(value.fields.some(field => field.value === source.fixtureSentinel)).toBe(true);
    expect(value.images.some(image => new URL(image.path, "https://summary.invalid").searchParams.get("versionId") === source.reportVersionId)).toBe(true);
    if (saved) expect(value.instructions === source.fixtureSentinel).toBe(true);
  }
}

describe("typed original order summary availability", () => {
  let f: Fixture;
  const proof: Array<{ scenario: string; items: Array<{ id: string; availability: OrderWorkSummaryAvailability | undefined; wireSha256: string }>; facts: Awaited<ReturnType<Fixture["facts"]>> }> = [];
  beforeAll(async () => { f = await createOrderSummaryFixture(); });
  async function summaries(values: readonly OrderSummaryCase[], context = f.context) {
    return OrderWorkSummariesSchema.parse(await f.work.summaries(context, { ids: values.map(value => value.lineId) })).items;
  }
  const pick = (items: OrderWorkSummary[], source: OrderSummaryCase) => {
    const result = items.filter(item => item.id === source.lineId); expect(result.length).toBe(1); return result[0]!;
  };
  async function record(scenario: string, values: readonly OrderSummaryCase[], items: OrderWorkSummary[]) {
    proof.push({ scenario, items: items.map(item => ({ id: item.id, availability: item.availability, wireSha256: hash(item) })), facts: await f.facts(values) });
  }
  afterAll(async () => {
    if (!f) return;
    const failures: unknown[] = [];
    try {
      const directory = resolve(f.isolated.lane, "qa");
      await mkdir(directory, { recursive: true });
      await writeFile(resolve(directory, `${f.isolated.nonce}-summary-proof.json`), JSON.stringify({ nonce: f.isolated.nonce,
        scope: "real_original_order_owners_synthetic_archive_no_manufacturing", scenarios: proof, effects: f.effects }, null, 2));
    } catch (error) { failures.push(error); }
    try { await f.close(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "order_summary_proof_or_cleanup_failed");
  });

  it("mixed_original_lifecycle_states keeps healthy items readable beside original anonymous, purged, expired and archived records", async () => {
    const healthy = await f.createCase("healthy_saved"), formal = await f.createCase("healthy_no_work"),
      reportWithoutWork = await f.createReportWithoutWork(), anonymized = await f.createCase("anonymized"),
      purged = await f.createCase("purged"), archived = await f.createCase("archived"), expired = await f.createCase("expired");
    const values = [healthy, formal, reportWithoutWork, anonymized, purged, archived, expired], items = await summaries(values);
    expect(items.length).toBe(values.length);
    available(pick(items, healthy), healthy); available(pick(items, formal), formal); available(pick(items, reportWithoutWork), reportWithoutWork, false);
    unavailable(pick(items, anonymized), "cleared", anonymized); unavailable(pick(items, purged), "cleared", purged);
    unavailable(pick(items, archived), "archived", archived); unavailable(pick(items, expired), "expired", expired);
    const facts = await f.facts(values), cleared = facts.find(value => value.lineId === purged.lineId)!;
    expect(cleared.addressStatus).toBe("anonymized"); expect(cleared.protected?.hasEnvelope).toBe(false); expect(cleared.work?.hasKey).toBe(false);
    expect(cleared.reportVersions.every(value => !value.hasArchive && !value.hasDocument)).toBe(true);
    expect(facts.find(value => value.lineId === formal.lineId)?.work).toBeNull();
    expect(facts.find(value => value.lineId === formal.lineId)?.report).toBeNull();
    expect(facts.find(value => value.lineId === reportWithoutWork.lineId)?.work).toBeNull();
    await record("mixed_original_lifecycle_states", values, items);
  });

  it("original_archive_reversible_history retains immutable revisions and requires the original unarchive owner", async () => {
    const source = await f.createCase("healthy_saved"), [before] = await f.facts([source]);
    await f.archive(source);
    unavailable(pick(await summaries([source]), source), "archived", source);
    const [archived] = await f.facts([source]);
    expect(archived!.work?.archivedAt !== null).toBe(true); expect(archived!.revisions).toEqual(before!.revisions);
    expect(archived!.events).toEqual(before!.events); expect(archived!.sources).toEqual(before!.sources);
    expect(archived!.workEvents.filter(event => event.action === "archive").length).toBe(1);
    await f.archive(source, false);
    const items = await summaries([source]); available(pick(items, source), source);
    const [restored] = await f.facts([source]); expect(restored!.work?.archivedAt).toBeNull();
    expect(restored!.revisions).toEqual(before!.revisions); expect(restored!.events).toEqual(before!.events);
    expect(restored!.workEvents.filter(event => event.action === "unarchive").length).toBe(1);
    await record("original_archive_reversible_history", [source], items);
  });

  it("actual_retention_deadline expires original work without treating a real clock boundary as a retryable failure", async () => {
    const source = await f.createCase("healthy_saved"); available(pick(await summaries([source]), source), source);
    const deadline = new Date((await f.now()).getTime() + 300);
    await f.setWorkExpiry(source, deadline);
    const [before] = await f.facts([source]); expect(before!.work?.hasKey).toBe(true);
    await expect.poll(async () => (await f.now()).getTime(), { timeout: 10_000, interval: 40 }).toBeGreaterThan(deadline.getTime());
    const items = await summaries([source]); unavailable(pick(items, source), "expired", source);
    const [after] = await f.facts([source]); expect(after!.revisions).toEqual(before!.revisions);
    expect(after!.events).toEqual(before!.events); expect(after!.sources).toEqual(before!.sources);
    await record("actual_retention_deadline", [source], items);
  });

  it("per_item_storage_failure_isolated reports a real decrypt failure without swallowing the healthy sibling", async () => {
    const healthy = await f.createCase("healthy_saved"), damaged = await f.createCase("healthy_saved"), restore = await f.corruptWorkKey(damaged);
    try {
      const items = await summaries([healthy, damaged]); available(pick(items, healthy), healthy); unavailable(pick(items, damaged), "failed", damaged);
      await record("per_item_storage_failure_isolated", [healthy, damaged], items);
    } finally { await restore(); }
    available(pick(await summaries([damaged]), damaged), damaged);
  });

  it("original_report_version_pin never substitutes a later archive for a saved work revision", async () => {
    const source = await f.createCase("healthy_saved"), [before] = await f.facts([source]), appended = await f.appendReport(source);
    expect(appended.versionId).not.toBe(source.reportVersionId);
    const items = await summaries([source]), item = pick(items, source); available(item, source);
    expect(JSON.stringify(item).includes(appended.fixtureSentinel)).toBe(false);
    expect(item.images.every(image => new URL(image.path, "https://summary.invalid").searchParams.get("versionId") === source.reportVersionId)).toBe(true);
    const [after] = await f.facts([source]); expect(after!.work?.sourceVersionId).toBe(source.reportVersionId);
    expect(after!.revisions).toEqual(before!.revisions);
    expect(after!.report?.currentVersionId).toBe(appended.versionId); expect(after!.reportVersions.length).toBe(before!.reportVersions.length + 1);
    for (const prior of before!.reportVersions) expect(after!.reportVersions.find(value => value.id === prior.id)).toEqual(prior);
    await record("original_report_version_pin", [source], items);
  });

  it("late_original_anonymization_and_purge cannot reuse private content fetched before the original clear", async () => {
    const source = await f.createCase("healthy_saved"), gate = f.holdNextSummaryRead(source), pending = summaries([source]);
    try { await gate.entered; await f.anonymize(source); await f.purge(source); }
    finally { gate.release(); }
    const completed = await pending; unavailable(pick(completed, source), "cleared", source);
    await record("late_original_anonymization_and_purge", [source], completed);
  });

  it("late_work_key_retention_purge rechecks the real work key and deadline after the report read", async () => {
    const source = await f.createCase("healthy_saved"), gate = f.holdNextSummaryRead(source), pending = summaries([source]);
    try { await gate.entered; await f.setWorkExpiry(source, new Date((await f.now()).getTime() - 1)); await f.purge(source); }
    finally { gate.release(); }
    const items = await pending; unavailable(pick(items, source), "expired", source);
    expect((await f.facts([source]))[0]!.work?.hasKey).toBe(false);
    await record("late_work_key_retention_purge", [source], items);
  });

  it("late_report_retention_purge rechecks the original report instead of adopting its buffered private data", async () => {
    const source = await f.createCase("healthy_saved"), gate = f.holdNextSummaryRead(source), pending = summaries([source]);
    try { await gate.entered; await f.setReportExpiry(source, new Date((await f.now()).getTime() - 1)); await f.purge(source); }
    finally { gate.release(); }
    const items = await pending; unavailable(pick(items, source), "expired", source);
    expect((await f.facts([source]))[0]!.reportVersions.every(value => !value.hasDocument && !value.hasArchive)).toBe(true);
    await record("late_report_retention_purge", [source], items);
  });

  it("current_pii_membership_and_foreign_scope fail closed before and after a real private read", async () => {
    const source = await f.createCase("healthy_saved"), foreign = await createOrderSummaryFixture();
    try {
      const actualForeign = await foreign.current();
      expect(OrderWorkSummariesSchema.parse(await f.work.summaries(actualForeign, { ids: [source.lineId, createEntityId()] })).items).toEqual([]);
      const current = await f.current(), gate = f.holdNextSummaryRead(source), pending = summaries([source], current);
      const rejected = pending.then(() => false, error => {
        const status = error && typeof error === "object" && "statusCode" in error ? error.statusCode : null;
        return status === 403;
      });
      let mutation: Awaited<ReturnType<Fixture["setPiiAccess"]>> | undefined;
      try {
        await gate.entered; mutation = await f.setPiiAccess(false);
        expect(mutation.after.permissions.includes(Permission.OrderPiiRead)).toBe(false);
      } finally { gate.release(); }
      try {
        expect(await rejected).toBe(true);
        await expect(f.work.summaries(current, { ids: [source.lineId] })).rejects.toMatchObject({ statusCode: 403 });
      } finally { await mutation?.restore(); }
      available(pick(await summaries([source]), source), source);
    } finally { await foreign.close(); }
    expect(f.effects.archiveDownloads).toBe(0); expect(f.effects.modelCalls).toBe(0); expect(f.effects.workerProcesses).toBe(0);
    await record("current_pii_membership_and_foreign_scope", [source], await summaries([source]));
  });
});
