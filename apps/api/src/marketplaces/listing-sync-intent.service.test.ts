import { createHash } from "node:crypto";

import { NotFoundException } from "@nestjs/common";
import { Permission, type PermissionValue } from "@yummyai/authz";
import type { CreateMarketplaceListingSyncInput, MarketplaceListingSyncEventView, MarketplaceListingSyncRequestView, TenantContext } from "@yummyai/contracts";
import { listingSyncIntentRequestText } from "@yummyai/contracts/marketplace/listing-sync-intent";
import { marketplaceListingSyncIntents, type DatabaseConnection, type TenantTransaction, type marketplaceListingSyncRequests } from "@yummyai/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuditService } from "../audit/audit.service.js";
import type { ChannelInventoryService } from "../channel-inventory/channel-inventory.service.js";
import { MarketplaceListingSyncService } from "./marketplace-listing-sync.service.js";

const runtime = vi.hoisted(() => ({ tx: {} as object }));
vi.mock("../catalog/catalog-access.js", () => ({
  withCatalogTenant: (_database: unknown, _context: unknown, operation: (tx: object) => Promise<unknown>) => operation(runtime.tx),
}));
vi.mock("../audit/audit.service.js", () => ({ AuditService: class {} }));
vi.mock("../channel-inventory/channel-inventory.service.js", () => ({ ChannelInventoryService: class {} }));
vi.mock("./marketplace-authority.js", () => ({
  databaseNow: async () => new Date("2026-10-22T08:00:00.000Z"), currentMarketplaceAuthority: vi.fn(),
}));

const id = (suffix: string) => `019a0e40-0000-7000-8000-${suffix.padStart(12, "0")}`;
const context: TenantContext = { tenantId: id("1"), userId: id("2"), dataScope: "tenant",
  permissions: [Permission.ListingPublish, Permission.ListingRead, Permission.StoreRead] };
const input: CreateMarketplaceListingSyncInput = { accountId: id("3"), listingId: id("4"), listingVersionId: id("5"),
  sourcePublicationRequestId: id("6"), action: "read", requestKey: id("7") };
const digest = (value: CreateMarketplaceListingSyncInput) => createHash("sha256").update(listingSyncIntentRequestText(value)).digest("hex");
type RequestRow = typeof marketplaceListingSyncRequests.$inferSelect;
const request: RequestRow = { ...input, id: id("8"), tenantId: context.tenantId, createdBy: context.userId,
  platform: "etsy", marketplaceId: "SYNTHETIC", externalListingId: "SYNTHETIC-LISTING",
  desiredState: { original: true }, desiredChecksum: "a".repeat(64), idempotencyKey: "b".repeat(64),
  createdAt: new Date("2026-10-21T08:00:00.000Z") };
const event: MarketplaceListingSyncEventView = { id: id("9"), sequence: 2, status: "failed", code: "SYNC_QUEUE_UNAVAILABLE",
  message: "Listing sync queue is unavailable", issues: [], snapshot: null, snapshotChecksum: null,
  retryable: false, occurredAt: "2026-10-21T08:00:01.000Z" };
const view: MarketplaceListingSyncRequestView = { ...request, platform: "etsy", action: "read", createdAt: request.createdAt.toISOString(), current: event };

// These units exercise orchestration only. The disposable integration family
// covers real membership, RLS, object scopes, transactions and concurrency.
interface OrchestrationSeams {
  current(tx: TenantTransaction, ceiling: TenantContext, permission: PermissionValue): Promise<TenantContext>;
  access(tx: TenantTransaction, current: TenantContext, target: { accountId: string; listingId: string }, permission: PermissionValue): Promise<unknown>;
  request(tx: TenantTransaction, id: string): Promise<RequestRow>;
  prepare(): Promise<never>;
  view(ceiling: TenantContext, id: string, permission: PermissionValue): Promise<MarketplaceListingSyncRequestView>;
  latestEvent(tx: TenantTransaction, id: string): Promise<MarketplaceListingSyncEventView>;
}

function fixture() {
  const intent = { id: id("10"), tenantId: context.tenantId, createdBy: context.userId, requestKey: input.requestKey!,
    requestId: request.id, requestChecksum: digest(input), createdAt: request.createdAt };
  const limit = vi.fn().mockResolvedValue([intent]);
  runtime.tx = { execute: vi.fn(), select: vi.fn(() => ({ from: () => ({ where: () => ({ limit, orderBy: () => ({ limit }) }) }) })) };
  const enqueue = vi.fn(), recordInTransaction = vi.fn();
  const service = new MarketplaceListingSyncService({ db: {} } as DatabaseConnection, { enqueue },
    { recordInTransaction } as unknown as AuditService, {} as ChannelInventoryService);
  const seams = service as unknown as OrchestrationSeams;
  const current = vi.spyOn(seams, "current").mockResolvedValue(context);
  const access = vi.spyOn(seams, "access").mockResolvedValue({});
  const original = vi.spyOn(seams, "request").mockResolvedValue(request);
  const prepare = vi.spyOn(seams, "prepare").mockRejectedValue(new Error("must_not_prepare_an_existing_intent"));
  const read = vi.spyOn(seams, "view").mockResolvedValue(view);
  vi.spyOn(seams, "latestEvent").mockResolvedValue(event);
  return { service, intent, enqueue, recordInTransaction, current, access, original, prepare, read, limit };
}

beforeEach(() => { vi.restoreAllMocks(); });

describe("Listing sync original intent orchestration", () => {
  it("restores an exact original key without preparing today's state or dispatching again, including publish-only callers", async () => {
    const f = fixture();
    const publisher = { ...context, permissions: [Permission.ListingPublish, Permission.StoreRead] };
    f.current.mockResolvedValue(publisher);
    expect(await f.service.create(publisher, input)).toEqual(view);
    expect(f.current).toHaveBeenCalledWith(runtime.tx, publisher, Permission.ListingPublish);
    expect(f.access).toHaveBeenCalledWith(runtime.tx, publisher, request, Permission.ListingPublish);
    expect(f.read).toHaveBeenCalledWith(publisher, request.id, Permission.ListingPublish);
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.recordInTransaction).not.toHaveBeenCalled();
  });

  it("checks the original object before disclosing a changed-target or receipt checksum conflict", async () => {
    const f = fixture(), hidden = new NotFoundException("Listing not found");
    f.access.mockRejectedValue(hidden);
    await expect(f.service.create(context, { ...input, listingId: id("11") })).rejects.toBe(hidden);
    await expect(f.service.receipt(context, { requestKey: input.requestKey!, requestChecksum: "c".repeat(64) })).rejects.toBe(hidden);
    expect(f.access).toHaveBeenCalledTimes(2);
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.recordInTransaction).not.toHaveBeenCalled();
  });

  it("returns the original failed request and version through a read-only receipt without consulting mutable preparation", async () => {
    const f = fixture();
    const receipt = await f.service.receipt(context, { requestKey: input.requestKey!, requestChecksum: digest(input) });
    expect(receipt).toMatchObject({ found: true, request: { id: request.id, listingVersionId: input.listingVersionId, current: event } });
    expect(f.current).toHaveBeenCalledWith(runtime.tx, context, Permission.ListingRead);
    expect(f.access).toHaveBeenCalledWith(runtime.tx, context, request, Permission.ListingRead);
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.recordInTransaction).not.toHaveBeenCalled();
  });

  it("rejects an intent whose stored original request no longer matches its complete target checksum", async () => {
    const f = fixture();
    f.original.mockResolvedValue({ ...request, sourcePublicationRequestId: id("12") });
    await expect(f.service.receipt(context, { requestKey: input.requestKey!, requestChecksum: f.intent.requestChecksum }))
      .rejects.toMatchObject({ response: { code: "listing_sync_intent_conflict" } });
    expect(f.access).toHaveBeenCalledTimes(1);
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.recordInTransaction).not.toHaveBeenCalled();
  });

  it("links a paged original v1 request using its captured checksum and case-sensitive key without preparing or re-enqueuing", async () => {
    const f = fixture(), rawKey = input.requestKey!.toUpperCase();
    expect(rawKey).not.toBe(rawKey.toLowerCase());
    const legacy = { ...request, id: id("99"), idempotencyKey: createHash("sha256").update(JSON.stringify({
      action: input.action, desiredChecksum: request.desiredChecksum, requestKey: rawKey, tenantId: context.tenantId, version: 1,
    })).digest("hex") };
    f.limit.mockResolvedValueOnce([])
      .mockResolvedValueOnce(Array.from({ length: 100 }, (_, index) => ({ ...request, id: id(String(index + 100)), idempotencyKey: "f".repeat(64) })))
      .mockResolvedValueOnce([legacy]);
    const values = vi.fn().mockResolvedValue(undefined), insert = vi.fn(() => ({ values }));
    runtime.tx = { ...runtime.tx, insert };
    f.read.mockResolvedValue({ ...view, id: legacy.id, idempotencyKey: legacy.idempotencyKey });
    expect(await f.service.create(context, { ...input, requestKey: rawKey })).toMatchObject({ id: legacy.id, idempotencyKey: legacy.idempotencyKey });
    expect(f.limit).toHaveBeenCalledTimes(3);
    expect(f.limit).toHaveBeenNthCalledWith(2, 100);
    expect(f.limit).toHaveBeenNthCalledWith(3, 100);
    expect(f.access.mock.invocationCallOrder[0]).toBeLessThan(f.limit.mock.invocationCallOrder[1]!);
    expect(insert).toHaveBeenCalledExactlyOnceWith(marketplaceListingSyncIntents);
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ requestId: legacy.id, requestKey: rawKey.toLowerCase(), requestChecksum: digest(input) }));
    expect(f.recordInTransaction).toHaveBeenCalledWith(runtime.tx, context, expect.objectContaining({ resourceId: legacy.id,
      metadata: expect.objectContaining({ recovered_legacy: true, dispatch: "not_requeued" }) }));
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
  });
});
