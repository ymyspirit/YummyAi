import { syntheticSpecificationFacts } from "../../../../tools/testing/specification-fixtures.js";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { NotFoundException } from "@nestjs/common";
import { SecretVault } from "@yummyai/ai-core";
import { ForbiddenError, Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { PillowProjectQuerySchema } from "@yummyai/contracts/catalog/pillow-project";
import {
  connectDatabase,
  migrateDatabase,
  marketplaceAccounts,
  withTenant,
} from "@yummyai/database";
import { createStorageFromEnvironment } from "@yummyai/storage";
import {
  applyPillowFactoryStandard,
  createDefaultProductionDocument,
} from "@yummyai/production-editor/products";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AuditService } from "../audit/audit.service.js";
import { ProductDevelopmentService } from "../catalog/product-development.service.js";
import { ProductService, DrizzleCatalogRepository } from "../catalog/product.service.js";
import { ProductionEditorService } from "../design/production-editor.service.js";
import type { AmazonOrderReportService } from "../orders/amazon-order-report.service.js";
import { OrderService } from "../orders/order.service.js";
import { OrderWorkspaceService } from "../orders/order-workspace.service.js";
import { PillowProjectService } from "./pillow-project.service.js";

describe.sequential("tenant-backed pillow project and pinned order basis", () => {
  const db = connectDatabase(),
    storage = createStorageFromEnvironment(),
    vault = new SecretVault(Buffer.alloc(32, 137));
  const a: TenantContext = {
    tenantId: createEntityId(),
    userId: createEntityId(),
    permissions: Object.values(Permission),
    dataScope: "tenant",
  };
  const b: TenantContext = { ...a, tenantId: createEntityId(), userId: createEntityId() };
  const audit = new AuditService(db),
    orders = new OrderService(db, vault, audit);
  const reports = {} as AmazonOrderReportService;
  const enqueue = { enqueue: vi.fn() },
    scanner = { scan: vi.fn() };
  const editor = new ProductionEditorService(db, vault, storage, reports, audit, enqueue, scanner);
  const work = new OrderWorkspaceService(db, vault, storage, reports, editor, scanner);
  const catalog = new ProductDevelopmentService(db, storage),
    productRepository = new DrizzleCatalogRepository(db),
    products = new ProductService(productRepository);
  const service = new PillowProjectService(catalog, work, editor, db, vault);
  const fixtures = {
    lines: [] as string[],
    profiles: [] as string[],
    projects: [] as string[],
    plans: [] as string[],
    artworks: [] as Array<{ id: string; version: number }>,
  };
  const directory = new URL("../../../../tmp/pillow-projects/", import.meta.url);
  const manifest = new URL(`integration-${a.tenantId}.json`, directory);
  const persist = (extra = {}) => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      manifest,
      JSON.stringify({ tenantId: a.tenantId, userId: a.userId, fixtures, ...extra }, null, 2),
    );
  };
  async function cleanup(ctx: TenantContext, owned: typeof fixtures) {
    const errors: unknown[] = [];
    for (const lineId of owned.lines)
      try {
        const detail = await work.detail(ctx, lineId);
        await work.archive(ctx, lineId, {
          archived: true,
          expectedProjectionVersion: detail.line.projectionVersion,
          reason: "Owned pillow fixture teardown",
          idempotencyKey: randomUUID(),
        });
      } catch (error) {
        errors.push(error);
      }
    for (const art of owned.artworks)
      try {
        await catalog.archiveArtwork(ctx, art.id, {
          archived: true,
          expectedVersion: art.version,
          reason: "Owned pillow fixture teardown",
          idempotencyKey: randomUUID(),
        });
      } catch (error) {
        errors.push(error);
      }
    for (const id of owned.plans)
      try {
        const existing = await productRepository.getPlan(ctx, id);
        if (existing?.status !== "archived") await products.transition(ctx, id, "archived");
      } catch (error) {
        errors.push(error);
      }
    for (const id of owned.profiles)
      try {
        await work.archiveProfile(ctx, id, {
          archived: true,
          reason: "Owned pillow fixture teardown",
        });
      } catch (error) {
        errors.push(error);
      }
    for (const id of owned.projects)
      try {
        await editor.archive(ctx, id, { archived: true, reason: "Owned pillow fixture teardown" });
      } catch (error) {
        errors.push(error);
      }
    return errors;
  }
  let pillowProfile: Awaited<ReturnType<typeof work.profiles>>[number],
    tireProfile: typeof pillowProfile;
  let templateVersionId: string, templateProjectId: string, specificationId: string;
  const accountId = createEntityId();
  async function profile(kind: "shaped_pillow" | "tire_cover") {
    let document = createDefaultProductionDocument(kind);
    if (document.productType === "shaped_pillow") {
      document = applyPillowFactoryStandard(document);
      document.spec = { ...document.spec, widthMm: 254, heightMm: 254, declaredLongestMm: 254 };
    }
    // Synthetic specification only. No customer image, artwork approval or factory release.
    document.confirmations.physicalSize = true;
    const template = await editor.create(a, { name: `QA pillow workspace ${kind}`, document });
    fixtures.projects.push(template.project.id);
    persist();
    await editor.review(a, template.project.id, template.version.id);
    const rows = await work.saveProfile(a, {
      code: `QA-${kind}`,
      name: `QA ${kind}`,
      projectId: template.project.id,
      versionId: template.version.id,
      instructions: "Synthetic read-projection fixture",
      expectedVersion: 0,
      idempotencyKey: randomUUID(),
    });
    const result = rows.find((p) => p.code === `QA-${kind}`)!;
    fixtures.profiles.push(result.id);
    persist();
    return result;
  }
  async function order(profileVersionId: string | null, index: number) {
    const result = await orders.ingestNormalized(a, {
      accountId,
      platform: "amazon",
      externalEventId: randomUUID(),
      externalOrderId: `QA-PILLOW-${index}-${a.tenantId}`,
      providerStatus: "Unshipped",
      placedAt: new Date().toISOString(),
      orderTotal: null,
      lines: [
        {
          externalLineId: `line-${index}`,
          externalListingId: null,
          skuCode: null,
          title: "Synthetic pillow title must not establish product type",
          quantity: 1,
          unitPrice: null,
          customizationCount: 0,
        },
      ],
      redactedSource: { fixture: true },
      protectedDetails: null,
    });
    const lineId = result.lines[0]!.id;
    fixtures.lines.push(lineId);
    persist();
    const detail = await work.detail(a, lineId);
    await work.save(a, lineId, {
      expectedRevision: 0,
      expectedSourceVersionId: null,
      draft: { ...detail.draft, printProfileVersionId: profileVersionId, designExecutor: "human" },
      status: "pending_review",
      reason: "Synthetic partial requirements",
      idempotencyKey: randomUUID(),
    });
    return lineId;
  }
  beforeAll(async () => {
    await migrateDatabase(db);
    await storage.ensureBucket();
    mkdirSync(directory, { recursive: true });
    for (const name of readdirSync(directory).filter((n) => /^integration-.*\.json$/.test(n))) {
      const path = new URL(name, directory),
        prior = JSON.parse(readFileSync(path, "utf8"));
      if (prior.cleaned === true) continue;
      const ctx = { ...a, tenantId: prior.tenantId, userId: prior.userId };
      const errors = await cleanup(ctx, prior.fixtures);
      writeFileSync(
        path,
        JSON.stringify(
          {
            ...prior,
            cleaned: errors.length === 0,
            cleanupErrors: errors.map((e) => String(e)),
            recoveredAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
      if (errors.length)
        throw new AggregateError(errors, "Previous owned pillow fixture cleanup incomplete");
    }
    for (const c of [a, b]) {
      // Identity bootstrap only. All tenant business records use the non-owner role.
      await db.client.unsafe(
        "insert into organizations(id,name,slug) values($1,'Pillow workspace fixture',$2)",
        [c.tenantId, `pillow-${c.tenantId}`],
      );
      await db.client.unsafe(
        "insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Pillow fixture')",
        [c.userId, c.userId, `${c.userId}@example.test`],
      );
    }
    await withTenant(db.db, a, (tx) =>
      tx
        .insert(marketplaceAccounts)
        .values({
          id: accountId,
          tenantId: a.tenantId,
          platform: "amazon",
          displayName: "Isolated fixture identity",
          region: "NA",
          marketplaceIds: ["ATVPDKIKX0DER"],
          authorizationMode: "amazon_private",
          status: "disabled",
          createdBy: a.userId,
        }),
    );
    pillowProfile = await profile("shaped_pillow");
    tireProfile = await profile("tire_cover");
    templateVersionId = pillowProfile.sourceVersionId;
    templateProjectId = pillowProfile.projectId;
    const { spu } = await catalog.createSpu(a, {
      code: "QA-PILLOW-SPU",
      name: "QA reusable shaped pillow",
      idempotencyKey: randomUUID(),
    });
    fixtures.plans.push(spu.productPlanId);
    persist();
    const { specification } = await catalog.saveSpecification(a, {
      spuId: spu.id,
      code: "QA-PILLOW-SPEC",
      name: "Synthetic 10 in",
      attributes: { Size: "10 in" },
      facts: syntheticSpecificationFacts({
        material: "Synthetic fabric and filling specification",
        dimensions: "254 mm artwork subject; synthetic specification",
        packageContents: "One synthetic pillow",
        packageQuantity: 1,
        factsConfirmed: true,
      }),
      processProfileVersionId: pillowProfile.versionId,
      expectedVersion: 0,
      idempotencyKey: randomUUID(),
    });
    specificationId = specification.versionId;
    const { artwork } = await catalog.registerArtwork(a, {
      code: "QA-PILLOW-PLAN",
      name: "QA private customer photo plan",
      mode: "customer_image",
      creativeVersionId: null,
      customization: {
        version: 1,
        fields: [
          {
            key: "buyer_photo",
            label: "顾客原图",
            type: "image",
            required: true,
            validation: { allowedMediaTypes: ["image/png"], maxFiles: 1, maxBytes: 32000000 },
          },
        ],
      },
      instructions: "Synthetic per-order photo workflow; no fixed creative master",
      expectedVersion: 0,
      idempotencyKey: randomUUID(),
    });
    fixtures.artworks.push({ id: artwork.id, version: artwork.version });
    persist();
    await catalog.combine(a, {
      artworkVersionId: artwork.versionId,
      items: [{ specificationVersionId: specificationId, skuCode: "QA-PILLOW-SALE" }],
      idempotencyKey: randomUUID(),
    });
    for (let i = 0; i < 3; i++) await order(pillowProfile.versionId, i);
    for (let i = 3; i < 5; i++) await order(tireProfile.versionId, i);
    await order(null, 5);
  }, 60000);
  afterAll(async () => {
    const errors = await cleanup(a, fixtures);
    try {
      const result = await service.workspace(a, PillowProjectQuerySchema.parse({}));
      expect(result.orders?.total).toBe(0);
      expect(result.orders?.counts?.total).toBe(0);
      expect((await work.list(a, { q: "QA-PILLOW" })).total).toBe(0);
      expect((await catalog.workspace(a, {})).total).toBe(0);
      expect(result.specifications).toHaveLength(0);
      expect(await work.profiles(a)).toHaveLength(0);
      expect((await editor.list(a)).projects).toHaveLength(0);
    } catch (error) {
      errors.push(error);
    }
    persist({
      cleaned: errors.length === 0,
      cleanupErrors: errors.map((e) => String(e)),
      retainedHistory: "Archived immutable synthetic versions and disabled fixture identity",
    });
    await db.client.end();
    if (errors.length) throw new AggregateError(errors, "Pillow fixture cleanup incomplete");
  }, 60000);
  it("filters by the pinned process before pagination and counts; a title cannot classify an unknown order", async () => {
    const result = await service.workspace(a, PillowProjectQuerySchema.parse({ pageSize: 1 }));
    expect(result.orders?.items).toHaveLength(1);
    expect(result.orders?.total).toBe(3);
    expect(result.orders?.counts?.total).toBe(3);
    expect(result.orders?.items[0]?.productType).toBe("shaped_pillow");
    expect(result.specifications).toHaveLength(1);
    expect(result.artworks[0]?.mode).toBe("customer_image");
    expect(result.recipes).toHaveLength(1);
    expect((await work.list(a, { productType: "tire_cover" })).total).toBe(2);
  });
  it("returns no other tenant records and rejects cross-tenant order details", async () => {
    const result = await service.workspace(b, PillowProjectQuerySchema.parse({}));
    expect(result.orders?.total).toBe(0);
    expect(result.specifications).toHaveLength(0);
    await expect(service.order(b, fixtures.lines[0]!)).rejects.toBeInstanceOf(NotFoundException);
  });
  it("preserves partial permissions and requires private-order authorization for task details", async () => {
    const limited = { ...a, permissions: [Permission.DesignRead, Permission.OrderRead] };
    const result = await service.workspace(limited, PillowProjectQuerySchema.parse({}));
    expect(result.access).toEqual({ catalog: false, orders: true, details: false });
    expect(result.specifications).toHaveLength(0);
    await expect(service.order(limited, fixtures.lines[0]!)).rejects.toBeInstanceOf(ForbiddenError);
    const catalogOnly = await service.workspace(
      { ...a, permissions: [Permission.DesignRead, Permission.ProductRead] },
      PillowProjectQuerySchema.parse({}),
    );
    expect(catalogOnly.orders).toBeNull();
    expect(catalogOnly.specifications).toHaveLength(1);
  });
  it("keeps the order's exact historical template and leaves an absent task snapshot explicit", async () => {
    const current = await editor.get(a, templateProjectId);
    current.version.document.name = "New synthetic template version";
    const next = await editor.save(a, templateProjectId, {
      expectedVersionId: current.version.id,
      document: current.version.document,
    });
    await editor.review(a, templateProjectId, next.version.id);
    await work.saveProfile(a, {
      code: pillowProfile.code,
      name: "QA pillow revised",
      projectId: templateProjectId,
      versionId: next.version.id,
      instructions: "Synthetic newer process",
      expectedVersion: pillowProfile.versionNumber,
      idempotencyKey: randomUUID(),
    });
    const result = await service.order(a, fixtures.lines[0]!);
    expect(result.template?.versionId).toBe(templateVersionId);
    expect(result.basis.profile.versionId).toBe(pillowProfile.versionId);
    expect(result.agent.run).toBeNull();
    expect(result.diagnostics.join(" ")).toContain("未生成任务快照");
    expect(result.formalFile).toBeNull();
    expect(enqueue.enqueue).not.toHaveBeenCalled();
  });
  it("classifies a revised order using its current saved basis rather than an older revision", async () => {
    const id = fixtures.lines[0]!,
      detail = await work.detail(a, id);
    await work.save(a, id, {
      expectedRevision: detail.line.revision,
      expectedProjectionVersion: detail.line.projectionVersion,
      expectedSourceVersionId: null,
      draft: { ...detail.draft, printProfileVersionId: tireProfile.versionId },
      status: "pending_review",
      reason: "Synthetic basis change",
      idempotencyKey: randomUUID(),
    });
    expect((await service.workspace(a, PillowProjectQuerySchema.parse({}))).orders?.total).toBe(2);
    await expect(service.order(a, id)).rejects.toBeInstanceOf(NotFoundException);
  });
});
