import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Permission } from "@yummyai/authz";
import { createEntityId } from "@yummyai/contracts";
import { OrderWorkDraftSchema } from "@yummyai/contracts/order/workspace";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { pillowSpecificationSize, resolvePillowOrderBasis } from "../catalog/order-pillow-matching.js";
import { createPillowMatchingFixture, type PillowMatchingActor } from "./order-pillow-matching.test-fixture.js";

// This must precede connectDatabase in the fixture. The acceptance runner owns
// the entire disposable DB/bucket/Redis and removes them even after a failure.
requireDisposableIntegrationEnvironment();

type Fixture = Awaited<ReturnType<typeof createPillowMatchingFixture>>;
type Specification = Awaited<ReturnType<Fixture["specification"]>>;

describe.sequential("exact shaped-pillow order matching and platform-only shipping promises", () => {
  let f: Fixture;
  let a: PillowMatchingActor, b: PillowMatchingActor;
  let spu: { id: string };
  let ten: Specification;
  let sixteen: typeof ten;

  beforeAll(async () => {
    f = await createPillowMatchingFixture();
    a = await f.actor(); b = await f.actor();
    spu = await f.createSpu(a);
    ten = await f.specification(a, spu.id, 10);
    sixteen = await f.specification(a, spu.id, 16);
    const foreignSpu = await f.createSpu(b);
    await f.specification(b, foreignSpu.id, 20);
  }, 60_000);
  afterEach(() => { if (f) { expect(f.external).not.toHaveBeenCalled(); expect(f.scan).not.toHaveBeenCalled(); } });
  afterAll(async () => { if (f) await f.close(); });

  it("reads the actual encrypted report and prepares the exact unconfirmed specification without persisting a work revision", async () => {
    const order = await f.seedOrder(a, [{ label: "Size", value: "16 inches" }, { label: "Pillow Style", value: "Half Body" }]);
    const detail = await f.work.detail(a.context, order.lineId);
    expect(detail.report?.versionId).toBe(order.versionId);
    expect(detail.report?.surfaces[0]?.fields[0]?.value).toBe("16 inches");
    expect(detail.catalog?.automatic).toMatchObject({ status: "partial", sourceVersionId: order.versionId,
      sizeInches: 16, spuId: spu.id, specificationVersionId: sixteen.versionId, processProfileVersionId: null, applied: true });
    expect(detail.draft).toMatchObject({ specificationVersionId: sixteen.versionId, printProfileVersionId: null, dueAt: null });
    expect(detail.catalog?.specifications.find(row => row.id === sixteen.versionId)).toMatchObject({ productionReady: false, sizeInches: 16 });
    expect(await f.revisions(a, order.lineId)).toEqual([]);
    expect(detail.line.revision).toBe(0);
    expect(detail.shippingTime).toMatchObject({ platform: { at: null, source: "missing" }, internal: { at: null, confidence: "unknown" },
      nextAttentionAt: null, countdownBasis: null, remainingSeconds: null });
  });

  it.each([
    [[], "missing"],
    [[{ label: "Size", value: "10–24 inches" }], "ambiguous"],
    [[{ label: "Size", value: "16 inches" }, { label: "尺寸", value: "18 英寸" }], "ambiguous"],
    [[{ label: "Size", value: "18 inches" }], "missing"],
  ] as const)("does not choose a title range, conflicting choice or nearest available specification: %j", async (fields, status) => {
    const order = await f.seedOrder(a, [...fields]);
    const detail = await f.work.detail(a.context, order.lineId);
    expect(detail.catalog?.automatic).toMatchObject({ status, applied: false, specificationVersionId: null, processProfileVersionId: null });
    expect(detail.draft.specificationVersionId ?? null).toBeNull();
    expect(await f.revisions(a, order.lineId)).toEqual([]);
  });

  it("does not classify a rectangular pillow or pillowcase as the shaped-pillow SPU", async () => {
    for (const title of ["Synthetic rectangular pillow 16 inches", "Synthetic shaped pillowcase 16 inches"]) {
      const order = await f.seedOrder(a, [{ label: "Size", value: "16 inches" }], title);
      const detail = await f.work.detail(a.context, order.lineId);
      expect(detail.catalog?.automatic).toMatchObject({ applied: false, spuId: null, specificationVersionId: null });
      expect(detail.draft.specificationVersionId ?? null).toBeNull();
    }
  });

  it("retains a saved manual specification and its historical version when the catalog changes", async () => {
    const order = await f.seedOrder(a);
    const before = await f.work.detail(a.context, order.lineId);
    const saved = await f.saveDraft(a, before, { ...before.draft, specificationVersionId: ten.versionId, printProfileVersionId: null,
      instructions: "Synthetic explicit operator override to 10 inch; still needs information" });
    expect(saved.line.revision).toBe(1);
    expect(saved.catalog?.automatic).toMatchObject({ status: "preserved", applied: false, specificationVersionId: ten.versionId });
    const updated = await f.specification(a, spu.id, 10, 1);
    expect(updated.versionId).not.toBe(ten.versionId);
    const reread = await f.work.detail(a.context, order.lineId);
    expect(reread.draft).toEqual(saved.draft);
    expect(reread.catalog?.automatic).toMatchObject({ status: "preserved", specificationVersionId: ten.versionId });
    expect(reread.sourceReport?.versionId).toBe(order.versionId);
    expect(await f.revisions(a, order.lineId)).toHaveLength(1);
  });

  it("rechecks source version before accepting a prepared draft instead of silently adopting a different source", async () => {
    const order = await f.seedOrder(a);
    const detail = await f.work.detail(a.context, order.lineId);
    await expect(f.work.save(a.context, order.lineId, { expectedRevision: 0, expectedProjectionVersion: detail.line.projectionVersion,
      expectedSourceVersionId: createEntityId(), draft: { ...detail.draft, designExecutor: "human" }, status: "needs_information",
      reason: "Synthetic stale source refusal", idempotencyKey: randomUUID() })).rejects.toThrow("导入资料已变化");
    expect(await f.revisions(a, order.lineId)).toEqual([]);
  });

  it("leaves a real unreviewed V4 unchanged and rejects production admission for the partial match", async () => {
    const template = await f.unreviewedTemplate(a);
    expect(template.version.versionNumber).toBe(4);
    expect(template.version.reviewed).toBe(false);
    expect(Object.values(template.version.document.confirmations).every(value => !value)).toBe(true);
    const state = await f.productionState(a, template.project.id);
    expect(state.project?.reviewedVersionId).toBeNull();
    const order = await f.seedOrder(a), detail = await f.work.detail(a.context, order.lineId);
    await expect(f.work.save(a.context, order.lineId, { expectedRevision: 0, expectedProjectionVersion: detail.line.projectionVersion,
      expectedSourceVersionId: order.versionId, draft: { ...detail.draft, designExecutor: "human" }, status: "ready_to_push",
      reason: "Synthetic partial match must not dispatch", idempotencyKey: randomUUID() })).rejects.toThrow();
    expect(await f.productionState(a, template.project.id)).toEqual(state);
    expect(await f.revisions(a, order.lineId)).toEqual([]);
    expect(a.context.permissions).not.toContain(Permission.DesignReview);
  });

  it("keeps an identically named foreign catalog invisible under the non-owner application role", async () => {
    const order = await f.seedOrder(a, [{ label: "Size", value: "20 inches" }]);
    const detail = await f.work.detail(a.context, order.lineId);
    expect(detail.catalog?.automatic).toMatchObject({ status: "missing", applied: false });
    expect(detail.catalog?.specifications.some(row => row.sizeInches === 20)).toBe(false);
    expect(await f.visibleVersion(b, sixteen.versionId)).toEqual([]);
    await expect(f.work.detail(b.context, order.lineId)).rejects.toThrow();
    expect((await f.rawRole(a))[0]?.role).toBe("yummyai_app");
  });

  it("honors a current product-read revocation and never returns proposals from the stale caller ceiling", async () => {
    const order = await f.seedOrder(a);
    await f.setPermissions(a, a.context.permissions.filter(permission => permission !== Permission.ProductRead));
    try {
      const detail = await f.work.detail(a.context, order.lineId);
      expect(detail.catalog?.specifications).toEqual([]);
      expect(detail.catalog?.automatic).toMatchObject({ applied: false, specificationVersionId: null });
    } finally { await f.setPermissions(a, a.context.permissions); }
  });

  it("rechecks current PII authority before opening a previously accessible source", async () => {
    const order = await f.seedOrder(a);
    await f.setPermissions(a, a.context.permissions.filter(permission => permission !== Permission.OrderPiiRead));
    try { await expect(f.work.detail(a.context, order.lineId)).rejects.toThrow(); }
    finally { await f.setPermissions(a, a.context.permissions); }
  });

  it("uses the newest official update time rather than the arrival order for a platform deadline", async () => {
    const order = await f.seedOrder(a), deadline = "2027-01-10T12:00:00.000Z";
    const expected = await f.appendSource(a, order, f.officialSource(order, deadline, "2026-10-25T12:00:00.000Z"), new Date("2026-10-25T12:00:00.000Z"));
    await f.appendSource(a, order, f.officialSource(order, "2027-01-05T12:00:00.000Z", "2026-10-24T12:00:00.000Z"), new Date("2026-10-26T12:00:00.000Z"));
    const detail = await f.work.detail(a.context, order.lineId);
    expect(detail.line).toMatchObject({ platformShipByAt: deadline, platformDeadlineSource: "marketplace_api", platformDeadlineSourceVersionId: expected });
    expect(detail.shippingTime).toMatchObject({ platform: { at: deadline, source: "marketplace_api", sourceVersionId: expected, verifiedAt: null },
      nextAttentionAt: deadline, countdownBasis: "platform", internal: { at: null, confidence: "unknown" } });
    const list = await f.work.list(a.context, { module: "orders", q: order.externalOrderId });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.platformShipByAt).toBe(deadline);
  });

  it("keeps an explicit manual clear ahead of a later API observation", async () => {
    const order = await f.seedOrder(a);
    await f.appendSource(a, order, f.officialSource(order, "2027-01-10T12:00:00.000Z"));
    const before = await f.work.detail(a.context, order.lineId);
    await f.work.recordPlatformDeadline(a.context, order.lineId, { expectedProjectionVersion: before.line.projectionVersion, shipByAt: null,
      evidenceReference: "Synthetic operator verified no platform promise", idempotencyKey: randomUUID() });
    await f.appendSource(a, order, f.officialSource(order, "2027-01-11T12:00:00.000Z", "2026-10-26T12:00:00.000Z"));
    const detail = await f.work.detail(a.context, order.lineId);
    expect(detail.line).toMatchObject({ platformShipByAt: null, platformDeadlineSource: "verified_record", platformDeadlineSourceVersionId: null });
    expect(detail.shippingTime).toMatchObject({ platform: { at: null, source: "verified_record" }, nextAttentionAt: null, countdownBasis: null, remainingSeconds: null });
    expect(detail.line.platformDeadlineVerifiedAt).not.toBeNull();
    expect(detail.shippingTime?.platform.verifiedAt).toBe(detail.line.platformDeadlineVerifiedAt);
  });

  it.each(["not-a-date", "2026-02-30T12:00:00.000Z", "2027-01-10", 42, { invalid: true }])("rejects an invalid API deadline without a PostgreSQL cast error: %j", async at => {
    const order = await f.seedOrder(a);
    await f.appendSource(a, order, f.officialSource(order, at));
    const detail = await f.work.detail(a.context, order.lineId);
    expect(detail.line.platformShipByAt).toBeNull();
    expect(detail.shippingTime).toMatchObject({ platform: { at: null, source: "missing" }, nextAttentionAt: null, remainingSeconds: null });
  });

  it("does not cast invalid update times or accept another order's or unrecognized source's promise", async () => {
    const order = await f.seedOrder(a);
    await f.appendSource(a, order, f.officialSource(order, "2027-01-10T12:00:00.000Z", "not-a-date"));
    await f.appendSource(a, order, { ...f.officialSource(order, "2027-01-11T12:00:00.000Z"), orderId: "SYNTHETIC-OTHER-ORDER" });
    await f.appendSource(a, order, { ...f.officialSource(order, "2027-01-12T12:00:00.000Z"), apiVersion: "unknown" });
    const detail = await f.work.detail(a.context, order.lineId);
    expect(detail.line.platformShipByAt).toBeNull();
  });

  it("shows an optional explicit internal plan without using it or purchase time for platform reminders", async () => {
    const order = await f.seedOrder(a);
    await f.setInternalDue(a, order, "2020-01-01T00:00:00.000Z");
    const detail = await f.work.detail(a.context, order.lineId);
    expect(detail.line.platformShipByAt).toBeNull();
    expect(detail.shippingTime).toMatchObject({ platform: { at: null, source: "missing" },
      internal: { at: "2020-01-01T00:00:00.000Z", source: "operator", confidence: "explicit" },
      nextAttentionAt: null, countdownBasis: null, remainingSeconds: null, platformOverdue: false });
  });

  it("keeps controlled delivery, duplicate candidates and each exact profile pin distinct in the pure decision", () => {
    const draft = OrderWorkDraftSchema.parse({ printProfileVersionId: null, fields: [], images: [], instructions: "", customerApprovalRequired: false, dueAt: null });
    const report = { surfaces: [{ key: "front", label: "Synthetic", previewFileKey: null, buyerFileKeys: [], fields: [{ key: "size", label: "Size", kind: "choice" as const, value: "16 inches" }] }] };
    const profileId = createEntityId(), candidate = { id: createEntityId(), spuId: createEntityId(), spuCode: "CUSTOM-SHAPED-PILLOW", name: "Synthetic", sizeInches: 16,
      processProfileVersionId: profileId, productionReady: false, issues: ["Synthetic unconfirmed facts"] };
    const input = { report, productTitle: "Synthetic custom shaped pillow", sourceVersionId: createEntityId(), draft, preserve: false, controlledDelivery: false, specifications: [candidate] };
    expect(resolvePillowOrderBasis(input)).toMatchObject({ status: "partial", applied: true, specificationVersionId: candidate.id, processProfileVersionId: profileId });
    expect(resolvePillowOrderBasis({ ...input, controlledDelivery: true })).toMatchObject({ status: "conflict", applied: false, specificationVersionId: null });
    expect(resolvePillowOrderBasis({ ...input, specifications: [candidate, { ...candidate, id: createEntityId() }] })).toMatchObject({ status: "ambiguous", applied: false, specificationVersionId: null });
    expect(resolvePillowOrderBasis({ ...input, draft: { ...draft, printProfileVersionId: profileId } })).toMatchObject({ status: "preserved", applied: false, processProfileVersionId: profileId });
    expect(pillowSpecificationSize("SIZE-16IN", { Size: "16 inches" })).toBe(16);
    expect(pillowSpecificationSize("SIZE-16IN", { Size: "18 inches" })).toBeNull();
    expect(pillowSpecificationSize("CP-16", { Size: "16 inches" })).toBeNull();
    expect(draft.specificationVersionId).toBeUndefined();
  });

  it("selects the latest registered masterless customer artwork and saves only an incomplete intake draft", async () => {
    const owner = await f.actor([Permission.DesignReview]), product = await f.createSpu(owner);
    const spec = await f.specification(owner, product.id, 16);
    const previous = await f.registerCustomerArtwork(owner), latest = await f.registerCustomerArtwork(owner, 1);
    expect(latest).toMatchObject({ version: 2, assetId: null, creativeVersionId: null, mode: "customer_image", materials: [] });
    const order = await f.seedOrder(owner), detail = await f.work.detail(owner.context, order.lineId);
    expect(detail.catalog?.automatic).toMatchObject({ status: "partial", applied: true, specificationVersionId: spec.versionId,
      artworkVersionId: latest.versionId, processProfileVersionId: null });
    expect(detail.draft.artworkVersionId).toBe(latest.versionId);
    expect(detail.draft.artworkVersionId).not.toBe(previous.versionId);
    const saved = await f.saveDraft(owner, detail);
    expect(saved.line).toMatchObject({ revision: 1, preparation: "needs_information", artwork: "not_pushed" });
    expect(saved.draft).toMatchObject({ artworkVersionId: latest.versionId, specificationVersionId: spec.versionId, printProfileVersionId: null });
    const revisions = await f.revisions(owner, order.lineId);
    await expect(f.work.save(owner.context, order.lineId, { expectedRevision: saved.line.revision,
      expectedProjectionVersion: saved.line.projectionVersion, expectedSourceVersionId: order.versionId,
      draft: saved.draft, status: "ready_to_push", reason: "Synthetic partial scheme must not dispatch", idempotencyKey: randomUUID() }))
      .rejects.toThrow(/规格|工艺/);
    expect(await f.revisions(owner, order.lineId)).toEqual(revisions);
    expect(f.external).not.toHaveBeenCalled();
  });

  it("does not fall back to an older artwork when the latest common-artwork version is ineligible", () => {
    const draft = OrderWorkDraftSchema.parse({ printProfileVersionId: null, fields: [], images: [], instructions: "", customerApprovalRequired: false, dueAt: null });
    const report = { surfaces: [{ key: "front", label: "Synthetic", previewFileKey: null, buyerFileKeys: [], fields: [{ key: "size", label: "Size", kind: "choice" as const, value: "16 inches" }] }] };
    const old = { id: createEntityId(), code: "ART-CUSTOM-SHAPED-PILLOW", mode: "customer_image", version: 1, materials: [] };
    const input = { report, productTitle: "Synthetic custom shaped pillow", sourceVersionId: createEntityId(), draft, preserve: false, controlledDelivery: false,
      specifications: [{ id: createEntityId(), spuId: createEntityId(), spuCode: "CUSTOM-SHAPED-PILLOW", name: "Synthetic 16", sizeInches: 16,
        processProfileVersionId: null, productionReady: false }] };
    for (const latest of [{ ...old, id: createEntityId(), version: 2, mode: "mixed" },
      { ...old, id: createEntityId(), version: 2, materials: [{ role: "master" }] }]) {
      const result = resolvePillowOrderBasis({ ...input, artworks: [old, latest] });
      expect(result).toMatchObject({ applied: true, status: "partial", artworkVersionId: null });
      expect(result.issues.some(issue => issue.includes("通用来图方案"))).toBe(true);
    }
    expect(draft.artworkVersionId).toBeUndefined();
  });

  it("preserves a saved manual artwork instead of applying a newer common-artwork suggestion", async () => {
    const owner = await f.actor([Permission.DesignReview]), product = await f.createSpu(owner);
    await f.specification(owner, product.id, 16);
    const common = await f.registerCustomerArtwork(owner);
    const manual = await f.registerCustomerArtwork(owner, 0, "SYNTHETIC-MANUAL-CUSTOMER-ART");
    const order = await f.seedOrder(owner), detail = await f.work.detail(owner.context, order.lineId);
    expect(detail.draft.artworkVersionId).toBe(common.versionId);
    const saved = await f.saveDraft(owner, detail, { ...detail.draft, artworkVersionId: manual.versionId });
    const newer = await f.registerCustomerArtwork(owner, 1);
    const reread = await f.work.detail(owner.context, order.lineId);
    expect(reread.draft).toEqual(saved.draft);
    expect(reread.draft.artworkVersionId).toBe(manual.versionId);
    expect(reread.draft.artworkVersionId).not.toBe(newer.versionId);
    expect(reread.catalog?.automatic).toMatchObject({ status: "preserved", applied: false, artworkVersionId: manual.versionId });
    expect(await f.revisions(owner, order.lineId)).toHaveLength(1);
    expect(f.external).not.toHaveBeenCalled();
  });
});
