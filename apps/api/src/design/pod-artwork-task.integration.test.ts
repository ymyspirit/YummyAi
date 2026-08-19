import { createEntityId, type PodExecutableToolKey, type TenantContext } from "@yummyai/contracts";
import { assetFiles, connectDatabase, migrateDatabase, withTenant } from "@yummyai/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuditService } from "../audit/audit.service.js";
import { DrizzleCatalogRepository, ProductService } from "../catalog/product.service.js";
import {
  PodArtworkInputAssetError,
  PodArtworkTaskService,
  type PodArtworkEnqueuer,
} from "./pod-artwork-task.service.js";
import { PodWorkbenchService } from "./pod-workbench.service.js";
import type { PodToolActivationPolicy } from "./pod-workbench.service.js";

describe("POD artwork task database", () => {
  const database = connectDatabase();
  const audit = new AuditService(database);
  const catalog = new ProductService(new DrizzleCatalogRepository(database));
  const enqueued: string[] = [];
  const enqueuer: PodArtworkEnqueuer = { enqueue: async ({ taskId }) => { enqueued.push(taskId); } };
  const activation = {
    enabledTools: () => new Set<PodExecutableToolKey>(["pattern_crop", "rights_risk_scan", "text_to_image", "series_design", "seamless_stitch", "product_suite", "title_draft", "virtual_try_on", "background_replace", "piece_extract", "piece_compose", "uv_layers"]),
  } as PodToolActivationPolicy;
  const service = new PodArtworkTaskService(
    database,
    enqueuer,
    new PodWorkbenchService(activation),
    audit,
  );
  const userId = createEntityId();
  const first = tenant(createEntityId(), userId);
  const second = tenant(createEntityId(), userId);
  let firstSkuId: string;
  let authorizedAssetId: string;
  let secondAuthorizedAssetId: string;
  let researchAssetId: string;

  beforeAll(async () => {
    await migrateDatabase(database);
    await database.client.unsafe(
      `insert into organizations (id, name, slug) values ($1, 'POD A', $2), ($3, 'POD B', $4)`,
      [first.tenantId, `pod-${first.tenantId}`, second.tenantId, `pod-${second.tenantId}`],
    );
    await database.client.unsafe(
      `insert into app_users (id, oidc_subject, email, display_name) values ($1, $2, $3, 'POD User')`,
      [userId, `pod-${userId}`, `${userId}@example.test`],
    );
    firstSkuId = await createSku(first);
    authorizedAssetId = await createAsset(first, "authorized", "approved", "a");
    secondAuthorizedAssetId = await createAsset(first, "authorized", "approved", "c");
    researchAssetId = await createAsset(first, "research", "unverified", "b");
  });

  afterAll(async () => { await database.client.end(); });

  it("pins input evidence and replays an idempotent request without a second queue job", async () => {
    const idempotencyKey = createEntityId();
    const input = {
      idempotencyKey,
      skuId: firstSkuId,
      toolKey: "pattern_crop" as const,
      title: "授权图案裁剪",
      inputAssetIds: [authorizedAssetId],
      parameterSnapshot: patternCropParameters({ multiCrop: true, maximumCropsPerInput: 4 }),
    };
    const created = await service.create(first, input);
    const replayed = await service.create(first, input);

    expect(replayed.id).toBe(created.id);
    expect(enqueued.filter((id) => id === created.id)).toHaveLength(1);
    expect(created.inputAssets[0]).toMatchObject({
      assetId: authorizedAssetId,
      version: 1,
      checksumSha256: "a".repeat(64),
      domain: "authorized",
      rightsStatus: "approved",
    });
    await expect(database.client.unsafe(
      `update pod_artwork_tasks set parameter_snapshot = '{"mode":"changed"}'::jsonb where id = $1`,
      [created.id],
    )).rejects.toMatchObject({ code: "55000" });
    await expect(service.get(second, created.id)).rejects.toMatchObject({ status: 404 });
  });

  it("allows research evidence only for rights-risk scans", async () => {
    await expect(service.create(first, {
      idempotencyKey: createEntityId(),
      skuId: firstSkuId,
      toolKey: "pattern_crop",
      title: "错误研究输入",
      inputAssetIds: [researchAssetId],
      parameterSnapshot: patternCropParameters(),
    })).rejects.toBeInstanceOf(PodArtworkInputAssetError);

    const riskTask = await service.create(first, {
      idempotencyKey: createEntityId(),
      skuId: firstSkuId,
      toolKey: "rights_risk_scan",
      title: "研究证据风险检查",
      inputAssetIds: [researchAssetId],
      parameterSnapshot: {
        depth: "deep", visualSimilarity: true, marketplaces: ["amazon", "etsy"],
        searchTerms: ["fixture artwork"], validityDays: 30,
      },
    });
    expect(riskTask.inputAssets[0]).toMatchObject({ domain: "research", rightsStatus: "unverified" });
  });

  it("pins asset-free text generation and source-bound series plans", async () => {
    const generated = await service.create(first, {
      idempotencyKey: createEntityId(), skuId: firstSkuId, toolKey: "text_to_image",
      title: "原创植物印花", inputAssetIds: [],
      parameterSnapshot: creativeParameters("text_to_image", { prompt: "original botanical tile" }),
    });
    const series = await service.create(first, {
      idempotencyKey: createEntityId(), skuId: firstSkuId, toolKey: "series_design",
      title: "双联系列印花", inputAssetIds: [authorizedAssetId],
      parameterSnapshot: creativeParameters("series_design", { batchPrompts: ["main tile", "companion tile"], outputCount: 2 }),
    });

    expect(generated.inputAssets).toEqual([]);
    expect(generated.parameterSnapshot).toMatchObject({ designTool: "text_to_image", prompt: "original botanical tile" });
    expect(series.inputAssets).toHaveLength(1);
    expect(series.parameterSnapshot).toMatchObject({ designTool: "series_design", batchPrompts: ["main tile", "companion tile"] });
  });

  it("pins fact-bound suite and title Listing candidates", async () => {
    const suite = await service.create(first, {
      idempotencyKey: createEntityId(), skuId: firstSkuId, toolKey: "product_suite",
      title: "Amazon 标准套图", inputAssetIds: [authorizedAssetId],
      parameterSnapshot: listingParameters("product_suite"),
    });
    const title = await service.create(first, {
      idempotencyKey: createEntityId(), skuId: firstSkuId, toolKey: "title_draft",
      title: "Amazon 标题草稿", inputAssetIds: [authorizedAssetId],
      parameterSnapshot: listingParameters("title_draft"),
    });

    expect(suite.parameterSnapshot).toMatchObject({
      listingTool: "product_suite", factSourcePolicy: "sku_catalog_snapshot", preserveProductIdentity: true,
    });
    expect(title.parameterSnapshot).toMatchObject({
      listingTool: "title_draft", requireFactAttribution: true, platformRuleVersion: "amazon-title-2026-08",
    });
  });

  it("pins a complete piece layout plan in the immutable task snapshot", async () => {
    const created = await service.create(first, {
      idempotencyKey: createEntityId(),
      skuId: firstSkuId,
      toolKey: "piece_compose",
      title: "双面裁片排版",
      inputAssetIds: [authorizedAssetId, secondAuthorizedAssetId],
      parameterSnapshot: {
        width: 600,
        height: 900,
        unit: "mm",
        dpi: 300,
        colorMode: "cmyk",
        positioningTemplate: "supplier-shirt-v3",
        fitMode: "contain",
        layoutMode: "manual",
        pieceKeys: ["front", "back"],
        minimumDpi: 300,
        gapMm: 5,
        allowRotation: true,
        manualPlacements: ["front,10,10,0,1", "back,310,10,90,1"],
      },
    });

    expect(created.parameterSnapshot).toMatchObject({
      layoutMode: "manual",
      pieceKeys: ["front", "back"],
      manualPlacements: ["front,10,10,0,1", "back,310,10,90,1"],
    });
    expect(created.inputAssets.map((asset) => asset.ordinal)).toEqual([0, 1]);
  });

  it("pins a one-source piece extraction and template-draft plan", async () => {
    const created = await service.create(first, {
      idempotencyKey: createEntityId(),
      skuId: firstSkuId,
      toolKey: "piece_extract",
      title: "分版裁片提取",
      inputAssetIds: [authorizedAssetId],
      parameterSnapshot: {
        width: 600,
        height: 900,
        unit: "mm",
        dpi: 300,
        colorMode: "cmyk",
        extractionMode: "separate",
        boundarySource: "alpha",
        pieceDefinitions: ["front|前片|0|none", "back|后片|180|horizontal"],
        printArea: "裁片边界内缩缝份后为印刷区域",
        seamAllowanceMm: 10,
        outputFormat: "png",
        preserveTransparency: true,
        minimumConfidence: 0.9,
        templateDraftName: "供应商上衣裁片草稿",
      },
    });

    expect(created.parameterSnapshot).toMatchObject({
      extractionMode: "separate",
      pieceDefinitions: ["front|前片|0|none", "back|后片|180|horizontal"],
      templateDraftName: "供应商上衣裁片草稿",
    });
    expect(created.inputAssets).toHaveLength(1);
    expect(created.inputAssets[0]?.ordinal).toBe(0);
  });

  it("pins a one-source UV channel plan and supplier profile", async () => {
    const created = await service.create(first, {
      idempotencyKey: createEntityId(),
      skuId: firstSkuId,
      toolKey: "uv_layers",
      title: "UV 智能分层",
      inputAssetIds: [authorizedAssetId],
      parameterSnapshot: {
        width: 300, height: 400, unit: "mm", dpi: 300, colorMode: "cmyk",
        separationMode: "automatic", layerPrefix: "uv", supplierChannelProfile: "supplier-uv-v1",
        layerDefinitions: [
          "artwork|彩墨层|color|0|1",
          "white|白墨层|white_ink|1|1",
          "varnish|光油层|varnish|2|1",
        ],
        outputFormat: "png", preserveTransparency: true,
        whiteInkLayer: true, varnishLayer: true,
        conflictPolicy: "manual_review", compositePreview: true,
      },
    });

    expect(created.parameterSnapshot).toMatchObject({
      supplierChannelProfile: "supplier-uv-v1",
      layerDefinitions: [
        "artwork|彩墨层|color|0|1",
        "white|白墨层|white_ink|1|1",
        "varnish|光油层|varnish|2|1",
      ],
    });
    expect(created.inputAssets).toHaveLength(1);
  });

  async function createSku(context: TenantContext) {
    const plan = await catalog.createPlan(context, {
      name: "POD integration",
      sourceReportIds: [createEntityId()],
      customization: { version: 1, fields: [] },
    });
    await catalog.transition(context, plan.id, "pending_approval");
    await catalog.transition(context, plan.id, "approved");
    const spu = await catalog.createSpu(context, plan.id, { code: `POD-${plan.id.slice(-6)}`, name: "POD product" });
    return (await catalog.createSku(context, { spuId: spu.id, code: `POD-SKU-${plan.id.slice(-6)}`, attributes: {} })).id;
  }

  async function createAsset(
    context: TenantContext,
    domain: "research" | "authorized",
    rightsStatus: "unverified" | "approved",
    checksumCharacter: string,
  ) {
    const id = createEntityId();
    await withTenant(database.db, context, (tx) => tx.insert(assetFiles).values({
      id,
      tenantId: context.tenantId,
      ownerUserId: context.userId,
      objectKey: `tenants/${context.tenantId}/${domain}/${checksumCharacter.repeat(64)}/source.png`,
      assetDomain: domain,
      fileName: "source.png",
      mediaType: "image/png",
      byteSize: 1200,
      checksumSha256: checksumCharacter.repeat(64),
      rightsStatus,
      rightsMetadata: rightsStatus === "approved"
        ? { source: { kind: "owned", reference: "integration" }, approvedAt: new Date().toISOString() }
        : {},
    }));
    return id;
  }
});

function patternCropParameters(overrides: Record<string, unknown> = {}) {
  return {
    mode: "general",
    multiCrop: false,
    maximumCropsPerInput: 1,
    outputFormat: "png",
    background: "preserved",
    perspectiveCorrection: true,
    cropPaddingPercent: 2,
    ...overrides,
  };
}

function creativeParameters(designTool: "text_to_image" | "series_design", overrides: Record<string, unknown> = {}) {
  return {
    designTool, prompt: "", referenceStrength: 70, creativity: 50, aspectRatio: "1:1",
    outputCount: 1, outputFormat: "png", markAiGenerated: true, markGeneratedAreas: true,
    ...overrides,
  };
}

function listingParameters(toolKey: "product_suite" | "title_draft") {
  const common = { listingTool: toolKey, platform: "amazon", locale: "en-US", outputCount: 2, markAiGenerated: true };
  return toolKey === "product_suite" ? {
    ...common, productCategory: "apparel", suiteTemplate: "standard", outputFormat: "png",
    preserveProductIdentity: true, factSourcePolicy: "sku_catalog_snapshot",
  } : {
    ...common, outputFormat: "txt", productFacts: "Black cotton T-shirt; floral front print",
    keywordConstraints: ["floral shirt"], platformRuleVersion: "amazon-title-2026-08",
    requireFactAttribution: true,
  };
}

function tenant(tenantId: string, userId: string): TenantContext {
  return { tenantId, userId, permissions: [], dataScope: "tenant" };
}
