import { Permission } from "@yummyai/authz";
import { createEntityId, type CaptureDraft, type TenantContext } from "@yummyai/contracts";
import { connectDatabase, migrateDatabase } from "@yummyai/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuditService } from "../audit/audit.service.js";
import { ResearchRepository } from "../research/research.repository.js";
import { CaptureService, type CaptureMediaEnqueuer } from "./capture.service.js";

describe("capture ingestion and research library", () => {
  const database = connectDatabase();
  const tenantId = createEntityId();
  const userId = createEntityId();
  const otherTenantId = createEntityId();
  const otherUserId = createEntityId();
  const context: TenantContext = {
    tenantId,
    userId,
    permissions: [Permission.CaptureRead, Permission.CaptureWrite, Permission.ResearchRead],
    dataScope: "tenant",
  };
  const otherContext: TenantContext = { ...context, tenantId: otherTenantId, userId: otherUserId };
  const enqueuer: CaptureMediaEnqueuer = {
    async enqueue(input) {
      if (input.sourceUrl.includes("fail")) throw new Error("Synthetic media failure");
    },
  };
  const audit = new AuditService(database);
  const service = new CaptureService(database, enqueuer, audit);
  const repository = new ResearchRepository(database);

  beforeAll(async () => {
    await migrateDatabase(database);
    await database.client.unsafe(
      `insert into organizations (id, name, slug) values ($1, 'Capture tenant', $2), ($3, 'Other capture tenant', $4)`,
      [tenantId, `capture-${tenantId}`, otherTenantId, `capture-${otherTenantId}`],
    );
    await database.client.unsafe(
      `insert into app_users (id, oidc_subject, email, display_name) values ($1, $2, $3, 'Capture User'), ($4, $5, $6, 'Other Capture User')`,
      [
        userId,
        `capture-${userId}`,
        `${userId}@example.test`,
        otherUserId,
        `capture-${otherUserId}`,
        `${otherUserId}@example.test`,
      ],
    );
  });

  afterAll(async () => database.client.end());

  it("creates an immutable second snapshot for the same normalized URL", async () => {
    const first = await service.createSnapshot(context, draft());
    const second = await service.createSnapshot(
      context,
      draft({
        sourceUrl: "https://www.amazon.com/dp/B000000001?ref=tracking#details",
        title: "Updated title",
        capturedAt: new Date(Date.now() + 1_000).toISOString(),
      }),
    );

    expect(second.researchItemId).toBe(first.researchItemId);
    expect(second.snapshotId).not.toBe(first.snapshotId);
    await expect(repository.snapshotCount(context, first.researchItemId)).resolves.toBe(2);
    const timeline = await repository.timeline(context, first.researchItemId);
    expect(timeline.map((entry) => entry.title)).toEqual([
      "Updated title",
      "Personalized Sample Product",
    ]);
  });

  it("records partial success when one included media job fails", async () => {
    const receipt = await service.createSnapshot(
      context,
      draft({
        sourceUrl: "https://www.etsy.com/listing/1729000001/sample",
        platform: "etsy",
        marketplace: "www.etsy.com",
        externalId: "1729000001",
        media: [
          media("https://images.example.test/good.jpg", "good"),
          media("https://images.example.test/fail.jpg", "fail"),
        ],
      }),
    );
    expect(receipt.status).toBe("partial");
    const snapshot = await service.getSnapshot(context, receipt.snapshotId);
    expect(snapshot.media.map((entry) => entry.status)).toEqual(["queued", "failed"]);
  });

  it("preserves a parser-declared partial capture when no media job fails", async () => {
    const receipt = await service.createSnapshot(
      context,
      draft({
        captureStatus: "partial",
        diagnostics: [
          {
            code: "selector_error",
            field: "livePageDom",
            message: "The source page blocked live parsing",
            severity: "warning",
          },
        ],
        media: [],
        missingFields: ["livePageDom"],
        sourceUrl: "https://www.etsy.com/listing/1729000002/blocked-sample",
      }),
    );

    expect(receipt.status).toBe("partial");
  });

  it("does not reveal snapshots across tenants", async () => {
    const receipt = await service.createSnapshot(
      context,
      draft({ sourceUrl: "https://amazon.com/dp/B000000099" }),
    );
    await expect(service.getSnapshot(otherContext, receipt.snapshotId)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("filters and cursor-paginates in the repository", async () => {
    const result = await repository.list(context, {
      platform: "etsy",
      captureStatus: "partial",
      limit: 1,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ platform: "etsy", latestStatus: "partial" });
  });
});

function draft(overrides: Partial<CaptureDraft> = {}): CaptureDraft {
  return {
    platform: "amazon",
    parserVersion: "amazon@1.0.0",
    extensionVersion: "0.0.0",
    marketplace: "www.amazon.com",
    sourceUrl: "https://www.amazon.com/dp/B000000001",
    externalId: "B000000001",
    title: "Personalized Sample Product",
    domain: "research",
    price: { raw: "$29.95", amount: 29.95, currency: "USD" },
    rating: 4.7,
    reviewCount: 138,
    bullets: ["Food safe"],
    media: [media("https://images.example.test/main.jpg", "main")],
    variants: [],
    contentBlocks: [],
    missingFields: [],
    diagnostics: [],
    captureStatus: "complete",
    capturedAt: new Date().toISOString(),
    ...overrides,
  };
}

function media(sourceUrl: string, id: string): CaptureDraft["media"][number] {
  return { id, kind: "image", sourceUrl, included: true };
}
