import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { NotFoundException } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { CANVAS_BRIDGE } from "@yummyai/contracts/pod/canvas-bridge";
import { connectDatabase, migrateDatabase, withTenant } from "@yummyai/database";
import { createStorageFromEnvironment } from "@yummyai/storage";
import { sql } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AuditService } from "../audit/audit.service.js";
import { ProductDevelopmentService } from "../catalog/product-development.service.js";
import { SalesPackageService } from "../catalog/sales-package.service.js";
import { CanvasBridgeService } from "../design/canvas-bridge.service.js";
import { CanvasWorkflowService } from "../design/canvas-workflow.service.js";
import { DesignService, DrizzleDesignRepository } from "../design/design.service.js";
import { PodBatchWorkflowService } from "../design/pod-batch-workflow.service.js";
import type { ProductionEditorService } from "../design/production-editor.service.js";
import { ClamAvProductionEditorScanner } from "../design/production-editor.service.js";
import { DrizzleListingRepository, ListingService } from "../listings/listing.service.js";
import { ContentProjectService } from "./content-project.service.js";

describe.sequential("tenant-backed content project projection", () => {
  const db = connectDatabase(),
    storage = createStorageFromEnvironment();
  const a: TenantContext = {
    tenantId: createEntityId(),
    userId: createEntityId(),
    permissions: Object.values(Permission),
    dataScope: "tenant",
  };
  const b: TenantContext = { ...a, tenantId: createEntityId(), userId: createEntityId() };
  const enqueue = {
    enqueueCreativeCandidate: vi.fn(),
    enqueueCreativeAdaptation: vi.fn(),
    enqueueTemplateCompile: vi.fn(),
    enqueueMockupRender: vi.fn(),
  };
  const audit = new AuditService(db),
    designs = new PodBatchWorkflowService(
      db,
      enqueue,
      audit,
      new DesignService(new DrizzleDesignRepository(db, storage)),
    );
  const bridge = new CanvasBridgeService(db, storage, audit, designs, new ClamAvProductionEditorScanner());
  // Results is a real tenant query; production writes are outside this read projection.
  const canvas = new CanvasWorkflowService(
    db,
    storage,
    bridge,
    designs,
    {} as ProductionEditorService,
    audit,
  );
  const listingService = new ListingService(new DrizzleListingRepository(db));
  const service = new ContentProjectService(
    db,
    bridge,
    canvas,
    new SalesPackageService(db, listingService, storage),
  );
  const catalog = new ProductDevelopmentService(db, storage);
  const briefs: string[] = [],
    artworks: Array<{ id: string; version: number }> = [];
  const directory = new URL("../../../../tmp/content-projects/", import.meta.url);
  const manifest = new URL(`integration-${a.tenantId}.json`, directory);
  const persist = () => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      manifest,
      JSON.stringify({ tenantId: a.tenantId, userId: a.userId, briefs, artworks }),
    );
  };
  let rootId: string, childId: string;
  beforeAll(async () => {
    await migrateDatabase(db);
    await storage.ensureBucket();
    for (const c of [a, b]) {
      // Identity bootstrap only; every business operation below uses the non-owner role.
      await db.client.unsafe(
        "insert into organizations(id,name,slug) values($1,'Content projection fixture',$2)",
        [c.tenantId, `content-${c.tenantId}`],
      );
      await db.client.unsafe(
        "insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Content fixture')",
        [c.userId, c.userId, `${c.userId}@example.test`],
      );
    }
    const root = await bridge.create(a, {
      requestId: randomUUID(),
      name: "Owned content project",
      prompt: "Synthetic original geometric pattern",
      templateKey: "original_pattern",
    });
    rootId = root.id;
    briefs.push(root.id);
    persist();
    const png = await sharp({
      create: { width: 64, height: 64, channels: 4, background: "#2859d6" },
    })
      .png()
      .toBuffer();
    const result = () => ({
      submissionId: randomUUID(),
      protocolVersion: 1,
      pluginVersion: CANVAS_BRIDGE.pluginVersion,
      upstreamVersion: CANVAS_BRIDGE.upstreamVersion,
      sourceNodeId: "content-fixture",
      title: "Synthetic original",
      contentBase64: png.toString("base64"),
      rightsAttested: true,
      sourceKind: "owned",
      sourceReference: "Owned integration fixture",
    });
    const first = await bridge.submit(a, root.id, result());
    await designs.reviewCreativeVersion(a, first.versionId, { decision: "approve" });
    const child = await bridge.continueWorkflow(a, root.id, {
      versionIds: [first.versionId],
      prompt: "Refine the synthetic original",
    });
    childId = child.id;
    briefs.push(child.id);
    persist();
    const final = await bridge.submit(a, child.id, result());
    await designs.reviewCreativeVersion(a, final.versionId, { decision: "approve" });
    const { artwork } = await catalog.registerArtwork(a, {
      code: "CONTENT-OWNED",
      name: "Owned fixture print",
      mode: "fixed",
      creativeVersionId: final.versionId,
      expectedVersion: 0,
      idempotencyKey: randomUUID(),
    });
    artworks.push({ id: artwork.id, version: artwork.version });
    persist();
  }, 60000);
  afterAll(async () => {
    const errors: unknown[] = [];
    for (const art of artworks)
      try {
        await catalog.archiveArtwork(a, art.id, {
          archived: true,
          expectedVersion: art.version,
          reason: "Content integration fixture teardown",
          idempotencyKey: randomUUID(),
        });
      } catch (e) {
        errors.push(e);
      }
    for (const id of briefs)
      try {
        const batch = await designs.getDesignBatch(a, id);
        if (["running", "queued"].includes(batch.status)) await designs.cancelDesignBatch(a, id);
        await designs.archiveDesignBatch(a, id, {
          archived: true,
          reason: "Content integration fixture teardown",
        });
      } catch (e) {
        errors.push(e);
      }
    try {
      expect(
        (await service.list(a, { q: "Owned content project", page: 1, pageSize: 20 })).total,
      ).toBe(0);
      expect((await catalog.options(a)).artworks).toHaveLength(0);
    } catch (e) {
      errors.push(e);
    }
    writeFileSync(
      manifest,
      JSON.stringify({
        tenantId: a.tenantId,
        userId: a.userId,
        briefs,
        artworks,
        cleaned: errors.length === 0,
        retained: "Immutable approved design and asset history retained in isolated fixture tenant",
      }),
    );
    await db.client.end();
    if (errors.length) throw new AggregateError(errors, "Content fixture cleanup incomplete");
  }, 60000);
  it("groups historical creative steps under one root and preserves final-version provenance", async () => {
    const list = await service.list(a, { q: "Owned", page: 1, pageSize: 1 });
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({ id: rootId, briefId: childId, approvedCount: 1 });
    const p = await service.get(a, childId);
    expect(p.id).toBe(rootId);
    expect(p.steps).toHaveLength(2);
    expect(p.results).toHaveLength(1);
    expect(p.artworks[0]?.creativeVersionId).toBe(p.results[0]?.versionId);
    expect(p.stages.find((s) => s.key === "design")?.status).toBe("complete");
    expect(p.stages.find((s) => s.key === "delivery")?.status).toBe("not_started");
    expect(enqueue.enqueueCreativeCandidate).not.toHaveBeenCalled();
  });
  it("enforces RLS for root and child identifiers and does not accept absent design permission", async () => {
    expect((await service.list(b, { q: "", page: 1, pageSize: 20 })).items).toEqual([]);
    await expect(service.get(b, rootId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.get(b, childId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.get({ ...a, permissions: [] }, rootId)).rejects.toThrow();
    const role = await withTenant(db.db, a, (tx) => tx.execute(sql`select current_user as role`));
    expect(role[0]?.role).toBe("yummyai_app");
  });
  it("omits restricted catalog data while preserving readable creative results", async () => {
    await expect(
      service.get({ ...a, permissions: [Permission.DesignRead] }, rootId),
    ).rejects.toThrow("asset:read");
    const p = await service.get(
      { ...a, permissions: [Permission.DesignRead, Permission.AssetRead] },
      rootId,
    );
    expect(p.results).toHaveLength(1);
    expect(p.artworks).toEqual([]);
    expect(p.skus).toEqual([]);
    expect(p.access).toEqual({ research: false, catalog: false, listing: false, assets: true });
    expect(p.stages.find((s) => s.key === "delivery")?.status).toBe("unauthorized");
  });
  it("returns the real total even when a requested page is past the last result", async () => {
    const list = await service.list(a, { q: "Owned", page: 2, pageSize: 1 });
    expect(list).toMatchObject({ items: [], total: 1, page: 2 });
  });
  it("uses the edited name and requirements while keeping the earlier step and artwork history", async () => {
    const revised = await bridge.revise(a, rootId, { requestId: randomUUID(), name: "Revised operations brief", prompt: "Manually confirmed by operations", expectedRevision: 1 });
    briefs.push(revised.id); persist();
    const list = await service.list(a, { q: "Revised operations", page: 1, pageSize: 20 });
    expect(list).toMatchObject({ total: 1, items: [{ id: rootId, name: "Revised operations brief", briefId: revised.id }] });
    const detail = await service.get(a, rootId);
    expect(detail).toMatchObject({ name: "Revised operations brief", briefId: revised.id, prompt: "Manually confirmed by operations", results: [] });
    expect(detail.steps).toHaveLength(3);
    expect(detail.artworks).toHaveLength(1);
    expect((await bridge.get(a, childId)).resultCount).toBe(1);
  });
});
