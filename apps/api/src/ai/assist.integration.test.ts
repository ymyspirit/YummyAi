import { createHash, randomUUID } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Permission, ForbiddenError } from "@yummyai/authz";
import { SecretVault, OpenAiCompatibleProvider } from "@yummyai/ai-core";
import {
  CaptureDraftSchema,
  createEntityId,
  type ProductionEditorDocument,
  type ProductionEditorImageView,
  type TenantContext,
} from "@yummyai/contracts";
import { CreativeRequirementsSchema } from "@yummyai/contracts/catalog/artwork";
import { AssistResultSchema, type CreateAssist } from "@yummyai/contracts/ai/assist";
import {
  aiAssistRuns,
  assetFiles,
  personalizationTemplateSourceInspections,
  aiBudgetLedger,
  aiBudgetPolicies,
  connectDatabase,
  marketplaceAccounts,
  memberships,
  membershipRoles,
  migrateDatabase,
  modelProviderConfigs,
  modelRoutes,
  modelPreferences,
  roles,
  fulfillmentSuppliers,
  withTenant,
} from "@yummyai/database";
import { JobEnvelopeSchema } from "@yummyai/jobs";
import {
  assertAssetAccess,
  type AssetDomain,
  type PutPrivateInput,
  type Storage,
  type StoredAsset,
} from "@yummyai/storage";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import JSZip from "jszip";
import { AiAssistProcessor, assistPricing } from "../../../worker/src/processors/ai-assist.processor.js";
import { AuditService } from "../audit/audit.service.js";
import { CaptureService } from "../capture/capture.service.js";
import { ResearchClassificationService } from "../research/research-classification.service.js";
import { OrderService } from "../orders/order.service.js";
import { AmazonOrderReportService } from "../orders/amazon-order-report.service.js";
import { OrderWorkspaceService } from "../orders/order-workspace.service.js";
import { ProductionEditorService } from "../design/production-editor.service.js";
import { AssistContextService } from "./assist-context.service.js";
import { AssistService } from "./assist.service.js";
import { AssistCatalogContextService } from "./assist-catalog-context.service.js";
import { AssistBusinessContextService } from "./assist-business-context.service.js";
import { FinanceService } from "../finance/finance.service.js";
import { InventoryService } from "../inventory/inventory.service.js";
import { ProcurementService } from "../procurement/procurement.service.js";
import { OrderAfterSalesService } from "../orders/order-after-sales.service.js";
import { PodPersonalizationService } from "../design/pod-personalization.service.js";
import { SalesPackageService } from "../catalog/sales-package.service.js";
import { ListingService, DrizzleListingRepository } from "../listings/listing.service.js";

describe("AI assists use real tenant services and immutable background tasks", () => {
  const database = connectDatabase();
  const context: TenantContext = {
    tenantId: createEntityId(),
    userId: createEntityId(),
    permissions: Object.values(Permission),
    dataScope: "tenant",
  };
  const other = { ...context, tenantId: createEntityId(), userId: createEntityId() };
  const modelVault = new SecretVault(Buffer.alloc(32, 42)),
    contentVault = new SecretVault(Buffer.alloc(32, 43)),
    orderVault = new SecretVault(Buffer.alloc(32, 44));
  const providerId = createEntityId(),
    accountId = createEntityId(),
    membershipId = createEntityId();
  const objects = new Map<string, Uint8Array>();
  const storage = {
    putPrivate: async (ctx: TenantContext, input: PutPrivateInput) => {
      const checksumSha256 = createHash("sha256").update(input.body).digest("hex"),
        objectKey = `tenants/${ctx.tenantId}/${input.domain}/${checksumSha256}/${input.fileName}`;
      objects.set(objectKey, input.body);
      return { objectKey, checksumSha256, deduplicated: false };
    },
    readPrivate: async (
      ctx: TenantContext,
      asset: StoredAsset,
      options: { requiredDomain: AssetDomain },
    ) => {
      assertAssetAccess(ctx, asset, options.requiredDomain);
      const body = objects.get(asset.objectKey);
      if (!body) throw new Error("Missing synthetic blob");
      return body;
    },
  } as unknown as Storage;
  const audit = new AuditService(database),
    orders = new OrderService(database, orderVault, audit);
  const scan = async () => ({
    result: "clean" as const,
    engine: "synthetic",
    signatureVersion: "1",
    scannedAt: new Date().toISOString(),
  });
  const reports = new AmazonOrderReportService(
    database,
    orderVault,
    orders,
    audit,
    {
      download: async () => {
        throw new Error("No network in fixture");
      },
      scan,
    },
    { schedule: async () => undefined },
  );
  const editor = new ProductionEditorService(
    database,
    orderVault,
    storage,
    reports,
    audit,
    { enqueue: async () => undefined },
    { scan },
  );
  const workspace = new OrderWorkspaceService(database, orderVault, storage, reports, editor, {
    scan,
  });
  const templates = new PodPersonalizationService(database, { enqueue: vi.fn() }, audit);
  const catalog = new AssistCatalogContextService(
    templates,
    new SalesPackageService(
      database,
      new ListingService(new DrizzleListingRepository(database)),
      storage,
    ),
  );
  const finance = new FinanceService(database, audit),
    inventory = new InventoryService(database, audit);
  const procurement = new ProcurementService(database, inventory, audit);
  const afterSales = new OrderAfterSalesService(database, orderVault, audit);
  const business = new AssistBusinessContextService(finance, procurement, afterSales, workspace);
  const contexts = new AssistContextService(
    database,
    workspace,
    reports,
    editor,
    catalog,
    business,
  );
  const enqueue = vi.fn(async () => undefined);
  const assists = new AssistService(database, contentVault, contexts, { enqueue });
  const captures = new CaptureService(
    database,
    { enqueue: async () => undefined },
    audit,
    new ResearchClassificationService(database, audit),
  );
  let modelId: string,
    source: { researchItemId: string; snapshotId: string },
    lineId: string,
    profileId: string;
  let observedBody: Record<string, unknown> = {},
    usage = true,
    fail = false;
  const creativeOutput = () =>
    AssistResultSchema.parse({
      summary: "依据合成研究给出原创建议",
      findings: [
        {
          title: "定制场景",
          detail: "资料说明可定制名字",
          kind: "fact",
          severity: "info",
          evidence: [{ sourceId: source.snapshotId, detail: "采集的定制说明" }],
          location: null,
        },
      ],
      directions: [1, 2, 3].map((n) => ({
        title: `原创方向 ${n}`,
        rationale: "差异化构图",
        prompt: "设计原创几何图案，预留名字位置",
        negativePrompt: "不要复制竞品",
        requirements: {
          mode: "personalized_text",
          audience: "礼物购买者",
          style: "原创几何",
          acceptance: "文字可编辑",
        },
        fields: [
          {
            key: "name",
            label: "名字",
            type: "short_text",
            required: true,
            maxLength: 20,
            helpText: "保留买家原文",
          },
        ],
        evidence: [{ sourceId: source.snapshotId, detail: "研究中的场景" }],
      })),
      matches: [],
      missingInformation: [],
    });
  let templateOutput: ReturnType<typeof AssistResultSchema.parse> | undefined;
  const modelFetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    observedBody = JSON.parse(String(init?.body));
    if (fail)
      return new Response("synthetic secret buyer private provider failure", { status: 500 });
    const serialized = JSON.stringify(observedBody);
    const value =
      templateOutput ??
      (serialized.includes('\\"kind\\":\\"creative\\"') || serialized.includes('"kind":"creative"')
        ? creativeOutput()
        : {
            summary: "需要人工核对排版",
            findings: [],
            directions: [],
            matches: [],
            missingInformation: ["请人工核对最终视觉稿"],
          });
    return Response.json({
      choices: [{ message: { content: JSON.stringify(value) } }],
      ...(usage ? { usage: { prompt_tokens: 120, completion_tokens: 300 } } : {}),
    });
  });
  const processor = new AiAssistProcessor(
    database,
    modelVault,
    contentVault,
    (provider, key, row) =>
      new OpenAiCompatibleProvider({
        providerId: provider.id,
        endpoint: "https://provider.example.test",
        apiKey: key,
        pricing: assistPricing(row.modelSnapshot),
        fetch: modelFetch as typeof fetch,
      }),
    async () => new Response(await image(), { headers: { "content-type": "image/png" } }),
  );
  const envelope = (id: string) =>
    JobEnvelopeSchema.parse({
      jobId: id,
      tenantId: context.tenantId,
      requestedBy: context.userId,
      correlationId: id,
      idempotencyKey: id,
      payload: { runId: id, operation: "analyze" },
    });
  const image = () =>
    sharp({
      create: {
        width: 256,
        height: 256,
        channels: 4,
        background: { r: 60, g: 120, b: 170, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
  const document = (): ProductionEditorDocument => ({
    schemaVersion: 1,
    name: "Synthetic AI preflight",
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
  const creativeRequest = (): CreateAssist => ({
    kind: "creative",
    requestId: randomUUID(),
    scopeId: randomUUID(),
    modelId,
    sources: [
      {
        researchItemId: source.researchItemId,
        snapshotId: source.snapshotId,
        studyRevisionId: null,
      },
    ],
    requirements: CreativeRequirementsSchema.parse({
      mode: "fixed",
      researchItemIds: [source.researchItemId],
    }),
    prompt: "使用合成资料分析原创方向",
  });

  beforeAll(async () => {
    await migrateDatabase(database);
    for (const ctx of [context, other]) {
      await database.client.unsafe(
        "insert into organizations(id,name,slug) values($1,'Isolated AI assist fixture',$2)",
        [ctx.tenantId, `ai-assist-${ctx.tenantId}`],
      );
      await database.client.unsafe(
        "insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic AI operator')",
        [ctx.userId, `assist-${ctx.userId}`, `${ctx.userId}@example.test`],
      );
    }
    await withTenant(database.db, context, async (tx) => {
      const roleId = createEntityId();
      await tx.insert(memberships).values({
        id: membershipId,
        tenantId: context.tenantId,
        userId: context.userId,
        status: "active",
      });
      await tx.insert(roles).values({
        id: roleId,
        tenantId: context.tenantId,
        name: "Synthetic role",
        permissions: context.permissions,
        dataScope: "tenant",
      });
      await tx.insert(membershipRoles).values({ tenantId: context.tenantId, membershipId, roleId });
      await tx.insert(modelProviderConfigs).values({
        id: providerId,
        tenantId: context.tenantId,
        label: "Synthetic channel",
        provider: "openai-compatible",
        endpoint: "https://provider.example.test",
        encryptedApiKey: modelVault.encrypt("synthetic-key"),
        status: "enabled",
        createdBy: context.userId,
      });
      await tx.insert(marketplaceAccounts).values({
        id: accountId,
        tenantId: context.tenantId,
        platform: "amazon",
        displayName: "Synthetic AI shop",
        region: "NA",
        authorizationMode: "amazon_private",
        marketplaceIds: ["ATVPDKIKX0DER"],
        createdBy: context.userId,
      });
    });
    modelId = (
      await assists.addModel(context, {
        providerConfigId: providerId,
        model: "synthetic-vision",
        label: "Synthetic analysis",
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 2,
        maxTaskCostUsd: 1,
      })
    ).id;
    source = await captures.createSnapshot(
      context,
      CaptureDraftSchema.parse({
        platform: "etsy",
        parserVersion: "etsy@1.0.0",
        extensionVersion: "0.0.0",
        marketplace: "www.etsy.com",
        sourceUrl: `https://www.etsy.com/listing/${Date.now()}/synthetic`,
        externalId: String(Date.now()),
        title: "Synthetic custom gift",
        domain: "research",
        capturedAt: new Date().toISOString(),
        price: null,
        rating: null,
        reviewCount: null,
        taxonomy: [],
        listingPublishedAt: null,
        favoriteCount: null,
        shipping: null,
        shop: null,
        reviewSummary: null,
        reviews: [],
        reviewCollection: {
          collectedCount: 0,
          reportedTotal: null,
          pageCount: 0,
          status: "visible",
          updatedAt: new Date().toISOString(),
        },
        bullets: [],
        variants: [],
        contentBlocks: [
          { kind: "personalization", text: "可定制名字", sourceSelector: "#synthetic" },
        ],
        missingFields: [],
        diagnostics: [],
        captureStatus: "complete",
        media: [
          {
            id: "one",
            kind: "image",
            sourceUrl: "https://i.etsystatic.com/synthetic.png",
            included: true,
          },
        ],
      }),
    );
    let template = await editor.create(context, {
      name: "Synthetic AI template",
      document: document(),
    });
    const asset = (await editor.upload(
      context,
      template.project.id,
      "synthetic.png",
      await image(),
    )) as ProductionEditorImageView;
    const doc = document();
    doc.layers = [
      {
        id: "print",
        kind: "image",
        name: "Synthetic print",
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
      document: doc,
    });
    await editor.review(context, template.project.id, template.version.id);
    profileId = (
      await workspace.saveProfile(context, {
        code: "SYNTHETIC-AI-PROFILE",
        name: "Synthetic AI profile",
        projectId: template.project.id,
        versionId: template.version.id,
        instructions: "Fixture",
        expectedVersion: 0,
        idempotencyKey: randomUUID(),
      })
    )[0]!.versionId;
    const externalOrderId = `AI-${createEntityId()}`,
      externalLineId = `LINE-${createEntityId()}`;
    const batch = await reports.importReport(context, {
      accountId,
      marketplaceId: "ATVPDKIKX0DER",
      fileName: "synthetic.txt",
      content: `order-id\torder-item-id\tpurchase-date\tsku\tproduct-name\tquantity-purchased\tcurrency\titem-price\tcustomized-url\n${externalOrderId}\t${externalLineId}\t${new Date().toISOString()}\tSYNTHETIC-AI\tSynthetic gift\t1\tUSD\t20\thttps://zme-caps.amazon.com/synthetic`,
    });
    const report = (await reports.workspace(context, { batchId: batch.id })).lines[0]!;
    lineId = report.orderLineId;
    const zip = new JSZip();
    zip.file(
      "order.json",
      JSON.stringify({
        orderId: externalOrderId,
        orderItemId: externalLineId,
        customizationData: {
          type: "PageContainerCustomization",
          children: [
            {
              type: "TextPrintingCustomization",
              label: "名字",
              inputValue: "PRIVATE-SYNTHETIC-NAME",
            },
          ],
        },
      }),
    );
    await reports.process(
      context,
      report.id,
      null,
      await zip.generateAsync({ type: "nodebuffer" }),
    );
  }, 60000);
  afterAll(async () => {
    objects.clear();
    await database.client.end();
  });

  it("uses configured models, sends actual research images and rejects tenant/owner access and mutation", async () => {
    expect(await assists.models(other)).toEqual([]);
    const input = creativeRequest(),
      task = await assists.create(context, input);
    expect(task.status).toBe("queued");
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect((await assists.create(context, input)).id).toBe(task.id);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls[0]).toEqual(enqueue.mock.calls[1]);
    await expect(assists.create(context, { ...input, prompt: "changed" })).rejects.toThrow(
      "同一请求",
    );
    await expect(assists.get(other, task.id)).rejects.toThrow("不存在");
    await expect(assists.get({ ...context, userId: other.userId }, task.id)).rejects.toThrow(
      "不存在",
    );
    await expect(
      assists.create({ ...context, permissions: [] }, creativeRequest()),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(
      await withTenant(database.db, other, (tx) =>
        tx.select().from(aiAssistRuns).where(eq(aiAssistRuns.id, task.id)),
      ),
    ).toEqual([]);
    const [stored] = await withTenant(database.db, context, (tx) =>
      tx.select().from(aiAssistRuns).where(eq(aiAssistRuns.id, task.id)),
    );
    expect(stored!.encryptedInput).not.toContain("Synthetic custom gift");
    await processor.process(envelope(task.id));
    const done = await assists.get(context, task.id);
    expect(done.status).toBe("completed");
    expect(done.result?.directions).toHaveLength(3);
    expect(done.costUsd).toBeGreaterThan(0);
    expect(JSON.stringify(observedBody)).toContain("data:image/jpeg;base64,");
    expect(JSON.stringify(observedBody)).not.toContain("synthetic-key");
    expect(done.images).toHaveLength(1);
    expect((await sharp(await assists.image(context, task.id, 0)).metadata()).format).toBe("jpeg");
    await expect(assists.image(other, task.id, 0)).rejects.toThrow("不存在");
    const calls = modelFetch.mock.calls.length;
    await processor.process(envelope(task.id));
    expect(modelFetch).toHaveBeenCalledTimes(calls);
    await expect(
      withTenant(database.db, context, (tx) =>
        tx
          .update(aiAssistRuns)
          .set({ inputFingerprint: "changed" })
          .where(eq(aiAssistRuns.id, task.id)),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(database.db, context, (tx) =>
        tx.update(aiAssistRuns).set({ status: "queued" }).where(eq(aiAssistRuns.id, task.id)),
      ),
    ).rejects.toThrow();
  });

  it("preserves unknown costs, sanitizes failures and never automatically repeats a paid request", async () => {
    usage = false;
    const unknown = await assists.create(context, creativeRequest());
    await processor.process(envelope(unknown.id));
    expect(await assists.get(context, unknown.id)).toMatchObject({
      status: "completed",
      costUsd: null,
      inputTokens: null,
    });
    const [ledger] = await withTenant(database.db, context, (tx) =>
      tx.select().from(aiBudgetLedger).where(eq(aiBudgetLedger.requestId, unknown.id)),
    );
    expect(ledger!.state).toBe("reserved");
    usage = true;
    fail = true;
    const failed = await assists.create(context, creativeRequest());
    await processor.process(envelope(failed.id));
    fail = false;
    const view = await assists.get(context, failed.id);
    expect(view.status).toBe("failed");
    expect(JSON.stringify(view)).not.toContain("secret buyer private");
    const calls = modelFetch.mock.calls.length;
    await processor.process(envelope(failed.id));
    expect(modelFetch).toHaveBeenCalledTimes(calls);
  });

  it("does not push an order or rewrite customer fields, and marks the result stale after a save", async () => {
    let detail = await workspace.detail(context, lineId);
    const task = await assists.create(context, {
      kind: "order_review",
      orderLineId: lineId,
      expectedRevision: detail.line.revision,
      expectedSourceVersionId: detail.report?.versionId ?? null,
      requestId: randomUUID(),
      modelId,
    });
    await processor.process(envelope(task.id));
    expect((await workspace.detail(context, lineId)).line).toMatchObject({
      revision: 0,
      preparation: "pending_review",
      artwork: "not_pushed",
    });
    detail = await workspace.save(context, lineId, {
      expectedRevision: 0,
      expectedSourceVersionId: detail.report?.versionId ?? null,
      draft: {
        ...detail.draft,
        printProfileVersionId: profileId,
        fields: [{ key: "name", kind: "text", label: "名字", value: "PRIVATE-SYNTHETIC-NAME" }],
        instructions: "保留买家原文",
      },
      status: "ready_to_push",
      reason: "Synthetic review",
      idempotencyKey: randomUUID(),
    });
    expect(await assists.get(context, task.id)).toMatchObject({ stale: true, result: null });
    await expect(
      assists.create(context, {
        kind: "order_review",
        orderLineId: lineId,
        expectedRevision: 0,
        expectedSourceVersionId: detail.report?.versionId ?? null,
        requestId: randomUUID(),
        modelId,
      }),
    ).rejects.toThrow("已更新");
  });

  it("preflights actual production pixels without export or approval, then invalidates an old editor version", async () => {
    let detail = await workspace.detail(context, lineId);
    for (const action of ["push", "start_artwork"] as const)
      detail = await workspace.action(context, lineId, {
        action,
        expectedRevision: detail.line.revision,
        expectedProjectionVersion: detail.line.projectionVersion,
        reason: "Synthetic controlled handoff",
        idempotencyKey: randomUUID(),
      });
    const file = await editor.get(context, detail.line.editorProjectId!);
    const task = await assists.create(context, {
      kind: "artwork_preflight",
      orderLineId: lineId,
      expectedRevision: detail.line.revision,
      expectedEditorVersionId: file.version.id,
      modelId,
      requestId: randomUUID(),
    });
    expect(task.checks.some((c) => c.code === "text_not_in_layers")).toBe(true);
    await processor.process(envelope(task.id));
    expect((await assists.get(context, task.id)).status).toBe("completed");
    expect(JSON.stringify(observedBody)).toContain("production-preview");
    expect((await editor.get(context, file.project.id)).renders).toHaveLength(file.renders.length);
    expect((await workspace.detail(context, lineId)).line.artwork).toBe("in_progress");
    await editor.save(context, file.project.id, {
      expectedVersionId: file.version.id,
      document: { ...file.version.document, name: "Synthetic revised production file" },
    });
    expect(await assists.get(context, task.id)).toMatchObject({ stale: true, result: null });
  });

  it("analyzes authorized PSD structure through the worker without creating or approving a template", async () => {
    const assetId = createEntityId();
    await withTenant(database.db, context, (tx) =>
      tx.insert(assetFiles).values({
        id: assetId,
        tenantId: context.tenantId,
        assetDomain: "authorized",
        objectKey: `tenants/${context.tenantId}/authorized/synthetic-template.psd`,
        fileName: "synthetic-template.psd",
        mediaType: "image/vnd.adobe.photoshop",
        byteSize: 100,
        checksumSha256: "f".repeat(64),
        rightsStatus: "approved",
        rightsMetadata: { source: { kind: "original" } },
      }),
    );
    const inspection = await templates.createTemplateSourceInspection(context, {
      sourceAssetId: assetId,
      sourceAssetVersion: 1,
      idempotencyKey: createEntityId(),
    });
    const slot = {
      stableKey: "customer.name",
      name: "Name",
      kind: "text" as const,
      fillMode: "none" as const,
      replaceable: true,
      geometry: { x: 20, y: 20, width: 100, height: 30, rotationDegrees: 0 },
      validationSnapshot: {},
      confidencePermille: 800,
      sourceLayerPath: ["text", "name"],
    };
    await withTenant(database.db, context, (tx) =>
      tx
        .update(personalizationTemplateSourceInspections)
        .set({
          status: "completed",
          canvas: { width: 300, height: 300, dpi: 300, colorMode: "rgb" },
          slotSnapshot: [slot],
          completedAt: new Date(),
        })
        .where(eq(personalizationTemplateSourceInspections.id, inspection.id)),
    );
    templateOutput = AssistResultSchema.parse({
      summary: "建议绑定姓名字段",
      findings: [],
      directions: [],
      matches: [],
      missingInformation: [],
      templateSlots: [
        {
          stableKey: slot.stableKey,
          name: "Customer name",
          kind: "text",
          fillMode: "none",
          replaceable: true,
          fieldKey: "customer_name",
          reuseLabel: null,
          reason: "文字图层",
          evidence: [{ sourceId: slot.stableKey, detail: "图层名称" }],
        },
      ],
    });
    try {
      const request = {
        kind: "template_config" as const,
        inspectionId: inspection.id,
        modelId,
        requestId: randomUUID(),
      };
      await expect(assists.create(other, request)).rejects.toThrow();
      const task = await assists.create(context, request);
      expect(task.kind).toBe("template_config");
      await processor.process(envelope(task.id));
      const completed = await assists.get(context, task.id);
      expect(completed).toMatchObject({ status: "completed", stale: false });
      expect(completed.result?.templateSlots[0]?.fieldKey).toBe("customer_name");
      expect(
        (await templates.getTemplateSourceInspection(context, inspection.id)).slots[0]?.name,
      ).toBe("Name");
      const confirmed = await templates.confirmTemplateSourceInspection(context, inspection.id, {
        name: "Human reviewed template",
        acknowledgeWarnings: true,
        slots: [
          {
            stableKey: slot.stableKey,
            name: slot.name,
            kind: slot.kind,
            fillMode: slot.fillMode,
            replaceable: slot.replaceable,
            suggestedFieldKey: "customer_name",
          },
        ],
      });
      expect(confirmed.status).toBe("draft");
      expect(confirmed.slots[0]?.validationSnapshot.suggestedFieldKey).toBe("customer_name");
      await withTenant(database.db, context, (tx) =>
        tx.update(assetFiles).set({ rightsStatus: "rejected" }).where(eq(assetFiles.id, assetId)),
      );
      expect((await assists.get(context, task.id)).stale).toBe(true);
      await withTenant(database.db, context, (tx) =>
        tx.update(assetFiles).set({ deletedAt: new Date() }).where(eq(assetFiles.id, assetId)),
      );
      expect(
        (await templates.listTemplateSourceInspections(context)).items.some(
          (i) => i.id === inspection.id,
        ),
      ).toBe(false);
      expect((await templates.getTemplateSourceInspection(context, inspection.id)).id).toBe(
        inspection.id,
      );
    } finally {
      templateOutput = undefined;
    }
  });
  it("prepares real profit evidence, keeps missing costs unknown, and isolates analysis access", async () => {
    const line = await workspace.detail(context, lineId);
    const now = new Date().toISOString();
    const statement = await finance.recordStatement(context, {
      accountId: accountId,
      provider: "manual",
      statementKind: "manual_adjustment",
      externalStatementId: "AI-BUSINESS-REPORT",
      periodStart: now,
      periodEnd: now,
      sourceCurrency: "USD",
      observedAt: now,
      idempotencyKey: "ai-business-statement",
      lines: [
        {
          lineKey: "SALE",
          factType: "sale_revenue",
          direction: "credit",
          amountMinor: 7350,
          currency: "USD",
          occurredAt: now,
          externalReference: null,
          orderId: line.line.orderId,
          orderLineId: lineId,
          skuId: null,
          listingId: null,
          supplierId: null,
          correctionKind: "original",
          correctsFactId: null,
        },
      ],
    });
    const metric = await finance.upsertProfitMetric(context, {
      metricId: null,
      name: "AI evidence metric",
      reportingCurrency: "USD",
      revenueFactTypes: ["sale_revenue"],
      costFactTypes: ["production_cost"],
      requiredFactTypes: ["sale_revenue", "production_cost"],
      reasonCode: "ANALYSIS_FIXTURE",
      idempotencyKey: "ai-business-metric",
    });
    const run = await finance.calculateProfit(context, {
      metricId: metric.id,
      expectedMetricVersion: 1,
      statementIds: [statement.id],
      fxRateIds: [],
      idempotencyKey: "ai-business-calculation",
    });
    const selection = { kind: "business_review" as const, runId: run.id, comparisonRunId: null };
    const before = await finance.workspace(context),
      preview = await assists.previewBusiness(context, selection);
    expect(preview.rows).toContainEqual({ label: "贡献利润", value: "待补资料" });
    expect(preview.checks.some((c) => c.code === "finance_incomplete")).toBe(true);
    expect(preview.rows).toContainEqual({ label: "关联订单", value: "1" });
    expect(await finance.workspace(context)).toEqual(before);
    await expect(assists.previewBusiness(other, selection)).rejects.toThrow();
    await expect(
      assists.previewBusiness({ ...context, permissions: [Permission.OrderRead] }, selection),
    ).rejects.toThrow(ForbiddenError);
    expect(
      await assists.models({ ...context, permissions: [Permission.FinanceRead] }),
    ).toHaveLength(1);
    const request = {
      ...selection,
      expectedFingerprint: preview.fingerprint,
      modelId,
      requestId: randomUUID(),
    };
    const prepared = await contexts.prepare(context, request);
    expect(JSON.stringify(prepared.data)).not.toContain(line.line.externalOrderId);
    const task = await assists.create(context, request);
    await processor.process(envelope(task.id));
    expect(await assists.get(context, task.id)).toMatchObject({
      kind: "business_review",
      status: "completed",
      stale: false,
    });
    await expect(
      assists.create(context, {
        ...request,
        expectedFingerprint: "0".repeat(64),
        requestId: randomUUID(),
      }),
    ).rejects.toThrow(ConflictException);
  });

  it("uses scoped inventory, current purchase approval, immutable RFQ lines and detects changed snapshots", async () => {
    const warehouse = await inventory.createWarehouse(context, {
      code: "AI-WAREHOUSE",
      name: "Synthetic analysis warehouse",
      type: "owned",
      countryCode: "US",
      timeZone: "UTC",
    });
    const location = await inventory.createLocation(context, {
      warehouseId: warehouse.id,
      code: "AI-LOCATION",
      name: "Synthetic dock",
    });
    const stock = await inventory.createStockItem(context, {
      skuId: null,
      code: "AI-STOCK",
      name: "Synthetic blank",
      baseUnit: "each",
    });
    const selection = {
      kind: "procurement_review" as const,
      stockItemId: stock.id,
      locationId: location.id,
    };
    const empty = await business.preview(context, selection);
    expect(empty.checks.map((c) => c.code)).toEqual(
      expect.arrayContaining(["inventory_missing", "policy_missing", "quotes_missing"]),
    );
    await inventory.recordMovement(context, {
      stockItemId: stock.id,
      locationId: location.id,
      lotId: null,
      bucket: "physical",
      type: "adjustment",
      quantityDelta: 2,
      unit: "each",
      sourceType: "manual",
      sourceId: "ai-opening",
      reasonCode: "OPENING",
      occurredAt: new Date().toISOString(),
      idempotencyKey: "ai-stock-opening",
    });
    await procurement.upsertReplenishmentPolicy(context, {
      stockItemId: stock.id,
      locationId: location.id,
      reorderPoint: 10,
      safetyStock: 4,
      minimumOrderQuantity: 5,
      leadTimeDays: 7,
      serviceLevelBps: 9500,
      reviewIntervalDays: 7,
      idempotencyKey: "ai-policy-fixture",
    });
    const supplierId = createEntityId();
    await withTenant(database.db, context, (tx) =>
      tx
        .insert(fulfillmentSuppliers)
        .values({
          id: supplierId,
          tenantId: context.tenantId,
          name: "Synthetic analysis supplier",
          kind: "manual",
          status: "active",
          regionCode: "US",
          settlementCurrency: "USD",
          createdBy: context.userId,
        }),
    );
    const lines = [
      {
        lineKey: "BLANK",
        stockItemId: stock.id,
        destinationLocationId: location.id,
        quantity: 20,
        unit: "each" as const,
      },
    ];
    const requisition = await procurement.createRequisition(context, {
      code: "AI-REQ",
      reasonCode: "REORDER",
      lines,
      idempotencyKey: "ai-requisition-fixture",
    });
    const future = new Date(Date.now() + 7 * 86400000).toISOString();
    const rfq = await procurement.createRfq(context, requisition.id, {
      expectedRequisitionVersion: 1,
      supplierIds: [supplierId],
      responseDueAt: future,
      idempotencyKey: "ai-rfq-fixture",
    });
    const quote = await procurement.recordSupplierQuote(context, rfq.id, {
      supplierId,
      currency: "USD",
      validUntil: future,
      lines: [{ lineKey: "BLANK", unitCostMinor: 150, minimumOrderQuantity: 5, leadTimeDays: 4 }],
      idempotencyKey: "ai-quote-fixture",
    });
    const purchase = await procurement.createPurchaseOrder(context, {
      code: "AI-PO",
      supplierId,
      requisitionId: requisition.id,
      quoteId: quote.id,
      currency: "USD",
      expectedAt: future,
      lines: lines.map((l) => ({ ...l, unitCostMinor: 150 })),
      idempotencyKey: "ai-purchase-fixture",
    });
    const preview = await business.preview(context, selection);
    expect(preview.rows).toContainEqual({ label: "规则建议补货数量", value: "12" });
    expect(preview.rows).toContainEqual({ label: "有效报价行", value: "1" });
    const before = await procurement.workspace(context);
    const request = {
      ...selection,
      expectedFingerprint: preview.fingerprint,
      modelId,
      requestId: randomUUID(),
    };
    const task = await assists.create(context, request);
    await processor.process(envelope(task.id));
    expect((await assists.get(context, task.id)).status).toBe("completed");
    expect(await procurement.workspace(context)).toEqual(before);
    await expect(business.preview(other, selection)).rejects.toThrow();
    await expect(
      business.preview({ ...context, permissions: [Permission.ProcurementRead] }, selection),
    ).rejects.toThrow(ForbiddenError);
    await procurement.reviewPurchaseOrder(context, purchase.id, {
      decision: "approved",
      expectedVersion: 1,
      reasonCode: "APPROVED",
      idempotencyKey: "ai-purchase-approval",
    });
    const changed = await business.preview(context, selection);
    expect(changed.rows).toContainEqual({ label: "规则建议补货数量", value: "0" });
    expect(changed.fingerprint).not.toBe(preview.fingerprint);
    expect(await assists.get(context, task.id)).toMatchObject({ stale: true, result: null });
    await expect(contexts.prepare(context, request)).rejects.toThrow(ConflictException);
  });

  it("makes a private, version-bound after-sales reply without sending messages or exposing raw contacts", async () => {
    const detail = await workspace.detail(context, lineId);
    const record = await afterSales.create(context, detail.line.orderId, {
      type: "quality_issue",
      reasonCode: "SIZE_MISMATCH",
      summary: "SENSITIVE original buyer note private@example.test",
      idempotencyKey: "ai-after-sales-fixture",
    });
    await afterSales.recordContact(context, record.case.id, {
      channel: "marketplace",
      direction: "inbound",
      body: "SENSITIVE original customer message",
      externalMessageId: "PRIVATE-MESSAGE-ID",
      occurredAt: new Date().toISOString(),
      idempotencyKey: "ai-after-sales-contact",
    });
    const selection = {
      kind: "after_sales_review" as const,
      caseId: record.case.id,
      locale: "en-US" as const,
      contextNotes: "运营说明：客户反映尺寸不一致，尚无测量照片",
    };
    const preview = await business.preview(context, selection),
      request = {
        ...selection,
        expectedFingerprint: preview.fingerprint,
        modelId,
        requestId: randomUUID(),
      };
    const prepared = await contexts.prepare(context, request),
      before = await afterSales.get(context, record.case.id);
    expect(JSON.stringify(prepared)).not.toMatch(/SENSITIVE|private@example|PRIVATE-MESSAGE/);
    templateOutput = AssistResultSchema.parse({
      summary: "待核对测量证据",
      findings: [],
      directions: [],
      matches: [],
      missingInformation: ["测量照片"],
      actions: [
        {
          title: "核对尺寸",
          detail: "对照订单规格与实际测量",
          priority: "high",
          sourceId: record.case.id,
          evidence: [{ sourceId: record.case.id, detail: "当前售后状态" }],
        },
      ],
      replyDraft: {
        locale: "en-US",
        body: "Could you share a measurement of the item you received?",
        evidence: [{ sourceId: record.case.id, detail: "待核对问题" }],
      },
    });
    try {
      const task = await assists.create(context, request);
      await processor.process(envelope(task.id));
      expect(await assists.get(context, task.id)).toMatchObject({
        status: "completed",
        stale: false,
        result: { replyDraft: { locale: "en-US" } },
      });
      expect(JSON.stringify(observedBody)).not.toMatch(/SENSITIVE|private@example|PRIVATE-MESSAGE/);
      expect(await afterSales.get(context, record.case.id)).toEqual(before);
      const [stored] = await withTenant(database.db, context, (tx) =>
        tx.select().from(aiAssistRuns).where(eq(aiAssistRuns.id, task.id)),
      );
      expect(stored?.orderLineId).toBe(lineId);
      expect(stored!.expiresAt.getTime() - stored!.createdAt.getTime()).toBeLessThanOrEqual(
        86400100,
      );
      await expect(business.preview(other, selection)).rejects.toThrow();
      await expect(
        business.preview({ ...context, permissions: [Permission.OrderRead] }, selection),
      ).rejects.toThrow(ForbiddenError);
      await afterSales.recordContact(context, record.case.id, {
        channel: "internal",
        direction: "internal",
        body: "New internal observation",
        externalMessageId: null,
        occurredAt: new Date().toISOString(),
        idempotencyKey: "ai-after-sales-changed",
      });
      expect(await assists.get(context, task.id)).toMatchObject({
        stale: true,
        result: null,
        request: null,
      });
    } finally {
      templateOutput = undefined;
    }
  });

  it("rechecks membership before any model call", async () => {
    const task = await assists.create(context, creativeRequest()),
      calls = modelFetch.mock.calls.length;
    await withTenant(database.db, context, (tx) =>
      tx.update(memberships).set({ status: "disabled" }).where(eq(memberships.id, membershipId)),
    );
    await processor.process(envelope(task.id));
    expect(modelFetch).toHaveBeenCalledTimes(calls);
    expect((await assists.get(context, task.id)).status).toBe("failed");
    await withTenant(database.db, context, (tx) =>
      tx.update(memberships).set({ status: "active" }).where(eq(memberships.id, membershipId)),
    );
  });

  it("reuses configured text models and user defaults, records unknown costs without a free bill, and rechecks disabled routes", async () => {
    const sharedId = createEntityId();
    await withTenant(database.db, context, async tx => {
      await tx.insert(modelRoutes).values({ id: sharedId, tenantId: context.tenantId, modelKey: "Shared assistant", taskType: "studio_text", targets: [{ providerConfigId: providerId, providerModel: "synthetic-shared", timeoutMs: 120000 }] });
      await tx.insert(modelPreferences).values({ tenantId: context.tenantId, userId: context.userId, defaults: { image: null, video: null, text: sharedId, analysis: null } });
    });
    expect((await assists.models(context))[0]).toMatchObject({ id: sharedId, maxTaskCostUsd: null });
    expect(await assists.models(other)).toEqual([]);
    const task = await assists.create(context, { ...creativeRequest(), modelId: sharedId });
    await processor.process(envelope(task.id));
    expect(await assists.get(context, task.id)).toMatchObject({ status: "completed", inputTokens: 120, outputTokens: 300, costUsd: null });
    expect(await withTenant(database.db, context, tx => tx.select().from(aiBudgetLedger).where(eq(aiBudgetLedger.requestId, task.id)))).toEqual([]);
    const queued = await assists.create(context, { ...creativeRequest(), modelId: sharedId });
    const calls = modelFetch.mock.calls.length;
    await withTenant(database.db, context, tx => tx.update(modelRoutes).set({ status: "disabled" }).where(eq(modelRoutes.id, sharedId)));
    await processor.process(envelope(queued.id));
    expect(modelFetch).toHaveBeenCalledTimes(calls);
    expect(await assists.get(context, queued.id)).toMatchObject({ status: "failed" });
    expect((await assists.models(context)).some(model => model.id === sharedId)).toBe(false);
  });

  it("clears encrypted content at retention expiry while retaining immutable task status", async () => {
    const task = await assists.create(context, creativeRequest());
    await processor.process(envelope(task.id));
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(Date.now() + 31 * 86400000));
      const view = await assists.get(context, task.id);
      expect(view).toMatchObject({ status: "completed", stale: true, result: null, images: [] });
      const [stored] = await withTenant(database.db, context, (tx) =>
        tx.select().from(aiAssistRuns).where(eq(aiAssistRuns.id, task.id)),
      );
      expect(stored).toMatchObject({
        encryptedInput: null,
        encryptedOutput: null,
        status: "completed",
      });
      await expect(assists.image(context, task.id, 0)).rejects.toThrow("不可读取");
    } finally {
      vi.useRealTimers();
    }
  });

  it("inherits separately registered pricing and rejects unpriced calls when organization budgets are enabled", async () => {
    const sharedId = createEntityId(), unknownId = createEntityId();
    await withTenant(database.db, context, async tx => {
      await tx.insert(modelRoutes).values([
        { id: sharedId, tenantId: context.tenantId, modelKey: "Shared priced", taskType: "studio_text", targets: [{ providerConfigId: providerId, providerModel: "synthetic-vision", timeoutMs: 120000 }] },
        { id: unknownId, tenantId: context.tenantId, modelKey: "Shared unpriced", taskType: "studio_text", targets: [{ providerConfigId: providerId, providerModel: "synthetic-unpriced", timeoutMs: 120000 }] },
      ]);
      await tx.insert(aiBudgetPolicies).values({ tenantId: context.tenantId, monthlyCapUsd: "100", defaultTaskCapUsd: "1" });
    });
    expect((await assists.models(context)).find(model => model.id === sharedId)).toMatchObject({ inputUsdPerMillion: 1, outputUsdPerMillion: 2, maxTaskCostUsd: 1 });
    await expect(assists.create(context, { ...creativeRequest(), modelId: unknownId })).rejects.toThrow("组织已启用 AI 预算");
    await expect(assists.create(context, { ...creativeRequest(), modelId: sharedId })).rejects.toThrow("本月存在未计价");
  });
});
