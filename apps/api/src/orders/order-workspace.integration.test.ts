import { syntheticQualityInspection, syntheticWholeQualityInspection } from "../../../../tools/testing/quality-fixtures.js";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ConflictException, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { ForbiddenError, Permission } from "@yummyai/authz";
import { SecretVault } from "@yummyai/ai-core";
import { syntheticShipmentAllocations } from "../../../../tools/testing/shipment-fixtures.js";
import { syntheticPassedProduction } from "./shipment-production-fixture.js";
import { syntheticManufacturingProduct } from "./manufacturing-production.test-fixture.js";
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
  OrderWorkActionInputSchema,
  ORDER_WORK_IMAGE_PENDING_USAGE,
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
  orderWorkAssets,
  orderWorkEvents,
  orders,
  orderDesignAgentRuns,
  amazonOrderReportVersions,
  productionOrderVersions,
  orderLineCatalogLinks,
  spus,
  productionEditorProjects,
  productionEditorImages,
  productionEditorRenders,
  modelProviderConfigs,
  modelRoutes,
  roles,
  memberships,
  membershipRoles,
  loadCurrentMembershipContext,
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
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { StudioGateway } from "../../../worker/src/processors/studio-generation.gateway.js";
import { ProductionEditorRenderProcessor } from "../../../worker/src/processors/production-editor.processor.js";
import { dispatchApprovedProductionRenders } from "../../../worker/src/processors/production-render-dispatcher.js";
import { AuditService } from "../audit/audit.service.js";
import { ProductionEditorService, type ProductionEditorScanner } from "../design/production-editor.service.js";
import { AmazonOrderReportService } from "./amazon-order-report.service.js";
import { OrderService } from "./order.service.js";
import { OrderWorkspaceService } from "./order-workspace.service.js";
import { OrderProductionService } from "./order-production.service.js";
import { ProductionCommandService } from "./production-command.service.js";
import { OrderShipmentService } from "./order-shipment.service.js";
import { OrderAfterSalesService } from "./order-after-sales.service.js";
import { OrderWholeDetailService } from "./order-whole-detail.service.js";
import { ShiposService } from "../suppliers/shipos.service.js";
import { ShiposReadGateway } from "../suppliers/shipos-read.gateway.js";
import { FactoryDirectoryService } from "../suppliers/factory-directory.service.js";
import { createSyntheticFactory } from "../suppliers/factory-directory.test-fixture.js";
import { createSyntheticFactoryCapacity } from "../suppliers/factory-capacity.test-fixture.js";
import { syntheticSupplierProfile } from "../../../../tools/testing/factory-fixtures.js";
import { FinanceService } from "../finance/finance.service.js";
import { OrderProductionDeliveryService } from "./order-production-delivery.service.js";
import { OrderReviewService } from "./order-review.service.js";
import { OrderDesignRepository } from "@yummyai/order-design";
import { sealWork } from "@yummyai/order-core";

describe("order centers explicit handoff and independent fulfillment", () => {
  const database = connectDatabase(),
    tenantId = createEntityId(),
    otherTenant = createEntityId(),
    userId = createEntityId(),
    accountId = createEntityId(),
    supplierId = createEntityId();
  const authorityMember = createEntityId(),
    authorityRole = createEntityId(),
    scopedRole = createEntityId();
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
      "product:read",
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
    discardOrderWorkUpload: async (ctx: TenantContext, imageId: string, key: string,
      options: { assertCurrent: () => Promise<void> }) => {
      assertAssetAccess(ctx, { id: imageId, tenantId: ctx.tenantId, assetDomain: "order", objectKey: key }, "order");
      expect(key.split("/")[4]).toMatch(new RegExp(`^${imageId}(?:-preview)?\\.pe$`));
      await options.assertCurrent();
      objects.delete(key);
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
    { schedule: async () => undefined },
  );
  const enqueue = vi.fn<
    (input: {
      renderId: string;
      tenantId: string;
      requestedBy: string;
      maxAttempts?: number;
    }) => Promise<void>
  >(async () => undefined);
  const editor = new ProductionEditorService(
    database,
    vault,
    storage,
    reports,
    audit,
    { enqueue },
    { scan: clean },
  );
  const uploadScanner: ProductionEditorScanner = { scan: clean };
  const work = new OrderWorkspaceService(database, vault, storage, reports, editor, uploadScanner);
  const factories = new FactoryDirectoryService(database, audit);
  const production = new OrderProductionService(
    database,
    vault,
    orderService,
    audit,
    editor,
    factories,
  );
  let factoryFixture: Awaited<ReturnType<typeof createSyntheticFactory>>;
  let capacityFixture: Awaited<ReturnType<typeof createSyntheticFactoryCapacity>>;
  const shiposGateway = new ShiposReadGateway(),
    shipos = new ShiposService(
      database,
      new SecretVault(Buffer.alloc(32, 31)),
      shiposGateway,
      audit,
    );
  const shipments = new OrderShipmentService(
    database,
    vault,
    orderService,
    audit,
    {
      enqueue: async () => {
        throw new Error("No marketplace writes in test");
      },
    },
    shipos,
  );
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
  async function attachment(
    externalOrderId: string,
    externalLineId: string,
    size: number,
    text?: string,
  ) {
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
            ...(text
              ? [{ type: "TextCustomization", label: "Synthetic engraving", inputValue: text }]
              : []),
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
  async function imported(text?: string) {
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
      await attachment(externalOrderId, externalLineId, 512, text),
    );
    return { report, parsed, externalOrderId, externalLineId, lineId: report.orderLineId };
  }
  const manufacturingForLine = new Map<string, Awaited<ReturnType<typeof syntheticManufacturingProduct>>>();
  async function matchingBasis(lineId: string, automaticInputs = false) {
    let basis = manufacturingForLine.get(lineId);
    if (!basis) {
      basis = await syntheticManufacturingProduct(database, context, { profileVersionId, document: doc(), automaticInputs });
      manufacturingForLine.set(lineId, basis);
    }
    return { artworkVersionId: basis.artworkVersionId, specificationVersionId: basis.specificationVersionId, salesRecipeVersionId: basis.salesRecipeVersionId };
  }
  async function save(detail: OrderWorkDetail, customerApprovalRequired = false, manufacturing = true) {
    const basis = manufacturing ? await matchingBasis(detail.line.id) : null;
    return work.save(context, detail.line.id, {
      expectedRevision: detail.line.revision,
      expectedProjectionVersion: detail.line.projectionVersion,
      expectedSourceVersionId: detail.report?.versionId ?? null,
      draft: {
        ...detail.draft,
        ...basis,
        customerApprovalRequired,
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
      await tx
        .insert(memberships)
        .values({ id: authorityMember, tenantId, userId, status: "active" });
      await tx.insert(roles).values([
        {
          id: authorityRole,
          tenantId,
          name: "Synthetic current order authority",
          permissions: context.permissions,
          dataScope: "tenant",
        },
        {
          id: scopedRole,
          tenantId,
          name: "Synthetic limited order authority",
          permissions: [],
          dataScope: "self",
        },
      ]);
      await tx.insert(membershipRoles).values([
        { tenantId, membershipId: authorityMember, roleId: authorityRole },
        { tenantId, membershipId: authorityMember, roleId: scopedRole },
      ]);
    });
    // Cross-tenant empty reads use a genuine member of that tenant, rather than
    // a caller-selected tenant with no authenticated membership.
    await withTenant(database.db, other, async (tx) => {
      const memberId = createEntityId(), roleId = createEntityId();
      await tx.insert(memberships).values({ id: memberId, tenantId: otherTenant, userId, status: "active" });
      await tx.insert(roles).values({ id: roleId, tenantId: otherTenant, name: "Synthetic other-tenant order authority",
        permissions: context.permissions, dataScope: "tenant" });
      await tx.insert(membershipRoles).values({ tenantId: otherTenant, membershipId: memberId, roleId });
    });
    await withTenant(database.db, context, async (tx) => {
      const providerId = createEntityId();
      await tx.insert(modelProviderConfigs).values({
        id: providerId,
        tenantId,
        provider: "openai-compatible",
        label: "Synthetic image provider",
        endpoint: "https://example.test/v1",
        encryptedApiKey: vault.encrypt("synthetic-image-key"),
        createdBy: userId,
      });
      await tx.insert(modelRoutes).values({
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
        profile: syntheticSupplierProfile,
        kind: "manual",
        status: "active",
        regionCode: "CN",
        settlementCurrency: "USD",
        createdBy: userId,
      });
    });
    factoryFixture = await createSyntheticFactory(factories, context, supplierId, "tire_cover");
    capacityFixture = await createSyntheticFactoryCapacity(database, context, { factory: factoryFixture.factory,
      bindings: [{ capabilityVersionId: factoryFixture.capability.versionId, unitsPerItem: 1 }], capacityUnits: 10_000 });
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
  afterEach(() => {
    enqueue.mockReset();
    enqueue.mockResolvedValue(undefined);
  });

  async function orderGrant(
    permission?: string,
    scope: "self" | "team" | "tenant" = "self",
    revoke = false,
  ) {
    await withTenant(database.db, context, async (tx) => {
      await tx
        .update(roles)
        .set({
          permissions: context.permissions.filter((p) => p !== permission),
          dataScope: "tenant",
        })
        .where(eq(roles.id, authorityRole));
      await tx
        .update(roles)
        .set({ permissions: permission && !revoke ? [permission] : [], dataScope: scope })
        .where(eq(roles.id, scopedRole));
    });
  }
  const currentOrderContext = () =>
    withTenant(database.db, context, (tx) => loadCurrentMembershipContext(tx, context));
  async function grantFinanceForCase(permissions: string[]) {
    const [original] = await withTenant(database.db, context, tx => tx.select({ permissions: roles.permissions }).from(roles).where(eq(roles.id, authorityRole)));
    if (!original) throw new Error("Synthetic order authority role missing");
    await withTenant(database.db, context, tx => tx.update(roles).set({ permissions: [...new Set([...original.permissions, ...permissions])] }).where(eq(roles.id, authorityRole)));
    return () => withTenant(database.db, context, tx => tx.update(roles).set({ permissions: original.permissions }).where(eq(roles.id, authorityRole)));
  }

  it.each(["self", "team"] as const)(
    "current order authority does not widen %s order reads from another grant",
    async (scope) => {
      await imported();
      try {
        await orderGrant(Permission.OrderRead, scope);
        const actor = await currentOrderContext();
        await expect(work.list(actor, {})).rejects.toBeInstanceOf(ForbiddenError);
        await expect(work.selection(actor, {})).rejects.toBeInstanceOf(ForbiddenError);
        await expect(work.analysisSummary(actor, [])).rejects.toBeInstanceOf(ForbiddenError);
      } finally {
        await orderGrant();
      }
    },
  );
  it.each(["self", "team"] as const)(
    "current order authority does not widen %s private order reads",
    async (scope) => {
      const source = await imported();
      try {
        await orderGrant(Permission.OrderPiiRead, scope);
        const actor = await currentOrderContext();
        await expect(work.detail(actor, source.lineId)).rejects.toBeInstanceOf(ForbiddenError);
        await expect(work.orderItems(actor, source.lineId)).rejects.toBeInstanceOf(ForbiddenError);
        await expect(work.reviewSources(actor, {})).rejects.toBeInstanceOf(ForbiddenError);
      } finally {
        await orderGrant();
      }
    },
  );
  it.each(["self", "team"] as const)(
    "current order authority does not widen %s writes or mutate before rejection",
    async (scope) => {
      const source = await imported(),
        before = await save(await work.detail(context, source.lineId));
      try {
        await orderGrant(Permission.OrderWrite, scope);
        await expect(
          work.archive(await currentOrderContext(), source.lineId, {
            archived: true,
            expectedProjectionVersion: before.line.projectionVersion,
            reason: "Synthetic forbidden archival",
            idempotencyKey: randomUUID(),
          }),
        ).rejects.toBeInstanceOf(ForbiddenError);
        const [stored] = await withTenant(database.db, context, (tx) =>
          tx.select().from(orderWorkItems).where(eq(orderWorkItems.id, source.lineId)),
        );
        expect(stored?.archivedAt).toBeNull();
        expect(stored?.projectionVersion).toBe(before.line.projectionVersion);
      } finally {
        await orderGrant();
      }
    },
  );
  it("current order authority rechecks membership instead of trusting an earlier request context", async () => {
    const source = await imported(),
      actor = await currentOrderContext();
    try {
      await orderGrant(Permission.OrderRead, "tenant", true);
      await expect(work.detail(actor, source.lineId)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(work.list(actor, {})).rejects.toBeInstanceOf(ForbiddenError);
    } finally {
      await orderGrant();
    }
  });

  it("current order authority stops an upload between private storage writes after write revocation", async () => {
    const source = await imported();
    await save(await work.detail(context, source.lineId));
    const actor = await currentOrderContext(),
      original = storage.putPrivate.bind(storage);
    const put = vi.spyOn(storage, "putPrivate").mockImplementationOnce(async (ctx, input) => {
      const result = await original(ctx, input);
      await orderGrant(Permission.OrderWrite, "self");
      return result;
    });
    try {
      await expect(
        work.upload(actor, source.lineId, "Synthetic forbidden upload.png", await image(32)),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(put).toHaveBeenCalledTimes(1);
      expect(
        await withTenant(database.db, context, (tx) =>
          tx.select().from(orderWorkAssets).where(eq(orderWorkAssets.workItemId, source.lineId)),
        ),
      ).toEqual([]);
    } finally {
      put.mockRestore();
      await orderGrant();
    }
  });
  it("selects real buyer originals in the first unsaved detail and summary without saving a draft", async () => {
    const source = await imported(), detail = await work.detail(context, source.lineId);
    const originals = detail.report!.files.filter(file => file.role === "buyer_image" && file.originalFileKey && file.mediaType.startsWith("image/"));
    expect(originals).toHaveLength(1);
    expect(detail.line.revision).toBe(0);
    expect(detail.draft.images).toEqual(originals.map(file => ({ origin: "report", key: file.key, usage: "待选择定制字段" })));
    const summary = OrderWorkSummariesSchema.parse(await work.summaries(context, { ids: [source.lineId] })).items[0]!;
    expect(summary.images.filter(image => image.kind === "buyer")).toEqual([expect.objectContaining({ selected: true })]);
    expect(summary.images.filter(image => image.kind === "preview").every(image => !image.selected)).toBe(true);
    expect(summary.sourceVersionId).toBe(detail.report!.versionId);
    expect(await withTenant(database.db, context, tx => tx.select().from(orderWorkItems).where(eq(orderWorkItems.id, source.lineId)))).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("uploads before the first save, binds the private original, and preserves a saved empty selection", async () => {
    const source = await imported(), initial = await work.detail(context, source.lineId), body = await image(37);
    const uploaded = OrderWorkDetailViewSchema.parse(await work.upload(context, source.lineId, "fresh-original.png", body));
    expect(uploaded.line).toMatchObject({ revision: 0, preparation: "pending_review", artwork: "not_pushed", editorProjectId: null });
    expect(uploaded).toMatchObject({ sourceVersionId: null, sourceReport: null, versions: [], events: [] });
    expect(uploaded.draft).toEqual(initial.draft);
    expect(uploaded.assets).toHaveLength(1);
    expect((await work.image(context, source.lineId, uploaded.assets[0]!.id, true)).body).toEqual(body);
    const [container] = await withTenant(database.db, context, tx => tx.select().from(orderWorkItems).where(eq(orderWorkItems.id, source.lineId)));
    expect(container).toMatchObject({ revision: 0, sourceVersionId: null, pushedRevisionId: null, approvedEditorVersionId: null });
    expect(await withTenant(database.db, context, tx => tx.select().from(orderWorkRevisions).where(eq(orderWorkRevisions.workItemId, source.lineId)))).toEqual([]);
    const initialSummary = OrderWorkSummariesSchema.parse(await work.summaries(context, { ids: [source.lineId] })).items[0]!;
    expect(initialSummary.sourceVersionId).toBe(initial.report!.versionId);
    expect(initialSummary.images.some(image => image.kind === "buyer" && image.selected)).toBe(true);
    const basis = await matchingBasis(source.lineId, true);
    const saved = await work.save(context, source.lineId, { expectedRevision: 0, expectedProjectionVersion: uploaded.line.projectionVersion,
      expectedSourceVersionId: uploaded.report!.versionId, draft: { ...uploaded.draft, ...basis, printProfileVersionId: profileVersionId,
        designExecutor: "human", images: [{ origin: "upload", key: uploaded.assets[0]!.id, usage: "front_photo" }] },
      status: "needs_information", reason: "Synthetic explicit image-field binding", idempotencyKey: randomUUID() });
    expect(saved.draft.images).toEqual([{ origin: "upload", key: uploaded.assets[0]!.id, usage: "front_photo" }]);
    const empty = await work.save(context, source.lineId, { expectedRevision: saved.line.revision,
      expectedProjectionVersion: saved.line.projectionVersion, expectedSourceVersionId: saved.report!.versionId,
      draft: { ...saved.draft, images: [] }, status: "needs_information", reason: "Synthetic explicit deselection", idempotencyKey: randomUUID() });
    expect(empty.draft.images).toEqual([]);
    expect((await work.detail(context, source.lineId)).draft.images).toEqual([]);
    expect((await work.summaries(context, { ids: [source.lineId] })).items[0]!.images.filter(image => image.kind === "buyer").every(image => !image.selected)).toBe(true);
    expect((await work.image(context, source.lineId, uploaded.assets[0]!.id, true)).body).toEqual(body);
    expect(enqueue).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("rejects unsaved cross-tenant, missing-PII and inactive-order uploads before scanning or storage", async () => {
    const source = await imported(), body = await image(31);
    const put = vi.spyOn(storage, "putPrivate"), scan = vi.spyOn(uploadScanner, "scan");
    try {
      await expect(work.upload(other, source.lineId, "forbidden.png", body)).rejects.toBeInstanceOf(NotFoundException);
      await expect(work.upload({ ...context, permissions: context.permissions.filter(permission => permission !== Permission.OrderPiiRead) }, source.lineId, "forbidden.png", body)).rejects.toBeInstanceOf(ForbiddenError);
      await withTenant(database.db, context, tx => tx.update(orders).set({ sideState: "cancelled" }).where(eq(orders.id, source.report.orderId)));
      await expect(work.upload(context, source.lineId, "cancelled.png", body)).rejects.toBeInstanceOf(ConflictException);
      expect(put).not.toHaveBeenCalled(); expect(scan).not.toHaveBeenCalled();
      expect(await withTenant(database.db, context, tx => tx.select().from(orderWorkItems).where(eq(orderWorkItems.id, source.lineId)))).toEqual([]);
    } finally { put.mockRestore(); scan.mockRestore(); }
  });

  it.each(["held", "pushed", "archived", "expired"] as const)("rejects %s upload containers without replacing the original private asset", async state => {
    const source = await imported(), original = await image(33), uploaded = await work.upload(context, source.lineId, "retained.png", original);
    const [asset] = await withTenant(database.db, context, tx => tx.select().from(orderWorkAssets).where(eq(orderWorkAssets.workItemId, source.lineId)));
    const retained = Uint8Array.from(objects.get(asset!.objectKey)!);
    await withTenant(database.db, context, tx => tx.update(orderWorkItems).set(state === "held" ? { held: true }
      : state === "pushed" ? { preparation: "pushed" } : state === "archived" ? { archivedAt: new Date() } : { expiresAt: new Date(0) })
      .where(eq(orderWorkItems.id, source.lineId)));
    const put = vi.spyOn(storage, "putPrivate"), scan = vi.spyOn(uploadScanner, "scan");
    try {
      await expect(work.upload(context, source.lineId, "blocked.png", await image(34))).rejects.toBeInstanceOf(state === "expired" ? NotFoundException : ConflictException);
      expect(put).not.toHaveBeenCalled(); expect(scan).not.toHaveBeenCalled();
      expect(objects.get(asset!.objectKey)).toEqual(retained);
      expect(uploaded.line.revision).toBe(0);
    } finally { put.mockRestore(); scan.mockRestore(); }
  });

  it("leaves no container on scanner rejection and cleans only a failed upload's exact private objects", async () => {
    const source = await imported(), scan = vi.spyOn(uploadScanner, "scan").mockResolvedValueOnce({
      result: "infected", engine: "synthetic", signatureVersion: "fixture-v1", scannedAt: new Date().toISOString(),
    });
    try {
      await expect(work.upload(context, source.lineId, "unsafe.png", await image(35))).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(await withTenant(database.db, context, tx => tx.select().from(orderWorkItems).where(eq(orderWorkItems.id, source.lineId)))).toEqual([]);
    } finally { scan.mockRestore(); }
    const baseline = new Set(objects.keys()), originalPut = storage.putPrivate.bind(storage), failure = new Error("Synthetic storage ACK lost");
    const put = vi.spyOn(storage, "putPrivate").mockImplementationOnce(originalPut).mockImplementationOnce(async (actor, input) => {
      await originalPut(actor, input); throw failure;
    });
    try {
      await expect(work.upload(context, source.lineId, "not-registered.png", await image(36))).rejects.toBe(failure);
      expect(new Set(objects.keys())).toEqual(baseline);
      expect(await withTenant(database.db, context, tx => tx.select().from(orderWorkAssets).where(eq(orderWorkAssets.workItemId, source.lineId)))).toEqual([]);
      expect(await withTenant(database.db, context, tx => tx.select().from(orderWorkRevisions).where(eq(orderWorkRevisions.workItemId, source.lineId)))).toEqual([]);
      expect(await withTenant(database.db, context, tx => tx.select().from(orderWorkEvents).where(eq(orderWorkEvents.workItemId, source.lineId)))).toEqual([]);
    } finally { put.mockRestore(); }
  });
  it.each([Permission.OrderRead, Permission.OrderPiiRead])(
    "current order authority rechecks %s after private file I/O",
    async (permission) => {
      const source = await imported();
      await save(await work.detail(context, source.lineId));
      await work.upload(context, source.lineId, "Synthetic private image.png", await image(32));
      const [asset] = await withTenant(database.db, context, (tx) =>
        tx.select().from(orderWorkAssets).where(eq(orderWorkAssets.workItemId, source.lineId)),
      );
      const actor = await currentOrderContext(),
        original = storage.readPrivate.bind(storage);
      const read = vi
        .spyOn(storage, "readPrivate")
        .mockImplementationOnce(async (ctx, file, options) => {
          const result = await original(ctx, file, options);
          await orderGrant(permission, "self");
          return result;
        });
      try {
        await expect(work.image(actor, source.lineId, asset!.id)).rejects.toBeInstanceOf(
          ForbiddenError,
        );
        expect(read).toHaveBeenCalledTimes(1);
      } finally {
        read.mockRestore();
        await orderGrant();
      }
    },
  );

  it("keeps intake previews tenant/PII scoped and rejects stale revisions without writing", async () => {
    const source = await imported();
    const detail = await work.detail(context, source.lineId);
    const body = {
      expectedRevision: detail.line.revision,
      expectedSourceVersionId: detail.report?.versionId ?? null,
      draft: detail.draft,
    };
    await expect(work.intakeCheck(other, source.lineId, body)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      work.intakeCheck(
        {
          ...context,
          permissions: context.permissions.filter((permission) => permission !== "order:pii:read"),
        },
        source.lineId,
        body,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      work.intakeCheck(context, source.lineId, { ...body, expectedRevision: 999 }),
    ).rejects.toBeInstanceOf(ConflictException);
    const preview = await work.intakeCheck(context, source.lineId, body);
    expect(preview.ready).toBe(false);
    expect((await work.detail(context, source.lineId)).versions).toEqual(detail.versions);
  });
  it("replays accepted saves and handoffs after later state changes without making another revision or task", async () => {
    const source = await imported();
    const detail = await work.detail(context, source.lineId);
    const saveBody = {
      expectedRevision: detail.line.revision,
      expectedSourceVersionId: detail.report?.versionId ?? null,
      draft: { ...detail.draft, ...await matchingBasis(source.lineId), printProfileVersionId: profileVersionId, designExecutor: "human" },
      status: "ready_to_push",
      reason: "Synthetic accepted request",
      idempotencyKey: randomUUID(),
    };
    const saved = await work.save(context, source.lineId, saveBody);
    const pushBody = {
      action: "push",
      expectedRevision: saved.line.revision,
      expectedProjectionVersion: saved.line.projectionVersion,
      reason: "Synthetic human queue only",
      idempotencyKey: randomUUID(),
    };
    const pushed = await work.action(context, source.lineId, pushBody);
    const resumed = await work.action(context, source.lineId, pushBody);
    expect(resumed.line.projectionVersion).toBe(pushed.line.projectionVersion);
    expect(resumed.events.filter((event) => event.action === "push")).toHaveLength(1);
    const replayed = await work.save(context, source.lineId, saveBody);
    expect(replayed.line.preparation).toBe("pushed");
    expect(replayed.versions).toHaveLength(1);
    await expect(
      work.save(context, source.lineId, { ...saveBody, reason: "Changed request" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("repairs the legacy production checksum column additively and idempotently", async () => {
    const migration = await readFile(
      new URL(
        "../../../../packages/database/migrations/0099_production_request_checksum_compat.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await database.client.begin(async (migrationTx) => {
      await migrationTx.unsafe("CREATE TEMP TABLE production_orders (id uuid) ON COMMIT DROP");
      await migrationTx.unsafe("SET LOCAL search_path TO pg_temp");
      await migrationTx.unsafe(migration);
      await migrationTx.unsafe(migration);
      await migrationTx.unsafe("INSERT INTO production_orders(id) VALUES($1)", [createEntityId()]);
      const [row] = await migrationTx.unsafe("SELECT request_checksum FROM production_orders");
      expect(row!.request_checksum).toBeNull();
    });
  });
  it("operations-role queues filter before grouped pagination, prioritize platform deadlines and enforce tenant access", async () => {
    const prefix = `SYNTHETIC-OPS-${createEntityId()}`;
    const states = [
      { preparation: "pending_review", artwork: "not_pushed", proof: "not_required", held: false },
      { preparation: "ready_to_push", artwork: "not_pushed", proof: "not_required", held: false },
      { preparation: "pushed", artwork: "in_review", proof: "not_required", held: false },
      { preparation: "pushed", artwork: "in_progress", proof: "not_required", held: false },
      { preparation: "pushed", artwork: "approved", proof: "not_required", held: false },
      { preparation: "pushed", artwork: "approved", proof: "pending", held: false },
      { preparation: "pushed", artwork: "queued", proof: "not_required", held: true },
      { preparation: "pushed", artwork: "changes_requested", proof: "not_required", held: false },
    ];
    const batch = await reports.importReport(context, {
      accountId,
      marketplaceId: "ATVPDKIKX0DER",
      fileName: "synthetic-operator-queue.txt",
      content:
        "order-id\torder-item-id\tpurchase-date\tsku\tproduct-name\tquantity-purchased\tcurrency\titem-price\n" +
        states
          .map(
            (_, index) =>
              `${prefix}-${index}\tLINE-${index}\t${new Date().toISOString()}\tSYNTHETIC-OPS\tSynthetic operator task\t1\tUSD\t20.00`,
          )
          .join("\n"),
    });
    const reportRows = (await reports.workspace(context, { batchId: batch.id })).lines;
    const ids: string[] = [];
    for (let index = 0; index < states.length; index++) {
      const source = reportRows.find((line) => line.externalOrderId === `${prefix}-${index}`)!;
      const detail = await work.detail(context, source.orderLineId);
      await work.save(context, detail.line.id, {
        expectedRevision: detail.line.revision,
        expectedProjectionVersion: detail.line.projectionVersion,
        expectedSourceVersionId: detail.report?.versionId ?? null,
        draft: { ...detail.draft, designExecutor: "human" },
        status: "pending_review",
        reason: "Synthetic read-projection setup",
        idempotencyKey: randomUUID(),
      });
      // These rows belong only to this disposable read-model test; no workflow is dispatched.
      await withTenant(database.db, context, (tx) =>
        tx
          .update(orderWorkItems)
          .set({
            ...states[index],
            platformShipByAt:
              index === 1 ? null : new Date(Date.now() + (index === 0 ? -2 : 3) * 86_400_000),
            platformDeadlineVerifiedAt: index === 1 ? null : new Date(),
          })
          .where(eq(orderWorkItems.id, detail.line.id)),
      );
      ids.push(detail.line.id);
    }
    const query = {
      module: "orders",
      q: prefix,
      grouping: "orders",
      workView: "todo",
      pageSize: 1,
    };
    const first = await work.list(context, query);
    expect(first).toMatchObject({
      total: 6,
      groupTotal: 6,
      counts: { operatorViews: { todo: 6, waiting: 2, exceptions: 4, all: 8 } },
    });
    expect(first.items.map((item) => item.id)).toEqual([ids[0]]);
    expect(first.items[0]).toMatchObject({
      operatorTaskKey: "review_order",
      operatorException: true,
    });
    const waiting = await work.list(context, { ...query, workView: "waiting", pageSize: 25 });
    expect(new Set(waiting.items.map((item) => item.id))).toEqual(new Set([ids[3], ids[7]]));
    expect(
      (await work.list(context, { ...query, workView: "todo", pageSize: 25 })).items.some(
        (item) => item.id === ids[4] && item.production === "not_released",
      ),
    ).toBe(true);
    expect(waiting.items.find((item) => item.id === ids[7])?.operatorTaskKey).toBe(
      "design_attention",
    );
    const exception = await work.list(context, { ...query, workView: "exceptions", pageSize: 25 });
    expect(new Set(exception.items.map((item) => item.id))).toEqual(
      new Set([ids[0], ids[1], ids[6], ids[7]]),
    );
    expect((await work.list(other, { ...query, workView: "all" })).total).toBe(0);
    await expect(work.list({ ...context, permissions: [] }, query)).rejects.toThrow();
  });

  it("projects one whole-order status before item filtering and grouped pagination, with tenant-scoped counts", async () => {
    const prefix = `SYNTHETIC-LIFECYCLE-${createEntityId()}`;
    const rows = [
      { order: "A", artwork: "approved", proof: "not_required" },
      { order: "A", artwork: "in_review", proof: "not_required" },
      { order: "A", artwork: "in_progress", proof: "not_required" },
      { order: "B", artwork: "in_review", proof: "not_required" },
      { order: "C", artwork: "approved", proof: "not_required" },
      { order: "D", artwork: "approved", proof: "pending" },
    ] as const;
    const placedAt = new Date().toISOString();
    const batch = await reports.importReport(context, {
      accountId,
      marketplaceId: "ATVPDKIKX0DER",
      fileName: "synthetic-lifecycle.txt",
      content:
        "order-id\torder-item-id\tpurchase-date\tsku\tproduct-name\tquantity-purchased\tcurrency\titem-price\n" +
        rows
          .map(
            (row, index) =>
              `${prefix}-${row.order}\tLINE-${index}\t${placedAt}\t${prefix}-SKU-${index}\tSynthetic whole order\t1\tUSD\t20.00`,
          )
          .join("\n"),
    });
    const sources = (await reports.workspace(context, { batchId: batch.id })).lines;
    const ids: string[] = [];
    for (let index = 0; index < rows.length; index++) {
      const source = sources.find((line) => line.externalLineId === `LINE-${index}`)!;
      const detail = await work.detail(context, source.orderLineId);
      await work.save(context, detail.line.id, {
        expectedRevision: detail.line.revision,
        expectedProjectionVersion: detail.line.projectionVersion,
        expectedSourceVersionId: detail.report?.versionId ?? null,
        draft: { ...detail.draft, designExecutor: "human" },
        status: "pending_review",
        reason: "Synthetic lifecycle read-projection setup",
        idempotencyKey: randomUUID(),
      });
      // Disposable read-model fixtures only; no design, production or shipping action is dispatched.
      await withTenant(database.db, context, (tx) =>
        tx
          .update(orderWorkItems)
          .set({
            preparation: "pushed",
            artwork: rows[index]!.artwork,
            proof: rows[index]!.proof,
          })
          .where(eq(orderWorkItems.id, detail.line.id)),
      );
      ids.push(detail.line.id);
    }
    const query = { module: "orders", q: prefix, grouping: "orders", pageSize: 1 };
    const counts = {
      processing: 1,
      awaiting_review: 2,
      reviewed: 1,
      produced: 0,
      shipped: 0,
      voided: 0,
    };
    const first = await work.list(context, { ...query, orderStatus: "processing" });
    expect(first).toMatchObject({ total: 3, groupTotal: 1, counts: { orderStatuses: counts } });
    expect(new Set(first.items.map((line) => line.id))).toEqual(new Set(ids.slice(0, 3)));
    for (const line of first.items)
      expect(line).toMatchObject({
        orderStatus: "processing",
        orderLineCount: 3,
        orderQuantity: 3,
      });
    expect(
      (await work.list(context, { ...query, orderStatus: "processing", page: 2 })).items,
    ).toEqual([]);
    const narrowed = await work.list(context, { ...query, sku: `${prefix}-SKU-0` });
    expect(narrowed.items).toHaveLength(1);
    expect(narrowed.items[0]).toMatchObject({
      id: ids[0],
      artwork: "approved",
      orderStatus: "processing",
      orderQuantity: 3,
    });
    expect(
      (await work.list(context, { ...query, sku: `${prefix}-SKU-0`, orderStatus: "reviewed" }))
        .total,
    ).toBe(0);
    const pending = await work.list(context, { ...query, orderStatus: "awaiting_review" });
    expect(pending).toMatchObject({ total: 2, groupTotal: 2, counts: { orderStatuses: counts } });
    expect(pending.items).toHaveLength(1);
    for (const module of ["orders", "artwork", "production"] as const) {
      const list = await work.list(context, { ...query, module, sku: `${prefix}-SKU-0` });
      expect(list.items[0]).toMatchObject({ orderStatus: "processing", orderQuantity: 3 });
    }
    await withTenant(database.db, context, (tx) =>
      tx.update(orderWorkItems).set({ artwork: "in_review" }).where(eq(orderWorkItems.id, ids[2]!)),
    );
    expect((await work.detail(context, ids[0]!)).line.orderStatus).toBe("awaiting_review");
    await withTenant(database.db, context, async (tx) => {
      for (const id of ids.slice(0, 3))
        await tx
          .update(orderWorkItems)
          .set({ artwork: "approved" })
          .where(eq(orderWorkItems.id, id));
      await tx
        .update(orderWorkItems)
        .set({ proof: "approved" })
        .where(eq(orderWorkItems.id, ids[5]!));
    });
    expect((await work.detail(context, ids[0]!)).line.orderStatus).toBe("reviewed");
    // An unbound historical proof is not a confirmation of the current artwork.
    expect((await work.detail(context, ids[5]!)).line.orderStatus).toBe("awaiting_review");
    const isolated = await work.list(other, { ...query, orderStatus: "reviewed" });
    expect(isolated).toMatchObject({
      total: 0,
      counts: {
        orderStatuses: {
          processing: 0,
          awaiting_review: 0,
          reviewed: 0,
          produced: 0,
          shipped: 0,
          voided: 0,
        },
      },
    });
    await expect(work.list({ ...context, permissions: [] }, query)).rejects.toThrow();
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
    const original = detail.report!.files.find(file => file.role === "buyer_image" && file.originalFileKey)!;
    expect(original).toBeDefined();
    expect(detail.draft.images).toEqual([{ origin: "report", key: original.key, usage: ORDER_WORK_IMAGE_PENDING_USAGE }]);
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

  it("pins review source metadata and private files while the latest report changes", async () => {
    const source = await imported("Synthetic original wording");
    const unsaved = await work.detail(context, source.lineId);
    expect(unsaved).toMatchObject({ sourceReport: null, sourceVersionId: null });
    const saved = await save(unsaved);
    await reports.process(
      context,
      source.report.id,
      source.parsed.versionId,
      await attachment(
        source.externalOrderId,
        source.externalLineId,
        256,
        "Synthetic revised wording",
      ),
    );
    const detail = OrderWorkDetailViewSchema.parse(await work.detail(context, source.lineId));
    expect(detail.sourceVersionId).toBe(source.parsed.versionId);
    expect(detail.sourceReport?.versionId).toBe(source.parsed.versionId);
    expect(detail.sourceReport?.line.versionNumber).toBe(1);
    expect(detail.report?.line.versionNumber).toBe(2);
    expect(detail.report?.versionId).not.toBe(detail.sourceVersionId);
    expect(
      detail.sourceReport?.surfaces
        .flatMap((surface) => surface.fields)
        .map((field) => field.value),
    ).toContain("Synthetic original wording");
    expect(
      detail.report?.surfaces.flatMap((surface) => surface.fields).map((field) => field.value),
    ).toContain("Synthetic revised wording");
    const original = detail.sourceReport!.files.find((file) => file.role === "buyer_image")!;
    const bytes = await work.sourceFile(
      context,
      source.lineId,
      original.originalFileKey!,
      saved.line.revision,
    );
    expect((await sharp(bytes.body).metadata()).width).toBe(512);
    const preview = detail.sourceReport!.files.find((file) => file.role === "preview")!;
    expect(
      await work.sourceFile(context, source.lineId, preview.key, saved.line.revision),
    ).toMatchObject({ inline: true, mediaType: "image/png" });
    await expect(
      work.sourceFile(context, source.lineId, original.key, saved.line.revision + 1),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      work.sourceFile(other, source.lineId, original.key, saved.line.revision),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(work.detail(other, source.lineId)).rejects.toBeInstanceOf(NotFoundException);
    const denied = {
      ...context,
      permissions: context.permissions.filter((permission) => permission !== "order:pii:read"),
    };
    await expect(work.detail(denied, source.lineId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      work.sourceFile(denied, source.lineId, original.key, saved.line.revision),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const unrelated = await imported();
    expect(
      await reports.detailFromVersion(context, unrelated.report.id, source.parsed.versionId!),
    ).toBeNull();
    await expect(
      reports.fileFromVersion(context, unrelated.report.id, source.parsed.versionId!, original.key),
    ).rejects.toBeInstanceOf(NotFoundException);
    await withTenant(database.db, context, (tx) =>
      tx
        .update(amazonOrderReportVersions)
        .set({ encryptedDocument: null, encryptedArchive: null })
        .where(eq(amazonOrderReportVersions.id, source.parsed.versionId!)),
    );
    const unavailable = await work.detail(context, source.lineId);
    expect(unavailable.sourceVersionId).toBe(source.parsed.versionId);
    expect(unavailable.sourceReport).toBeNull();
    expect(unavailable.report?.versionId).toBe(detail.report?.versionId);
    await expect(
      work.sourceFile(context, source.lineId, original.key, saved.line.revision),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("lock-order: waits for the parent order before locking work source and preserves the original private revision", async () => {
    const nonceDatabase = new URL(process.env.DATABASE_URL!).pathname.slice(1);
    expect(nonceDatabase).toMatch(/^order_daily_e2e_[a-f0-9]{32}$/);
    const source = await imported("Synthetic parent-first source locking"),
      before = await save(await work.detail(context, source.lineId)),
      actor = await currentOrderContext(),
      original = before.sourceReport!.files.find(file => file.role === "buyer_image")!;
    const baseline = await work.sourceFile(actor, source.lineId, original.originalFileKey!, before.line.revision),
      originalChecksum = createHash("sha256").update(baseline.body).digest("hex");
    let acquired!: (pid: number) => void, permitUpdate!: () => void;
    const parentLocked = new Promise<number>(resolve => { acquired = resolve; }),
      updateAllowed = new Promise<void>(resolve => { permitUpdate = resolve; });
    const writer = withTenant(database.db, actor, async tx => {
      await tx.execute(sql`set local lock_timeout='8s'`);
      const [parent] = await tx.execute<{ id: string; pid: number; application_role: boolean }>(sql`select id,
        pg_backend_pid() as pid,current_user='yummyai_app' as application_role from orders where id=${before.line.orderId}::uuid for update`);
      expect(parent).toMatchObject({ id: before.line.orderId, application_role: true });
      acquired(parent!.pid);
      await updateAllowed;
      // This row lock is intentional, with no change to a revision or source pin.
      const updated = await tx.update(orderWorkItems).set({ updatedAt: sql`${orderWorkItems.updatedAt}` })
        .where(eq(orderWorkItems.id, source.lineId)).returning({ revision: orderWorkItems.revision, projectionVersion: orderWorkItems.projectionVersion,
          sourceVersionId: orderWorkItems.sourceVersionId, reportLineId: orderWorkItems.reportLineId });
      expect(updated).toHaveLength(1);
      expect(updated[0]).toMatchObject({ revision: before.line.revision, projectionVersion: before.line.projectionVersion,
        sourceVersionId: before.sourceVersionId, reportLineId: source.report.id });
    });
    const outstanding: Promise<unknown>[] = [writer];
    // Observe rejection immediately, while retaining it for the strict outcomes below.
    void writer.catch(() => undefined);
    try {
      const writerPid = await Promise.race([parentLocked, writer.then(() => { throw new Error("Synthetic writer ended before the parent lock barrier"); })]);
      // This public read enters currentSource first. detail() also performs report
      // reads beforehand, which could otherwise hide the original lock inversion.
      const reading = work.sourceFile(actor, source.lineId, original.originalFileKey!, before.line.revision);
      outstanding.push(reading); void reading.catch(() => undefined);
      let readerPid = 0;
      await vi.waitFor(async () => {
        const waiting = await database.client<{ pid: number; blockers: number[]; database: string }[]>`select pid,
          pg_blocking_pids(pid) as blockers,current_database() as database from pg_stat_activity
          where datname=current_database() and wait_event_type='Lock' and ${writerPid}=any(pg_blocking_pids(pid))
            and query ilike '%"order_lines"%' and query ilike '%for share%' and pid<>pg_backend_pid()`;
        expect(waiting).toHaveLength(1); expect(waiting[0]!.database).toBe(nonceDatabase);
        expect(waiting[0]!.blockers).toContain(writerPid); readerPid = waiting[0]!.pid;
      }, { timeout: 5000, interval: 10 });
      expect(readerPid).not.toBe(writerPid); expect(readerPid).toBeGreaterThan(0);
      permitUpdate();
      const outcomes = await Promise.allSettled([writer, reading]);
      for (const outcome of outcomes) if (outcome.status === "rejected") {
        const failure = outcome.reason as { code?: string; cause?: { code?: string } };
        expect(failure.cause?.code ?? failure.code, "Neither actual operation may fail with a deadlock").not.toBe("40P01");
      }
      expect(outcomes.map(outcome => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(createHash("sha256").update((await reading).body).digest("hex")).toBe(originalChecksum);
    } finally {
      permitUpdate();
      await Promise.allSettled(outstanding);
    }
    const after = OrderWorkDetailViewSchema.parse(await work.detail(actor, source.lineId));
    expect(after.line).toMatchObject({ id: source.lineId, revision: before.line.revision, projectionVersion: before.line.projectionVersion });
    expect(after.sourceVersionId).toBe(before.sourceVersionId); expect(after.sourceReport?.versionId).toBe(before.sourceReport?.versionId);
    expect(after.versions).toEqual(before.versions); expect(after.draft).toEqual(before.draft);
    expect(after.draft.fields[0]!.value).toBe("Private customer text");
    await expect(work.detail(other, source.lineId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(work.detail({ ...actor, permissions: actor.permissions.filter(permission => permission !== Permission.OrderPiiRead) }, source.lineId))
      .rejects.toBeInstanceOf(ForbiddenError);
  });

  it("rejects concurrent work revisions during pinned review metadata and file reads", async () => {
    const source = await imported("Synthetic concurrent wording");
    let saved = await save(await work.detail(context, source.lineId));
    const metadata = reports.detailFromVersion.bind(reports);
    const metadataRead = vi
      .spyOn(reports, "detailFromVersion")
      .mockImplementationOnce(async (...args) => {
        const result = await metadata(...args);
        saved = await save(saved);
        return result;
      });
    try {
      await expect(work.detail(context, source.lineId)).rejects.toBeInstanceOf(ConflictException);
    } finally {
      metadataRead.mockRestore();
    }
    const file = saved.sourceReport!.files.find((item) => item.role === "buyer_image")!;
    const read = reports.fileFromVersion.bind(reports);
    const fileRead = vi
      .spyOn(reports, "fileFromVersion")
      .mockImplementationOnce(async (...args) => {
        const result = await read(...args);
        saved = await save(saved);
        return result;
      });
    try {
      await expect(
        work.sourceFile(context, source.lineId, file.key, saved.line.revision),
      ).rejects.toBeInstanceOf(ConflictException);
    } finally {
      fileRead.mockRestore();
    }
    await withTenant(database.db, context, (tx) =>
      tx
        .update(orderWorkItems)
        .set({ expiresAt: new Date(0) })
        .where(eq(orderWorkItems.id, source.lineId)),
    );
    await expect(
      work.sourceFile(context, source.lineId, file.key, saved.line.revision),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(work.detail(context, source.lineId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("records a verified platform deadline independently of draft revisions", async () => {
    const source = await imported();
    let detail = await work.detail(context, source.lineId);
    const input = {
      expectedProjectionVersion: detail.line.projectionVersion,
      shipByAt: new Date(Date.now() - 60_000).toISOString(),
      evidenceReference: "Synthetic Seller Central ship-by reference",
      idempotencyKey: randomUUID(),
    };
    detail = await work.recordPlatformDeadline(context, source.lineId, input);
    expect(detail.line.platformShipByAt).toBe(input.shipByAt);
    expect(detail.line.platformDeadlineVerifiedAt).toBeTruthy();
    expect(detail.line.revision).toBe(0);
    expect(detail).toMatchObject({ sourceReport: null, sourceVersionId: null });
    expect(detail.line.sourceChanged).toBe(false);
    expect(detail.draft.instructions).toBe("");
    detail = await work.recordPlatformDeadline(context, source.lineId, input);
    expect(detail.events.filter((event) => event.action === "platform_deadline")).toHaveLength(1);
    await expect(
      work.recordPlatformDeadline(context, source.lineId, { ...input, shipByAt: null }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(work.recordPlatformDeadline(other, source.lineId, input)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      work.recordPlatformDeadline(
        { ...context, permissions: ["order:write"] },
        source.lineId,
        input,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const overdue = await work.list(context, {
      module: "orders",
      attention: "platform_overdue",
      q: source.externalOrderId,
    });
    expect(overdue.items.map((item) => item.id)).toContain(source.lineId);
    detail = await save(detail);
    expect(detail.line.platformShipByAt).toBe(input.shipByAt);
    const oldDraft = detail.draft;
    detail = await work.recordPlatformDeadline(context, source.lineId, {
      ...input,
      expectedProjectionVersion: detail.line.projectionVersion,
      shipByAt: null,
      idempotencyKey: randomUUID(),
    });
    expect(detail.draft).toEqual(oldDraft);
    expect(detail.line.revision).toBe(1);
    expect(detail.line.platformShipByAt).toBeNull();
    expect(
      (
        await work.list(context, {
          module: "orders",
          attention: "platform_deadline_missing",
          q: source.externalOrderId,
        })
      ).items.map((item) => item.id),
    ).toContain(source.lineId);
  });

  it("review-only approval durably prepares one formal file, recovers queue failure and never releases production", async () => {
    const source = await imported();
    let detail = await act(await save(await work.detail(context, source.lineId)), "push");
    detail = await act(detail, "start_artwork");
    let project = await editor.get(context, detail.line.editorProjectId!);
    project = await editor.save(context, project.project.id, {
      expectedVersionId: project.version.id,
      document: { ...project.version.document, confirmations: doc().confirmations },
    });
    // Recovery must not dispatch even ordinary previews, let alone paid model work.
    const preview = await editor.render(context, project.project.id, {
      expectedVersionId: project.version.id,
      purpose: "preview",
      format: "png",
      background: "white",
    });
    detail = await act(detail, "submit_artwork", project.version.id);
    expect(detail.line.orderStatus).toBe("awaiting_review");
    const reviewer = {
      ...context,
      permissions: context.permissions.filter((permission) => permission !== "design:write"),
    };
    const approval = {
      action: "approve_artwork",
      expectedRevision: detail.line.revision,
      expectedProjectionVersion: detail.line.projectionVersion,
      expectedEditorVersionId: project.version.id,
      reason: "Synthetic proof approved",
      idempotencyKey: randomUUID(),
    };
    enqueue.mockClear();
    generate.mockClear();
    enqueue.mockRejectedValueOnce(new Error("Synthetic queue outage"));
    detail = await work.action(reviewer, source.lineId, approval);
    expect(detail.line).toMatchObject({ artwork: "approved", production: "not_released" });
    expect(enqueue).toHaveBeenCalledTimes(1);
    const formal = (await editor.get(reviewer, project.project.id)).renders.filter(
      (render) => render.purpose === "production",
    );
    expect(formal).toHaveLength(1);
    expect(formal[0]).toMatchObject({ status: "queued", versionId: project.version.id });
    expect(enqueue).toHaveBeenCalledWith({
      renderId: formal[0]!.id,
      tenantId,
      requestedBy: userId,
      maxAttempts: 3,
    });
    await work.action(reviewer, source.lineId, approval);
    expect(
      (await editor.get(reviewer, project.project.id)).renders.filter(
        (render) => render.purpose === "production",
      ),
    ).toHaveLength(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    await expect(editor.getRender(other, project.project.id, formal[0]!.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await withTenant(database.db, context, (tx) =>
      tx
        .update(productionEditorRenders)
        .set({ updatedAt: sql`now() - interval '1 minute'` })
        .where(eq(productionEditorRenders.projectId, project.project.id)),
    );
    const delivered = vi.fn<
      (input: { renderId: string; tenantId: string; requestedBy: string }) => Promise<void>
    >(async () => undefined);
    await dispatchApprovedProductionRenders(database, vault, delivered);
    expect(delivered.mock.calls.map(([input]) => input.renderId)).toContain(formal[0]!.id);
    expect(delivered.mock.calls.map(([input]) => input.renderId)).not.toContain(preview.id);
    expect(delivered).toHaveBeenCalledWith({
      renderId: formal[0]!.id,
      tenantId,
      requestedBy: userId,
    });
    await worker.process(envelope(formal[0]!.id));
    const completed = await editor.getRender(reviewer, project.project.id, formal[0]!.id);
    expect(completed).toMatchObject({ status: "completed", preflight: { productionReady: true } });
    expect(completed.files.length).toBeGreaterThan(0);
    const bytes = await editor.renderFile(
      reviewer,
      project.project.id,
      completed.id,
      completed.files[0]!.key,
    );
    expect(await sharp(bytes.body).metadata()).toMatchObject({ format: "png", density: 150 });
    expect(generate).not.toHaveBeenCalled();
    expect((await work.detail(context, source.lineId)).line.production).toBe("not_released");
    expect(
      await withTenant(database.db, context, (tx) =>
        tx
          .select()
          .from(productionOrderVersions)
          .where(eq(productionOrderVersions.sourceRenderId, completed.id)),
      ),
    ).toHaveLength(0);

    // Revoking approval while a file waits in the queue must still block rendering.
    detail = await work.detail(context, source.lineId);
    const delayed = await editor.render(context, project.project.id, {
      expectedVersionId: project.version.id,
      purpose: "production",
      format: "png",
      background: "transparent",
    });
    await act(detail, "reject_artwork", project.version.id);
    await worker.process(envelope(delayed.id)).catch(() => undefined);
    expect((await editor.getRender(context, project.project.id, delayed.id)).status).toBe("failed");
    detail = await act(
      await work.detail(context, source.lineId),
      "submit_artwork",
      project.version.id,
    );
    let releaseQueue!: () => void;
    enqueue.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseQueue = resolve;
        }),
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const approved = await Promise.race([
        act(detail, "approve_artwork", project.version.id),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Approval waited for Redis")), 3000);
        }),
      ]);
      expect(approved.line.artwork).toBe("approved");
    } finally {
      clearTimeout(timeout);
      releaseQueue?.();
    }
  });

  it("whole order production and shipment commit all three items atomically with safe retries", async () => {
    const externalOrderId = `WHOLE-${createEntityId()}`;
    const externalLines = Array.from({ length: 3 }, () => `WHOLE-LINE-${createEntityId()}`);
    const placedAt = new Date().toISOString();
    const batch = await reports.importReport(context, {
      accountId,
      marketplaceId: "ATVPDKIKX0DER",
      fileName: "whole-synthetic.txt",
      content:
        "order-id\torder-item-id\tpurchase-date\tsku\tproduct-name\tquantity-purchased\tcurrency\titem-price\tcustomized-url\n" +
        externalLines
          .map(
            (line) =>
              `${externalOrderId}\t${line}\t${placedAt}\tTEST-CENTER-SKU\tSynthetic whole custom item\t1\tUSD\t20.00\thttps://zme-caps.amazon.com/synthetic`,
          )
          .join("\n"),
    });
    const reportsView = await reports.workspace(context, { batchId: batch.id });
    let orderId = "";
    for (const row of reportsView.lines) {
      await reports.process(
        context,
        row.id,
        null,
        await attachment(externalOrderId, row.externalLineId, 512),
      );
      let detail = await act(await save(await work.detail(context, row.orderLineId), true, true), "push");
      detail = await act(detail, "start_artwork");
      orderId = detail.line.orderId;
      let project = await editor.get(context, detail.line.editorProjectId!);
      project = await editor.save(context, project.project.id, {
        expectedVersionId: project.version.id,
        document: { ...project.version.document, confirmations: doc().confirmations },
      });
      detail = await act(detail, "submit_artwork", project.version.id);
      detail = await act(detail, "approve_artwork", project.version.id);
      detail = await act(detail, "approve_proof", project.version.id);
      const render = await editor.render(context, project.project.id, {
        expectedVersionId: project.version.id,
        purpose: "production",
        format: "png",
        background: "transparent",
      });
      await worker.process(envelope(render.id));
    }
    let plan = await production.wholeOrderFulfillment(context, orderId);
    expect(plan.items).toHaveLength(3);
    expect(plan.quantity).toBe(3);
    expect(plan.factories).toHaveLength(1);
    const wholeDetail = new OrderWholeDetailService(
      work,
      production,
      shipments,
      afterSales,
      editor,
      shipos,
    );
    const overview = await wholeDetail.get(context, plan.items[1]!.lineId);
    expect(overview.items).toHaveLength(3);
    expect(
      overview.items.every(
        (item) => item.artwork.data?.approved && item.artwork.data?.productionFile,
      ),
    ).toBe(true);
    expect(
      new Set(overview.items.map((item) => item.artwork.data!.productionFile!.path)).size,
    ).toBe(3);
    expect(overview).toMatchObject({
      production: { data: [], error: null },
      shipments: { data: [], error: null },
      shipos: { data: [], error: null },
    });
    await expect(wholeDetail.get(other, plan.items[0]!.lineId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      wholeDetail.get({ ...context, permissions: ["order:read"] }, plan.items[0]!.lineId),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      wholeDetail.get({ ...context, dataScope: "self" }, plan.items[0]!.lineId),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const outage = vi
      .spyOn(production, "list")
      .mockRejectedValueOnce(new Error("PRIVATE_INTERNAL_DATABASE_DETAIL"));
    try {
      const partial = await wholeDetail.get(context, plan.items[0]!.lineId);
      expect(partial.production).toEqual({ data: null, error: "生产记录暂时无法读取，请重试" });
      expect(partial.shipments).toEqual({ data: [], error: null });
      expect(partial.items).toHaveLength(3);
      expect(JSON.stringify(partial)).not.toContain("PRIVATE_INTERNAL_DATABASE_DETAIL");
    } finally {
      outage.mockRestore();
    }
    const release = {
      factoryId: factoryFixture.pins.factoryId,
      factoryVersionId: factoryFixture.pins.factoryVersionId,
      supplierId,
      expectedCompletionAt: new Date(Date.now() + 86400000).toISOString(),
      instructions: "Synthetic make and pack all items together",
      items: plan.items.map((item) => ({
        lineId: item.lineId,
        quantity: item.quantity,
        expectedRevision: item.expectedRevision,
        expectedProjectionVersion: item.expectedProjectionVersion,
        renderId: item.renderId!,
        capabilityVersionId: factoryFixture.pins.capabilityVersionId,
        capacityPlan: capacityFixture.capacityPlan,
        manufacturing: manufacturingForLine.get(item.lineId)!.manufacturing,
      })),
      idempotencyKey: randomUUID(),
    };
    await expect(production.wholeOrderFulfillment(other, orderId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      production.releaseWholeOrder({ ...context, permissions: ["order:write"] }, orderId, release),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(production.releaseWholeOrder(other, orderId, release)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      production.releaseWholeOrder(context, orderId, {
        ...release,
        items: release.items.slice(0, 2),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      production.releaseWholeOrder(context, orderId, {
        ...release,
        items: release.items.map((item, index) =>
          index === 2 ? { ...item, capabilityVersionId: createEntityId() } : item,
        ),
      }),
    ).rejects.toThrow();
    expect(await production.list(context, orderId)).toHaveLength(0);
    expect(
      (await production.wholeOrderFulfillment(context, orderId)).items.map(
        (item) => item.expectedProjectionVersion,
      ),
    ).toEqual(plan.items.map((item) => item.expectedProjectionVersion));
    const commands = new ProductionCommandService(database, vault, production);
    const intent = await commands.prepare(context, { kind: "reviewed_order", targetId: orderId, input: release });
    expect(intent).toMatchObject({ status: "prepared", summary: { lineCount: 3, quantity: 3 } });
    const overlapping = release.items[0]!;
    await expect(commands.prepare(context, { kind: "reviewed_line", targetId: overlapping.lineId, input: {
      ...factoryFixture.pins, supplierId, quantity: overlapping.quantity, renderId: overlapping.renderId,
      capacityPlan: capacityFixture.capacityPlan,
      expectedRevision: overlapping.expectedRevision, expectedProjectionVersion: overlapping.expectedProjectionVersion,
      expectedCompletionAt: release.expectedCompletionAt, instructions: "Synthetic overlapping command", manufacturing: overlapping.manufacturing, idempotencyKey: randomUUID(),
    } })).rejects.toThrow("待确认");
    const saved = await commands.execute(context, intent.id);
    expect(saved.status).toBe("succeeded"); expect(saved.receipt?.productionOrderIds).toHaveLength(3);
    const first = saved.receipt!, repeated = (await new ProductionCommandService(database, vault, production).execute(context, intent.id)).receipt!;
    expect(new Set((await production.releaseWholeOrder(context, orderId, release)).productionOrderIds)).toEqual(new Set(first.productionOrderIds));
    expect(new Set(first.productionOrderIds)).toEqual(new Set(repeated.productionOrderIds));
    expect(await production.list(context, orderId)).toHaveLength(3);
    const groupedProduction = await work.list(context, {
      module: "production",
      grouping: "orders",
      q: plan.items[0]!.externalLineId,
    });
    expect(groupedProduction.groupTotal).toBe(1);
    expect(groupedProduction.items).toHaveLength(3);
    expect(groupedProduction.items.every((item) => item.orderId === orderId)).toBe(true);
    const scheduledOverview = await wholeDetail.get(context, plan.items[0]!.lineId);
    expect(scheduledOverview.production.error).toBeNull();
    expect(scheduledOverview.production.data).toHaveLength(3);
    expect(
      scheduledOverview.production.data!.every(
        (record) => typeof record.productionOrder.expectedCompletionAt === "string",
      ),
    ).toBe(true);
    await expect(
      production.releaseWholeOrder(context, orderId, { ...release, instructions: "changed retry" }),
    ).rejects.toBeInstanceOf(ConflictException);
    const pins = (view: typeof plan) =>
      view.items.map(({ lineId, quantity, expectedRevision, expectedProjectionVersion }) => ({
        lineId,
        quantity,
        expectedRevision,
        expectedProjectionVersion,
      }));
    const shipping = () => ({
      items: pins(plan).map(item => ({ ...item, productionAllocations: syntheticShipmentAllocations(plan.shipmentSources, item.lineId, item.quantity) })),
      trackingNumber: "SYNTHETIC-WHOLE-TRACK",
      carrierCode: "MANUAL",
      carrierName: "Synthetic carrier",
      carrierService: "Synthetic service",
      shipFromCountryCode: "CN",
      shipDate: new Date().toISOString(),
      idempotencyKey: randomUUID(),
    });
    plan = await production.wholeOrderFulfillment(context, orderId);
    await expect(shipments.createWholeOrder(context, orderId, shipping())).rejects.toBeInstanceOf(
      ConflictException,
    );
    const productionPins = () =>
      plan.items.map((item, index) => ({
        ...pins(plan)[index]!,
        productionOrderId: item.production!.id,
        expectedProductionProjectionVersion: item.production!.projectionVersion,
      }));
    for (const type of ["submitted", "acknowledged", "started", "completed"] as const) {
      const input = {
        type,
        items: productionPins(),
        occurredAt: new Date().toISOString(),
        evidence: {
          code: "SYNTHETIC_WHOLE",
          note: "Synthetic whole-order factory evidence",
          assetIds: [],
        },
        idempotencyKey: randomUUID(),
      };
      if (type === "completed") {
        await expect(
          production.recordWholeOrderProduction(context, orderId, {
            ...input,
            items: input.items.map((item, index) =>
              index === 2
                ? {
                    ...item,
                    expectedProductionProjectionVersion:
                      item.expectedProductionProjectionVersion + 1,
                  }
                : item,
            ),
          }),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(
          (await production.wholeOrderFulfillment(context, orderId)).items.every(
            (item) => item.production?.status === "in_production",
          ),
        ).toBe(true);
      }
      await production.recordWholeOrderProduction(context, orderId, input);
      await production.recordWholeOrderProduction(context, orderId, input);
      await expect(
        production.recordWholeOrderProduction(context, orderId, {
          ...input,
          evidence: { ...input.evidence, note: "changed retry" },
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      plan = await production.wholeOrderFulfillment(context, orderId);
    }
    const standard = await production.createQualityStandard(context, {
      name: "Synthetic whole quality",
      skuId: null,
      supplierId: null,
      minimumScoreBps: 9000,
      criteria: [
        { code: "WHOLE", label: "Synthetic verify every item", weightBps: 10000, blocking: true },
      ],
    });
    const qc = {
      items: productionPins(),
      qualityStandardVersionId: standard.id,
      scoreBps: 10000,
      inspectedAt: await qualityFixtureTime(),
      evidenceAssetIds: [],
      idempotencyKey: randomUUID(),
    };
    await expect(
      production.inspectWholeOrder(context, orderId, await syntheticWholeQualityInspection(production, context, { ...qc, scoreBps: 8999 })),
    ).rejects.toThrow();
    expect(
      (await production.wholeOrderFulfillment(context, orderId)).items.every(
        (item) => item.readyQuantity === 0,
      ),
    ).toBe(true);
    const inspection = await production.inspectWholeOrder(context, orderId, await syntheticWholeQualityInspection(production, context, qc));
    expect(inspection.inspectionIds).toHaveLength(3);
    expect(await production.inspectWholeOrder(context, orderId, await syntheticWholeQualityInspection(production, context, qc))).toEqual(inspection);
    await expect(production.inspectWholeOrder({ ...context, userId: createEntityId() }, orderId,
      await syntheticWholeQualityInspection(production, context, qc))).rejects.toBeInstanceOf(ConflictException);
    await expect(
      production.inspectWholeOrder(context, orderId, await syntheticWholeQualityInspection(production, context, { ...qc, scoreBps: 9900 })),
    ).rejects.toBeInstanceOf(ConflictException);
    plan = await production.wholeOrderFulfillment(context, orderId);
    expect(plan.orderStatus).toBe("produced");
    const groupedShipping = await work.list(context, {
      module: "shipments",
      grouping: "orders",
      q: plan.items[0]!.externalLineId,
    });
    expect(groupedShipping.groupTotal).toBe(1);
    expect(groupedShipping.items).toHaveLength(3);
    await expect(
      shipments.createWholeOrder(context, orderId, {
        ...shipping(),
        items: pins(plan).slice(0, 2),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      shipments.createWholeOrder(context, orderId, {
        ...shipping(),
        items: pins(plan).map((item, index) => (index === 1 ? { ...item, quantity: 2 } : item)),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    const shipmentContext = {
      ...context,
      permissions: [...context.permissions, "integration:manage"],
    };
    const connection = await shipos.save(shipmentContext, supplierId, {
      name: "Synthetic whole shipment",
      status: "active",
      expectedVersion: 0,
      appKey: "synthetic-appkey",
      appSecret: "synthetic-secret",
      channelMappings: [
        {
          channel: "Synthetic channel",
          carrierCode: "MANUAL",
          carrierName: "Synthetic carrier",
          carrierService: "Synthetic service",
          shipFromCountryCode: "CN",
        },
      ],
      idempotencyKey: randomUUID(),
    });
    const orderNumber = (await work.detail(context, plan.items[0]!.lineId)).line.externalOrderId;
    const gatewayOrders = vi.spyOn(shiposGateway, "orders").mockResolvedValue([
      {
        orderNumber,
        trackingNumber: "SYNTHETIC-WHOLE-TRACK",
        labelAvailable: true,
        statusCode: 13,
        cancelStatusCode: 0,
        labelStatusCode: 2,
        settlementStatusCode: 1,
        channel: null,
        fee: null,
        currency: null,
        diagnostics: [],
      },
    ]);
    const gatewayDetail = vi.spyOn(shiposGateway, "detail").mockResolvedValue({
      trackingNumber: "SYNTHETIC-WHOLE-TRACK",
      labelUrl: "https://shipease.oss-cn-hangzhou.aliyuncs.com/pdfs/synthetic.pdf",
      channel: "Synthetic channel",
      fee: null,
      currency: null,
    });
    const observation = await shipos.sync(shipmentContext, supplierId, {
      orderNumbers: [orderNumber],
      expectedVersion: connection.version,
      idempotencyKey: randomUUID(),
    });
    const shipInput = {
      ...shipping(),
      shiposSource: {
        supplierId,
        recordId: observation.records[0]!.id,
        expectedConnectionVersion: connection.version,
      },
    };
    await expect(
      shipments.createWholeOrder(context, orderId, {
        ...shipInput,
        trackingNumber: "wrong source",
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      shipments.createWholeOrder(context, orderId, {
        ...shipInput,
        shiposSource: { ...shipInput.shiposSource, recordId: createEntityId() },
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      shipments.createWholeOrder(context, orderId, { ...shipInput, carrierCode: "WRONG" }),
    ).rejects.toBeInstanceOf(ConflictException);
    let shipment = await shipments.createWholeOrder(context, orderId, shipInput);
    expect(shipment.versions[0]!.shiposSource).toMatchObject({
      recordId: observation.records[0]!.id,
      carrierMapping: { carrierCode: "MANUAL" },
      labelAvailable: true,
    });
    expect(shipment.physicalHandover.allDispatched).toBe(false);
    expect(gatewayOrders).toHaveBeenCalledTimes(1);
    expect(gatewayDetail).toHaveBeenCalledTimes(1);
    gatewayOrders.mockRestore();
    gatewayDetail.mockRestore();
    expect(shipment.packages).toHaveLength(1);
    expect(shipment.packageLines).toHaveLength(3);
    expect(shipment.shipment.wholeOrder).toBe(true);
    expect((await shipments.createWholeOrder(context, orderId, shipInput)).shipment.id).toBe(
      shipment.shipment.id,
    );
    await expect(
      shipments.createWholeOrder(context, orderId, {
        ...shipInput,
        trackingNumber: "changed retry",
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      shipments.createWholeOrder(context, orderId, { ...shipInput, idempotencyKey: randomUUID() }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect((await production.wholeOrderFulfillment(context, orderId)).orderStatus).toBe("produced");
    shipment = await shipments.reviewVersion(
      context,
      shipment.shipment.id,
      shipment.versions[0]!.id,
      {
        decision: "approved",
        reasonCode: "SYNTHETIC_WHOLE",
        reason: "Synthetic all items packed together",
        expectedCurrentVersion: 1,
        idempotencyKey: randomUUID(),
      },
    );
    await expect(
      shipments.appendVersion(context, shipment.shipment.id, {
        ...CreateShipmentInputSchema.parse({
          shipDate: shipInput.shipDate,
          shipFromCountryCode: "CN",
          idempotencyKey: randomUUID(),
          packages: [
            {
              packageReferenceId: "WHOLE",
              trackingNumber: shipInput.trackingNumber,
              carrierCode: "MANUAL",
              carrierName: "Synthetic",
              carrierService: "Synthetic",
              lines: [{ orderLineId: plan.items[0]!.lineId, quantity: 1 }],
            },
          ],
        }),
        expectedCurrentVersion: 1,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    let paused = await act(await work.detail(context, plan.items[2]!.lineId), "hold");
    const dispatch = {
      expectedVersion: 1,
      occurredAt: new Date().toISOString(),
      reason: "Synthetic entire-order pickup receipt",
      idempotencyKey: randomUUID(),
    };
    await expect(
      shipments.dispatch(context, shipment.shipment.id, dispatch),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(
      (await shipments.get(context, shipment.shipment.id)).physicalHandover.dispatchedPackageCount,
    ).toBe(0);
    paused = await act(paused, "resume");
    expect(paused.line.held).toBe(false);
    await shipments.dispatch(context, shipment.shipment.id, dispatch);
    await shipments.dispatch(context, shipment.shipment.id, dispatch);
    expect((await production.wholeOrderFulfillment(context, orderId)).orderStatus).toBe("shipped");
    const shipped = await shipments.get(context, shipment.shipment.id);
    expect(shipped.physicalHandover.allDispatched).toBe(true);
    expect(shipped.tracking).toHaveLength(1);
    expect(shipped.writebacks).toHaveLength(0);
    for (const item of plan.items)
      expect((await work.detail(context, item.lineId)).line.shippedQuantity).toBe(1);
  });

  async function qualityFixtureTime() {
    const clock = await withTenant(database.db, context, tx => tx.execute<{ checkedAt: Date }>(sql.raw("select clock_timestamp() as \"checkedAt\"")));
    return new Date(clock[0]!.checkedAt).toISOString();
  }

  it("requires reviewed production renders and records partial shipments without marketplace writes", async () => {
    const source = await imported();
    let detail = await act(await save(await work.detail(context, source.lineId), true, true), "push");
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
    await expect(act(detail, "approve_proof")).rejects.toBeInstanceOf(ConflictException);
    await expect(act(detail, "approve_proof", createEntityId())).rejects.toBeInstanceOf(
      ConflictException,
    );
    detail = await act(detail, "approve_proof", project.version.id);
    expect(detail.line.proofVersionCurrent).toBe(true);
    expect(detail.line.orderStatus).toBe("reviewed");
    const rejection = {
      action: "reject_artwork",
      expectedRevision: detail.line.revision,
      expectedProjectionVersion: detail.line.projectionVersion,
      expectedEditorVersionId: project.version.id,
      reason: "Synthetic review: smooth the lower cutting line",
      idempotencyKey: randomUUID(),
    };
    await expect(
      work.action(context, source.lineId, { ...rejection, reason: "  " }),
    ).rejects.toThrow();
    await expect(
      work.action(context, source.lineId, { ...rejection, expectedEditorVersionId: undefined }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      work.action(context, source.lineId, {
        ...rejection,
        expectedEditorVersionId: createEntityId(),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(work.action(other, source.lineId, rejection)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      work.action(
        {
          ...context,
          permissions: context.permissions.filter((permission) => permission !== "design:review"),
        },
        source.lineId,
        rejection,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // Review-only operators can reject without design-write permission.
    detail = await work.action(
      {
        ...context,
        permissions: context.permissions.filter((permission) => permission !== "design:write"),
      },
      source.lineId,
      rejection,
    );
    detail = await work.action(context, source.lineId, rejection);
    expect(detail.line.artwork).toBe("changes_requested");
    expect(detail.line.proof).toBe("pending");
    expect(detail.line.proofVersionCurrent).toBe(false);
    expect(detail.events.filter((event) => event.action === "reject_artwork")).toHaveLength(1);
    expect(detail.events.find((event) => event.action === "reject_artwork")?.reason).toBe(
      rejection.reason,
    );
    expect((await editor.get(context, project.project.id)).version.reviewed).toBe(false);
    await expect(
      editor.render(context, project.project.id, {
        expectedVersionId: project.version.id,
        purpose: "production",
        format: "png",
        background: "white",
      }),
    ).rejects.toThrow();
    detail = await act(detail, "submit_artwork", project.version.id);
    detail = await act(detail, "approve_artwork", project.version.id);
    const render = await editor.render(context, project.project.id, {
      expectedVersionId: project.version.id,
      purpose: "production",
      format: "png",
      background: "transparent",
    });
    const release = {
      ...factoryFixture.pins,
      capacityPlan: capacityFixture.capacityPlan,
      manufacturing: manufacturingForLine.get(source.lineId)!.manufacturing,
      expectedRevision: detail.line.revision,
      expectedProjectionVersion: detail.line.projectionVersion,
      renderId: render.id,
      supplierId,
      quantity: 1,
      expectedCompletionAt: new Date(Date.now() + 86400000).toISOString(),
      instructions: "Synthetic factory instructions",
      idempotencyKey: randomUUID().toUpperCase(),
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
    await expect(production.releaseArtwork(context, source.lineId, release)).rejects.toBeInstanceOf(
      ConflictException,
    );
    detail = await act(detail, "approve_proof", project.version.id);
    release.expectedProjectionVersion = detail.line.projectionVersion;
    // A later channel/catalog match must not replace the SKU and product plan
    // pinned in the actual approved work revision.
    const originalProduct = manufacturingForLine.get(source.lineId)!;
    const replacementProduct = await syntheticManufacturingProduct(database, context, { profileVersionId, document: doc() });
    const [originalPlan] = await withTenant(database.db, context, async tx => {
      const [link] = await tx.select().from(orderLineCatalogLinks).where(eq(orderLineCatalogLinks.orderLineId, source.lineId));
      if (link) await tx.update(orderLineCatalogLinks).set({ skuId: replacementProduct.skuId }).where(eq(orderLineCatalogLinks.id, link.id));
      else await tx.insert(orderLineCatalogLinks).values({ id: createEntityId(), tenantId, orderLineId: source.lineId, skuId: replacementProduct.skuId, matchSource: "manual", linkedBy: userId });
      return tx.select({ id: spus.productPlanId }).from(spus).where(eq(spus.id, originalProduct.spuId));
    });
    const choices = vi.spyOn(factories, "choices");
    try {
      await production.factoryOptions(context, source.lineId, render.id);
      expect(choices.mock.calls.at(-1)![1]).toMatchObject({ skuId: originalProduct.skuId, productPlanId: originalPlan!.id,
        templateVersionId: profileVersionId, productType: "tire_cover", longestMm: (doc() as Extract<ProductionEditorDocument, { productType: "tire_cover" }>).spec.diameterMm });
      await expect(production.factoryOptions({ ...context, permissions: context.permissions.filter(permission => permission !== Permission.ProductRead) }, source.lineId, render.id)).rejects.toBeInstanceOf(ForbiddenError);
    } finally { choices.mockRestore(); }
    const singleCommands = new ProductionCommandService(database, vault, production);
    const singleIntent = await singleCommands.prepare(context, { kind: "reviewed_line", targetId: source.lineId, input: release });
    const singleReceipt = await singleCommands.execute(context, singleIntent.id);
    expect(singleReceipt).toMatchObject({ status: "succeeded", lineIds: [source.lineId] });
    expect((await singleCommands.execute(context, singleIntent.id)).receipt).toEqual(singleReceipt.receipt);
    let released = await production.get(context, singleReceipt.receipt!.productionOrderIds[0]!);
    expect(released.versions[0]!.manufacturing).toMatchObject({ skuId: originalProduct.skuId, specificationVersionId: originalProduct.specificationVersionId });
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
    await production.inspect(context, released.productionOrder.id, await syntheticQualityInspection(production, context, released.productionOrder.id, {
      qualityStandardVersionId: standard.id,
      result: "passed",
      scoreBps: 10000,
      evidenceAssetIds: [],
      defects: [],
      inspectedAt: await qualityFixtureTime(),
      idempotencyKey: randomUUID(),
    }));
    shipping.packages[0]!.lines[0]!.productionAllocations = syntheticShipmentAllocations(await shipments.productionSources(context, detail.line.orderId), source.lineId, 1);
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
      orderStatus: "reviewed",
      platformConfirmationPending: true,
    });
    const platformConfirmation = {
      expectedVersion: 1,
      confirmedAt: new Date().toISOString(),
      evidenceReference: "Synthetic Seller Central confirmed shipment receipt",
      idempotencyKey: randomUUID(),
    };
    await expect(
      shipments.recordManualConfirmation(context, shipment.shipment.id, {
        ...platformConfirmation,
        expectedVersion: 2,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      shipments.recordManualConfirmation(other, shipment.shipment.id, platformConfirmation),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      shipments.recordManualConfirmation(
        { ...context, permissions: ["order:write"] },
        shipment.shipment.id,
        platformConfirmation,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await shipments.recordManualConfirmation(context, shipment.shipment.id, platformConfirmation);
    const confirmed = await shipments.recordManualConfirmation(
      context,
      shipment.shipment.id,
      platformConfirmation,
    );
    expect(confirmed.manualConfirmations).toHaveLength(1);
    await expect(
      shipments.recordManualConfirmation(context, shipment.shipment.id, {
        ...platformConfirmation,
        evidenceReference: "different",
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(
      (await work.list(context, { module: "shipments", q: source.externalOrderId })).items[0]
        ?.platformConfirmationPending,
    ).toBe(false);
    const history = await work.detail(context, source.lineId);
    expect(
      history.events.filter((event) => event.action === "platform_shipment_confirmed"),
    ).toHaveLength(1);
    expect(
      history.events.find((event) => event.action === "platform_shipment_confirmed")?.reason,
    ).toContain(platformConfirmation.evidenceReference);
    expect((await shipments.get(context, shipment.shipment.id)).writebacks).toHaveLength(0);
    await expect(
      shipments.create(context, detail.line.orderId, { ...shipping, idempotencyKey: randomUUID() }),
    ).rejects.toBeInstanceOf(ConflictException);
    detail = await work.detail(context, source.lineId);
    await expect(act(detail, "recall")).rejects.toBeInstanceOf(ConflictException);
    // Legacy partial history stays valid, but only the full quantity advances the order.
    let remaining = await production.releaseArtwork(context, source.lineId, {
      ...release,
      expectedRevision: detail.line.revision,
      expectedProjectionVersion: detail.line.projectionVersion,
      idempotencyKey: randomUUID(),
    });
    for (const type of ["submitted", "acknowledged", "started", "completed"] as const)
      remaining = await production.recordMilestone(context, remaining.productionOrder.id, {
        type,
        expectedProjectionVersion: remaining.productionOrder.projectionVersion,
        externalEventId: randomUUID(),
        occurredAt: new Date().toISOString(),
        evidence: { code: "SYNTHETIC_EVIDENCE", note: "Fixture remaining quantity", assetIds: [] },
      });
    expect((await work.detail(context, source.lineId)).line.orderStatus).toBe("reviewed");
    await production.inspect(context, remaining.productionOrder.id, await syntheticQualityInspection(production, context, remaining.productionOrder.id, {
      qualityStandardVersionId: standard.id,
      result: "passed",
      scoreBps: 10000,
      evidenceAssetIds: [],
      defects: [],
      inspectedAt: await qualityFixtureTime(),
      idempotencyKey: randomUUID(),
    }));
    expect((await work.detail(context, source.lineId)).line.orderStatus).toBe("produced");
    let finalShipment = await shipments.create(context, detail.line.orderId, {
      ...shipping,
      packages: [
        {
          ...shipping.packages[0]!,
          lines: [{ ...shipping.packages[0]!.lines[0]!, productionAllocations: syntheticShipmentAllocations(await shipments.productionSources(context, detail.line.orderId), source.lineId, 1) }],
          packageReferenceId: "SYNTHETIC-REMAINING-PKG",
          trackingNumber: "SYNTHETIC-REMAINING-TRACK",
        },
      ],
      idempotencyKey: randomUUID(),
    });
    finalShipment = await shipments.reviewVersion(
      context,
      finalShipment.shipment.id,
      finalShipment.versions[0]!.id,
      {
        decision: "approved",
        expectedCurrentVersion: 1,
        reasonCode: "SYNTHETIC_CHECK",
        reason: "Synthetic remaining package review",
        idempotencyKey: randomUUID(),
      },
    );
    expect((await work.detail(context, source.lineId)).line.orderStatus).toBe("produced");
    await shipments.dispatch(context, finalShipment.shipment.id, {
      ...handover,
      idempotencyKey: randomUUID(),
    });
    const complete = await work.list(context, {
      module: "orders",
      q: source.externalOrderId,
      orderStatus: "shipped",
    });
    expect(complete.items[0]).toMatchObject({
      orderStatus: "shipped",
      readyQuantity: 2,
      shippedQuantity: 2,
    });
    expect(complete.counts.orderStatuses?.shipped).toBe(1);
    expect((await shipments.get(context, finalShipment.shipment.id)).writebacks).toHaveLength(0);
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
    const awaitingCompletion = await work.list(context, {
      module: "after-sales",
      q: source.externalOrderId,
      grouping: "orders",
    });
    expect(awaitingCompletion.groupTotal).toBe(1);
    expect(awaitingCompletion.items[0]?.afterSalesCount).toBe(1);
    const closed = await afterSales.complete(context, created.case.id, completion);
    expect(
      (
        await work.list(context, {
          module: "after-sales",
          q: source.externalOrderId,
          grouping: "orders",
        })
      ).groupTotal,
    ).toBe(0);
    expect(
      (
        await work.list(context, {
          module: "after-sales",
          q: source.externalOrderId,
          grouping: "orders",
          caseScope: "all",
        })
      ).groupTotal,
    ).toBe(1);
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

  it("blocks an explicit Agent handoff without template automation while preserving the saved human workflow", async () => {
    const source = await imported(), initial = await work.detail(context, source.lineId);
    const basis = await matchingBasis(source.lineId, true);
    const saved = await work.save(context, source.lineId, {
      expectedRevision: initial.line.revision,
      expectedProjectionVersion: initial.line.projectionVersion,
      expectedSourceVersionId: initial.report?.versionId ?? null,
      draft: {
        ...initial.draft,
        ...basis,
        printProfileVersionId: profileVersionId,
        designExecutor: "agent",
        instructions: "",
        fields: [],
        images: initial.report!.files.filter(file => file.role === "buyer_image")
          .map(file => ({ origin: "report", key: file.key, usage: "正面" })),
      },
      status: "ready_to_push",
      reason: "Synthetic explicit Agent admission without automation",
      idempotencyKey: randomUUID(),
    });
    expect(saved.draft).toMatchObject({ ...basis, printProfileVersionId: profileVersionId, designExecutor: "agent" });
    expect(saved.line).toMatchObject({ preparation: "ready_to_push", artwork: "not_pushed", production: "not_released", editorProjectId: null });
    expect(saved.profile).not.toBeNull();
    const template = await editor.get(context, saved.profile!.projectId, saved.profile!.sourceVersionId);
    expect(template.version.document.automation).toBeUndefined();
    const plan = await work.templatePlan(context, source.lineId);
    expect(plan).toMatchObject({
      ready: false,
      templateVersionId: template.version.id,
      artworkVersionId: basis.artworkVersionId,
      specificationVersionId: basis.specificationVersionId,
      blockers: ["当前工艺模板尚未配置无人设计，不能创建自动任务。请配置并审核自动制图配方后重新保存本单制作需求"],
    });
    const [before] = await withTenant(database.db, context, tx => tx.select().from(orderWorkItems).where(eq(orderWorkItems.id, source.lineId)));
    expect(before).toMatchObject({ preparation: "ready_to_push", artwork: "not_pushed", pushedRevisionId: null, editorProjectId: null });
    const generated = generate.mock.calls.length, enqueued = enqueue.mock.calls.length;
    await expect(work.action(context, source.lineId, {
      action: "push",
      expectedRevision: saved.line.revision,
      expectedProjectionVersion: saved.line.projectionVersion,
      reason: "Synthetic rejected Agent handoff",
      idempotencyKey: randomUUID(),
    })).rejects.toThrow(/当前工艺模板尚未配置无人设计/);
    const rejected = await work.detail(context, source.lineId);
    const [after] = await withTenant(database.db, context, tx => tx.select().from(orderWorkItems).where(eq(orderWorkItems.id, source.lineId)));
    expect(after).toEqual(before);
    expect(rejected.line).toEqual(saved.line);
    expect(rejected.draft).toEqual(saved.draft);
    expect(rejected.versions).toEqual(saved.versions);
    expect(rejected.events).toEqual(saved.events);
    expect(await withTenant(database.db, context, tx => tx.select().from(orderDesignAgentRuns).where(eq(orderDesignAgentRuns.workItemId, source.lineId)))).toEqual([]);

    const human = await work.save(context, source.lineId, {
      expectedRevision: rejected.line.revision,
      expectedProjectionVersion: rejected.line.projectionVersion,
      expectedSourceVersionId: rejected.report?.versionId ?? null,
      draft: { ...rejected.draft, designExecutor: "human" },
      status: "ready_to_push",
      reason: "Synthetic explicit saved human continuation",
      idempotencyKey: randomUUID(),
    });
    expect(human.draft).toEqual({ ...saved.draft, designExecutor: "human" });
    expect(await work.templatePlan(context, source.lineId)).toMatchObject({ ready: true, blockers: [], templateVersionId: template.version.id });
    const pushed = await work.action(context, source.lineId, {
      action: "push",
      expectedRevision: human.line.revision,
      expectedProjectionVersion: human.line.projectionVersion,
      reason: "Synthetic explicit human handoff",
      idempotencyKey: randomUUID(),
    });
    expect(pushed.line).toMatchObject({ preparation: "pushed", artwork: "queued", production: "not_released", editorProjectId: null });
    expect(pushed.draft.designExecutor).toBe("human");
    expect(pushed.events.filter(event => event.action === "push")).toHaveLength(1);
    expect(await withTenant(database.db, context, tx => tx.select().from(orderDesignAgentRuns).where(eq(orderDesignAgentRuns.workItemId, source.lineId)))).toEqual([]);
    expect(generate.mock.calls).toHaveLength(generated);
    expect(enqueue.mock.calls).toHaveLength(enqueued);
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
        ...await matchingBasis(source.lineId, true),
        designExecutor: "agent",
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
    const action = OrderWorkActionInputSchema.parse({
      action: "push",
      expectedRevision: detail.line.revision,
      expectedProjectionVersion: detail.line.projectionVersion,
      reason: "Synthetic historical Agent handoff before durable runs",
      idempotencyKey: randomUUID(),
    });
    // Disposable historical compatibility fixture: the real saved Agent revision
    // predates durable runs. New Agent pushes without automation remain refused.
    const revision = detail.versions.find(row => row.revision === detail.line.revision)!;
    expect(revision).toBeDefined();
    await withTenant(database.db, context, async tx => {
      const [saved] = await tx.select().from(orderWorkItems).where(eq(orderWorkItems.id, source.lineId)).for("update");
      expect(saved).toMatchObject({ revision: detail.line.revision, preparation: "ready_to_push", artwork: "not_pushed", editorProjectId: null });
      const key = vault.withSecret(saved!.encryptedDataKey!, secret => Buffer.from(secret, "base64"));
      try {
        await tx.update(orderWorkItems).set({
          preparation: "pushed", artwork: "queued", pushedRevisionId: revision.id,
          projectionVersion: saved!.projectionVersion + 1, updatedAt: new Date(),
        }).where(eq(orderWorkItems.id, source.lineId));
        await tx.insert(orderWorkEvents).values({
          id: createEntityId(), tenantId, workItemId: source.lineId, action: "push",
          fromState: "not_pushed", toState: "queued", revision: saved!.revision,
          encryptedReason: sealWork(key, action.reason), idempotencyKey: action.idempotencyKey,
          requestHash: createHash("sha256").update(JSON.stringify(action)).digest("hex"), actorId: userId,
        });
      } finally { key.fill(0); }
    });
    detail = await work.detail(context, source.lineId);
    expect(detail.line).toMatchObject({ preparation: "pushed", artwork: "queued", editorProjectId: null, production: "not_released" });
    expect(detail.events).toContainEqual(expect.objectContaining({ action: "push", reason: action.reason }));
    const historical = detail;
    await expect(work.action(context, source.lineId, action)).rejects.toThrow(/这次历史派单没有创建无人设计任务/);
    expect(await work.detail(context, source.lineId)).toEqual({
      ...historical,
      shippingTime: { ...historical.shippingTime, computedAt: expect.any(String) },
    });
    expect(await withTenant(database.db, context, tx => tx.select().from(orderDesignAgentRuns).where(eq(orderDesignAgentRuns.workItemId, source.lineId)))).toEqual([]);
    detail = await work.action(context, source.lineId, {
      action: "start_artwork",
      expectedRevision: detail.line.revision,
      expectedProjectionVersion: detail.line.projectionVersion,
      reason: "Synthetic explicit historical Agent artwork start",
      idempotencyKey: randomUUID(),
    });
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
      const originalIds = new Set(project.version.document.layers.flatMap(layer => layer.kind === "image" &&
        ["custom_front_photo", "custom_back_photo"].includes(layer.id) ? [layer.assetId] : []));
      const originals = project.images.filter(asset => originalIds.has(asset.id));
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
    const [stock] = await syntheticPassedProduction(database, context, detail.line.orderId, [{ id: source.lineId, quantity: 2 }]);
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
          sql`insert into shipment_versions(id,tenant_id,shipment_id,version_number,ship_date,ship_from_country_code,idempotency_key,production_source_version,request_checksum,created_by) values(${versionId},${tenantId},${shipmentId},${number},now(),'CN',${randomUUID()},2,${"a".repeat(64)},${context.userId})`,
        );
        for (let i = 0; i < (number === 1 ? 1 : 2); i++) {
          const packageId = createEntityId();
          await tx.execute(
            sql`insert into shipment_packages(id,tenant_id,shipment_id,shipment_version_id,package_reference_id,tracking_number,carrier_code,carrier_name,carrier_service,external_label_id) values(${packageId},${tenantId},${shipmentId},${versionId},${`PACKAGE-${number}-${i}`},${`TRACK-${number}-${i}`},'MANUAL','Synthetic','Synthetic',${number === 2 && i === 0 ? "SYNTHETIC-LABEL" : null})`,
          );
          const packageLineId = createEntityId();
          await tx.execute(
            sql`insert into shipment_package_lines(id,tenant_id,shipment_id,shipment_version_id,package_id,order_line_id,quantity) values(${packageLineId},${tenantId},${shipmentId},${versionId},${packageId},${source.lineId},1)`,
          );
          await tx.execute(sql`insert into shipment_production_allocations(id,tenant_id,shipment_id,shipment_version_id,package_id,package_line_id,order_line_id,production_order_id,production_version_id,quality_inspection_id,production_projection_version,quantity)
            values(${createEntityId()},${tenantId},${shipmentId},${versionId},${packageId},${packageLineId},${source.lineId},${stock!.productionOrderId},${stock!.productionVersionId},${stock!.qualityInspectionId},5,1)`);
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

  it("reviews real tenant financial evidence without sharing buyer inputs or allocating whole-order costs to SKU", async () => {
    const restoreFinance = await grantFinanceForCase(["finance:read", "finance:write", "finance:review"]);
    try {
    const source = await imported(),
      detail = await save(await work.detail(context, source.lineId));
    const financeContext = {
      ...context,
      permissions: [...context.permissions, "finance:read", "finance:write", "finance:review"],
    };
    const finance = new FinanceService(database, audit),
      deliveries = new OrderProductionDeliveryService(
        database,
        vault,
        editor,
        production,
        audit,
        factories,
      );
    const review = new OrderReviewService(
      work,
      production,
      shipments,
      afterSales,
      deliveries,
      finance,
      database,
      vault,
    );
    const now = new Date().toISOString(),
      orderId = detail.line.orderId;
    const statement = await finance.recordStatement(financeContext, {
      accountId: null,
      provider: "manual",
      statementKind: "operational_cost",
      externalStatementId: `SYNTHETIC-REVIEW-${orderId}`,
      sourceIdentity: { schemaVersion: 2, kind: "named_source", sourceName: "SYNTHETIC-ORDER-REVIEW" },
      periodStart: now,
      periodEnd: now,
      sourceCurrency: "USD",
      observedAt: now,
      idempotencyKey: randomUUID(),
      lines: (
        ["sale_revenue", "production_cost", "carrier_cost", "marketplace_commission"] as const
      ).map((factType, index) => ({
        lineKey: String(index),
        sourceEntryId: `synthetic-order:${orderId}:${factType}`,
        factType,
        direction: index === 0 ? ("credit" as const) : ("debit" as const),
        amountMinor: [5000, 1200, 300, 500][index]!,
        currency: "USD",
        occurredAt: now,
        externalReference: null,
        orderId,
        orderLineId: null,
        skuId: null,
        listingId: null,
        supplierId: null,
        correctionKind: "original" as const,
        correctsFactId: null,
      })),
    });
    const metric = await finance.upsertProfitMetric(financeContext, {
      metricId: null,
      name: "Synthetic complete custom order margin",
      reportingCurrency: "USD",
      revenueFactTypes: ["sale_revenue"],
      costFactTypes: ["production_cost", "carrier_cost", "marketplace_commission", "other_fee"],
      requiredFactTypes: [
        "sale_revenue",
        "production_cost",
        "carrier_cost",
        "marketplace_commission",
      ],
      reasonCode: "SYNTHETIC_ONLY",
      idempotencyKey: randomUUID(),
    });
    const run = await finance.calculateProfit(financeContext, {
      metricId: metric.id,
      expectedMetricVersion: 1,
      statementIds: [statement.id],
      fxRateIds: [],
      coverageDimension: "order",
      idempotencyKey: randomUUID(),
    });
    const value = await review.get(financeContext, source.lineId);
    expect(value.profit).toMatchObject({
      runId: run.id,
      status: "verified",
      profitMinor: 3000,
      lines: [],
    });
    expect(value.lines[0]).toMatchObject({
      profileVersionId,
      basisStatus: "pinned",
      deadline: { status: "unknown" },
    });
    expect(JSON.stringify(value)).not.toMatch(
      /Private customer text|Private operator instructions|encryptedDraft|encryptedDataKey|tenantId/,
    );
    const unavailable = await review.get(context, source.lineId);
    expect(unavailable.profit).toMatchObject({ status: "unavailable", profitMinor: null });
    expect(unavailable.facts).toEqual([]);
    await expect(
      review.get({ ...financeContext, tenantId: otherTenant }, source.lineId),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      review.get({ ...financeContext, dataScope: "self" }, source.lineId),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      review.get({ ...financeContext, permissions: ["order:read", "finance:read"] }, source.lineId),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(finance.orderEvidence({ ...financeContext, tenantId: otherTenant }, [orderId])).rejects.toBeInstanceOf(ForbiddenError);
    await finance.recordStatement(financeContext, {
      accountId: null,
      provider: "manual",
      statementKind: "operational_cost",
      externalStatementId: `SYNTHETIC-LATE-COST-${orderId}`,
      sourceIdentity: { schemaVersion: 2, kind: "named_source", sourceName: "SYNTHETIC-ORDER-REVIEW" },
      periodStart: now,
      periodEnd: now,
      sourceCurrency: "USD",
      observedAt: now,
      idempotencyKey: randomUUID(),
      lines: [
        {
          lineKey: "new-cost",
          sourceEntryId: `synthetic-order:${orderId}:late-other-fee`,
          factType: "other_fee",
          direction: "debit",
          amountMinor: 10,
          currency: "USD",
          occurredAt: now,
          externalReference: null,
          orderId,
          orderLineId: null,
          skuId: null,
          listingId: null,
          supplierId: null,
          correctionKind: "original",
          correctsFactId: null,
        },
      ],
    });
    expect((await review.get(financeContext, source.lineId)).profit).toMatchObject({
      status: "incomplete",
      profitMinor: null,
    });
    } finally { await restoreFinance(); }
  });

  it("reports bounded review cohorts through RLS and marks independent failed reads explicitly", async () => {
    const restoreFinance = await grantFinanceForCase(["finance:read"]);
    try {
    const source = await imported(),
      detail = await save(await work.detail(context, source.lineId));
    const financeContext = { ...context, permissions: [...context.permissions, "finance:read"] };
    const finance = new FinanceService(database, audit),
      deliveries = new OrderProductionDeliveryService(
        database,
        vault,
        editor,
        production,
        audit,
        factories,
      );
    const review = new OrderReviewService(
      work,
      production,
      shipments,
      afterSales,
      deliveries,
      finance,
      database,
      vault,
    );
    const from = new Date(Date.now() - 60000).toISOString(),
      to = new Date(Date.now() + 60000).toISOString();
    const cohort = await review.workspace(financeContext, { from, to, sku: "TEST-CENTER-SKU" });
    expect(cohort.orders.some((order) => order.orderId === detail.line.orderId)).toBe(true);
    expect(
      (await review.workspace({ ...financeContext, tenantId: otherTenant }, { from, to }))
        .orderCount,
    ).toBe(0);
    await expect(
      review.workspace(financeContext, {
        from: "2026-01-01T00:00:00Z",
        to: "2026-10-01T00:00:00Z",
      }),
    ).rejects.toThrow();
    const failed = vi
      .spyOn(shipments, "list")
      .mockRejectedValueOnce(new Error("Synthetic sensitive internal failure"));
    try {
      const partial = await review.get(financeContext, source.lineId);
      expect(partial.diagnostics).toContain("交运证据暂时无法读取，请重试");
      expect(partial.lines[0]!.deadline.status).toBe("unknown");
      expect(partial.profit.profitMinor).toBeNull();
      expect(JSON.stringify(partial)).not.toContain("sensitive internal");
    } finally {
      failed.mockRestore();
    }
    const productionFailed = vi
      .spyOn(production, "list")
      .mockRejectedValueOnce(new Error("Synthetic production failure"));
    try {
      const partial = await review.get(financeContext, source.lineId);
      expect(partial.lines[0]).toMatchObject({
        factoryStatus: "unknown",
        remakeCount: null,
        remakeQuantity: null,
      });
    } finally {
      productionFailed.mockRestore();
    }
    } finally { await restoreFinance(); }
  });

  it("retains cancelled and historical label fees while resolving unknown current fees only from explicit carrier bills", async () => {
    const restoreFinance = await grantFinanceForCase(["finance:read", "finance:write"]);
    try {
    const source = await imported(),
      detail = await save(await work.detail(context, source.lineId));
    const shipmentId = createEntityId(),
      oldVersion = createEntityId(),
      currentVersion = createEntityId(),
      oldPackage = createEntityId(),
      currentPackage = createEntityId();
    const [stock] = await syntheticPassedProduction(database, context, detail.line.orderId, [{ id: source.lineId, quantity: 2 }], undefined, {
      vault, workSources: new Map([[source.lineId, { revisionId: detail.versions.find(version => version.revision === detail.line.revision)!.id,
        manufacturing: manufacturingForLine.get(source.lineId)!.manufacturing }]]),
    });
    // Carrier occurrence times are explicit evidence. Docker's database clock
    // can lead the application clock; SQL now() makes this fixture intermittently
    // look like future evidence. Keep both past and future cases deterministic.
    const evidenceAt = new Date(Date.now() - 60_000).toISOString();
    const futureEvidenceAt = new Date(Date.now() + 86_400_000).toISOString();
    await withTenant(database.db, context, async (tx) => {
      await tx.execute(
        sql`insert into shipments(id,tenant_id,order_id,status,current_version_number,approved_version_number,idempotency_key) values(${shipmentId},${tenantId},${detail.line.orderId},'approved',2,2,${randomUUID()})`,
      );
      for (const [versionId, number, packageId, cost] of [
        [oldVersion, 1, oldPackage, 250],
        [currentVersion, 2, currentPackage, null],
      ] as const) {
        await tx.execute(
          sql`insert into shipment_versions(id,tenant_id,shipment_id,version_number,ship_date,ship_from_country_code,idempotency_key,production_source_version,request_checksum,created_by) values(${versionId},${tenantId},${shipmentId},${number},now(),'CN',${randomUUID()},2,${"a".repeat(64)},${context.userId})`,
        );
        await tx.execute(
          sql`insert into shipment_packages(id,tenant_id,shipment_id,shipment_version_id,package_reference_id,tracking_number,carrier_code,carrier_name,carrier_service,external_label_id,label_cost_minor,label_currency) values(${packageId},${tenantId},${shipmentId},${versionId},${`SYNTHETIC-${number}`},${`SYNTHETIC-TRACK-${number}`},'MANUAL','Synthetic','Synthetic',${`SYNTHETIC-LABEL-${number}`},${cost},${cost === null ? null : "USD"})`,
        );
        const packageLineId = createEntityId();
        await tx.execute(
          sql`insert into shipment_package_lines(id,tenant_id,shipment_id,shipment_version_id,package_id,order_line_id,quantity) values(${packageLineId},${tenantId},${shipmentId},${versionId},${packageId},${source.lineId},1)`,
        );
        await tx.execute(sql`insert into shipment_production_allocations(id,tenant_id,shipment_id,shipment_version_id,package_id,package_line_id,order_line_id,production_order_id,production_version_id,quality_inspection_id,production_projection_version,quantity)
          values(${createEntityId()},${tenantId},${shipmentId},${versionId},${packageId},${packageLineId},${source.lineId},${stock!.productionOrderId},${stock!.productionVersionId},${stock!.qualityInspectionId},5,1)`);
      }
      await tx.execute(
        sql`insert into shipment_tracking_events(id,tenant_id,shipment_id,package_id,status,provider,external_event_id,detail_code,occurred_at) values(${createEntityId()},${tenantId},${shipmentId},${oldPackage},'picked_up','synthetic',${randomUUID()},'SYNTHETIC',${evidenceAt}::timestamptz)`,
      );
      await tx.execute(
        sql`insert into shipment_tracking_events(id,tenant_id,shipment_id,package_id,status,provider,external_event_id,detail_code,occurred_at) values(${createEntityId()},${tenantId},${shipmentId},${currentPackage},'in_transit','synthetic',${randomUUID()},'SYNTHETIC',${futureEvidenceAt}::timestamptz)`,
      );
    });
    const financeContext = {
      ...context,
      permissions: [...context.permissions, "finance:read", "finance:write"],
    };
    const finance = new FinanceService(database, audit),
      deliveries = new OrderProductionDeliveryService(
        database,
        vault,
        editor,
        production,
        audit,
        factories,
      );
    const review = new OrderReviewService(
      work,
      production,
      shipments,
      afterSales,
      deliveries,
      finance,
      database,
      vault,
    );
    const before = await review.get(financeContext, source.lineId);
    expect(before.costs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: oldPackage, amountMinor: 250, current: true }),
        expect.objectContaining({ id: currentPackage, basis: "unknown", amountMinor: null }),
      ]),
    );
    expect(before.lines[0]!.deadline.handedOverQuantity).toBe(0);
    const now = new Date().toISOString();
    await finance.recordStatement(financeContext, {
      accountId: null,
      provider: "manual",
      statementKind: "operational_cost",
      externalStatementId: `SYNTHETIC-BILL-${shipmentId}`,
      sourceIdentity: { schemaVersion: 2, kind: "named_source", sourceName: "SYNTHETIC-ORDER-REVIEW" },
      periodStart: now,
      periodEnd: now,
      sourceCurrency: "USD",
      observedAt: now,
      idempotencyKey: randomUUID(),
      lines: [oldPackage, currentPackage].map((id, index) => ({
        lineKey: String(index),
        sourceEntryId: `shipment-package:${id}:booked-carrier-cost`,
        factType: "carrier_cost",
        direction: "debit",
        amountMinor: index ? 325 : 250,
        currency: "USD",
        occurredAt: now,
        externalReference: `shipment-package:${id}`,
        orderId: detail.line.orderId,
        orderLineId: null,
        skuId: null,
        listingId: null,
        supplierId: null,
        correctionKind: "original",
        correctsFactId: null,
      })),
    });
    const booked = await review.get(financeContext, source.lineId);
    expect(booked.costs.find((cost) => cost.id === currentPackage)).toMatchObject({
      basis: "confirmed",
      amountMinor: 325,
    });
    expect(
      booked.costs
        .filter((cost) => cost.source === "shipment")
        .every((cost) => cost.ledgerFactIds.length === 1),
    ).toBe(true);
    await withTenant(database.db, context, (tx) =>
      tx.execute(
        sql`insert into shipment_tracking_events(id,tenant_id,shipment_id,package_id,status,provider,external_event_id,detail_code,occurred_at) values(${createEntityId()},${tenantId},${shipmentId},${currentPackage},'delivered','synthetic',${randomUUID()},'SYNTHETIC',${evidenceAt}::timestamptz)`,
      ),
    );
    const deliveredOnly = await review.get(financeContext, source.lineId);
    expect(deliveredOnly.lines[0]!.deadline).toMatchObject({
      handedOverQuantity: 1,
      handedOverAt: null,
      status: "unknown",
    });
    expect(deliveredOnly.lines[0]!.blockers).toContain(
      "物流已推进，但缺少实际揽收时间，准时情况待核对",
    );
    await withTenant(database.db, context, (tx) =>
      tx.execute(sql`update shipments set status='cancelled' where id=${shipmentId}`),
    );
    const cancelled = await review.get(financeContext, source.lineId);
    expect(cancelled.costs.filter((cost) => cost.source === "shipment")).toHaveLength(2);
    expect(cancelled.lines[0]!.deadline.handedOverQuantity).toBe(0);
    } finally { await restoreFinance(); }
  });

  it("keeps every cancelled model attempt and confirms unknown provider costs only from attributed booked bills", async () => {
    const restoreFinance = await grantFinanceForCase(["finance:read", "finance:write"]);
    try {
    const source = await imported(),
      first = await save(await work.detail(context, source.lineId)),
      second = await save(first);
    const runIds = [createEntityId(), createEntityId()];
    await withTenant(database.db, context, async (tx) => {
      for (const [index, detail] of [first, second].entries())
        await tx.insert(orderDesignAgentRuns).values({
          id: runIds[index]!,
          tenantId,
          workItemId: source.lineId,
          workRevisionId: detail.versions.find(
            (version) => version.revision === detail.line.revision,
          )!.id,
          status: "cancelled",
          executorKey: "synthetic-read-fixture",
          recipeVersion: "synthetic",
          policyVersion: "synthetic",
          encryptedSnapshot: vault.encrypt("Synthetic unused cancelled snapshot"),
          inputChecksum: "a".repeat(64),
          requestedBy: userId,
          costStatus: index ? "reported" : "unknown",
          actualCostUsd: index ? "0.400000" : null,
          estimatedCostUsd: "5.000000",
        });
    });
    const repository = new OrderDesignRepository(database, vault);
    expect((await repository.costEvidence(context, [source.lineId])).runs).toHaveLength(2);
    expect(
      (await repository.costEvidence({ ...context, tenantId: otherTenant }, [source.lineId])).runs,
    ).toEqual([]);
    await expect(
      repository.costEvidence({ ...context, dataScope: "self" }, [source.lineId]),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const financeContext = {
      ...context,
      permissions: [...context.permissions, "finance:read", "finance:write"],
    };
    const finance = new FinanceService(database, audit),
      deliveries = new OrderProductionDeliveryService(
        database,
        vault,
        editor,
        production,
        audit,
        factories,
      );
    const review = new OrderReviewService(
      work,
      production,
      shipments,
      afterSales,
      deliveries,
      finance,
      database,
      vault,
    );
    const unknown = await review.get(financeContext, source.lineId);
    expect(unknown.costs.find((cost) => cost.id === runIds[0])).toMatchObject({
      basis: "unknown",
      amountUsd: null,
      ledgerFactIds: [],
    });
    const now = new Date().toISOString();
    await finance.recordStatement(financeContext, {
      accountId: null,
      provider: "manual",
      statementKind: "operational_cost",
      externalStatementId: `SYNTHETIC-MODEL-BILL-${source.lineId}`,
      sourceIdentity: { schemaVersion: 2, kind: "named_source", sourceName: "SYNTHETIC-ORDER-REVIEW" },
      periodStart: now,
      periodEnd: now,
      sourceCurrency: "USD",
      observedAt: now,
      idempotencyKey: randomUUID(),
      lines: runIds.map((id, index) => ({
        lineKey: String(index),
        sourceEntryId: `order-design-run:${id}:booked-provider-cost`,
        factType: "other_fee",
        direction: "debit",
        amountMinor: index ? 40 : 65,
        currency: "USD",
        occurredAt: now,
        externalReference: `order-design-run:${id}`,
        orderId: first.line.orderId,
        orderLineId: source.lineId,
        skuId: null,
        listingId: null,
        supplierId: null,
        correctionKind: "original",
        correctsFactId: null,
      })),
    });
    const booked = await review.get(financeContext, source.lineId);
    expect(booked.costs.find((cost) => cost.id === runIds[0])).toMatchObject({
      basis: "confirmed",
      amountUsd: 0.65,
    });
    expect(
      booked.costs
        .filter((cost) => cost.source === "model")
        .every((cost) => cost.ledgerFactIds.length === 1),
    ).toBe(true);
    expect(JSON.stringify(booked)).not.toMatch(/unused cancelled snapshot|encryptedSnapshot/);
    } finally { await restoreFinance(); }
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
