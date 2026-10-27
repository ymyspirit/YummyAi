import { syntheticSpecificationFacts } from "../../../../tools/testing/specification-fixtures.js";
import { createHash, randomUUID } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Permission, ForbiddenError, ASSIST_ACCESS_POLICY_VERSION, requiredAssistPermissions } from "@yummyai/authz";
import { SecretVault, OpenAiCompatibleProvider, assistFingerprint, ASSIST_PROMPT_VERSION, assistExecutionPolicy, assistHarness } from "@yummyai/ai-core";
import {
  CaptureDraftSchema,
  createEntityId,
  type ProductionEditorDocument,
  type ProductionEditorImageView,
  type TenantContext,
} from "@yummyai/contracts";
import { CreativeRequirementsSchema } from "@yummyai/contracts/catalog/artwork";
import { CANVAS_WORKFLOW_TEMPLATES } from "@yummyai/contracts/pod/canvas-bridge";
import { AssistResultSchema, CreateAssistSchema, type CreateAssist } from "@yummyai/contracts/ai/assist";
import { orderRequirementDraftInput } from "@yummyai/contracts/order/requirement-interpretation";
import {
  aiAssistRuns,
  orderWorkItems,
  aiAssistExecutions,
  assetFiles,
  personalizationTemplateSourceInspections,
  aiBudgetLedger,
  aiBudgetPolicies,
  captureSnapshots,
  connectDatabase,
  creativeDesignBatches,
  creativeDesignBatchItems,
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
import { JobEnvelopeSchema, createQueue, QueueName } from "@yummyai/jobs";
import {
  assertAssetAccess,
  type AssetDomain,
  type PutPrivateInput,
  type Storage,
  type StoredAsset,
} from "@yummyai/storage";
import { eq, sql } from "drizzle-orm";
import sharp from "sharp";
import JSZip from "jszip";
import { AiAssistProcessor, assistPricing } from "../../../worker/src/processors/ai-assist.processor.js";
import { AiAssistScheduler } from "../../../worker/src/processors/ai-assist.scheduler.js";
import { AuditService } from "../audit/audit.service.js";
import { CaptureService } from "../capture/capture.service.js";
import { ResearchClassificationService } from "../research/research-classification.service.js";
import { OrderService } from "../orders/order.service.js";
import { AmazonOrderReportService } from "../orders/amazon-order-report.service.js";
import { OrderWorkspaceService } from "../orders/order-workspace.service.js";
import { ProductionEditorService } from "../design/production-editor.service.js";
import { AssistContextService } from "./assist-context.service.js";
import { AssistService, type AssistEnqueuer } from "./assist.service.js";
import { ModelBillingService } from "./model-billing.service.js";
import { AssistTaskWorkspaceService } from "./assist-task-workspace.service.js";
import { AssistCatalogContextService } from "./assist-catalog-context.service.js";
import { KnowledgeService } from "../knowledge/knowledge.service.js";
import { MethodGovernanceService } from "../knowledge/method-governance.service.js";
import { AssistBusinessContextService } from "./assist-business-context.service.js";
import { FinanceService } from "../finance/finance.service.js";
import { InventoryService } from "../inventory/inventory.service.js";
import { ProcurementService } from "../procurement/procurement.service.js";
import { OrderAfterSalesService } from "../orders/order-after-sales.service.js";
import { PodPersonalizationService } from "../design/pod-personalization.service.js";
import { createDefaultProductionDocument } from "@yummyai/production-editor/products";
import { ArtworkAuditRepository } from "@yummyai/order-design";
import { SalesPackageService } from "../catalog/sales-package.service.js";
import { ListingService, DrizzleListingRepository } from "../listings/listing.service.js";
import { SalesPlanService } from "../catalog/sales-plan.service.js";
import { SalesPlanLaunchService } from "../catalog/sales-plan-launch.service.js";
import { ProductDevelopmentService } from "../catalog/product-development.service.js";
import { ProductService, DrizzleCatalogRepository } from "../catalog/product.service.js";
import { SalesPlanFieldsSchema } from "@yummyai/contracts/catalog/sales-plan";
import { AssistTaskBasisSchema } from "@yummyai/contracts/ai/task-workspace";

function executionGate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

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
    membershipId = createEntityId(),
    roleId = createEntityId();
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
    contentVault,
  );
  const workspace = new OrderWorkspaceService(database, orderVault, storage, reports, editor, {
    scan,
  });
  const templates = new PodPersonalizationService(database, { enqueue: vi.fn() }, audit);
  const listingService = new ListingService(new DrizzleListingRepository(database));
  const salesPlans = new SalesPlanService(database, listingService);
  const development = new ProductDevelopmentService(database, storage);
  const salesPackages = new SalesPackageService(database, listingService, storage);
  const catalog = new AssistCatalogContextService(
    templates,
    new SalesPackageService(
      database,
      new ListingService(new DrizzleListingRepository(database)),
      storage,
    ),
    new KnowledgeService(database, audit),
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
    undefined,
    salesPlans,
  );
  const enqueue = vi.fn<AssistEnqueuer["enqueue"]>(async () => undefined);
  const assists = new AssistService(database, contentVault, contexts, { enqueue });
  const taskWorkspace = new AssistTaskWorkspaceService(database, assists, contexts, workspace, editor);
  const salesLaunch = new SalesPlanLaunchService(database, salesPlans, development, assists, contexts, salesPackages);
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
    ...createDefaultProductionDocument("shaped_pillow"),
    name: "Synthetic AI preflight",
    productType: "shaped_pillow",
    spec: {...(createDefaultProductionDocument("shaped_pillow") as Extract<ProductionEditorDocument, {productType: "shaped_pillow"}>).spec, declaredLongestMm: 304.8},
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

  const methods = new MethodGovernanceService(database, audit);
  const governedTasks = new Map<string, {
    request: CreateAssist;
    methodKey: string;
    notes: string;
    nextNotes: string;
    selection: unknown;
  }>();
  async function publishMethod(methodKey: string, notes: string) {
    const current = (await methods.workspace(context)).methods.find(row => row.methodKey === methodKey);
    const saved = await methods.save(context, {
      methodKey,
      expectedRevision: current?.revision ?? 0,
      notes,
      knowledgeVersionIds: [],
      reason: "Synthetic governed business fixture",
      requestId: randomUUID(),
    });
    for (const operation of ["submit", "publish"] as const) {
      const row = (await methods.workspace(context)).methods.find(row => row.id === saved.methodId)!;
      await methods.transition(context, saved.methodId, operation, {
        expectedRevision: row.revision,
        version: row.latestVersion,
        ...(operation === "publish" ? { reviewedChecksum: row.latest.checksum } : {}),
        reason: "Synthetic explicit method review",
        requestId: randomUUID(),
      });
    }
  }
  async function createGovernedTask(request: CreateAssist) {
    const harness = assistHarness(request.kind,
      request.kind === "artwork_preflight" && request.automaticAudit === true,
      requiredAssistPermissions(request.kind, "run"), ASSIST_ACCESS_POLICY_VERSION);
    const methodKey = harness.skill.key;
    const notes = `Synthetic reviewed ${methodKey} version one: preserve business facts and require operator review`;
    const nextNotes = `Synthetic reviewed ${methodKey} version two: require the newly reviewed procedure`;
    await publishMethod(methodKey, notes);
    const task = await assists.create(context, request);
    expect(task.methodSelection).toMatchObject({ mode: "published", methodKey, version: 1 });
    await publishMethod(methodKey, nextNotes);
    governedTasks.set(task.id, { request, methodKey, notes, nextNotes, selection: task.methodSelection });
    return task;
  }
  async function verifyGovernedTask(id: string) {
    const pinned = governedTasks.get(id)!;
    const done = await assists.get(context, id);
    expect(done).toMatchObject({ status: "completed", stale: false });
    expect(done.methodSelection).toEqual(pinned.selection);
    expect(JSON.stringify(observedBody)).toContain(pinned.notes);
    expect(JSON.stringify(observedBody)).not.toContain(pinned.nextNotes);
    expect(observedBody.tools).toBeUndefined();
    const messages = observedBody.messages as Array<{ role: string; content: unknown }>;
    expect(JSON.stringify(messages.filter(message => message.role === "system"))).not.toContain(pinned.notes);
    const fresh = await contexts.prepare(context, { ...pinned.request, requestId: randomUUID() });
    expect(fresh.methodSelection).toMatchObject({ mode: "published", methodKey: pinned.methodKey, version: 2 });
    await expect(assists.get({ ...context, permissions: context.permissions.filter(p => p !== Permission.WorkflowRead) }, id))
      .rejects.toBeInstanceOf(ForbiddenError);
    return done;
  }

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

  it("order requirement analysis pins the actual dirty draft and rejects invented or cross-group model bindings without rewriting an order", async () => {
    const externalOrderId = "SYNTHETIC-REQUIREMENT-AI-" + createEntityId(), externalLineId = "SYNTHETIC-LINE-" + createEntityId();
    const batch = await reports.importReport(context, { accountId, marketplaceId: "ATVPDKIKX0DER", fileName: "synthetic-requirement-analysis.txt",
      content: ["order-id\torder-item-id\tpurchase-date\tsku\tproduct-name\tquantity-purchased\tcurrency\titem-price",
        [externalOrderId, externalLineId, new Date().toISOString(), "SYNTHETIC", "Synthetic custom shaped pillow", "1", "USD", "20"].join("\t")].join("\n") });
    const sourceLine = (await reports.workspace(context, { batchId: batch.id })).lines[0]!;
    const zip = new JSZip();
    zip.file("order.json", JSON.stringify({ orderId: externalOrderId, orderItemId: externalLineId, customizationData: {
      type: "PageContainerCustomization", children: [
        ...["Alpha", "Beta"].map(name => ({ type: "TextContainerCustomization", label: "Synthetic " + name, children: [
          { type: "TextCustomization", label: name === "Alpha" ? "First name" : "Second name", inputValue: "Synthetic " + name },
          { type: "FontCustomization", label: "Font", fontSelection: { family: name + " Font" } },
        ] })),
      ],
    } }));
    await reports.process(context, sourceLine.id, null, await zip.generateAsync({ type: "nodebuffer" }));
    const { artwork } = await development.registerArtwork(context, { code: "SYNTHETIC-REQUIREMENT-" + createEntityId(),
      name: "Synthetic grouped text scheme", mode: "customer_image", expectedVersion: 0, idempotencyKey: randomUUID(),
      customization: { version: 1, fields: [
        { key: "front_message", label: "Front message", type: "short_text", required: true },
        { key: "back_message", label: "Back message", type: "short_text", required: false },
        { key: "operator_message", label: "Operator message", type: "short_text", required: false },
      ] }, layout: [], instructions: "Synthetic analysis classification only No production approval" });
    const original = await workspace.detail(context, sourceLine.orderLineId), sources = original.requirementSources!;
    const alpha = sources.find(row => row.role === "text" && row.value === "Synthetic Alpha")!;
    const beta = sources.find(row => row.role === "text" && row.value === "Synthetic Beta")!;
    const font = sources.find(row => row.role === "font" && row.groupKey === alpha.groupKey)!;
    expect(alpha.groupKey).not.toBe(beta.groupKey);
    // Historical zero-based keys may collide with a current raw ordinal. Only
    // unique original label/value evidence may recover the legacy source link.
    const legacyField = { key: alpha.sourceFieldKey, label: "Second name", kind: "text" as const, value: beta.value };
    const linked = await workspace.intakeCheck(context, sourceLine.orderLineId, { expectedRevision: original.line.revision,
      expectedSourceVersionId: original.report!.versionId, draft: { ...original.draft, fields: [legacyField] } });
    expect(linked.normalizedDraft.fields[0]!.sourceKey).toBe(beta.sourceFieldKey);
    expect(linked.normalizedDraft.fields[0]!.font).toBe("Beta Font");
    const unmatched = { ...legacyField, value: "Synthetic unmatched legacy text" };
    const inputLegacy = { expectedRevision: original.line.revision, expectedSourceVersionId: original.report!.versionId,
      draft: { ...original.draft, fields: [unmatched] } };
    const isolated = await workspace.intakeCheck(context, sourceLine.orderLineId, inputLegacy);
    const stableKey = "operator-legacy:" + createHash("sha256").update(orderRequirementDraftInput({
      key: unmatched.key, label: unmatched.label, value: unmatched.value,
    })).digest("hex");
    expect(isolated.normalizedDraft.fields[0]).toMatchObject({ value: unmatched.value, sourceKey: stableKey });
    expect(isolated.normalizedDraft.fields[0]!.font).toBeUndefined(); expect(isolated.normalizedDraft.fields[0]!.color).toBeUndefined();
    expect(isolated.requirements!.sources.find(row => row.sourceFieldKey === stableKey)).toMatchObject({ origin: "operator", value: unmatched.value });
    expect(isolated.requirements!.sources.find(row => row.sourceFieldKey === alpha.sourceFieldKey)!.value).toBe(alpha.value);
    expect((await workspace.intakeCheck(context, sourceLine.orderLineId, inputLegacy)).normalizedDraft.fields[0]!.sourceKey).toBe(stableKey);
    expect((await workspace.detail(context, sourceLine.orderLineId)).draft).toEqual(original.draft);
    const dirty = { ...original.draft, artworkVersionId: artwork.versionId,
      instructions: "Synthetic unsaved operator instruction", fields: [
        ...original.draft.fields.map(row => (row.sourceKey ?? row.key) === alpha.sourceFieldKey ? { ...row, value: "Synthetic dirty Alpha" } : row),
        { key: "operator-new", label: "Synthetic extra text", kind: "text" as const, value: "Synthetic unsaved extra text" },
      ] };
    const changedAlpha = dirty.fields.filter(row => (row.sourceKey ?? row.key) === alpha.sourceFieldKey);
    expect(changedAlpha).toHaveLength(1);
    expect(changedAlpha[0]!.value).toBe("Synthetic dirty Alpha");
    expect(original.draft.fields.find(row => (row.sourceKey ?? row.key) === alpha.sourceFieldKey)!.value).toBe(alpha.value);
    const checked = await workspace.intakeCheck(context, sourceLine.orderLineId, { expectedRevision: original.line.revision,
      expectedSourceVersionId: original.report!.versionId, draft: dirty });
    expect(checked.requirements!.sources.find(row => row.sourceFieldKey === "operator-new")).toMatchObject({
      origin: "operator", value: "Synthetic unsaved extra text", role: "text" });
    const sourceId = (key: string) => "order-field:" + createHash("sha256").update(JSON.stringify(key)).digest("hex");
    const binding = (key: string, target: string, role: "text" | "font" = "text") => ({ sourceFieldKey: key, targetFieldKey: target,
      role, confidence: 0.98, reason: "Synthetic original-source classification", evidence: [{ sourceId: sourceId(key), detail: "Actual source field" }] });
    const good = [binding(alpha.sourceFieldKey, "front_message"), binding(beta.sourceFieldKey, "back_message"),
      binding("operator-new", "operator_message"), binding(font.sourceFieldKey, "front_message", "font")];
    const input = CreateAssistSchema.parse({ kind: "order_review", orderLineId: sourceLine.orderLineId,
      expectedRevision: original.line.revision, expectedSourceVersionId: original.report!.versionId, draft: dirty,
      requestId: randomUUID(), modelId });
    try {
      templateOutput = AssistResultSchema.parse({ summary: "Synthetic current-source classification only", findings: [], directions: [],
        matches: [], missingInformation: [], orderFieldBindings: good });
      const task = await assists.create(context, input);
      const callsBefore = modelFetch.mock.calls.length;
      await processor.process(envelope(task.id));
      const done = await assists.get(context, task.id);
      expect(done).toMatchObject({ status: "completed", stale: false, request: input });
      expect(done.result!.orderFieldBindings).toEqual(good);
      expect(JSON.stringify(observedBody)).toContain("Synthetic dirty Alpha");
      expect(JSON.stringify(observedBody)).toContain("Synthetic unsaved extra text");
      expect(JSON.stringify(observedBody)).toContain(sourceId("operator-new"));
      expect((await workspace.detail(context, sourceLine.orderLineId)).draft).toEqual(original.draft);
      expect((await workspace.detail(context, sourceLine.orderLineId)).line.revision).toBe(original.line.revision);
      await processor.process(envelope(task.id));
      expect(modelFetch).toHaveBeenCalledTimes(callsBefore + 1);
      for (const invalid of [
        good.map(row => row.role === "font" ? { ...row, targetFieldKey: "back_message" } : row),
        good.map((row, index) => index ? row : { ...row, evidence: [{ sourceId: sourceId(beta.sourceFieldKey), detail: "Wrong original source" }] }),
      ]) {
        templateOutput = AssistResultSchema.parse({ ...templateOutput, orderFieldBindings: invalid });
        const denied = await assists.create(context, { ...input, requestId: randomUUID() });
        await processor.process(envelope(denied.id));
        expect(await assists.get(context, denied.id)).toMatchObject({ status: "failed", result: null });
        expect((await workspace.detail(context, sourceLine.orderLineId)).draft).toEqual(original.draft);
      }
      const changed = await workspace.save(context, sourceLine.orderLineId, { expectedRevision: original.line.revision,
        expectedSourceVersionId: original.report!.versionId, draft: { ...dirty, instructions: "Synthetic newer operator input" },
        status: "needs_information", reason: "Synthetic explicit save after the earlier analysis", idempotencyKey: randomUUID() });
      expect(changed.draft.instructions).toBe("Synthetic newer operator input");
      expect(await assists.get(context, task.id)).toMatchObject({ stale: true, result: null });
    } finally { templateOutput = undefined; }
  }, 60_000);

  it("uses configured models, sends actual research images and rejects tenant/owner access and mutation", async () => {
    expect(await assists.models(other)).toEqual([]);
    const input = creativeRequest(),
      task = await createGovernedTask(input);
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
    const done = await verifyGovernedTask(task.id);
    expect(done.status).toBe("completed");
    expect(done.result?.directions).toHaveLength(3);
    expect(done.costUsd).toBeGreaterThan(0);
    expect(done.invocations?.[0]).toMatchObject({owner:"assist",boundary:"received",billing:{basis:"configured_rate",needsProviderEvidence:true},responseChecksum:expect.stringMatching(/^[a-f0-9]{64}$/)});
    expect(JSON.stringify(observedBody)).toContain("data:image/jpeg;base64,");
    expect(JSON.stringify(observedBody)).not.toContain("synthetic-key");
    expect(JSON.stringify(observedBody)).not.toContain("native-harness-v1");
    expect(done.executionContract).toEqual(task.executionContract);
    expect(task.executionContract?.tools.map(tool => tool.key)).toEqual(["yummyai.assist.creative"]);
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

  it("sales plan launch pins product facts, adopts selected output once and rejects stale or foreign results", async () => {
    const spu = (await development.createSpu(context, { code: `LAUNCH-${createEntityId().slice(-8)}`, name: "Synthetic launch product", idempotencyKey: randomUUID() })).spu;
    let planId = "";
    try {
      const spec = (await development.saveSpecification(context, {
        spuId: spu.id, code: "LAUNCH-SPEC", name: "Synthetic 10 inch specification", attributes: { size: "10 inch" }, processProfileVersionId: profileId,
        facts: syntheticSpecificationFacts({ material: "Synthetic fabric", dimensions: "10 inch", packageContents: "One synthetic product", packageQuantity: 1, factsConfirmed: true }),
        expectedVersion: 0, idempotencyKey: randomUUID(),
      })).specification;
      let plan = (await salesPlans.create(context, { spuId: spu.id, fields: SalesPlanFieldsSchema.parse({ name: "Synthetic Custom launch", mode: "custom", fulfillment: "fbm", audience: "Synthetic buyers", scenario: "Synthetic gifting", researchConclusion: "Synthetic reviewed research", researchItemIds: [source.researchItemId], specificationIds: [spec.id] }), idempotencyKey: randomUUID() })).plan;
      planId = plan.id;
      expect((await salesLaunch.get(context, plan.id)).nextStage?.key).toBe("direction");
      await expect(salesLaunch.get(other, plan.id)).rejects.toThrow();
      await expect(salesLaunch.get({ ...context, permissions: [] }, plan.id)).rejects.toBeInstanceOf(ForbiddenError);
      const calls = enqueue.mock.calls.length;
      const basis = AssistTaskBasisSchema.parse(await salesLaunch.basis(context, plan.id, { kind: "creative", expectedRevision: plan.revision }));
      expect(enqueue.mock.calls.length).toBe(calls);
      expect(basis.sources.some(s => s.id === spec.versionId)).toBe(true);
      const request = { ...basis.input, modelId, requestId: randomUUID() };
      const task = await assists.create(context, request);
      expect((await assists.create(context, request)).id).toBe(task.id);
      expect(new Set(enqueue.mock.calls.slice(calls).map(call => call[0].id))).toEqual(new Set([task.id]));
      const modelCalls = modelFetch.mock.calls.length;
      await processor.process(envelope(task.id));
      await processor.process(envelope(task.id));
      expect(modelFetch.mock.calls.length).toBe(modelCalls + 1);
      expect((await assists.get(context, task.id)).status).toBe("completed");
      expect((await salesLaunch.get({ ...context, userId: createEntityId() }, plan.id)).tasks).toHaveLength(0);
      const adoption = { kind: "creative", runId: task.id, directionIndex: 0, fields: ["positioning"], expectedRevision: plan.revision, idempotencyKey: randomUUID() };
      await expect(salesLaunch.adopt(context, plan.id, { ...adoption, fields: ["title"] })).rejects.toThrow("只能采纳");
      await expect(salesLaunch.adopt({ ...context, userId: createEntityId() }, plan.id, adoption)).rejects.toThrow("不存在");
      const applied = await salesLaunch.adopt(context, plan.id, adoption);
      expect(await salesLaunch.adopt(context, plan.id, adoption)).toEqual(applied);
      plan = applied.plan;
      expect(plan.revision).toBe(2);
      expect(plan.fields.positioning).toContain("原创方向 1");
      expect(plan.fields.audience).toBe("Synthetic buyers");
      expect(plan.fields.skuIds).toEqual([]);
      expect((await salesLaunch.get(context, plan.id)).adoptions[0]?.runId).toBe(task.id);
      await expect(assists.create(context, { ...request, requestId: randomUUID() })).rejects.toThrow("新版本");
      const fresh = await salesLaunch.basis(context, plan.id, { kind: "creative", expectedRevision: plan.revision });
      const second = await assists.create(context, { ...fresh.input, modelId, requestId: randomUUID() });
      await processor.process(envelope(second.id));
      expect((await assists.get(context, second.id)).stale).toBe(false);
      await expect(assists.get({ ...context, permissions: context.permissions.filter(permission => permission !== Permission.ProductRead) }, second.id)).rejects.toBeInstanceOf(ForbiddenError);
      const [oldSnapshot] = await withTenant(database.db, context, tx => tx.select().from(captureSnapshots).where(eq(captureSnapshots.id, source.snapshotId)));
      const recaptured = await captures.createSnapshot(context, CaptureDraftSchema.parse({ ...oldSnapshot!.draft, capturedAt: new Date(Date.now() + 1000).toISOString(), title: "Synthetic updated launch source" }));
      expect(recaptured.researchItemId).toBe(source.researchItemId);
      expect((await assists.get(context, second.id)).stale).toBe(true);
      await expect(assists.create(context, { ...fresh.input, modelId, requestId: randomUUID() })).rejects.toThrow("研究来源已变化");
      const recapturedBasis = await salesLaunch.basis(context, plan.id, { kind: "creative", expectedRevision: plan.revision });
      const third = await assists.create(context, { ...recapturedBasis.input, modelId, requestId: randomUUID() });
      await processor.process(envelope(third.id));
      expect((await assists.get(context, third.id)).stale).toBe(false);
      await development.saveSpecification(context, { spuId: spu.id, code: spec.code, name: spec.name, attributes: spec.attributes, facts: { ...spec.facts, factsConfirmed: false }, processProfileVersionId: spec.processProfileVersionId, expectedVersion: spec.version, idempotencyKey: randomUUID() });
      expect((await assists.get(context, third.id)).stale).toBe(true);
      await expect(salesLaunch.adopt(context, plan.id, { ...adoption, runId: third.id, expectedRevision: plan.revision, idempotencyKey: randomUUID() })).rejects.toThrow("依据已变化");
      await expect(assists.create(context, { ...recapturedBasis.input, modelId, requestId: randomUUID() })).rejects.toThrow("规格依据已变化");
      expect((await salesLaunch.get(context, plan.id)).nextStage?.key).toBe("product");
      const historical = await salesLaunch.get(context, plan.id);
      expect(historical.fees.knownUsd).toBeGreaterThan(0);
      expect(historical.tasks).toHaveLength(3);
    } finally {
      if (planId) { const latest = (await salesPlans.get(context, planId)).plan; await salesPlans.archive(context, planId, { expectedRevision: latest.revision, idempotencyKey: randomUUID() }); }
      await new ProductService(new DrizzleCatalogRepository(database)).transition(context, spu.productPlanId, "archived");
    }
  });

  it("task workspace pins real order input, rejects changed previews and isolates private task history", async () => {
    const beforeCalls = modelFetch.mock.calls.length;
    const basis = await taskWorkspace.basis(context, { kind: "order_review", targetId: lineId, taskGoal: "核对定制资料缺项" });
    expect(basis.input.kind).toBe("order_review");
    expect(basis.input.expectedTaskFingerprint).toBe(basis.fingerprint);
    expect(basis.sources.length).toBeGreaterThan(0);
    expect(modelFetch.mock.calls.length).toBe(beforeCalls);
    await expect(assists.create(context, { ...basis.input, modelId, requestId: randomUUID(), expectedTaskFingerprint: "0".repeat(64) })).rejects.toThrow("任务依据已变化");
    const request = { ...basis.input, modelId, requestId: randomUUID() };
    const task = await assists.create(context, request);
    expect((await assists.create(context, request)).id).toBe(task.id);
    expect((await taskWorkspace.workspace(context, { kind: "order_review" })).items).toEqual(expect.arrayContaining([expect.objectContaining({ id: task.id, goal: "核对定制资料缺项", status: "queued" })]));
    expect((await taskWorkspace.workspace(other, {})).items.some(row => row.id === task.id)).toBe(false);
    expect((await taskWorkspace.workspace({ ...context, userId: other.userId }, {})).items.some(row => row.id === task.id)).toBe(false);
    expect((await taskWorkspace.workspace({ ...context, permissions: [] }, {})).capabilities).toEqual([]);
    await expect(taskWorkspace.targets({ ...context, permissions: [Permission.OrderRead] }, { kind: "order_review" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(taskWorkspace.basis(other, { kind: "order_review", targetId: lineId, taskGoal: "" })).rejects.toThrow();
    await expect(taskWorkspace.basis(context, { kind: "procurement_review", targetId: "../../secrets", taskGoal: "" })).rejects.toThrow();
    await processor.process(envelope(task.id));
    const completed = (await taskWorkspace.workspace(context, { kind: "order_review", status: "completed" })).items.find(row => row.id === task.id);
    expect(completed).toMatchObject({ status: "completed", stale: false });
    expect(completed?.costUsd).toBeGreaterThan(0);
    expect((await workspace.detail(context, lineId)).line.preparation).not.toBe("pushed");
  });

  it("task workspace checks immutable creative pins and invalidates archived projects", async () => {
    const projectId = createEntityId(), itemId = createEntityId();
    const request = creativeRequest();
    if (request.kind !== "creative") throw new Error("Expected creative fixture");
    const workflow = { template: CANVAS_WORKFLOW_TEMPLATES[0]!, rootBatchId: projectId, parentBatchId: null, stepIndex: 0, sourceVersionIds: [],
      requirements: request.requirements, analysisScopeId: request.scopeId, researchReferences: [{ domain: "research" as const, researchItemId: source.researchItemId, snapshotId: source.snapshotId,
        studyRevisionId: null, studyVersion: 0, title: "Synthetic creative source", sourceUrl: "https://www.etsy.com/listing/100000001", platform: "etsy" as const,
        capturedAt: "2026-01-01T00:00:00.000Z", thumbnailUrl: null, mediaCount: 0, content: null }] };
    await withTenant(database.db, context, async tx => {
      await tx.insert(creativeDesignBatches).values({ id: projectId, tenantId: context.tenantId, name: "Synthetic task project", executionMode: "infinite_canvas", canvasWorkflow: workflow,
        itemCount: 1, requestChecksum: createHash("sha256").update(projectId).digest("hex"), createdBy: context.userId });
      await tx.insert(creativeDesignBatchItems).values({ id: itemId, tenantId: context.tenantId, batchId: projectId, ordinal: 0, rowKey: "synthetic", name: "Synthetic", prompt: request.prompt,
        candidateCount: 1, printSpecVersionIds: [], focalPoint: { xPermille: 500, yPermille: 500 } });
    });
    const calls = modelFetch.mock.calls.length;
    const basis = await taskWorkspace.basis(context, { kind: "creative", targetId: projectId, taskGoal: "只分析已固定来源" });
    expect(modelFetch).toHaveBeenCalledTimes(calls);
    expect(basis.input.kind).toBe("creative");
    const input = CreateAssistSchema.parse({ ...basis.input, modelId, requestId: randomUUID() });
    if (input.kind !== "creative") throw new Error("Expected creative basis");
    const task = await assists.create(context, input);
    expect((await assists.get(context, task.id)).stale).toBe(false);
    await expect(assists.create(context, { ...input, prompt: "Synthetic forged prompt", requestId: randomUUID() })).rejects.toThrow("研究来源已变化");
    await expect(assists.create(context, { ...input, sources: [{ ...input.sources[0]!, snapshotId: createEntityId() }], requestId: randomUUID() })).rejects.toThrow("研究来源已变化");
    await expect(assists.create(context, { ...input, requirements: { ...input.requirements, audience: "Synthetic forged audience" }, requestId: randomUUID() })).rejects.toThrow("研究来源已变化");
    await withTenant(database.db, context, tx => tx.update(creativeDesignBatches).set({ archivedAt: new Date() }).where(eq(creativeDesignBatches.id, projectId)));
    expect((await assists.get(context, task.id)).stale).toBe(true);
    await expect(taskWorkspace.basis(other, { kind: "creative", targetId: projectId, taskGoal: "" })).rejects.toThrow();
    expect(modelFetch).toHaveBeenCalledTimes(calls);
  });

  it("pins knowledge inside encrypted task input and requires current knowledge access when reading it", async () => {
    const knowledge = new KnowledgeService(database, audit);
    const fields = { title: "Synthetic Listing operating reference", summary: "Synthetic fixture", body: "Synthetic Listing 原始版本运营指导", topic: "listing", platform: "all", market: "ALL", spuId: null,
      sourceType: "team", sourceLabel: "Synthetic SOP", sourceUrl: "", owner: "Synthetic operator", verifiedOn: "2020-01-01", reviewDueOn: "2099-12-31", tags: ["Listing"] };
    const created = await knowledge.save(context, null, { fields, expectedRevision: 0, reason: "Synthetic create", requestId: randomUUID() });
    await knowledge.change(context, created.id, "submit", { expectedRevision: 1, version: 1, reason: "Synthetic review", requestId: randomUUID() });
    await knowledge.change(context, created.id, "publish", { expectedRevision: 2, version: 1, reason: "Synthetic publish", requestId: randomUUID() });
    const references = await knowledge.search(context, { query: "Synthetic Listing", topic: "listing", platform: "all", market: "ALL" });
    const input = creativeRequest(), prepared = await contexts.prepare(context, input);
    const prepare = vi.spyOn(contexts, "prepare").mockResolvedValueOnce({ ...prepared, knowledge: references.references,
      data: { ...prepared.data, operatingKnowledge: references }, sources: [...prepared.sources, ...references.references.map(reference => ({ id: reference.sourceId, label: reference.title, href: reference.href }))] });
    let task: Awaited<ReturnType<AssistService["create"]>>;
    try { task = await assists.create(context, input); } finally { prepare.mockRestore(); }
    const pinned = (await assists.get(context, task.id)).knowledge;
    expect(pinned[0]?.version).toBe(1); expect(pinned[0]?.excerpt).toContain("原始版本");
    const [stored] = await withTenant(database.db, context, tx => tx.select().from(aiAssistRuns).where(eq(aiAssistRuns.id, task.id)));
    expect(stored!.encryptedInput).not.toContain("原始版本");
    contentVault.withSecret(stored!.encryptedInput!, plaintext => expect(JSON.parse(plaintext).knowledge).toEqual(pinned));
    await knowledge.save(context, created.id, { fields: { ...fields, body: "Synthetic Listing 后续修订" }, expectedRevision: 3, reason: "Synthetic revise", requestId: randomUUID() });
    await knowledge.change(context, created.id, "submit", { expectedRevision: 4, version: 2, reason: "Synthetic review", requestId: randomUUID() });
    await knowledge.change(context, created.id, "publish", { expectedRevision: 5, version: 2, reason: "Synthetic publish", requestId: randomUUID() });
    expect((await knowledge.search(context, { query: "Synthetic Listing", topic: "listing", platform: "all", market: "ALL" })).references[0]?.version).toBe(2);
    expect((await assists.get(context, task.id)).knowledge).toEqual(pinned);
    await expect(assists.get({ ...context, permissions: context.permissions.filter(permission => permission !== Permission.WorkflowRead) }, task.id)).rejects.toBeInstanceOf(ForbiddenError);
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
    const task = await createGovernedTask({
      kind: "artwork_preflight",
      orderLineId: lineId,
      expectedRevision: detail.line.revision,
      expectedEditorVersionId: file.version.id,
      modelId,
      requestId: randomUUID(),
    });
    expect(task.checks.some((c) => c.code === "text_not_in_layers")).toBe(true);
    await processor.process(envelope(task.id));
    expect((await verifyGovernedTask(task.id)).status).toBe("completed");
    expect(JSON.stringify(observedBody)).toContain("production-preview");
    expect((await editor.get(context, file.project.id)).renders).toHaveLength(file.renders.length);
    expect((await workspace.detail(context, lineId)).line.artwork).toBe("in_progress");
    await editor.save(context, file.project.id, {
      expectedVersionId: file.version.id,
      document: { ...file.version.document, name: "Synthetic revised production file" },
    });
    expect(await assists.get(context, task.id)).toMatchObject({ stale: true, result: null });
  });

  it("pins and shares automatic artwork evidence, deduplicates calls, and never approves or reuses stale checks", async () => {
    const detail = await workspace.detail(context, lineId);
    let file = await editor.get(context, detail.line.editorProjectId!);
    const confirmations = {physicalSize: false, visualReview: false, narrowParts: false, whiteBorderRule: false, barcodeTab: false, backText: false};
    file = await editor.save(context, file.project.id, {expectedVersionId: file.version.id, document: {...file.version.document, confirmations}});
    const input = {kind: "artwork_preflight" as const, automaticAudit: true as const, orderLineId: lineId, expectedRevision: detail.line.revision, expectedEditorVersionId: file.version.id, modelId, requestId: randomUUID()};
    const repository = new ArtworkAuditRepository(database, contentVault);
    templateOutput = AssistResultSchema.parse({summary: "Synthetic visual check", findings: [], directions: [], matches: [], missingInformation: [],
      artworkChecks: ["visualReview", "narrowParts", "backText"].map(code => ({code, status: "passed", detail: "Synthetic observation", action: "", evidence: [{sourceId: "production-preview", detail: "Saw synthetic production sheet"}], marks: []}))});
    try {
      const task = await createGovernedTask(input);
      expect(task.artworkAudit).toMatchObject({complete: false, versionId: file.version.id, revision: detail.line.revision});
      expect(task.artworkAudit?.checks).toHaveLength(6);
      expect((await assists.create(context, {...input, requestId: randomUUID()})).id).toBe(task.id);
      await processor.process(envelope(task.id));
      const completed = await verifyGovernedTask(task.id);
      expect(completed.status).toBe("completed");
      expect(completed.artworkAudit?.checks.find(c => c.code === "visualReview")?.status).toBe("needs_review"); // No customer image in this fixture.
      expect(completed.artworkAudit?.checks.find(c => c.code === "barcodeTab")?.status).toBe("passed");
      expect(await repository.current(context, file.project.id, file.version.id)).toEqual(completed.artworkAudit);
      expect(await repository.current(other, file.project.id, file.version.id)).toBeNull();
      const reviewer = {...context, userId: other.userId};
      expect((await assists.get(reviewer, task.id)).artworkAudit).toEqual(completed.artworkAudit);
      expect((await assists.image(reviewer, task.id, 0)).length).toBeGreaterThan(0);
      await expect(assists.get({...reviewer, permissions: [Permission.DesignRead]}, task.id)).rejects.toBeInstanceOf(ForbiddenError);
      const check = await editor.preflight(context, file.project.id, {expectedVersionId: file.version.id, purpose: "production", format: "jpeg", background: "white"});
      expect(check.productionReady).toBe(false);
      expect(check.issues.some(i => i.code === "barcode_rule_unconfirmed")).toBe(false);
      expect(check.issues.some(i => i.code === "artwork_audit_visualReview")).toBe(true);
      expect((await editor.get(context, file.project.id)).version.document.confirmations).toEqual(confirmations);
      expect((await assists.create(context, {...input, requestId: randomUUID()})).id).toBe(task.id);
      expect((await workspace.detail(context, lineId)).line.artwork).toBe("in_progress");
      const retry = await assists.create(context, {...input, retryAudit: true, requestId: randomUUID()});
      expect(retry.id).not.toBe(task.id);
      expect((await repository.current(context, file.project.id, file.version.id))?.complete).toBe(false);
      await editor.save(context, file.project.id, {expectedVersionId: file.version.id, document: {...file.version.document, name: "Synthetic audit invalidation"}});
      expect(await repository.current(context, file.project.id, file.version.id)).toBeNull();
      expect(await assists.get(context, task.id)).toMatchObject({stale: true, artworkAudit: null, images: []});
    } finally { templateOutput = undefined; }
  }, 60000);

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
      const task = await createGovernedTask(request);
      expect(task.kind).toBe("template_config");
      await processor.process(envelope(task.id));
      const completed = await verifyGovernedTask(task.id);
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
      provider: "amazon",
      statementKind: "manual_adjustment",
      externalStatementId: "AI-BUSINESS-REPORT",
      sourceIdentity: { schemaVersion: 2, kind: "marketplace_account" },
      periodStart: now,
      periodEnd: now,
      sourceCurrency: "USD",
      observedAt: now,
      idempotencyKey: "ai-business-statement",
      lines: [
        {
          lineKey: "SALE",
          sourceEntryId: `synthetic-ai-sale:${line.line.orderId}`,
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
    expect(preview.rows).toContainEqual({ label: "核验粒度", value: "逐订单" });
    expect(run.diagnostics.coverage).toMatchObject({ dimension: "order", missingByEntity: [{ key: line.line.orderId, missingFactTypes: ["production_cost"] }] });
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
    const task = await createGovernedTask(request);
    await processor.process(envelope(task.id));
    await verifyGovernedTask(task.id);
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
    const processNow = Date.now();
    for (const skew of [-10, 10]) {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(processNow + skew * 86_400_000);
      try {
        const skewed = await business.preview(context, selection);
        expect(skewed.rows).toContainEqual({ label: "有效报价行", value: "1" });
        expect(skewed.fingerprint).toBe(preview.fingerprint);
      } finally { vi.useRealTimers(); }
    }
    const before = await procurement.workspace(context);
    const request = {
      ...selection,
      expectedFingerprint: preview.fingerprint,
      modelId,
      requestId: randomUUID(),
    };
    const task = await createGovernedTask(request);
    await processor.process(envelope(task.id));
    expect((await verifyGovernedTask(task.id)).status).toBe("completed");
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
      const task = await createGovernedTask(request);
      await processor.process(envelope(task.id));
      await verifyGovernedTask(task.id);
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

  it("harness access blocks queued creative tasks after attached knowledge permission is revoked", async () => {
    const knowledge = new KnowledgeService(database, audit);
    const fields = { title: "Synthetic harness knowledge", summary: "Synthetic fixture", body: "Synthetic harness scoped operating guidance", topic: "operations", platform: "all", market: "ALL", spuId: null,
      sourceType: "team", sourceLabel: "Synthetic SOP", sourceUrl: "", owner: "Synthetic operator", verifiedOn: "2020-01-01", reviewDueOn: "2099-12-31", tags: ["harness"] };
    const entry = await knowledge.save(context, null, { fields, expectedRevision: 0, reason: "Synthetic create", requestId: randomUUID() });
    await knowledge.change(context, entry.id, "submit", { expectedRevision: 1, version: 1, reason: "Synthetic review", requestId: randomUUID() });
    await knowledge.change(context, entry.id, "publish", { expectedRevision: 2, version: 1, reason: "Synthetic publish", requestId: randomUUID() });
    const references = await knowledge.search(context, { query: "Synthetic harness", topic: "operations", platform: "all", market: "ALL" });
    expect(references.references.length).toBeGreaterThan(0);
    const request = creativeRequest(), input = await contexts.prepare(context, request);
    const prepare = vi.spyOn(contexts, "prepare").mockResolvedValueOnce({ ...input, knowledge: references.references,
      data: { ...input.data, operatingKnowledge: references }, sources: [...input.sources, ...references.references.map(reference => ({ id: reference.sourceId, label: reference.title, href: reference.href }))] });
    let task: Awaited<ReturnType<AssistService["create"]>>;
    try { task = await assists.create(context, request); } finally { prepare.mockRestore(); }
    expect(task.accessPolicy).toMatchObject({ version: ASSIST_ACCESS_POLICY_VERSION, dataScope: "tenant", requiredPermissions: expect.arrayContaining([Permission.WorkflowRead]) });
    const calls = modelFetch.mock.calls.length;
    try {
      await withTenant(database.db, context, tx => tx.update(roles).set({ permissions: context.permissions.filter(permission => permission !== Permission.WorkflowRead) }).where(eq(roles.id, roleId)));
      const queuedBeforeReplay = enqueue.mock.calls.length;
      await expect(assists.create({ ...context, permissions: context.permissions.filter(permission => permission !== Permission.WorkflowRead) }, request)).rejects.toBeInstanceOf(ForbiddenError);
      expect(enqueue).toHaveBeenCalledTimes(queuedBeforeReplay);
      await processor.process(envelope(task.id));
      const [stored] = await withTenant(database.db, context, tx => tx.select().from(aiAssistRuns).where(eq(aiAssistRuns.id, task.id)));
      expect({ status: stored?.status, errorCode: stored?.errorCode, hasOutput: !!stored?.encryptedOutput }).toEqual({ status: "failed", errorCode: "assist_access_changed", hasOutput: false });
      expect(modelFetch).toHaveBeenCalledTimes(calls);
      const ledger = await withTenant(database.db, context, tx => tx.select().from(aiBudgetLedger).where(eq(aiBudgetLedger.requestId, task.id)));
      expect(ledger).toHaveLength(1);
      expect(ledger[0]!.state).toBe("released");
    } finally {
      await withTenant(database.db, context, tx => tx.update(roles).set({ permissions: context.permissions }).where(eq(roles.id, roleId)));
    }
  });

  it("harness access rechecks permission after image reads and before provider submission", async () => {
    const task = await assists.create(context, creativeRequest()), calls = modelFetch.mock.calls.length;
    let imageRead = false;
    const delayedProcessor = new AiAssistProcessor(database, modelVault, contentVault,
      (provider, key, row) => new OpenAiCompatibleProvider({ providerId: provider.id, endpoint: "https://provider.example.test", apiKey: key, pricing: assistPricing(row.modelSnapshot), fetch: modelFetch as typeof fetch }),
      async () => {
        imageRead = true;
        await withTenant(database.db, context, tx => tx.update(roles).set({ permissions: context.permissions.filter(permission => permission !== Permission.ResearchRead) }).where(eq(roles.id, roleId)));
        return new Response(await image(), { headers: { "content-type": "image/png" } });
      });
    try {
      await delayedProcessor.process(envelope(task.id));
      expect(imageRead).toBe(true);
      expect(modelFetch).toHaveBeenCalledTimes(calls);
      const [stored] = await withTenant(database.db, context, tx => tx.select().from(aiAssistRuns).where(eq(aiAssistRuns.id, task.id)));
      expect({ status: stored?.status, errorCode: stored?.errorCode, hasOutput: !!stored?.encryptedOutput }).toEqual({ status: "failed", errorCode: "assist_access_changed", hasOutput: false });
      const ledger = await withTenant(database.db, context, tx => tx.select().from(aiBudgetLedger).where(eq(aiBudgetLedger.requestId, task.id)));
      expect(ledger).toHaveLength(1);
      expect(ledger[0]!.state).toBe("released");
    } finally {
      await withTenant(database.db, context, tx => tx.update(roles).set({ permissions: context.permissions }).where(eq(roles.id, roleId)));
    }
  });

  it("harness access blocks a tenant-wide snapshot after membership scope is reduced", async () => {
    const task = await assists.create(context, creativeRequest()), calls = modelFetch.mock.calls.length;
    expect(task.accessPolicy?.dataScope).toBe("tenant");
    try {
      await withTenant(database.db, context, tx => tx.update(roles).set({ dataScope: "self" }).where(eq(roles.id, roleId)));
      await processor.process(envelope(task.id));
      expect(modelFetch).toHaveBeenCalledTimes(calls);
      const [stored] = await withTenant(database.db, context, tx => tx.select().from(aiAssistRuns).where(eq(aiAssistRuns.id, task.id)));
      expect({ status: stored?.status, errorCode: stored?.errorCode, hasOutput: !!stored?.encryptedOutput }).toEqual({ status: "failed", errorCode: "assist_access_changed", hasOutput: false });
      await expect(assists.get({ ...context, dataScope: "self" }, task.id)).rejects.toBeInstanceOf(ForbiddenError);
    } finally {
      await withTenant(database.db, context, tx => tx.update(roles).set({ dataScope: "tenant" }).where(eq(roles.id, roleId)));
    }
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

  it("blocks a queued order revision change, rejects replay and allows a search-cache refresh", async () => {
    const batch = await reports.importReport(context, {
      accountId, marketplaceId: "ATVPDKIKX0DER", fileName: "synthetic-authority.txt",
      content: `order-id\torder-item-id\tpurchase-date\tsku\tproduct-name\tquantity-purchased\tcurrency\titem-price\nAUTH-${randomUUID()}\tAUTH-LINE-${randomUUID()}\t${new Date().toISOString()}\tSYNTHETIC-AUTHORITY\tSynthetic authority gift\t1\tUSD\t20`,
    });
    const lineId = (await reports.workspace(context, { batchId: batch.id })).lines[0]!.orderLineId;
    const detail = await workspace.detail(context, lineId);
    const request = { kind: "order_review" as const, orderLineId: lineId, expectedRevision: detail.line.revision, expectedSourceVersionId: detail.report?.versionId ?? null, requestId: randomUUID(), modelId };
    const task = await assists.create(context, request), calls = modelFetch.mock.calls.length;
    const [original] = await withTenant(database.db, context, tx => tx.select().from(aiAssistRuns).where(eq(aiAssistRuns.id, task.id)));
    await workspace.save(context, lineId, { expectedRevision: detail.line.revision, expectedSourceVersionId: detail.report?.versionId ?? null,
      draft: { ...detail.draft, instructions: detail.draft.instructions + " Synthetic changed instructions" }, status: "needs_information", reason: "Synthetic current-source change", idempotencyKey: randomUUID() });
    const dispatches = enqueue.mock.calls.length;
    await expect(assists.create(context, request)).rejects.toThrow("原任务依据已变化");
    expect(enqueue).toHaveBeenCalledTimes(dispatches);
    await processor.process(envelope(task.id));
    const view = await assists.get(context, task.id);
    expect(view).toMatchObject({ status: "failed", costUsd: null, result: null, budgetState: "released", inputAuthority: task.inputAuthority });
    expect(view.diagnostics.join(" ")).toContain("订单及定制资料");
    expect(modelFetch).toHaveBeenCalledTimes(calls);
    const [stored] = await withTenant(database.db, context, tx => tx.select().from(aiAssistRuns).where(eq(aiAssistRuns.id, task.id)));
    const [ledger] = await withTenant(database.db, context, tx => tx.select().from(aiBudgetLedger).where(eq(aiBudgetLedger.requestId, task.id)));
    expect(stored!.encryptedInput).toBe(original!.encryptedInput); expect(ledger?.state).toBe("released");
    await withTenant(database.db, context, tx => tx.update(orderWorkItems).set({ searchRevision: -1 }).where(eq(orderWorkItems.id, lineId)));
    const current = await workspace.detail(context, lineId);
    const fresh = await assists.create(context, { ...request, requestId: randomUUID(), expectedRevision: current.line.revision, expectedSourceVersionId: current.report?.versionId ?? null });
    await workspace.list(context, {});
    const [refreshed] = await withTenant(database.db, context, tx => tx.select({ revision: orderWorkItems.revision, search: orderWorkItems.searchRevision }).from(orderWorkItems).where(eq(orderWorkItems.id, lineId)));
    expect(refreshed?.search).toBe(refreshed?.revision);
    await processor.process(envelope(fresh.id));
    expect((await assists.get(context, fresh.id)).status).toBe("completed");
    expect(modelFetch).toHaveBeenCalledTimes(calls + 1);
  });

  it("uses current inventory dependencies without invalidating an unrelated stock movement", async () => {
    const warehouse = await inventory.createWarehouse(context, { code: "AUTH-W", name: "Synthetic authority warehouse", type: "owned", countryCode: "US", timeZone: "UTC" });
    const location = await inventory.createLocation(context, { warehouseId: warehouse.id, code: "AUTH-L", name: "Synthetic authority location" });
    const first = await inventory.createStockItem(context, { skuId: null, code: "AUTH-A", name: "Synthetic first stock", baseUnit: "each" });
    const second = await inventory.createStockItem(context, { skuId: null, code: "AUTH-B", name: "Synthetic unrelated stock", baseUnit: "each" });
    const movement = (stockItemId: string, id: string) => inventory.recordMovement(context, { stockItemId, locationId: location.id, lotId: null, bucket: "physical", type: "adjustment", quantityDelta: 1, unit: "each", sourceType: "manual", sourceId: id, reasonCode: "OPENING", occurredAt: new Date().toISOString(), idempotencyKey: id });
    await movement(first.id, "auth-first-opening");
    const selection = { kind: "procurement_review" as const, stockItemId: first.id, locationId: location.id };
    const before = await business.preview(context, selection);
    const stale = await assists.create(context, { ...selection, expectedFingerprint: before.fingerprint, requestId: randomUUID(), modelId });
    const calls = modelFetch.mock.calls.length;
    await movement(first.id, "auth-first-change");
    await processor.process(envelope(stale.id));
    expect(await assists.get(context, stale.id)).toMatchObject({ status: "failed", costUsd: null });
    expect(modelFetch).toHaveBeenCalledTimes(calls);
    const latest = await business.preview(context, selection);
    const current = await assists.create(context, { ...selection, expectedFingerprint: latest.fingerprint, requestId: randomUUID(), modelId });
    await movement(second.id, "auth-unrelated-change");
    await processor.process(envelope(current.id));
    expect((await assists.get(context, current.id)).status).toBe("completed");
    expect(modelFetch).toHaveBeenCalledTimes(calls + 1);
  });

  it("keeps after-sales execution valid after search refresh but rejects new case evidence before submission", async () => {
    const detail = await workspace.detail(context, lineId);
    const record = await afterSales.create(context, detail.line.orderId, {
      type: "quality_issue", reasonCode: "SIZE_MISMATCH", summary: "Synthetic authority case", idempotencyKey: randomUUID(),
    });
    const selection = { kind: "after_sales_review" as const, caseId: record.case.id, locale: "en-US" as const, contextNotes: "Synthetic evidence review" };
    await withTenant(database.db, context, tx => tx.update(orderWorkItems).set({ searchRevision: -1 }).where(eq(orderWorkItems.id, lineId)));
    const before = await business.preview(context, selection);
    const current = await assists.create(context, { ...selection, expectedFingerprint: before.fingerprint, modelId, requestId: randomUUID() });
    const calls = modelFetch.mock.calls.length;
    await workspace.list(context, {});
    await processor.process(envelope(current.id));
    expect((await assists.get(context, current.id)).status).toBe("completed");
    expect(modelFetch).toHaveBeenCalledTimes(calls + 1);
    const fresh = await business.preview(context, selection);
    const changed = await assists.create(context, { ...selection, expectedFingerprint: fresh.fingerprint, modelId, requestId: randomUUID() });
    await afterSales.recordContact(context, record.case.id, {
      channel: "marketplace", direction: "inbound", body: "Synthetic new evidence", externalMessageId: "AUTHORITY-CASE-CONTACT", occurredAt: new Date().toISOString(), idempotencyKey: randomUUID(),
    });
    await processor.process(envelope(changed.id));
    expect(await assists.get(context, changed.id)).toMatchObject({ status: "failed", costUsd: null });
    expect(modelFetch).toHaveBeenCalledTimes(calls + 1);
  });

  it.each([false, true])("does not manufacture missing dependency snapshots for legacy execution=%s", async durable => {
    const request = creativeRequest(), input = await contexts.prepare(context, request), id = createEntityId();
    const model = (await assists.models(context)).find(m => m.id === modelId)!;
    const encryptedInput = contentVault.encrypt(JSON.stringify(input)), inputFingerprint = assistFingerprint(input);
    await withTenant(database.db, context, async tx => {
      await tx.insert(aiAssistRuns).values({ id, tenantId: context.tenantId, ownerId: context.userId, requestId: request.requestId, kind: "creative", scope: `creative:${request.kind === "creative" ? request.scopeId : id}`, inputFingerprint, requestFingerprint: assistFingerprint(request), encryptedInput,
        modelSnapshot: { ...model, providerConfigId: providerId }, promptVersion: ASSIST_PROMPT_VERSION, reservedCostUsd: model.maxTaskCostUsd!.toFixed(6), expiresAt: new Date(Date.now() + 86400000) });
      await tx.insert(aiBudgetLedger).values({ id: createEntityId(), tenantId: context.tenantId, requestId: id, taskType: "creative", modelKey: model.model, provider: "openai-compatible", amountUsd: model.maxTaskCostUsd!.toFixed(6), state: "reserved" });
      if (durable) await tx.insert(aiAssistExecutions).values({ runId: id, tenantId: context.tenantId, inputFingerprint, policyChecksum: assistExecutionPolicy(false).checksum });
    });
    const calls = modelFetch.mock.calls.length;
    await processor.process(envelope(id));
    const result = await assists.get(context, id);
    expect(result).toMatchObject({ status: "failed", inputAuthority: null, costUsd: null });
    expect(result.error).toContain("旧任务缺少业务依赖快照");
    expect(modelFetch).toHaveBeenCalledTimes(calls);
    const [stored] = await withTenant(database.db, context, tx => tx.select().from(aiAssistRuns).where(eq(aiAssistRuns.id, id)));
    const [ledger] = await withTenant(database.db, context, tx => tx.select().from(aiBudgetLedger).where(eq(aiBudgetLedger.requestId, id)));
    expect(stored!.encryptedInput).toBe(encryptedInput); expect(ledger?.state).toBe("released");
    expect((await withTenant(database.db, context, tx => tx.select().from(aiAssistExecutions).where(eq(aiAssistExecutions.runId, id)))).length).toBe(durable ? 1 : 0);
  });

  it.each(["missing", "unknown_tool", "wrong_method", "unsupported_version"] as const)("rejects a historical %s tool contract before replay, model submission or reservation use", async kind => {
    const request = CreateAssistSchema.parse(creativeRequest()), input = await contexts.prepareForExecution(context, request), id = createEntityId();
    if (kind === "missing") delete input.executionContract;
    else if (kind === "unknown_tool") input.executionContract!.tools[0]!.key = "marketplace.publish";
    else if (kind === "wrong_method") input.executionContract!.skill.key = "yummyai.assist.knowledge_answer.review";
    else input.executionContract!.tools[0]!.version = "unsupported-v99";
    const model = (await assists.models(context)).find(m => m.id === modelId)!;
    const encryptedInput = contentVault.encrypt(JSON.stringify(input)), inputFingerprint = assistFingerprint(input);
    await withTenant(database.db, context, async tx => {
      await tx.insert(aiAssistRuns).values({ id, tenantId: context.tenantId, ownerId: context.userId, requestId: request.requestId, kind: "creative", scope: `creative:${request.kind === "creative" ? request.scopeId : id}`, inputFingerprint, requestFingerprint: assistFingerprint(request), encryptedInput,
        modelSnapshot: { ...model, providerConfigId: providerId }, promptVersion: ASSIST_PROMPT_VERSION, reservedCostUsd: model.maxTaskCostUsd!.toFixed(6), expiresAt: new Date(Date.now() + 86400000) });
      await tx.insert(aiBudgetLedger).values({ id: createEntityId(), tenantId: context.tenantId, requestId: id, taskType: "creative", modelKey: model.model, provider: "openai-compatible", amountUsd: model.maxTaskCostUsd!.toFixed(6), state: "reserved" });
      await tx.insert(aiAssistExecutions).values({ runId: id, tenantId: context.tenantId, inputFingerprint, policyChecksum: assistExecutionPolicy(false).checksum });
    });
    const calls = modelFetch.mock.calls.length, dispatches = enqueue.mock.calls.length;
    await expect(assists.create(context, request)).rejects.toThrow("工具或执行方法无法核验");
    expect(enqueue).toHaveBeenCalledTimes(dispatches);
    await processor.process(envelope(id));
    const view = await assists.get(context, id);
    expect(view).toMatchObject({ status: "failed", costUsd: null, budgetState: "released", result: null });
    expect(view.error).toMatch(/工具|执行方法/);
    expect(modelFetch).toHaveBeenCalledTimes(calls);
    const [stored] = await withTenant(database.db, context, tx => tx.select().from(aiAssistRuns).where(eq(aiAssistRuns.id, id)));
    expect(stored!.encryptedInput).toBe(encryptedInput);
  });

  it("keeps the committed assist intent and reservation when Redis admission fails", async () => {
    const request = creativeRequest(); enqueue.mockRejectedValueOnce(new Error("synthetic Redis outage"));
    const task = await assists.create(context, request);
    expect(task.status).toBe("queued");
    expect(task.error).toContain("任务已保存");
    const [execution] = await withTenant(database.db, context, tx => tx.select().from(aiAssistExecutions).where(eq(aiAssistExecutions.runId, task.id)));
    expect(execution).toMatchObject({ phase: "pending", submissionState: "not_submitted", attemptCount: 0 });
    const [ledger] = await withTenant(database.db, context, tx => tx.select().from(aiBudgetLedger).where(eq(aiBudgetLedger.requestId, task.id)));
    expect(ledger?.state).toBe("reserved");
    expect((await assists.create(context, request)).id).toBe(task.id);
    await processor.process(envelope(task.id));
    expect((await assists.get(context, task.id)).status).toBe("completed");
  });

  it("fences concurrent deliveries without interrupting a live paid assist", async () => {
    const task = await assists.create(context, creativeRequest()), before = modelFetch.mock.calls.length;
    const original = modelFetch.getMockImplementation()!;
    const started = executionGate(), gate = executionGate();
    modelFetch.mockImplementationOnce(async (...args) => { started.resolve(); await gate.promise; return original(...args); });
    const running = processor.process(envelope(task.id));
    try {
      await started.promise;
      vi.useFakeTimers({toFake:["Date"]});
      try {
        vi.setSystemTime(new Date(Date.now()+600_000));
        expect(await processor.process(envelope(task.id))).toMatchObject({ disposition: "skipped" });
      } finally {vi.useRealTimers();}
      expect((await assists.get(context, task.id)).status).toBe("running");
    } finally { gate.resolve(); await running; }
    expect(modelFetch).toHaveBeenCalledTimes(before + 1);
    expect((await assists.get(context, task.id)).status).toBe("completed");
  });

  it("dispatches a lost original intent through real Redis and resumes an expired unsubmitted lease", async () => {
    const task = await assists.create(context, creativeRequest()), before = modelFetch.mock.calls.length;
    await withTenant(database.db, context, async tx => {
      await tx.update(aiAssistRuns).set({ status: "running", startedAt: new Date() }).where(eq(aiAssistRuns.id, task.id));
      // The scheduler uses database time; make the expired fixture independent of VM/host clock drift.
      await tx.update(aiAssistExecutions).set({ phase: "preparing", attemptCount: 1, leaseToken: createEntityId(), leaseExpiresAt: sql`clock_timestamp()-interval '1 second'`, nextAttemptAt: sql`clock_timestamp()-interval '1 second'`, lastDispatchedAt: null }).where(eq(aiAssistExecutions.runId, task.id));
    });
    const queue = createQueue(QueueName.AiAssist), scheduler = new AiAssistScheduler(database, queue);
    try {
      const dispatch=await scheduler.dispatch();
      expect(dispatch.failed).toBe(0);
      expect(dispatch.queued).toBeGreaterThan(0);
      const job = (await queue.getJobs()).find(j => j.data.payload.runId === task.id);
      expect(job).toBeDefined();
      expect(JSON.stringify(job!.data)).not.toContain("encrypted");
      vi.useFakeTimers({toFake:["Date"]});
      try {
        vi.setSystemTime(new Date(Date.now()-60_000));
        await processor.process(JobEnvelopeSchema.parse(job!.data));
      } finally {vi.useRealTimers();}
    } finally { await scheduler.close(); }
    expect(modelFetch).toHaveBeenCalledTimes(before + 1);
    const [execution] = await withTenant(database.db, context, tx => tx.select().from(aiAssistExecutions).where(eq(aiAssistExecutions.runId, task.id)));
    expect(execution).toMatchObject({ phase: "completed", attemptCount: 2, leaseToken: null });
  });

  it("rejects a late response from an expired lease after uncertainty has been recorded", async () => {
    const task = await assists.create(context, creativeRequest()), before = modelFetch.mock.calls.length;
    const original = modelFetch.getMockImplementation()!;
    const started = executionGate(), gate = executionGate();
    modelFetch.mockImplementationOnce(async (...args) => { started.resolve(); await gate.promise; return original(...args); });
    const running = processor.process(envelope(task.id));
    try {
      await started.promise;
      await withTenant(database.db, context, tx => tx.update(aiAssistExecutions).set({ leaseExpiresAt: sql`clock_timestamp()-interval '1 second'` }).where(eq(aiAssistExecutions.runId, task.id)));
      await processor.process(envelope(task.id));
    } finally { gate.resolve(); await running; }
    expect(modelFetch).toHaveBeenCalledTimes(before + 1);
    const [stored] = await withTenant(database.db, context, tx => tx.select().from(aiAssistRuns).where(eq(aiAssistRuns.id, task.id)));
    const [execution] = await withTenant(database.db, context, tx => tx.select().from(aiAssistExecutions).where(eq(aiAssistExecutions.runId, task.id)));
    const [ledger] = await withTenant(database.db, context, tx => tx.select().from(aiBudgetLedger).where(eq(aiBudgetLedger.requestId, task.id)));
    expect(stored).toMatchObject({ status: "failed", errorCode: "assist_submission_unknown", encryptedOutput: null });
    expect(execution).toMatchObject({ phase: "uncertain", encryptedResponse: null }); expect(ledger?.state).toBe("reserved");
  });

  it("retains an uncertain submitted request without another provider call or budget release", async () => {
    const task = await assists.create(context, creativeRequest()), before = modelFetch.mock.calls.length;
    await withTenant(database.db, context, async tx => {
      await tx.update(aiAssistRuns).set({ status: "running", startedAt: new Date() }).where(eq(aiAssistRuns.id, task.id));
      await tx.update(aiAssistExecutions).set({ phase: "preparing", submissionState: "submitted", submittedAt: new Date(), attemptCount: 1, leaseToken: createEntityId(), leaseExpiresAt: sql`clock_timestamp()-interval '1 second'` }).where(eq(aiAssistExecutions.runId, task.id));
    });
    await processor.process(envelope(task.id)); await processor.process(envelope(task.id));
    expect(modelFetch).toHaveBeenCalledTimes(before);
    expect(await assists.get(context, task.id)).toMatchObject({ status: "failed", costUsd: null });
    const [execution] = await withTenant(database.db, context, tx => tx.select().from(aiAssistExecutions).where(eq(aiAssistExecutions.runId, task.id)));
    const [ledger] = await withTenant(database.db, context, tx => tx.select().from(aiBudgetLedger).where(eq(aiBudgetLedger.requestId, task.id)));
    expect(execution?.phase).toBe("uncertain"); expect(ledger?.state).toBe("reserved");
  });

  it("recovers encrypted response processing without purchasing the model answer twice", async () => {
    const task = await assists.create(context, creativeRequest()), before = modelFetch.mock.calls.length;
    const original = contentVault.encrypt.bind(contentVault);
    const storageFailure = vi.spyOn(contentVault, "encrypt").mockImplementation(raw => {
      if (Object.hasOwn(JSON.parse(raw) as object, "result")) throw new Error("synthetic local output storage interruption");
      return original(raw);
    });
    try { expect(await processor.process(envelope(task.id))).toMatchObject({ disposition: "recovery_pending" }); }
    finally { storageFailure.mockRestore(); }
    const [checkpoint] = await withTenant(database.db, context, tx => tx.select().from(aiAssistExecutions).where(eq(aiAssistExecutions.runId, task.id)));
    expect(checkpoint).toMatchObject({ phase: "response_ready", submissionState: "received", leaseToken: null });
    expect(checkpoint!.encryptedResponse).not.toContain("依据合成研究");
    const [bill] = await withTenant(database.db, context, tx => tx.select().from(aiBudgetLedger).where(eq(aiBudgetLedger.requestId, task.id)));
    expect(bill?.state).toBe("committed");
    // An early duplicate respects the local backoff, then the same durable checkpoint resumes.
    expect(await processor.process(envelope(task.id))).toMatchObject({ disposition: "skipped" });
    await withTenant(database.db, context, tx => tx.update(aiAssistExecutions).set({ nextAttemptAt: sql`clock_timestamp()-interval '1 second'` }).where(eq(aiAssistExecutions.runId, task.id)));
    expect(await processor.process(envelope(task.id))).toMatchObject({ disposition: "completed" });
    expect(modelFetch).toHaveBeenCalledTimes(before + 1);
    const [settled] = await withTenant(database.db, context, tx => tx.select().from(aiBudgetLedger).where(eq(aiBudgetLedger.requestId, task.id)));
    expect(settled).toMatchObject({ id: bill!.id, state: "committed", amountUsd: bill!.amountUsd });
  });

  it("records paid response usage before rejecting invalid output and preserves immutable scoped evidence", async () => {
    const task = await assists.create(context, creativeRequest()), before = modelFetch.mock.calls.length;
    modelFetch.mockResolvedValueOnce(Response.json({ id: "synthetic-paid-receipt", usage: { prompt_tokens: 120, completion_tokens: 300 }, choices: [{ message: { content: "invalid JSON synthetic private data" } }] }));
    await processor.process(envelope(task.id));
    const view = await assists.get(context, task.id);
    expect(view.status).toBe("failed"); expect(view.costUsd).toBeGreaterThan(0); expect(JSON.stringify(view)).not.toContain("private data");
    const [execution] = await withTenant(database.db, context, tx => tx.select().from(aiAssistExecutions).where(eq(aiAssistExecutions.runId, task.id)));
    const [ledger] = await withTenant(database.db, context, tx => tx.select().from(aiBudgetLedger).where(eq(aiBudgetLedger.requestId, task.id)));
    expect(execution).toMatchObject({ phase: "failed", submissionState: "received", providerRequestId: "synthetic-paid-receipt" }); expect(ledger?.state).toBe("committed");
    expect(view.invocations?.[0]).toMatchObject({boundary:"received",providerRequestId:"synthetic-paid-receipt",billing:{basis:"configured_rate",budgetState:"committed",needsProviderEvidence:true}});
    expect(await withTenant(database.db, other, tx => tx.select().from(aiAssistExecutions).where(eq(aiAssistExecutions.runId, task.id)))).toEqual([]);
    await expect(withTenant(database.db, context, tx => tx.update(aiAssistExecutions).set({ inputFingerprint: "changed" }).where(eq(aiAssistExecutions.runId, task.id)))).rejects.toThrow();
    await expect(withTenant(database.db, context, tx => tx.update(aiAssistExecutions).set({ encryptedResponse: "changed" }).where(eq(aiAssistExecutions.runId, task.id)))).rejects.toThrow();
    await expect(withTenant(database.db, context, tx => tx.update(aiAssistExecutions).set({ phase: "pending" }).where(eq(aiAssistExecutions.runId, task.id)))).rejects.toThrow();
    await processor.process(envelope(task.id)); expect(modelFetch).toHaveBeenCalledTimes(before + 1);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(Date.now() + 31 * 86400000));
      await processor.process({ ...envelope(task.id), payload: { runId: task.id, operation: "expire" } });
      const [expired] = await withTenant(database.db, context, tx => tx.select().from(aiAssistExecutions).where(eq(aiAssistExecutions.runId, task.id)));
      expect(expired).toMatchObject({ phase: "failed", encryptedResponse: null, responseChecksum: execution!.responseChecksum });
    } finally { vi.useRealTimers(); }
  });

  it("settles only reserved AI budgets with column permissions, immutable terminal amounts, and tenant isolation", async () => {
    const committedId = createEntityId(), releasedId = createEntityId();
    await withTenant(database.db, context, (tx) => tx.insert(aiBudgetLedger).values([committedId, releasedId].map((id) => ({
      id, tenantId: context.tenantId, requestId: createEntityId(), taskType: "integration_budget", modelKey: "synthetic",
      provider: "synthetic", amountUsd: "0.750000", state: "reserved",
    }))));
    const permissions = await withTenant(database.db, context, async (tx) => (await tx.execute(sql`
      select has_column_privilege(current_user, 'ai_budget_ledger', 'state', 'UPDATE') as state_update,
      has_column_privilege(current_user, 'ai_budget_ledger', 'amount_usd', 'UPDATE') as amount_update,
      has_column_privilege(current_user, 'ai_budget_ledger', 'tenant_id', 'UPDATE') as tenant_update,
      has_column_privilege(current_user, 'ai_budget_ledger', 'request_id', 'UPDATE') as request_update,
      has_table_privilege(current_user, 'ai_budget_ledger', 'DELETE') as ledger_delete,
      (select relforcerowsecurity from pg_class where oid = 'ai_budget_ledger'::regclass) as forced_rls
    `))[0]);
    expect(permissions).toEqual({ state_update: true, amount_update: true, tenant_update: false, request_update: false, ledger_delete: false, forced_rls: true });
    const update = (id: string, state: string, amountUsd?: string) => withTenant(database.db, context, (tx) =>
      tx.update(aiBudgetLedger).set({ state, ...(amountUsd ? { amountUsd } : {}) }).where(eq(aiBudgetLedger.id, id)).returning());
    expect(await withTenant(database.db, other, (tx) => tx.update(aiBudgetLedger).set({ state: "released" }).where(eq(aiBudgetLedger.id, committedId)).returning())).toEqual([]);
    await expect(update(committedId, "reserved", "0.800000")).rejects.toThrow();
    await expect(update(committedId, "committed", "-0.100000")).rejects.toThrow();
    expect(await update(committedId, "committed", "0.250000")).toMatchObject([{ state: "committed", amountUsd: "0.250000" }]);
    expect(await update(committedId, "committed", "0.250000")).toHaveLength(1);
    await expect(update(committedId, "committed", "0.350000")).rejects.toThrow();
    await expect(update(committedId, "released")).rejects.toThrow();
    await expect(update(committedId, "reserved")).rejects.toThrow();
    await expect(update(releasedId, "released", "0.200000")).rejects.toThrow();
    expect(await update(releasedId, "released")).toMatchObject([{ state: "released", amountUsd: "0.750000" }]);
    expect(await update(releasedId, "released")).toHaveLength(1);
    await expect(update(releasedId, "committed", "0.250000")).rejects.toThrow();
    await expect(withTenant(database.db, context, (tx) => tx.update(aiBudgetLedger).set({ requestId: createEntityId() }).where(eq(aiBudgetLedger.id, committedId)))).rejects.toThrow();
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
    const oldFlag=process.env.MODEL_BILLING_TENANT_IDS;
    process.env.MODEL_BILLING_TENANT_IDS=context.tenantId;
    try {
      const billing=new ModelBillingService(database);
      const unpriced=await withTenant(database.db,context,tx=>tx.select({id:aiAssistRuns.id}).from(aiAssistRuns).where(sql`${aiAssistRuns.modelSnapshot}->>'maxTaskCostUsd' is null and ${aiAssistRuns.startedAt} is not null and ${aiAssistRuns.costUsd} is null`));
      expect(unpriced.length).toBeGreaterThan(0);
      const confirmed:Array<{id:string}>=[];
      for(const row of unpriced){
        const basis=await billing.basis(context,"assist",row.id);
        if(basis.originalInvocation?.boundary==="not_submitted"){
          expect(basis.canConfirm).toBe(false);
          continue;
        }
        await billing.confirm(context,"assist",row.id,{commandId:createEntityId(),expectedFingerprint:basis.fingerprint,amountUsd:"0",currency:"USD",evidenceKind:"provider_usage",invoiceReference:"synthetic-budget-review",providerRequestId:basis.providerRequestId??"synthetic-manual-"+row.id,proofChecksum:createHash("sha256").update(row.id).digest("hex"),matchesOriginalRequest:true});
        confirmed.push(row);
      }
      const permitted=await assists.create(context,{...creativeRequest(),modelId:sharedId});
      expect(permitted.status).toBe("queued");
      await processor.process(envelope(permitted.id));
      expect(confirmed.length).toBeGreaterThan(0);
      const original=confirmed[0]!,basis=await billing.basis(context,"assist",original.id);
      await billing.confirm(context,"assist",original.id,{commandId:createEntityId(),expectedFingerprint:basis.fingerprint,amountUsd:"101",currency:"USD",evidenceKind:"provider_invoice",invoiceReference:"synthetic-final-budget-review",providerRequestId:basis.providerRequestId??"synthetic-manual-"+original.id,proofChecksum:createHash("sha256").update(original.id+"final").digest("hex"),matchesOriginalRequest:true});
      const view=await assists.get(context,original.id);
      expect(view.costUsd).toBeNull();expect(view.invocations?.[0]?.billing.reconciliation?.amountUsd).toBe("101.00000000");
      const calls=modelFetch.mock.calls.length;
      await expect(assists.create(context,{...creativeRequest(),modelId:sharedId})).rejects.toThrow("组织当月 AI 预算不足");
      expect(modelFetch).toHaveBeenCalledTimes(calls);
    } finally {if(oldFlag===undefined)delete process.env.MODEL_BILLING_TENANT_IDS;else process.env.MODEL_BILLING_TENANT_IDS=oldFlag;}
  });
});
