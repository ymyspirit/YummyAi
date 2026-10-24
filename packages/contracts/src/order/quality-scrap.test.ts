import { describe, expect, it } from "vitest";
import { createEntityId } from "../common/ids.js";
import { erpSessionAuthority } from "../auth/session.js";
import {
  AllocateQualityScrapInputSchema, QualityScrapBasisSchema, QualityScrapGroupBasisSchema,
  QualityScrapHistoryQuerySchema, QualityScrapLotSchema, QualityScrapResultSchema,
  QualityScrapReviewViewSchema, QualityScrapWorkspaceSchema,
} from "./quality-scrap.js";

const ids = { tenant: createEntityId(), actor: createEntityId(), production: createEntityId(), order: createEntityId(),
  version: createEntityId(), root: createEntityId(), group: createEntityId(), report: createEntityId(), quantityReview: createEntityId(), scrapReview: createEntityId() };
const at = "2026-10-21T04:30:00.123Z";
const authority = (permissions = ["order:read", "order:write"], permissionScopes?: Record<string, "self" | "team" | "tenant">) =>
  erpSessionAuthority({ tenantId: ids.tenant, userId: ids.actor, permissions, dataScope: "tenant", ...(permissionScopes ? { permissionScopes } : {}) });
const input = () => ({ idempotencyKey: "synthetic-original-scrap-allocation", productionVersionId: ids.version,
  expectedProductionProjectionVersion: 4, expectedRootInspectionId: ids.root, expectedQuantityReviewId: ids.quantityReview,
  expectedScrapReviewId: null, expectedBasisFingerprint: "a".repeat(64), physicalSegregationConfirmed: true as const,
  occurredAt: at, evidenceCode: "SYNTHETIC_PHYSICAL_SCRAP", evidenceAssetIds: [],
  allocations: [{ qualityGroupId: ids.group, sourceQuantityReviewId: ids.quantityReview, quantity: 2 }] });
const lot = () => ({ sourceQuantityReviewId: ids.quantityReview, reportId: ids.report, observedAt: at, reviewedAt: at,
  quantity: 2, allocatedQuantity: 0, remainingQuantity: 2, scope: "groupable" as const });
const group = () => ({ qualityGroupId: ids.group, inspectionId: ids.root, label: "Synthetic held physical bin", quantity: 6,
  inspectionRecordedAt: at, active: true, result: "failed" as const, scrappedQuantity: 2, reinspectableQuantity: 4,
  maxAllocatableQuantity: 4, remakeEligible: true, remakeQuantity: 0, remainingRemakeQuantity: 6,
  remainingScrapRemakeQuantity: 2, allocatedQuantity: 0, allocationBlockers: [] });
const basis = () => ({ productionOrderId: ids.production, orderId: ids.order, productionVersionId: ids.version, projectionVersion: 4,
  rootInspectionId: ids.root, quantityReviewId: ids.quantityReview, scrapReviewId: null,
  actualScrappedQuantity: 2, mappedScrappedQuantity: 0, unassignedQuantity: 2, unassignedGroupQuantity: 2,
  outsideRootQuantity: 0, ambiguousQuantity: 0, groups: [{ ...group(), scrappedQuantity: 0, reinspectableQuantity: 6,
    maxAllocatableQuantity: 2, remainingScrapRemakeQuantity: 0 }], lots: [lot()], blockers: [], fingerprint: "a".repeat(64) });
const review = () => ({ id: ids.scrapReview, productionOrderId: ids.production, productionVersionId: ids.version,
  rootInspectionId: ids.root, quantityReviewId: ids.quantityReview, previousReviewId: null, input: input(), createdBy: ids.actor, createdAt: at });
const workspace = () => ({ contextAuthority: authority(), access: { canRead: true as const, canWrite: true }, basis: basis(), reviews: [], nextCursor: null });

describe("fixed physical scrap allocation contracts", () => {
  it("retains the actual group and incremental scrap lot instead of accepting a cumulative anonymous quantity", () => {
    expect(AllocateQualityScrapInputSchema.parse(input())).toEqual(input());
    const unidentified = { qualityGroupId: ids.group, quantity: 2 };
    expect(AllocateQualityScrapInputSchema.safeParse({ ...input(), allocations: [unidentified] }).success).toBe(false);
  });
  it.each([0, -1, 0.5, 100001, "2"])("rejects an invalid allocated count %s", quantity => {
    expect(AllocateQualityScrapInputSchema.safeParse({ ...input(), allocations: [{ ...input().allocations[0], quantity }] }).success).toBe(false);
  });
  it("requires an explicit real physical segregation confirmation", () => {
    expect(AllocateQualityScrapInputSchema.safeParse({ ...input(), physicalSegregationConfirmed: false }).success).toBe(false);
  });
  it("rejects a duplicated group and lot pair but keeps distinct lots and groups", () => {
    const row = input().allocations[0]!;
    expect(AllocateQualityScrapInputSchema.safeParse({ ...input(), allocations: [row, row] }).success).toBe(false);
    expect(AllocateQualityScrapInputSchema.safeParse({ ...input(), allocations: [row, { ...row, sourceQuantityReviewId: createEntityId() }] }).success).toBe(true);
    expect(AllocateQualityScrapInputSchema.safeParse({ ...input(), allocations: [row, { ...row, qualityGroupId: createEntityId() }] }).success).toBe(true);
  });
  it("bounds the whole allocation rather than only each row", () => {
    const row = { ...input().allocations[0]!, quantity: 100000 };
    expect(AllocateQualityScrapInputSchema.safeParse({ ...input(), allocations: [row] }).success).toBe(true);
    expect(AllocateQualityScrapInputSchema.safeParse({ ...input(), allocations: [row, { ...row, qualityGroupId: createEntityId(), quantity: 1 }] }).success).toBe(false);
  });
  it("rejects repeated attachments and caller supplied pool releases or monetary effects", () => {
    const asset = createEntityId();
    expect(AllocateQualityScrapInputSchema.safeParse({ ...input(), evidenceAssetIds: [asset, asset] }).success).toBe(false);
    expect(AllocateQualityScrapInputSchema.safeParse({ ...input(), releasedUnits: 2 }).success).toBe(false);
    expect(AllocateQualityScrapInputSchema.safeParse({ ...input(), allocations: [{ ...input().allocations[0], refundMinor: 200 }] }).success).toBe(false);
  });
  it("preserves all four source timing classifications without treating excluded old scrap as group credit", () => {
    for (const scope of ["groupable", "before_root", "ambiguous", "no_root"])
      expect(QualityScrapLotSchema.parse({ ...lot(), scope }).scope).toBe(scope);
    expect(QualityScrapLotSchema.safeParse({ ...lot(), quantity: 0, remainingQuantity: 0 }).success).toBe(false);
  });
  it("requires every incremental lot to conserve allocated plus remaining units", () => {
    expect(QualityScrapLotSchema.parse(lot())).toEqual(lot());
    expect(QualityScrapLotSchema.safeParse({ ...lot(), allocatedQuantity: 1 }).success).toBe(false);
    expect(QualityScrapLotSchema.safeParse({ ...lot(), allocatedQuantity: 3, remainingQuantity: 0 }).success).toBe(false);
  });
  it("keeps original group quantity separate from its physically reinspectable remainder", () => {
    expect(QualityScrapGroupBasisSchema.parse(group())).toMatchObject({ quantity: 6, scrappedQuantity: 2, reinspectableQuantity: 4 });
    expect(QualityScrapGroupBasisSchema.safeParse({ ...group(), reinspectableQuantity: 5 }).success).toBe(false);
    expect(QualityScrapGroupBasisSchema.safeParse({ ...group(), scrappedQuantity: 7, reinspectableQuantity: 0 }).success).toBe(false);
    expect(QualityScrapGroupBasisSchema.safeParse({ ...group(), remainingScrapRemakeQuantity: 3 }).success).toBe(false);
  });
  it("cannot reinspect a retired parent while retaining its original scrap remake evidence", () => {
    expect(QualityScrapGroupBasisSchema.safeParse({ ...group(), active: false }).success).toBe(false);
    expect(QualityScrapGroupBasisSchema.parse({ ...group(), active: false, reinspectableQuantity: 0 })).toMatchObject({ quantity: 6, scrappedQuantity: 2, remainingScrapRemakeQuantity: 2 });
  });
  it("retains unknown physical scrap and never fills it with a zero", () => {
    const unknown = { ...basis(), quantityReviewId: null, actualScrappedQuantity: null, unassignedQuantity: 0, unassignedGroupQuantity: 0, lots: [], groups: [], blockers: ["尚无已核准报废数量"] };
    expect(QualityScrapBasisSchema.parse(unknown).actualScrappedQuantity).toBeNull();
  });
  it("conserves the actual cumulative scrap and does not count a before-root lot twice", () => {
    expect(QualityScrapBasisSchema.parse(basis())).toEqual(basis());
    expect(QualityScrapBasisSchema.safeParse({ ...basis(), mappedScrappedQuantity: 1 }).success).toBe(false);
    expect(QualityScrapBasisSchema.safeParse({ ...basis(), outsideRootQuantity: 1 }).success).toBe(false);
    expect(QualityScrapBasisSchema.parse({ ...basis(), unassignedGroupQuantity: 0, outsideRootQuantity: 2 }).outsideRootQuantity).toBe(2);
  });
  it("binds read and write display access to the actual individual permission scopes", () => {
    expect(QualityScrapWorkspaceSchema.parse(workspace()).access.canWrite).toBe(true);
    const mixed = authority(["order:read", "order:write"], { "order:read": "tenant", "order:write": "self" });
    expect(QualityScrapWorkspaceSchema.parse({ ...workspace(), contextAuthority: mixed, access: { canRead: true, canWrite: false } }).access.canWrite).toBe(false);
    expect(QualityScrapWorkspaceSchema.safeParse({ ...workspace(), contextAuthority: mixed }).success).toBe(false);
    expect(QualityScrapWorkspaceSchema.safeParse({ ...workspace(), contextAuthority: authority(["order:read", "order:write"], { "order:read": "self", "order:write": "tenant" }) }).success).toBe(false);
  });
  it("rejects another production's review in otherwise complete history", () => {
    expect(QualityScrapWorkspaceSchema.parse({ ...workspace(), reviews: [review()] }).reviews).toHaveLength(1);
    expect(QualityScrapWorkspaceSchema.safeParse({ ...workspace(), reviews: [{ ...review(), productionOrderId: createEntityId() }] }).success).toBe(false);
  });
  it.each(["productionVersionId", "rootInspectionId", "quantityReviewId", "previousReviewId"] as const)("binds saved %s to the exact original allocation input", field => {
    expect(QualityScrapReviewViewSchema.safeParse(review()).success).toBe(true);
    expect(QualityScrapReviewViewSchema.safeParse({ ...review(), [field]: createEntityId() }).success).toBe(false);
  });
  it("keeps the immutable review receipt and rejects a forged write grant", () => {
    const result = { contextAuthority: authority(), access: { canRead: true, canWrite: true }, review: review(), replayed: true };
    expect(QualityScrapResultSchema.parse(result).review.input).toEqual(input());
    expect(QualityScrapResultSchema.safeParse({ ...result, contextAuthority: authority(["order:read"]) }).success).toBe(false);
  });
  it("accepts bounded history pages while rejecting duplicate-style arrays and unknown query fields", () => {
    expect(QualityScrapHistoryQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(QualityScrapHistoryQuerySchema.parse({ before: ids.scrapReview, limit: "50" })).toEqual({ before: ids.scrapReview, limit: 50 });
    for (const query of [{ limit: 51 }, { limit: 0 }, { before: [ids.scrapReview, ids.scrapReview] }, { parentId: ids.group }])
      expect(QualityScrapHistoryQuerySchema.safeParse(query).success).toBe(false);
  });
});
