import { randomUUID } from "node:crypto";
import { HttpException } from "@nestjs/common";
import { ForbiddenError, Permission } from "@yummyai/authz";
import { CatalogAccessNotFoundError } from "@yummyai/catalog-core";
import { StudioPinnedResultRequestSchema } from "@yummyai/contracts/pod/studio-original";
import { StudioPaidImageRequestSchema, type StudioPaidImageRequest } from "@yummyai/contracts/pod/studio-paid-image";
import { assetFiles, withTenant } from "@yummyai/database";
import { studioImageHash } from "@yummyai/pod-core";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { requireStudioVisualPaidImageEnvironment } from "../../../../tools/testing/studio-visual-paid-image-environment.mjs";
import { createStudioVisualPaidImageFixture, type VisualPaidGroup } from "./studio-visual-paid-image.test-fixture.js";

requireStudioVisualPaidImageEnvironment();
type Fixture = Awaited<ReturnType<typeof createStudioVisualPaidImageFixture>>;
type Facts = Awaited<ReturnType<Fixture["facts"]>>;
async function rejected(operation: Promise<unknown>) {
  try { await operation; }
  catch (error) {
    if (error instanceof HttpException) {
      const body = error.getResponse();
      return { status: error.getStatus(), code: body && typeof body === "object" && "code" in body ? body.code : null };
    }
    if (error instanceof CatalogAccessNotFoundError) return { status: 404, code: null };
    if (error instanceof ForbiddenError) return { status: 403, code: null };
    throw error;
  }
  throw new Error("visual_paid_expected_rejection");
}
function noExecution(before: Facts, after: Facts) {
  expect(after.role).toBe("yummyai_app");
  expect(after.generations).toEqual(before.generations);
  expect(after.executions).toEqual(before.executions);
  expect(after.ledger).toEqual(before.ledger);
  expect(after.calls).toEqual(before.calls);
  expect(after.queue).toEqual(before.queue);
}

describe("controlled visual slots through the real paid producer and explicit original review", () => {
  let f: Fixture;
  beforeAll(async () => { f = await createStudioVisualPaidImageFixture(); });
  afterEach(() => { if (f) { f.paid.admission(f.context, false); f.costKnown(true); } });
  afterAll(async () => { if (f) await f.close(); });
  async function found(group: VisualPaidGroup, request: StudioPaidImageRequest) {
    const value = await f.lookup(group, request);
    expect(value.status).toBe("found");
    if (value.status !== "found") throw new Error("visual_paid_original_missing");
    return StudioPaidImageRequestSchema.parse(value.request);
  }
  async function completed(group: VisualPaidGroup) {
    const prepared = await f.prepare(group, "artwork");
    f.paid.admission(f.context, true);
    const queued = await f.commit(group, prepared);
    expect(queued.status).toBe("queued");
    expect(await f.process(queued)).toEqual({ id: queued.generationId, disposition: "completed" });
    return found(group, queued);
  }

  it("requires the paid isolation guard and its additional visual-lane flag", () => {
    expect(() => requireStudioVisualPaidImageEnvironment({ ...process.env, E2E_STUDIO_VISUAL_PAID_IMAGE_ISOLATED: "0" }))
      .toThrow("studio_visual_paid_image_explicit_isolation_required");
    expect(() => requireStudioVisualPaidImageEnvironment({ ...process.env, E2E_STUDIO_PAID_IMAGE_ISOLATED: "0" }))
      .toThrow("studio_paid_image_explicit_isolation_required");
  });

  it("prepares a complete fixed artwork quote without reservation or dispatch and retains it while paused", async () => {
    const group = await f.group(), before = await f.facts(), prepared = await f.prepare(group, "artwork");
    const workspace = await f.service.get(await f.current(), group.plan.id), project = workspace.projects.find(row => row.id === group.id)!;
    const slot = group.slots.find(row => row.slotKey === "artwork")!;
    expect(group.slots.map(row => row.slotKey).sort()).toEqual(["artwork", "customization", "detail", "scene"]);
    expect(prepared).toMatchObject({ scope: slot.projectId, status: "prepared", generationId: null,
      admission: { enabled: false, code: "operator_paused" }, result: null,
      execution: { phase: null, costUsd: null, budgetState: null, budgetAmountUsd: null },
      input: { modelId: f.modelId, visualSlotKey: "artwork", size: "1024x1024", quality: "high", background: "transparent" } });
    expect(prepared.quote.visualDelivery).toEqual({ ...project.snapshot, slotKey: "artwork" });
    expect(prepared.quote.references.map(row => row.assetId)).toEqual([f.sampleId]);
    expect(prepared.quote.pricing).toMatchObject({ reservationUsd: "0.050000", estimatedUsd: "0.02000000" });
    expect(prepared.quote.inputFingerprint).toBe(studioImageHash({ input: prepared.input, visualDelivery: prepared.quote.visualDelivery }));
    const { quoteHash, ...quote } = prepared.quote;
    expect(quoteHash).toBe(studioImageHash(quote));
    noExecution(before, await f.facts());
    const pending = await f.facts();
    expect(await rejected(f.commit(group, prepared))).toEqual({ status: 409, code: "studio_paid_execution_paused" });
    expect(await found(group, prepared)).toEqual(prepared);
    expect((await f.service.imageRequests(await f.current(), group.plan.id, group.id, { slotKey: "artwork" })).items.map(row => row.id)).toContain(prepared.id);
    const cancelled = await f.service.cancelImage(await f.current(), group.plan.id, group.id,
      { ...f.address(prepared), quoteHash });
    expect(cancelled).toMatchObject({ id: prepared.id, status: "cancelled", generationId: null });
    expect(await found(group, prepared)).toMatchObject({ status: "cancelled", generationId: null });
    noExecution(pending, await f.facts());
    const lost = await f.prepare(group, "artwork");
    expect(await f.service.abandonImage(await f.current(), group.plan.id, group.id, f.address(lost))).toMatchObject({ status: "cancelled", requestId: lost.requestId });
    noExecution(pending, await f.facts());
  });

  it("commits and processes exactly once, inspects real private bytes, and submits only through an explicit saved intent", async () => {
    const group = await f.group(), before = await f.facts(), request = await completed(group);
    expect(request).toMatchObject({ status: "completed", execution: { phase: "completed", costUsd: "0.01234567", budgetState: "committed", budgetAmountUsd: "0.012346" },
      result: { key: "image:" + request.generationId, namespace: "image_files", mediaType: "image/png", rightsStatus: "unverified" } });
    const generated = await f.facts(), generation = generated.generations.find(row => row.id === request.generationId)!;
    expect(generated.queue.length - before.queue.length).toBe(1);
    expect(generated.calls.length - before.calls.length).toBe(1);
    expect(generation.modelSnapshot).toMatchObject({ visualCeilingUsd: 0.1,
      paidImage: { imageRequestId: request.id, quoteHash: request.quote.quoteHash, reservationUsd: "0.050000" } });
    expect(generated.ledger.filter(row => row.requestId === request.generationId)).toHaveLength(1);
    const [file] = await withTenant(f.db.db, await f.current(), tx => tx.select().from(assetFiles).where(eq(assetFiles.id, request.result!.assetId)));
    expect(file).toMatchObject({ assetDomain: "authorized", rightsStatus: "unverified", checksumSha256: request.result!.checksumSha256 });
    const bytes = await f.storage.readPrivate(await f.current(), { ...file!, assetDomain: "authorized" }, { requiredDomain: "authorized" });
    expect(Buffer.from(bytes)).toEqual(f.transparent);
    const metadata = await sharp(bytes).metadata();
    expect({ width: metadata.width, height: metadata.height, alpha: metadata.hasAlpha }).toEqual({ width: 1024, height: 1024, alpha: true });
    const original = await f.original(group, request);
    expect(original.inspection).toMatchObject({ source: { assetId: request.result!.assetId, checksumSha256: request.result!.checksumSha256,
      byteSize: request.result!.byteSize, mediaType: "image/png", sourceKind: "ai_generated" },
      technical: { status: "verified", kind: "image", displayWidth: 1024, displayHeight: 1024 } });
    await f.service.collect(await f.current(), group.plan.id, group.id);
    await f.paid.generations.get(await f.current(), request.scope, request.generationId!);
    expect((await f.workflow.results(await f.current(), request.scope)).items).toEqual([]);
    expect((await f.facts()).entries).toEqual(generated.entries);
    const missingIntent = StudioPinnedResultRequestSchema.parse({ operation: "result.submit.pinned", scope: original.scope, key: original.key,
      source: original.inspection.source, title: "Synthetic explicit original", submissionId: randomUUID(), rightsAttested: true, sourceReference: "Synthetic paid original" });
    expect((await rejected(f.submit(missingIntent))).status).toBe(409);
    const saved = await f.intent(group, request), submitted = await f.submit(saved.input);
    const lookup = await f.resultLookup(saved.input);
    expect(lookup).toMatchObject({ status: "found", receipt: { versionId: submitted.versionId, assetId: request.result!.assetId } });
    const results = (await f.workflow.results(await f.current(), request.scope)).items;
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ versionId: submitted.versionId, status: "pending_review" });
    expect((await f.service.get(await f.current(), group.plan.id)).projects.find(row => row.id === group.id)!.adoptedRevision).toBeNull();
    expect(await f.commit(group, request)).toMatchObject({ id: request.id, generationId: request.generationId, status: "completed" });
    expect(await f.process(request)).toEqual({ id: request.generationId, disposition: "already_claimed" });
    const after = await f.facts();
    noExecution(generated, after);
    expect(after.generations.filter(row => row.id === request.generationId)).toHaveLength(1);
  });

  it("rejects a real sales-plan revision change before reserving or dispatching its prepared image", async () => {
    const group = await f.group(), prepared = await f.prepare(group, "artwork");
    await f.plans.save(await f.current(), group.plan.id, { expectedRevision: group.plan.revision,
      fields: { ...group.plan.fields, positioning: "Changed synthetic visual direction" }, idempotencyKey: randomUUID() });
    const before = await f.facts();
    f.paid.admission(f.context, true);
    expect(await rejected(f.commit(group, prepared))).toEqual({ status: 409, code: "studio_visual_image_changed" });
    noExecution(before, await f.facts());
    expect(await found(group, prepared)).toMatchObject({ id: prepared.id, generationId: null, status: "prepared" });
  });

  it("requires an explicitly reviewed artwork from the same group and pins it as the first reference in every derived slot", async () => {
    const group = await f.group(), art = await completed(group), saved = await f.intent(group, art), submitted = await f.submit(saved.input);
    const artVersionId = submitted.versionId, before = await f.facts();
    expect(await rejected(f.prepare(group, "scene", artVersionId))).toEqual({ status: 409, code: "studio_visual_image_changed" });
    noExecution(before, await f.facts());
    // This is an explicit operator review of the synthetic acceptance image.
    // Neither prepare-original, collect nor result submission performs it.
    await f.service.review(await f.current(), group.plan.id, group.id, { versionId: artVersionId, decision: "approve",
      checks: { identity: true, shape: true, facts: true, sides: true } });
    const afterReview = (await f.workflow.results(await f.current(), art.scope)).items;
    expect(afterReview.find(row => row.versionId === artVersionId)?.status).toBe("approved");
    const derived: StudioPaidImageRequest[] = [];
    for (const slotKey of ["scene", "detail", "customization"] as const) {
      const prepared = await f.prepare(group, slotKey, artVersionId);
      expect(prepared).toMatchObject({ input: { visualSlotKey: slotKey, visualArtworkVersionId: artVersionId, quality: "high", background: "opaque" },
        quote: { visualDelivery: { groupId: group.id, slotKey } } });
      expect(prepared.quote.references.map(row => row.assetId)).toEqual([art.result!.assetId, f.sampleId]);
      derived.push(prepared);
    }
    const foreign = await f.group(), foreignBefore = await f.facts();
    expect(await rejected(f.prepare(foreign, "scene", artVersionId))).toEqual({ status: 409, code: "studio_visual_image_changed" });
    noExecution(foreignBefore, await f.facts());
    const queue = await f.commit(group, derived[0]!);
    const callsBefore = f.calls.length;
    expect(await f.process(queue)).toEqual({ id: queue.generationId, disposition: "completed" });
    const wire = f.calls[callsBefore]!;
    expect(wire).toMatchObject({ n: 1, size: "1024x1024", quality: "high", background: "opaque" });
    expect(wire.referenceChecksums).toEqual([art.result!.checksumSha256, derived[0]!.quote.references[1]!.checksum]);
    expect((await f.workflow.results(await f.current(), queue.scope)).items).toEqual([]);
  });

  it("does not expose another actor or tenant's original request or original image", async () => {
    const group = await f.group(), request = await completed(group), before = await f.facts();
    const peers = [await f.paid.actor(f.context.tenantId, "tenant"), await f.paid.actor(undefined, "tenant")];
    for (const peer of peers) {
      const context = await f.paid.grant(peer.context, Object.values(Permission), "tenant");
      const read = await rejected(f.service.lookupImage(context, group.plan.id, group.id, request.requestId, { slotKey: "artwork" }));
      expect([403, 404]).toContain(read.status);
      const original = await rejected(f.service.prepareImageOriginal(context, group.plan.id, group.id, f.address(request)));
      expect([403, 404]).toContain(original.status);
    }
    noExecution(before, await f.facts());
    expect(await found(group, request)).toMatchObject({ id: request.id, status: "completed", generationId: request.generationId });
  });

  it("uses actual ledger reservations for unknown image costs and rejects exhaustion of the group's fixed total", async () => {
    const group = await f.group(0.1), ids: string[] = [];
    f.costKnown(false);
    for (let index = 0; index < 2; index++) {
      const request = await completed(group);
      ids.push(request.generationId!);
      expect(request.execution).toMatchObject({ costUsd: null, budgetState: "reserved", budgetAmountUsd: "0.050000" });
    }
    const before = await f.facts();
    expect(before.ledger.filter(row => ids.includes(row.requestId)).map(row => ({ state: row.state, amount: row.amountUsd })))
      .toEqual([{ state: "reserved", amount: "0.050000" }, { state: "reserved", amount: "0.050000" }]);
    expect(await rejected(f.prepare(group, "artwork"))).toEqual({ status: 409, code: "studio_visual_image_budget_exceeded" });
    noExecution(before, await f.facts());
  });

  it("keeps the four-attempt limit after every prior attempt has completed", async () => {
    const group = await f.group(), ids: string[] = [];
    for (let index = 0; index < 4; index++) ids.push((await completed(group)).generationId!);
    const before = await f.facts();
    expect(before.generations.filter(row => ids.includes(row.id)).map(row => row.status)).toEqual(["completed", "completed", "completed", "completed"]);
    expect(before.ledger.filter(row => ids.includes(row.requestId))).toHaveLength(4);
    expect(await rejected(f.prepare(group, "artwork"))).toEqual({ status: 409, code: "studio_visual_image_attempt_limit" });
    noExecution(before, await f.facts());
  });
});
