import { createHash, randomUUID } from "node:crypto";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { ForbiddenError } from "@yummyai/authz";
import { SecretVault } from "@yummyai/ai-core";
import {
  createEntityId,
  CreateShipmentInputSchema,
  type ProductionEditorDocument,
  type ProductionEditorImageView,
  type TenantContext,
} from "@yummyai/contracts";
import {
  OrderWorkDetailViewSchema,
  OrderWorkSummariesSchema,
  OrderBulkPreviewSchema,
  type OrderWorkDetail,
  type OrderWorkActionInput,
} from "@yummyai/contracts/order/workspace";
import {
  connectDatabase,
  fulfillmentSuppliers,
  marketplaceAccounts,
  migrateDatabase,
  orderWorkItems,
  orderWorkRevisions,
  productionOrderVersions,
  productionEditorProjects,
  productionEditorImages,
  productionEditorRenders,
  modelProviderConfigs,
  modelRoutes,
  withTenant,
} from "@yummyai/database";
import { JobEnvelopeSchema } from "@yummyai/jobs";
import {
  assertAssetAccess,
  type Storage,
  type PutPrivateInput,
  type StoredAsset,
  type AssetDomain,
} from "@yummyai/storage";
import { eq, sql } from "drizzle-orm";
import JSZip from "jszip";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { StudioGateway } from "../../../worker/src/processors/studio-generation.gateway.js";
import { ProductionEditorRenderProcessor } from "../../../worker/src/processors/production-editor.processor.js";
import { AuditService } from "../audit/audit.service.js";
import { ProductionEditorService } from "../design/production-editor.service.js";
import { AmazonOrderReportService } from "./amazon-order-report.service.js";
import { OrderService } from "./order.service.js";
import { OrderWorkspaceService } from "./order-workspace.service.js";
import { OrderProductionService } from "./order-production.service.js";
import { OrderShipmentService } from "./order-shipment.service.js";
import { OrderAfterSalesService } from "./order-after-sales.service.js";

describe("order centers explicit handoff and independent fulfillment", () => {
  const database = connectDatabase(),
    tenantId = createEntityId(),
    otherTenant = createEntityId(),
    userId = createEntityId(),
    accountId = createEntityId(),
    supplierId = createEntityId();
  const context: TenantContext = {
    tenantId,
    userId,
    dataScope: "tenant",
    permissions: [
      "order:read",
      "order:write",
      "order:pii:read",
      "design:read",
      "design:write",
      "design:review",
      "asset:read",
    ],
  };
  const other: TenantContext = { ...context, tenantId: otherTenant };
  const vault = new SecretVault(Buffer.alloc(32, 119)),
    audit = new AuditService(database),
    orderService = new OrderService(database, vault, audit);
  const objects = new Map<string, Uint8Array>();
  const storage = {
    putPrivate: async (ctx: TenantContext, input: PutPrivateInput) => {
      const checksumSha256 = createHash("sha256").update(input.body).digest("hex"),
        objectKey = `tenants/${ctx.tenantId}/${input.domain}/${checksumSha256}/${input.fileName}`;
      objects.set(objectKey, Uint8Array.from(input.body));
      return { objectKey, checksumSha256, deduplicated: false };
    },
    readPrivate: async (
      ctx: TenantContext,
      asset: StoredAsset,
      options: { requiredDomain: AssetDomain },
    ) => {
      assertAssetAccess(ctx, asset, options.requiredDomain);
      const result = objects.get(asset.objectKey);
      if (!result) throw new Error("Synthetic blob missing");
      return result;
    },
  } as unknown as Storage;
  const clean = async () => ({
    result: "clean" as const,
    engine: "synthetic",
    signatureVersion: "fixture-v1",
    scannedAt: new Date().toISOString(),
  });
  const reports = new AmazonOrderReportService(
    database,
    vault,
    orderService,
    audit,
    {
      download: async () => {
        throw new Error("No network in test");
      },
      scan: clean,
    },
    { schedule: async () => undefined },
  );
  const editor = new ProductionEditorService(
    database,
    vault,
    storage,
    reports,
    audit,
    { enqueue: async () => undefined },
    { scan: clean },
  );
  const work = new OrderWorkspaceService(database, vault, storage, reports, editor, {
    scan: clean,
  });
  const production = new OrderProductionService(database, vault, orderService, audit, editor);
  const shipments = new OrderShipmentService(database, vault, orderService, audit, {
    enqueue: async () => {
      throw new Error("No marketplace writes in test");
    },
  });
  const generate = vi.fn<StudioGateway["generate"]>(async () => ({
    bytes: await image(768),
    mediaType: "image/png",
  }));
  const worker = new ProductionEditorRenderProcessor(
    database,
    storage,
    vault,
    vault,
    { generate },
    { scan: clean },
  );
  const afterSales = new OrderAfterSalesService(database, vault, audit);
  let profileVersionId: string;
  const image = (size: number) =>
    sharp({
      create: {
        width: size,
        height: size,
        channels: 4,
        background: { r: 30, g: 120, b: 200, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
  const doc = (): ProductionEditorDocument => ({
    schemaVersion: 1,
    name: "Synthetic print",
    productType: "tire_cover",
    spec: { diameterMm: 50, dpi: 150, safeInsetMm: 2, opening: null },
    contour: [],
    layers: [],
    confirmations: {
      physicalSize: true,
      visualReview: true,
      whiteBorderRule: true,
      narrowParts: true,
      barcodeTab: true,
      backText: true,
    },
  });
  async function attachment(externalOrderId: string, externalLineId: string, size: number) {
    const zip = new JSZip();
    zip.file(
      "order.json",
      JSON.stringify({
        orderId: externalOrderId,
        orderItemId: externalLineId,
        customizationData: {
          type: "PageContainerCustomization",
          snapshot: { imageName: "preview.png" },
          children: [
            {
              type: "ImageCustomization",
              image: { imageName: "buyer.png", buyerFilename: "buyer.png" },
            },
          ],
        },
      }),
    );
    zip.file("preview.png", await image(16));
    zip.file("buyer.png", await image(size));
    return zip.generateAsync({ type: "nodebuffer" });
  }
  async function imported() {
    const externalOrderId = `SYNTHETIC-CENTERS-${createEntityId()}`,
      externalLineId = `LINE-${createEntityId()}`;
    const content = `order-id\torder-item-id\tpurchase-date\tsku\tproduct-name\tquantity-purchased\tcurrency\titem-price\tcustomized-url\n${externalOrderId}\t${externalLineId}\t${new Date().toISOString()}\tTEST-CENTER-SKU\tSynthetic custom item\t2\tUSD\t40.00\thttps://zme-caps.amazon.com/synthetic`;
    const batch = await reports.importReport(context, {
      accountId,
      marketplaceId: "ATVPDKIKX0DER",
      fileName: "synthetic.txt",
      content,
    });
    const report = (await reports.workspace(context, { batchId: batch.id })).lines[0]!;
    const parsed = await reports.process(
      context,
      report.id,
      null,
      await attachment(externalOrderId, externalLineId, 512),
    );
    return { report, parsed, externalOrderId, externalLineId, lineId: report.orderLineId };
  }
  async function save(detail: OrderWorkDetail) {
    return work.save(context, detail.line.id, {
      expectedRevision: detail.line.revision,
      expectedProjectionVersion: detail.line.projectionVersion,
      expectedSourceVersionId: detail.report?.versionId ?? null,
      draft: {
        ...detail.draft,
        designExecutor: "human",
        printProfileVersionId: profileVersionId,
        instructions: "Private operator instructions",
        fields: [{ key: "name", label: "Name", kind: "text", value: "Private customer text" }],
        images: detail
          .report!.files.filter((file) => file.role === "buyer_image")
          .map((file) => ({ origin: "report", key: file.key, usage: "正面" })),
      },
      status: "ready_to_push",
      reason: "Synthetic operator review",
      idempotencyKey: randomUUID(),
    });
  }
  const envelope = (renderId: string) =>
    JobEnvelopeSchema.parse({
      jobId: createEntityId(),
      tenantId,
      requestedBy: userId,
      correlationId: renderId,
      idempotencyKey: renderId,
      payload: { renderId },
    });
  const act = async (
    detail: OrderWorkDetail,
    action: OrderWorkActionInput["action"],
    version?: string,
  ) => {
    const result = await work.action(context, detail.line.id, {
      action,
      expectedRevision: detail.line.revision,
      expectedProjectionVersion: detail.line.projectionVersion,
      expectedEditorVersionId: version,
      reason: "Synthetic recorded action",
      idempotencyKey: randomUUID(),
    });
    if (["start_artwork", "push"].includes(action) && result.line.editorProjectId) {
      const project = await editor.get(context, result.line.editorProjectId);
      for (const job of project.renders.filter(
        (job) => job.purpose === "order_image_enhancement" && job.status === "queued",
      ))
        await worker.process(envelope(job.id));
    }
    return work.detail(context, detail.line.id);
  };

  beforeAll(async () => {
    await migrateDatabase(database);
    await database.client.unsafe(
      "insert into organizations(id,name,slug) values($1,$2,$3),($4,$5,$6)",
      [
        tenantId,
        "Synthetic Centers",
        `centers-${tenantId}`,
        otherTenant,
        "Synthetic Other",
        `centers-${otherTenant}`,
      ],
    );
    await database.client.unsafe(
      "insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,$4)",
      [userId, `centers-${userId}`, `${userId}@example.test`, "Synthetic Operator"],
    );
    await withTenant(database.db, context, async (tx) => {
      const providerId = createEntityId();
      await tx
        .insert(modelProviderConfigs)
        .values({
          id: providerId,
          tenantId,
          provider: "openai-compatible",
          label: "Synthetic image provider",
          endpoint: "https://example.test/v1",
          encryptedApiKey: vault.encrypt("synthetic-image-key"),
          createdBy: userId,
        });
      await tx
        .insert(modelRoutes)
        .values({
          id: createEntityId(),
          tenantId,
          modelKey: "synthetic-image",
          taskType: "studio_image",
          targets: [
            { providerConfigId: providerId, providerModel: "gpt-image-2.5", timeoutMs: 600000 },
          ],
        });
      await tx.insert(marketplaceAccounts).values({
        id: accountId,
        tenantId,
        platform: "amazon",
        displayName: "Synthetic Center Shop",
        region: "NA",
        authorizationMode: "amazon_private",
        marketplaceIds: ["ATVPDKIKX0DER"],
        createdBy: userId,
      });
      await tx.insert(fulfillmentSuppliers).values({
        id: supplierId,
        tenantId,
        name: "Synthetic Manual Factory",
        kind: "manual",
        status: "active",
        regionCode: "CN",
        settlementCurrency: "USD",
        createdBy: userId,
      });
    });
    let template = await editor.create(context, { name: "Synthetic template", document: doc() });
    const asset = (await editor.upload(
      context,
      template.project.id,
      "template.png",
      await image(512),
    )) as ProductionEditorImageView;
    const document = doc();
    document.layers = [
      {
        id: "image",
        kind: "image",
        name: "Print",
        assetId: asset.id,
        assetVersion: 1,
        xMm: 5,
        yMm: 5,
        widthMm: 40,
        heightMm: 40,
        rotationDeg: 0,
        opacity: 1,
        visible: true,
        locked: false,
        flipX: false,
        flipY: false,
      },
    ];
    template = await editor.save(context, template.project.id, {
      expectedVersionId: template.version.id,
      document,
    });
    await editor.review(context, template.project.id, template.version.id);
    const profiles = await work.saveProfile(context, {
      code: "SYNTHETIC-PRINT-01",
      name: "Synthetic print",
      projectId: template.project.id,
      versionId: template.version.id,
      instructions: "Synthetic process",
      expectedVersion: 0,
      idempotencyKey: randomUUID(),
    });
    profileVersionId = profiles[0]!.versionId;
  }, 60_000);
  afterAll(async () => {
    objects.clear();
    await database.client.end();
  });

  it("imports without starting work, retains source originals across reimports and isolates private versions", async () => {
    const source = await imported();
    let detail = OrderWorkDetailViewSchema.parse(await work.detail(context, source.lineId));
    expect(detail.line).toMatchObject({
      preparation: "pending_review",
      artwork: "not_pushed",
      production: "not_released",
      revision: 0,
    });
    expect((await work.list(context, { module: "artwork", q: source.externalOrderId })).total).toBe(
      0,
    );
    expect(detail.draft.images).toEqual([]);
    detail = await save(detail);
    await expect(save({ ...detail, line: { ...detail.line, revision: 0 } })).rejects.toBeInstanceOf(
      ConflictException,
    );
    const push = {
      action: "push",
      expectedRevision: detail.line.revision,
      expectedProjectionVersion: detail.line.projectionVersion,
      reason: "Confirmed",
      idempotencyKey: randomUUID(),
    };
    detail = await work.action(context, source.lineId, push);
    await work.action(context, source.lineId, push);
    expect(detail.events.filter((event) => event.action === "push")).toHaveLength(1);
    expect(detail.line.editorProjectId).toBeNull();
    await expect(save(detail)).rejects.toBeInstanceOf(ConflictException);
    await reports.process(
      context,
      source.report.id,
      source.parsed.versionId,
      await attachment(source.externalOrderId, source.externalLineId, 256),
    );
    detail = await work.detail(context, source.lineId);
    expect(detail.line.sourceChanged).toBe(true);
    detail = await act(detail, "start_artwork");
    const project = await editor.get(context, detail.line.editorProjectId!);
    const templates = await editor.list(context, "templates");
    expect(templates.projects.length).toBeGreaterThan(0);
    expect(templates.projects.every((row) => !row.source && !row.workSource)).toBe(true);
    expect(
      project.images.find(
        (asset) => asset.name.includes("正面") && !asset.name.startsWith("保真美化 · "),
      ),
    ).toMatchObject({
      width: 512,
      height: 512,
    });
    expect(detail.draft.fields[0]!.value).toBe("Private customer text");
    expect(
      (await work.revision(context, source.lineId, project.project.workSource!.revisionId))
        .fields[0]!.value,
    ).toBe("Private customer text");
    await expect(
      work.revision(other, source.lineId, project.project.workSource!.revisionId),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect((await work.list(other, { q: source.externalOrderId })).total).toBe(0);
    await expect(work.detail(other, source.lineId)).rejects.toBeInstanceOf(NotFoundException);
    const records = await withTenant(database.db, context, (tx) =>
      tx.select().from(orderWorkRevisions).where(eq(orderWorkRevisions.workItemId, source.lineId)),
    );
    expect(JSON.stringify(records)).not.toContain("Private customer");
    await expect(
      withTenant(database.db, context, (tx) =>
        tx.execute(
          sql`update order_work_revisions set checksum = repeat('0',64) where work_item_id = ${source.lineId}`,
        ),
      ),
    ).rejects.toThrow();
    detail = await act(detail, "recall");
    await expect(
      editor.save(context, project.project.id, {
        expectedVersionId: project.version.id,
        document: project.version.document,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect((await editor.get(context, project.project.id)).version.id).toBe(project.version.id);
    expect(detail.line.artwork).toBe("not_pushed");
  });

  it("requires reviewed production renders and records partial shipments without marketplace writes", async () => {
    const source = await imported();
    let detail = await act(await save(await work.detail(context, source.lineId)), "push");
    detail = await act(detail, "start_artwork");
    let project = await editor.get(context, detail.line.editorProjectId!);
    project = await editor.save(context, project.project.id, {
      expectedVersionId: project.version.id,
      document: { ...project.version.document, confirmations: doc().confirmations },
    });
    detail = await act(detail, "submit_artwork", project.version.id);
    await expect(
      editor.save(context, project.project.id, {
        expectedVersionId: project.version.id,
        document: project.version.document,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      editor.review(context, project.project.id, project.version.id),
    ).rejects.toBeInstanceOf(ConflictException);
    detail = await act(detail, "approve_artwork", project.version.id);
    const rejection = {
      action: "reject_artwork",
      expectedRevision: detail.line.revision,
      expectedProjectionVersion: detail.line.projectionVersion,
      expectedEditorVersionId: project.version.id,
      reason: "Synthetic review: smooth the lower cutting line",
      idempotencyKey: randomUUID(),
    };
    await expect(work.action(context, source.lineId, { ...rejection, reason: "  " })).rejects.toThrow();
    await expect(work.action(context, source.lineId, { ...rejection, expectedEditorVersionId: undefined })).rejects.toBeInstanceOf(ConflictException);
    await expect(work.action(context, source.lineId, { ...rejection, expectedEditorVersionId: createEntityId() })).rejects.toBeInstanceOf(ConflictException);
    await expect(work.action(other, source.lineId, rejection)).rejects.toBeInstanceOf(NotFoundException);
    await expect(work.action({ ...context, permissions: context.permissions.filter((permission) => permission !== "design:review") }, source.lineId, rejection)).rejects.toBeInstanceOf(ForbiddenError);
    // Review-only operators can reject without design-write permission.
    detail = await work.action({ ...context, permissions: context.permissions.filter((permission) => permission !== "design:write") }, source.lineId, rejection);
    detail = await work.action(context, source.lineId, rejection);
    expect(detail.line.artwork).toBe("changes_requested");
    expect(detail.events.filter((event) => event.action === "reject_artwork")).toHaveLength(1);
    expect(detail.events.find((event) => event.action === "reject_artwork")?.reason).toBe(rejection.reason);
    expect((await editor.get(context, project.project.id)).version.reviewed).toBe(false);
    await expect(editor.render(context, project.project.id, {
      expectedVersionId: project.version.id, purpose: "production", format: "png", background: "white",
    })).rejects.toThrow();
    detail = await act(detail, "submit_artwork", project.version.id);
    detail = await act(detail, "approve_artwork", project.version.id);
    const render = await editor.render(context, project.project.id, {
      expectedVersionId: project.version.id,
      purpose: "production",
      format: "png",
      background: "transparent",
    });
    const release = {
      expectedRevision: detail.line.revision,
      expectedProjectionVersion: detail.line.projectionVersion,
      renderId: render.id,
      supplierId,
      quantity: 1,
      expectedCompletionAt: new Date(Date.now() + 86400000).toISOString(),
      instructions: "Synthetic factory instructions",
      idempotencyKey: randomUUID(),
    };
    await expect(production.releaseArtwork(context, source.lineId, release)).rejects.toBeInstanceOf(
      ConflictException,
    );
    await worker.process(
      JobEnvelopeSchema.parse({
        jobId: createEntityId(),
        tenantId,
        requestedBy: userId,
        correlationId: render.id,
        idempotencyKey: render.id,
        payload: { renderId: render.id },
      }),
    );
    let released = await production.releaseArtwork(context, source.lineId, release);
    expect(
      (await production.releaseArtwork(context, source.lineId, release)).productionOrder.id,
    ).toBe(released.productionOrder.id);
    const pinned = await withTenant(database.db, context, (tx) =>
      tx
        .select()
        .from(productionOrderVersions)
        .where(eq(productionOrderVersions.productionOrderId, released.productionOrder.id)),
    );
    expect(pinned[0]).toMatchObject({
      sourceRenderId: render.id,
      sourceEditorVersionId: project.version.id,
      quantity: 1,
    });
    const shipping = CreateShipmentInputSchema.parse({
      shipDate: new Date().toISOString(),
      shipFromCountryCode: "CN",
      packages: [
        {
          packageReferenceId: "SYNTHETIC-PKG",
          trackingNumber: "SYNTHETIC-TRACK",
          carrierCode: "MANUAL",
          carrierName: "Synthetic carrier",
          carrierService: "Synthetic service",
          lines: [{ orderLineId: source.lineId, quantity: 1 }],
        },
      ],
      idempotencyKey: randomUUID(),
    });
    await expect(shipments.create(context, detail.line.orderId, shipping)).rejects.toBeInstanceOf(
      ConflictException,
    );
    for (const type of ["submitted", "acknowledged", "started", "completed"] as const)
      released = await production.recordMilestone(context, released.productionOrder.id, {
        type,
        expectedProjectionVersion: released.productionOrder.projectionVersion,
        externalEventId: randomUUID(),
        occurredAt: new Date().toISOString(),
        evidence: { code: "SYNTHETIC_EVIDENCE", note: "Fixture event", assetIds: [] },
      });
    const standard = await production.createQualityStandard(context, {
      name: "Synthetic QC",
      skuId: null,
      supplierId: null,
      minimumScoreBps: 9000,
      criteria: [{ code: "SYNTHETIC", label: "Synthetic print", weightBps: 10000, blocking: true }],
    });
    await production.inspect(context, released.productionOrder.id, {
      qualityStandardVersionId: standard.id,
      result: "passed",
      scoreBps: 10000,
      evidenceAssetIds: [],
      defects: [],
      inspectedAt: new Date().toISOString(),
      idempotencyKey: randomUUID(),
    });
    let shipment = await shipments.create(context, detail.line.orderId, shipping);
    shipment = await shipments.reviewVersion(
      context,
      shipment.shipment.id,
      shipment.versions[0]!.id,
      {
        decision: "approved",
        expectedCurrentVersion: 1,
        reasonCode: "SYNTHETIC_CHECK",
        reason: "Synthetic package review",
        idempotencyKey: randomUUID(),
      },
    );
    const handover = {
      expectedVersion: 1,
      occurredAt: new Date().toISOString(),
      reason: "Synthetic pickup receipt",
      idempotencyKey: randomUUID(),
    };
    await shipments.dispatch(context, shipment.shipment.id, handover);
    await shipments.dispatch(context, shipment.shipment.id, handover);
    const list = await work.list(context, {
      module: "shipments",
      shipment: "partial",
      q: source.externalOrderId,
    });
    expect(list.items[0]).toMatchObject({
      quantity: 2,
      readyQuantity: 1,
      shippedQuantity: 1,
      production: "partially_completed",
    });
    expect((await shipments.get(context, shipment.shipment.id)).writebacks).toHaveLength(0);
    await expect(
      shipments.create(context, detail.line.orderId, { ...shipping, idempotencyKey: randomUUID() }),
    ).rejects.toBeInstanceOf(ConflictException);
    detail = await work.detail(context, source.lineId);
    await expect(act(detail, "recall")).rejects.toBeInstanceOf(ConflictException);
  }, 60_000);

  it("records private after-sales evidence and closes once without executing external actions", async () => {
    const source = await imported();
    const detail = await work.detail(context, source.lineId);
    const created = await afterSales.create(context, detail.line.orderId, {
      type: "customer_contact",
      reasonCode: "SYNTHETIC",
      summary: "Private customer question",
      idempotencyKey: randomUUID(),
    });
    expect(JSON.stringify(created)).not.toContain("Private customer question");
    await expect(
      afterSales.getPrivate({ ...context, permissions: ["order:read"] }, created.case.id),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(afterSales.getPrivate(other, created.case.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const completion = {
      expectedDecisionVersion: 1,
      evidenceReference: "Synthetic actual receipt",
      reason: "Customer issue was handled",
      occurredAt: new Date().toISOString(),
      idempotencyKey: randomUUID(),
    };
    await expect(afterSales.complete(context, created.case.id, completion)).rejects.toBeInstanceOf(
      ConflictException,
    );
    await afterSales.decide(context, created.case.id, {
      resolution: "no_action",
      refundAmountMinor: null,
      refundCurrency: null,
      returnRequired: false,
      responsibilityParty: "undetermined",
      reasonCode: "ANSWERED",
      reason: "Private answer recorded",
      expectedDecisionVersion: 0,
      idempotencyKey: randomUUID(),
    });
    const closed = await afterSales.complete(context, created.case.id, completion);
    expect(closed.case).toMatchObject({ status: "resolved", summary: "Private customer question" });
    expect(closed.contacts.at(-1)?.body).toContain("Synthetic actual receipt");
    expect((await afterSales.complete(context, created.case.id, completion)).contacts).toHaveLength(
      closed.contacts.length,
    );
    await expect(
      afterSales.complete(context, created.case.id, { ...completion, reason: "Changed retry" }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(
      (
        await work.list(context, {
          module: "after-sales",
          q: source.externalOrderId,
          afterSales: "resolved",
        })
      ).total,
    ).toBe(1);
  });

  it("groups matching products without splitting an order and returns tenant-authorized review summaries", async () => {
    const source = await imported();
    const saved = await save(await work.detail(context, source.lineId));
    await reports.importReport(context, {
      accountId,
      marketplaceId: "ATVPDKIKX0DER",
      fileName: "synthetic-group.txt",
      content: `order-id\torder-item-id\tpurchase-date\tsku\tproduct-name\tquantity-purchased\tcurrency\titem-price\n${source.externalOrderId}\tSECOND-LINE\t${new Date().toISOString()}\tSECOND-SKU\tSecond synthetic item\t1\tUSD\t20.00`,
    });
    const grouped = await work.list(context, {
      module: "orders",
      q: source.externalOrderId,
      grouping: "orders",
      pageSize: 1,
    });
    expect(grouped.groupTotal).toBe(1);
    expect(grouped.items).toHaveLength(2);
    expect(new Set(grouped.items.map((line) => line.orderId)).size).toBe(1);
    expect(
      (
        await work.list(context, {
          module: "orders",
          q: source.externalOrderId,
          grouping: "orders",
          pageSize: 1,
          page: 2,
        })
      ).items,
    ).toEqual([]);
    expect((await work.selection(context, { q: source.externalOrderId })).items).toHaveLength(2);
    const result = OrderWorkSummariesSchema.parse(
      await work.summaries(context, { ids: [source.lineId] }),
    );
    expect(result.items[0]?.fields).toEqual([{ label: "Name", value: "Private customer text" }]);
    expect(result.items[0]?.revision).toBe(saved.line.revision);
    expect(result.items[0]?.images.some((image) => image.kind === "buyer" && image.selected)).toBe(
      true,
    );
    expect(JSON.stringify(result)).not.toMatch(
      /encryptedDraft|contentBase64|encryptedDataKey|events|catalog/,
    );
    expect(await work.summaries(other, { ids: [source.lineId] })).toEqual({ items: [] });
    expect((await work.selection(other, { q: source.externalOrderId })).items).toEqual([]);
    await expect(
      work.summaries({ ...context, permissions: ["order:read"] }, { ids: [source.lineId] }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("previews batch changes without writing, retains individual customization, and rejects changed workflow versions", async () => {
    const source = await imported();
    const saved = await save(await work.detail(context, source.lineId));
    const request = {
      ids: [source.lineId],
      operation: "assign",
      onlyEmpty: true,
      patch: { designExecutor: "human", dueAt: "2026-12-01T00:00:00.000Z" },
      reason: "Synthetic batch plan",
    };
    const preview = OrderBulkPreviewSchema.parse(await work.bulkPreview(context, request));
    const input = preview.items[0]!.save!;
    expect(preview.items[0]!.blockers).toEqual([]);
    expect(input.draft.fields).toEqual(saved.draft.fields);
    expect(input.draft.images).toEqual(saved.draft.images);
    expect(input.draft.instructions).toEqual(saved.draft.instructions);
    expect((await work.detail(context, source.lineId)).line.revision).toBe(saved.line.revision);
    const held = await act(saved, "hold");
    await expect(work.save(context, source.lineId, input)).rejects.toThrow(/状态已变化/);
    const blocked = await work.bulkPreview(context, request);
    expect(blocked.items[0]?.save).toBeNull();
    expect(blocked.items[0]?.blockers).toContain("订单已暂停或取消");
    await act(held, "resume");
    const refreshed = await work.bulkPreview(context, request);
    const updated = await work.save(context, source.lineId, refreshed.items[0]!.save);
    expect(updated.line.preparation).toBe("pending_review");
    expect(updated.draft.fields).toEqual(saved.draft.fields);
    expect(updated.draft.images).toEqual(saved.draft.images);
    const noChange = await work.bulkPreview(context, {
      ...request,
      patch: { dueAt: "2026-12-02T00:00:00.000Z" },
    });
    expect(noChange.items[0]?.save).toBeNull();
    expect(noChange.items[0]?.blockers.join()).toContain("无需修改");
    const overwrite = await work.bulkPreview(context, {
      ...request,
      onlyEmpty: false,
      patch: { dueAt: "2026-12-02T00:00:00.000Z" },
    });
    expect(overwrite.items[0]?.save?.draft.dueAt).toBe("2026-12-02T00:00:00.000Z");
    const mixed = await work.bulkPreview(context, {
      ...request,
      ids: [source.lineId, createEntityId()],
    });
    expect(mixed.items).toHaveLength(1);
    expect(mixed.failures).toHaveLength(1);
  });

  async function enhancementOrder(choice: string, transparent = false) {
    const source = await imported();
    let detail = await work.detail(context, source.lineId);
    expect(detail.draft.designExecutor).toBe("agent");
    detail = await work.save(context, source.lineId, {
      expectedRevision: 0,
      expectedSourceVersionId: detail.report?.versionId ?? null,
      draft: {
        ...detail.draft,
        designExecutor: undefined,
        printProfileVersionId: profileVersionId,
        fields: [
          {
            key: "beautification",
            label: "Image beautification options",
            kind: "text",
            value: choice,
          },
        ],
        images: detail
          .report!.files.filter((file) => file.role === "buyer_image")
          .map((file) => ({ origin: "report", key: file.key, usage: "正面" })),
      },
      status: "pending_review",
      reason: "Synthetic image policy",
      idempotencyKey: randomUUID(),
    });
    const second = transparent
      ? await sharp({
          create: {
            width: 640,
            height: 640,
            channels: 4,
            background: { r: 30, g: 120, b: 200, alpha: 0.5 },
          },
        })
          .png()
          .toBuffer()
      : await image(640);
    detail = await work.upload(context, source.lineId, "second-original.png", second);
    detail = await work.save(context, source.lineId, {
      expectedRevision: detail.line.revision,
      expectedSourceVersionId: detail.report?.versionId ?? null,
      draft: {
        ...detail.draft,
        images: [
          ...detail.draft.images,
          { origin: "upload", key: detail.assets[0]!.id, usage: "背面" },
        ],
      },
      status: "ready_to_push",
      reason: "Synthetic reviewed photos",
      idempotencyKey: randomUUID(),
    });
    expect(detail.draft.designExecutor).toBe("agent");
    const action = {
      action: "push",
      expectedRevision: detail.line.revision,
      expectedProjectionVersion: detail.line.projectionVersion,
      reason: "Synthetic default Agent",
      idempotencyKey: randomUUID(),
    };
    detail = await work.action(context, source.lineId, action);
    const project = await editor.get(context, detail.line.editorProjectId!);
    const job = project.renders.find((job) => job.purpose === "order_image_enhancement")!;
    return { source, detail, project, job, action };
  }

  it.each(["Yes", "No", ""])(
    "enhances every buyer image with customer option %j and preserves source evidence",
    async (choice) => {
      const { source, detail, project, job, action } = await enhancementOrder(choice);
      expect(detail.line.artwork).toBe("in_progress");
      expect(job.status).toBe("queued");
      await work.action(context, source.lineId, action);
      expect(
        (await editor.get(context, project.project.id)).renders.filter(
          (row) => row.purpose === "order_image_enhancement",
        ),
      ).toHaveLength(1);
      const originals = project.images.filter(
        (asset) => asset.name.includes("正面") || asset.name.includes("背面"),
      );
      expect(originals).toHaveLength(2);
      const checksums = originals.map((asset) => asset.checksumSha256);
      const preflight = await editor.preflight(context, project.project.id, {
        expectedVersionId: project.version.id,
        purpose: "production",
        format: "png",
        background: "white",
      });
      expect(preflight.issues).toContainEqual(
        expect.objectContaining({ code: "order_image_enhancement_pending", severity: "error" }),
      );
      await expect(
        editor.save(context, project.project.id, {
          expectedVersionId: project.version.id,
          document: project.version.document,
        }),
      ).rejects.toThrow("正在保真美化");
      await expect(
        editor.enhanceOrderImages(other, project.project.id, project.version.id, createEntityId()),
      ).rejects.toBeInstanceOf(NotFoundException);
      const before = generate.mock.calls.length;
      await worker.process(envelope(job.id));
      await worker.process(envelope(job.id));
      expect(generate.mock.calls.length - before).toBe(2);
      for (const [request] of generate.mock.calls.slice(before)) {
        expect(request.input.prompt).toContain("所有订单");
        expect(request.input.prompt).toContain("不瘦脸、换脸");
        expect(request.input.background).toBe("auto");
      }
      const completed = await editor.get(context, project.project.id);
      expect(completed.version.versionNumber).toBe(project.version.versionNumber + 1);
      expect(completed.version.reviewed).toBe(false);
      expect(completed.version.document.confirmations.visualReview).toBe(false);
      expect(completed.images.filter((asset) => asset.name.startsWith("保真美化 · "))).toHaveLength(
        2,
      );
      expect(
        originals.map(
          (asset) => completed.images.find((row) => row.id === asset.id)!.checksumSha256,
        ),
      ).toEqual(checksums);
      for (const original of originals)
        expect(
          createHash("sha256")
            .update((await editor.image(context, project.project.id, original.id, "original")).body)
            .digest("hex"),
        ).toBe(original.checksumSha256);
      expect((await work.detail(context, source.lineId)).draft.fields[0]!.value).toBe(choice);
      const privateRows = await withTenant(database.db, context, (tx) =>
        tx
          .select()
          .from(productionEditorImages)
          .where(eq(productionEditorImages.projectId, project.project.id)),
      );
      expect(
        privateRows.every((row) => row.originalObjectKey.includes(`/${context.tenantId}/order/`)),
      ).toBe(true);
      expect(JSON.stringify(privateRows)).not.toContain("second-original");
      // A later placement of an unprocessed original is blocked, and a fresh batch replaces it.
      const placed = await editor.save(context, project.project.id, {
        expectedVersionId: completed.version.id,
        document: {
          ...completed.version.document,
          layers: [{ ...completed.version.document.layers[0]!, assetId: originals[0]!.id }],
          confirmations: doc().confirmations,
        },
      });
      const check = await editor.preflight(context, project.project.id, {
        expectedVersionId: placed.version.id,
        purpose: "production",
        format: "png",
        background: "white",
      });
      expect(check.issues).toContainEqual(
        expect.objectContaining({ code: "order_image_enhancement_required" }),
      );
      const retry = await editor.enhanceOrderImages(
        context,
        project.project.id,
        placed.version.id,
        createEntityId(),
      );
      await worker.process(envelope(retry.id));
      const updated = await editor.get(context, project.project.id);
      expect(updated.version.document.layers[0]).toMatchObject({
        kind: "image",
        widthMm: 40,
        heightMm: 40,
      });
      expect(
        updated.version.document.layers[0]!.kind === "image" &&
          updated.version.document.layers[0]!.assetId,
      ).not.toBe(originals[0]!.id);
      expect((await work.detail(context, source.lineId)).line.artwork).toBe("in_progress");
    },
  );

  it("fails the whole enhancement batch without publishing partial assets and does not rebill a retry", async () => {
    const { project, job } = await enhancementOrder("No");
    generate.mockImplementationOnce(async () => ({
      bytes: await image(768),
      mediaType: "image/png",
    }));
    generate.mockImplementationOnce(async () => {
      throw new Error("Synthetic provider failure");
    });
    await expect(worker.process(envelope(job.id))).rejects.toThrow(
      "production_image_provider_failed",
    );
    const failed = await editor.get(context, project.project.id);
    expect(failed.version.id).toBe(project.version.id);
    expect(failed.images.map((asset) => asset.id)).toEqual(project.images.map((asset) => asset.id));
    const count = generate.mock.calls.length;
    await expect(worker.process(envelope(job.id))).rejects.toThrow(
      "production_image_submission_interrupted",
    );
    expect(generate.mock.calls.length).toBe(count);
    expect((await editor.getRender(context, project.project.id, job.id)).status).toBe("failed");
    const retry = await editor.enhanceOrderImages(
      context,
      project.project.id,
      project.version.id,
      createEntityId(),
    );
    await worker.process(envelope(retry.id));
    expect((await editor.getRender(context, project.project.id, retry.id)).status).toBe(
      "completed",
    );
  });

  it("does not apply a generated image after the order has been paused", async () => {
    const { detail, project, job } = await enhancementOrder("");
    generate.mockImplementationOnce(async () => {
      await act(detail, "hold");
      return { bytes: await image(768), mediaType: "image/png" };
    });
    await expect(worker.process(envelope(job.id))).rejects.toThrow("production_work_changed");
    expect((await editor.get(context, project.project.id)).version.id).toBe(project.version.id);
    expect(
      (
        await withTenant(database.db, context, (tx) =>
          tx.select().from(productionEditorRenders).where(eq(productionEditorRenders.id, job.id)),
        )
      )[0]!.status,
    ).toBe("failed");
  });

  it("rejects enhancement that loses an original transparent background", async () => {
    const { project, job } = await enhancementOrder("No", true);
    await expect(worker.process(envelope(job.id))).rejects.toThrow(
      "production_enhancement_alpha_lost",
    );
    const retained = await editor.get(context, project.project.id);
    expect(retained.version.id).toBe(project.version.id);
    expect(retained.images.some((asset) => asset.name.startsWith("保真美化 · "))).toBe(false);
  });

  it("counts exclusive queues across pages, searches pasted IDs, and respects tenant/date boundaries", async () => {
    const sources = [await imported(), await imported(), await imported()];
    const reviewed = await save(await work.detail(context, sources[1]!.lineId));
    await act(reviewed, "push");
    const query = {
      orderNumbers: sources.map((s) => s.externalOrderId).join("，\n"),
      grouping: "orders",
      pageSize: 1,
    };
    const page = await work.list(context, query);
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(3);
    expect(page.counts).toMatchObject({
      total: 3,
      orders: 3,
      quantity: 6,
      stages: { pending_review: 2, queued: 1 },
    });
    const queued = await work.list(context, { ...query, stage: "queued" });
    expect(queued.total).toBe(queued.counts.stages.queued);
    expect(queued.counts).toEqual(page.counts);
    expect((await work.list(other, query)).counts.total).toBe(0);
    expect((await work.list(context, { ...query, designExecutor: "human" })).total).toBe(1);
    expect(
      (await work.list(context, { ...query, dateField: "due", from: "2026-01-01" })).total,
    ).toBe(0);
    const date = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
    expect(
      (
        await work.list(context, {
          ...query,
          dateField: "imported",
          from: date,
          to: date,
          timeZone: "Asia/Shanghai",
        })
      ).total,
    ).toBe(3);
    await expect(
      work.list(context, { ...query, from: "2026-09-15", to: "2026-09-14" }),
    ).rejects.toThrow();
    expect((await work.list(context, { ...query, labelStatus: "missing" })).total).toBe(0);
  });

  it("archives reversibly across queues without deleting immutable order evidence", async () => {
    const source = await imported();
    const detail = await save(await work.detail(context, source.lineId));
    const request = {
      archived: true,
      expectedProjectionVersion: detail.line.projectionVersion,
      reason: "Synthetic fixture teardown",
      idempotencyKey: randomUUID(),
    };
    await expect(work.archive(other, source.lineId, request)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const archived = await work.archive(context, source.lineId, request);
    await work.archive(context, source.lineId, request);
    expect(archived.line.archivedAt).toBeTruthy();
    expect(archived.line.held).toBe(true);
    expect((await work.list(context, { q: source.externalOrderId })).total).toBe(0);
    expect((await work.list(context, { q: source.externalOrderId, archived: "only" })).total).toBe(
      1,
    );
    expect(archived.versions).toEqual(detail.versions);
    await expect(act(archived, "resume")).rejects.toBeInstanceOf(ConflictException);
    const restored = await work.archive(context, source.lineId, {
      ...request,
      archived: false,
      expectedProjectionVersion: archived.line.projectionVersion,
      idempotencyKey: randomUUID(),
    });
    expect(restored.line.archivedAt).toBeNull();
    expect(restored.line.held).toBe(true);
    expect((await work.list(context, { q: source.externalOrderId })).total).toBe(1);
  });

  it("counts labels on current non-cancelled packages, including partial labels", async () => {
    const source = await imported(),
      detail = await work.detail(context, source.lineId);
    const shipmentId = createEntityId(),
      oldVersion = createEntityId(),
      currentVersion = createEntityId();
    // Isolated storage fixture for the read projection; no carrier or marketplace call.
    await withTenant(database.db, context, async (tx) => {
      await tx.execute(
        sql`insert into shipments(id,tenant_id,order_id,status,current_version_number,idempotency_key) values(${shipmentId},${tenantId},${detail.line.orderId},'draft',2,${randomUUID()})`,
      );
      for (const [versionId, number] of [
        [oldVersion, 1],
        [currentVersion, 2],
      ] as const) {
        await tx.execute(
          sql`insert into shipment_versions(id,tenant_id,shipment_id,version_number,ship_date,ship_from_country_code,idempotency_key) values(${versionId},${tenantId},${shipmentId},${number},now(),'CN',${randomUUID()})`,
        );
        for (let i = 0; i < (number === 1 ? 1 : 2); i++) {
          const packageId = createEntityId();
          await tx.execute(
            sql`insert into shipment_packages(id,tenant_id,shipment_id,shipment_version_id,package_reference_id,tracking_number,carrier_code,carrier_name,carrier_service,external_label_id) values(${packageId},${tenantId},${shipmentId},${versionId},${`PACKAGE-${number}-${i}`},${`TRACK-${number}-${i}`},'MANUAL','Synthetic','Synthetic',${number === 2 && i === 0 ? "SYNTHETIC-LABEL" : null})`,
          );
          await tx.execute(
            sql`insert into shipment_package_lines(id,tenant_id,shipment_id,shipment_version_id,package_id,order_line_id,quantity) values(${createEntityId()},${tenantId},${shipmentId},${versionId},${packageId},${source.lineId},1)`,
          );
        }
      }
    });
    const query = { q: source.externalOrderId, labelStatus: "missing" };
    const missing = await work.list(context, query);
    expect(missing.items[0]).toMatchObject({
      labelStatus: "partial",
      packageCount: 2,
      labeledPackageCount: 1,
    });
    expect(missing.counts.missingLabels).toBe(1);
    expect((await work.list(context, { ...query, labelStatus: "ready" })).total).toBe(0);
    await withTenant(database.db, context, (tx) =>
      tx.execute(sql`update shipments set status='cancelled' where id=${shipmentId}`),
    );
    expect((await work.list(context, query)).total).toBe(0);
  });

  it("erases work keys and all derived private projects at the order deadline", async () => {
    const source = await imported();
    let detail = await act(await save(await work.detail(context, source.lineId)), "push");
    detail = await act(detail, "start_artwork");
    await withTenant(database.db, context, (tx) =>
      tx
        .update(orderWorkItems)
        .set({ expiresAt: new Date(0) })
        .where(eq(orderWorkItems.id, source.lineId)),
    );
    await reports.cleanupExpired(context);
    const [record] = await withTenant(database.db, context, (tx) =>
      tx
        .select()
        .from(productionEditorProjects)
        .where(eq(productionEditorProjects.id, detail.line.editorProjectId!)),
    );
    expect(record).toMatchObject({ status: "expired", encryptedDataKey: null });
    await expect(work.detail(context, source.lineId)).rejects.toBeInstanceOf(NotFoundException);
  });
});
