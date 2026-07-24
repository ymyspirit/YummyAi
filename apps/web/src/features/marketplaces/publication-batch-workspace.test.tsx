import type { MarketplaceAccountView, MarketplacePublicationBatchView } from "@yummyai/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { PublicationBatchWorkspace } from "./publication-batch-workspace";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("./marketplace-actions", () => ({
  cancelMarketplacePublicationBatch: vi.fn(),
  continueMarketplacePublicationBatch: vi.fn(),
  createMarketplacePublicationBatch: vi.fn(),
}));

describe("publication batch workspace", () => {
  it("renders selectable approved targets and immutable batch progress", () => {
    const html = renderToStaticMarkup(<PublicationBatchWorkspace
      accounts={[account()]}
      batches={[batch()]}
      candidates={[
        candidate("0198fbef-4a10-7000-8000-000000000901", "PILLOW-S"),
        candidate("0198fbef-4a10-7000-8000-000000000902", "PILLOW-L"),
      ]}
    />);

    for (const label of ["批量发布", "目标店铺", "计划时间（可选）", "PILLOW-S", "PILLOW-L", "批次记录", "提交 JSON Feed"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("可继续");
    expect(html.includes("2 BATCHES")).toBe(false);
    expect(html).not.toContain("refresh-token-value");
  });

  it("shows an explicit locked state without a writable account", () => {
    const html = renderToStaticMarkup(<PublicationBatchWorkspace
      accounts={[]}
      batches={[]}
      candidates={[
        candidate("0198fbef-4a10-7000-8000-000000000901", "PILLOW-S"),
        candidate("0198fbef-4a10-7000-8000-000000000902", "PILLOW-L"),
      ]}
    />);
    expect(html).toContain("没有健康且具备 listing_write 权限的店铺");
    expect(html).toContain("尚无批量发布");
  });
});

function candidate(variantSkuId: string, skuCode: string) {
  return {
    id: `0198fbef-4a10-7000-8000-000000000910:${variantSkuId}`,
    listingId: "0198fbef-4a10-7000-8000-000000000910",
    listingVersionId: "0198fbef-4a10-7000-8000-000000000911",
    platform: "amazon" as const,
    skuCode,
    spuCode: "PILLOW-SPU",
    title: "Personalized pillow with a deliberately long operational title",
    variantSkuId,
    versionNumber: 4,
  };
}

function account(): MarketplaceAccountView {
  return {
    authorizationMode: "amazon_private",
    capabilities: ["listing_read", "listing_write"],
    capabilityExpiresAt: "2026-07-26T00:00:00.000Z",
    quota: null,
    createdAt: "2026-07-25T00:00:00.000Z",
    credentialStatus: "valid",
    displayName: "Amazon US",
    externalAccountId: "A1SELLER",
    grantedScopes: ["product-listing"],
    hasCredential: true,
    healthStatus: "healthy",
    id: "0198fbef-4a10-7000-8000-000000000920",
    lastCapabilitySyncAt: "2026-07-25T01:00:00.000Z",
    lastErrorCode: null,
    lastHealthAt: "2026-07-25T01:00:00.000Z",
    marketplaceIds: ["ATVPDKIKX0DER"],
    platform: "amazon",
    region: "NA",
    requestedScopes: ["product-listing"],
    status: "active",
    updatedAt: "2026-07-25T01:00:00.000Z",
  };
}

function batch(): MarketplacePublicationBatchView {
  const accountId = account().id;
  return {
    id: "0198fbef-4a10-7000-8000-000000000930",
    accountId,
    capabilitySnapshotId: "0198fbef-4a10-7000-8000-000000000931",
    platform: "amazon",
    marketplaceId: "ATVPDKIKX0DER",
    action: "initial",
    parentBatchId: null,
    idempotencyKey: "a".repeat(64),
    itemCount: 2,
    scheduledFor: null,
    createdBy: "0198fbef-4a10-7000-8000-000000000932",
    createdAt: "2026-07-25T02:00:00.000Z",
    status: "ready_to_continue",
    counts: { total: 2, waiting: 0, succeeded: 2, failed: 0, reconciliationRequired: 0, cancelled: 0 },
    items: ["PILLOW-S", "PILLOW-L"].map((targetLabel, index) => ({
      id: `0198fbef-4a10-7000-8000-00000000094${index}`,
      accountId,
      capabilitySnapshotId: "0198fbef-4a10-7000-8000-000000000931",
      listingId: "0198fbef-4a10-7000-8000-000000000910",
      listingVersionId: "0198fbef-4a10-7000-8000-000000000911",
      platform: "amazon" as const,
      marketplaceId: "ATVPDKIKX0DER",
      action: "amazon_validation_preview" as const,
      batchId: "0198fbef-4a10-7000-8000-000000000930",
      parentRequestId: null,
      sourceExternalListingId: null,
      idempotencyKey: `${index + 1}`.repeat(64),
      payloadChecksum: `${index + 3}`.repeat(64),
      targetLabel,
      assetCount: 1,
      scheduledFor: null,
      createdBy: "0198fbef-4a10-7000-8000-000000000932",
      createdAt: "2026-07-25T02:00:00.000Z",
      current: {
        id: `0198fbef-4a10-7000-8000-00000000095${index}`,
        sequence: 2,
        status: "validation_passed" as const,
        code: null,
        message: null,
        issues: [],
        externalListingId: targetLabel,
        externalSubmissionId: null,
        externalMediaIds: [],
        externalState: "VALID",
        retryable: false,
        occurredAt: "2026-07-25T02:01:00.000Z",
      },
    })),
  };
}
