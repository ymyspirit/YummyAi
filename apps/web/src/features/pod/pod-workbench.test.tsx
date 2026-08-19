import type { PodToolCatalogView } from "@yummyai/contracts/pod";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PodWorkbench } from "./pod-workbench";

const catalog: PodToolCatalogView = {
  supportedMarketplaces: ["amazon", "etsy"],
  modules: [
    { key: "print_extraction", label: "印花提取", order: 1, phase: "pod_1" },
    { key: "print_design", label: "印花设计", order: 2, phase: "pod_2" },
    { key: "pattern_processing", label: "图案处理", order: 3, phase: "pod_1" },
    { key: "rights_risk", label: "侵权检测", order: 4, phase: "pod_1" },
    { key: "listing_assets", label: "套图&标题", order: 5, phase: "pod_2" },
    { key: "personalization", label: "来图定制", order: 6, phase: "pod_3" },
    { key: "production_artwork", label: "生产图", order: 7, phase: "pod_3" },
  ],
  tools: [{
    key: "pattern_crop",
    module: "print_extraction",
    label: "图案裁剪",
    description: "从已授权商品图中识别并裁剪图案。",
    phase: "pod_1",
    availability: "implementation_active",
    assetPolicy: "authorized_only",
    inputKinds: ["image"],
    outputKinds: ["image", "transparent_image"],
    parameterSummary: ["裁剪模式", "多张裁剪"],
  }],
  supportCapabilities: [{
    key: "task_center",
    label: "任务中心",
    description: "查看异步任务进度。",
    phase: "pod_1",
    availability: "implementation_active",
  }],
};

describe("PodWorkbench", () => {
  it("renders the fixed seven-module order and real catalog state", () => {
    const html = renderToStaticMarkup(<PodWorkbench catalog={catalog} requestedModule="print_extraction" />);
    const labels = ["印花提取", "印花设计", "图案处理", "侵权检测", "套图&amp;标题", "来图定制", "生产图"];
    let previousIndex = -1;
    for (const label of labels) {
      const index = html.indexOf(label);
      expect(index).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }
    expect(html).toContain("Amazon");
    expect(html).toContain("Etsy");
    expect(html).toContain("图案裁剪");
    expect(html).toContain("仅授权域");
    expect(html).toContain("正在实现");
    expect(html).not.toContain("可创建任务</small>");
  });

  it("keeps module navigation visible when the catalog fails", () => {
    const html = renderToStaticMarkup(
      <PodWorkbench error={{ kind: "forbidden", message: "当前成员没有 design:read 权限。" }} />,
    );
    expect(html).toContain("缺少作图中心权限");
    expect(html).toContain("当前成员没有 design:read 权限");
    expect(html).toContain("印花提取");
    expect(html).toContain("生产图");
    expect(html).not.toContain("pod-tool-row");
  });

  it("renders the real task form and progress only when a tool is enabled", () => {
    const enabledCatalog: PodToolCatalogView = {
      ...catalog,
      tools: catalog.tools.map((tool) => ({ ...tool, availability: "enabled" })),
    };
    const taskId = "019f0000-0000-7000-8000-000000000001";
    const html = renderToStaticMarkup(
      <PodWorkbench
        catalog={enabledCatalog}
        inputOptions={{
          toolKey: "pattern_crop",
          enabled: true,
          requiresAssetInput: true,
          skus: [{ id: "019f0000-0000-7000-8000-000000000002", code: "TEE-BLK-M", spuCode: "TEE-BLK", productName: "黑色印花 T 恤" }],
          assets: [{
            id: "019f0000-0000-7000-8000-000000000003",
            fileName: "authorized-shirt.png",
            mediaType: "image/png",
            version: 2,
            checksumSha256: "a".repeat(64),
            domain: "authorized",
            rightsStatus: "approved",
          }],
        }}
        requestedModule="print_extraction"
        requestedTool="pattern_crop"
        tasks={[{
          id: taskId,
          designTaskId: "019f0000-0000-7000-8000-000000000004",
          skuId: "019f0000-0000-7000-8000-000000000002",
          title: "图案裁剪 · TEE-BLK-M",
          toolKey: "pattern_crop",
          status: "running",
          parameterSnapshot: patternCropParameters(),
          inputAssets: [{ assetId: "019f0000-0000-7000-8000-000000000003", ordinal: 0, version: 2, checksumSha256: "a".repeat(64), domain: "authorized", rightsStatus: "approved" }],
          qualityCheckSnapshot: {
            passed: true, mode: "general", inputCoverageComplete: true, cropBoundsValid: true,
            blankOutputsDetected: false, duplicateOutputsDetected: false,
            outputChecks: [{
              fileName: "front-print.png", inputOrdinal: 0, cropIndex: 0,
              sourceBounds: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
              outputWidth: 2400, outputHeight: 3000, transparent: false,
              perspectiveCorrectionValidated: true, cropComplete: true,
            }],
          },
          progressPercent: 45,
          attemptCount: 1,
          maxAttempts: 3,
          createdAt: "2026-08-03T06:00:00.000Z",
          updatedAt: "2026-08-03T06:01:00.000Z",
        }]}
      />,
    );
    expect(html).toContain("新建图案裁剪任务");
    expect(html).toContain("authorized-shirt.png");
    expect(html).toContain("创建异步任务");
    expect(html).toContain("处理中");
    expect(html).toContain('value="45"');
    expect(html).toContain("图案裁剪已校验");
    expect(html).toContain("1 张输入图 · 1 个裁剪结果 · 无空白/重复");
  });

  it("renders strict series-design controls and review evidence", () => {
    const creativeCatalog: PodToolCatalogView = {
      ...catalog,
      tools: [{
        key: "series_design", module: "print_design", label: "多联图/系列图/情侣图",
        description: "按批量提示词生成系列设计。", phase: "pod_2", availability: "enabled",
        assetPolicy: "authorized_only", inputKinds: ["image"], outputKinds: ["image"],
        parameterSummary: ["参考强度", "批量提示词"],
      }],
    };
    const skuId = "019f0000-0000-7000-8000-000000000012";
    const assetId = "019f0000-0000-7000-8000-000000000013";
    const checks = ["series-main.png", "series-companion.png"].map((fileName, outputIndex) => ({
      fileName, outputIndex, sourceInputOrdinals: [0], width: 2400, height: 2400,
      format: "png" as const, transparent: false, aiInference: "full" as const,
      generatedRegions: [], promptSafetyPassed: true as const, contentSafetyPassed: true as const,
      textDetected: false, textReviewRequired: false, sourceIdentityPreserved: true as const,
    }));
    const html = renderToStaticMarkup(<PodWorkbench
      catalog={creativeCatalog}
      requestedModule="print_design"
      requestedTool="series_design"
      inputOptions={{
        toolKey: "series_design", enabled: true, requiresAssetInput: true,
        skus: [{ id: skuId, code: "TEE-SERIES", spuCode: "TEE", productName: "系列印花 T 恤" }],
        assets: [{ id: assetId, fileName: "licensed-floral.png", mediaType: "image/png", version: 1, checksumSha256: "b".repeat(64), domain: "authorized", rightsStatus: "approved" }],
      }}
      tasks={[{
        id: "019f0000-0000-7000-8000-000000000014",
        designTaskId: "019f0000-0000-7000-8000-000000000015",
        skuId,
        title: "花卉双联系列",
        toolKey: "series_design",
        status: "awaiting_review",
        parameterSnapshot: {
          designTool: "series_design", prompt: "", referenceStrength: 70, creativity: 50,
          aspectRatio: "1:1", outputCount: 2, outputFormat: "png", markAiGenerated: true,
          markGeneratedAreas: true, batchPrompts: ["main floral tile", "companion floral tile"],
        },
        inputAssets: [{ assetId, ordinal: 0, version: 1, checksumSha256: "b".repeat(64), domain: "authorized", rightsStatus: "approved" }],
        modelKey: "pod.series-design.v1", modelVersion: "2026-08-04", seed: "42",
        qualityCheckSnapshot: {
          passed: true, toolKey: "series_design", inputCoverageComplete: true,
          outputCountMatched: true, duplicateOutputsDetected: false,
          finalPromptHashSha256: "c".repeat(64), outputChecks: checks,
        },
        progressPercent: 100, attemptCount: 1, maxAttempts: 3,
        createdAt: "2026-08-04T06:00:00.000Z", updatedAt: "2026-08-04T06:02:00.000Z",
      }]}
    />);

    expect(html).toContain("系列提示词（每行一条）");
    expect(html).toContain("印花设计已校验");
    expect(html).toContain("2 张结果 · 1 张输入 · AI 生成");
    expect(html).toContain("AI 结果仍需人工审核");
  });

  it("renders a partial product suite with isolated failed-slot evidence", () => {
    const listingCatalog: PodToolCatalogView = {
      ...catalog,
      tools: [{
        key: "product_suite", module: "listing_assets", label: "商品套图",
        description: "生成 Listing 候选套图。", phase: "pod_2", availability: "enabled",
        assetPolicy: "authorized_only", inputKinds: ["image"], outputKinds: ["image"],
        parameterSummary: ["平台", "品类", "套图模板"],
      }],
    };
    const skuId = "019f0000-0000-7000-8000-000000000022";
    const assetId = "019f0000-0000-7000-8000-000000000023";
    const html = renderToStaticMarkup(<PodWorkbench
      catalog={listingCatalog}
      requestedModule="listing_assets"
      requestedTool="product_suite"
      inputOptions={{
        toolKey: "product_suite", enabled: true, requiresAssetInput: true,
        skus: [{ id: skuId, code: "TEE-SUITE", spuCode: "TEE", productName: "Listing 套图 T 恤" }],
        assets: [{ id: assetId, fileName: "approved-shirt.png", mediaType: "image/png", version: 1, checksumSha256: "e".repeat(64), domain: "authorized", rightsStatus: "approved" }],
      }}
      tasks={[{
        id: "019f0000-0000-7000-8000-000000000024",
        designTaskId: "019f0000-0000-7000-8000-000000000025",
        skuId, title: "服装标准套图", toolKey: "product_suite", status: "partially_succeeded",
        parameterSnapshot: {
          listingTool: "product_suite", platform: "amazon", locale: "en-US", productCategory: "apparel",
          suiteTemplate: "standard", outputCount: 2, outputFormat: "png", markAiGenerated: true,
          preserveProductIdentity: true, factSourcePolicy: "sku_catalog_snapshot",
        },
        inputAssets: [{ assetId, ordinal: 0, version: 1, checksumSha256: "e".repeat(64), domain: "authorized", rightsStatus: "approved" }],
        modelKey: "pod.product-suite.v1", modelVersion: "2026-08-04", seed: "84",
        qualityCheckSnapshot: {
          passed: true, toolKey: "product_suite", platform: "amazon", locale: "en-US",
          requestedOutputCount: 2, successfulOutputCount: 1, failedOutputCount: 1,
          inputCoverageComplete: true, duplicateOutputsDetected: false,
          outputChecks: [{
            fileName: "main.png", outputIndex: 0, sourceInputOrdinals: [0], contentKind: "image",
            slotKey: "main", width: 1600, height: 2000, format: "png", transparent: false,
            aiInference: "full", generatedRegions: [], productIdentityPreserved: true,
            categoryIdentityPassed: true, printPlacementPreserved: true, approvedFactsOnly: true,
            contentSafetyPassed: true, textDetected: false, textReviewRequired: false,
          }],
          failedOutputs: [{ outputIndex: 1, slotKey: "alternate", errorCode: "PROCESSOR_SLOT_FAILED", safeMessage: "候选槽位生成失败" }],
        },
        progressPercent: 100, attemptCount: 1, maxAttempts: 3,
        createdAt: "2026-08-04T07:00:00.000Z", updatedAt: "2026-08-04T07:03:00.000Z",
      }]}
    />);

    expect(html).toContain("商品品类");
    expect(html).toContain("套图部分完成，失败槽位已隔离");
    expect(html).toContain("1 成功 · 1 失败");
    expect(html).toContain("PROCESSOR_SLOT_FAILED");
  });

  it("renders an executable product-video plan and strict review evidence", () => {
    const skuId = "019f0000-0000-7000-8000-000000000051";
    const assetId = "019f0000-0000-7000-8000-000000000052";
    const videoCatalog: PodToolCatalogView = {
      ...catalog,
      tools: [{
        key: "product_video", module: "listing_assets", label: "商品短视频",
        description: "从授权商品图生成可审核 MP4。", phase: "pod_2", availability: "enabled",
        assetPolicy: "authorized_only", inputKinds: ["image"], outputKinds: ["video"],
        parameterSummary: ["H.264", "字幕安全区", "许可音轨"],
      }],
    };
    const html = renderToStaticMarkup(
      <PodWorkbench
        catalog={videoCatalog}
        inputOptions={{
          toolKey: "product_video", enabled: true, requiresAssetInput: true,
          skus: [{ id: skuId, code: "PET-TAG-M", spuCode: "PET-TAG", productName: "宠物挂牌" }],
          assets: [{ id: assetId, fileName: "approved-detail.webp", mediaType: "image/webp", version: 1, checksumSha256: "e".repeat(64), domain: "authorized", rightsStatus: "approved" }],
        }}
        requestedModule="listing_assets"
        requestedTool="product_video"
        tasks={[{
          id: "019f0000-0000-7000-8000-000000000053",
          designTaskId: "019f0000-0000-7000-8000-000000000054",
          skuId,
          title: "竖版商品短视频",
          toolKey: "product_video",
          status: "awaiting_review",
          parameterSnapshot: {
            durationSeconds: 15, shotTemplate: "detail", aspectRatio: "9:16", resolution: "1080p", fps: 30,
            transition: "fade", loop: false, captionMode: "custom", captionText: "细节展示",
            soundtrackMode: "licensed", soundtrackLicenseReference: "license://audio/42",
            soundtrackRightsAttested: true, allowAiMotion: true, safeArea: true,
          },
          inputAssets: [{ assetId, ordinal: 0, version: 1, checksumSha256: "e".repeat(64), domain: "authorized", rightsStatus: "approved" }],
          qualityCheckSnapshot: {
            passed: true, durationMatched: true, fpsMatched: true, dimensionsMatched: true, inputCoverageComplete: true,
            playbackValid: true, blankFramesDetected: false, corruptFramesDetected: false, safeAreaPassed: true,
            captionOverflowDetected: false, audioClippingDetected: false, soundtrackLicenseMatched: true, aiMotionEvidenceMatched: true,
            outputChecks: [{ fileName: "detail.mp4", usedInputOrdinals: [0], durationSeconds: 15, fps: 30, width: 1080, height: 1920, videoCodec: "h264", audioCodec: "aac" }],
          },
          progressPercent: 100, attemptCount: 1, maxAttempts: 3,
          resultVersionId: "019f0000-0000-7000-8000-000000000055",
          createdAt: "2026-08-04T08:00:00.000Z", updatedAt: "2026-08-04T08:01:00.000Z",
        }]}
      />,
    );
    expect(html).toContain("新建商品短视频任务");
    expect(html).toContain('name="soundtrackLicenseReference"');
    expect(html).toContain("安全区检查固定开启");
    expect(html).toContain("商品短视频已通过检查");
    expect(html).toContain("15 秒 · 1080×1920 · 30 FPS · 1 张输入图");
    expect(html).toContain("H.264 · AAC 许可音轨");
  });

  it("renders a marked outpaint plan and per-file processing evidence", () => {
    const skuId = "019f0000-0000-7000-8000-000000000061";
    const assetId = "019f0000-0000-7000-8000-000000000062";
    const processingCatalog: PodToolCatalogView = {
      ...catalog,
      tools: [{
        key: "outpaint", module: "pattern_processing", label: "扩图",
        description: "延展授权图片并保留 AI 区域。", phase: "pod_1", availability: "enabled",
        assetPolicy: "authorized_only", inputKinds: ["image"], outputKinds: ["image"],
        parameterSummary: ["比例", "方向", "AI 区域标记"],
      }],
    };
    const html = renderToStaticMarkup(
      <PodWorkbench
        catalog={processingCatalog}
        inputOptions={{
          toolKey: "outpaint", enabled: true, requiresAssetInput: true,
          skus: [{ id: skuId, code: "PET-TAG-M", spuCode: "PET-TAG", productName: "宠物挂牌" }],
          assets: [{ id: assetId, fileName: "approved-scene.png", mediaType: "image/png", version: 1, checksumSha256: "c".repeat(64), domain: "authorized", rightsStatus: "approved" }],
        }}
        requestedModule="pattern_processing"
        requestedTool="outpaint"
        tasks={[{
          id: "019f0000-0000-7000-8000-000000000063",
          designTaskId: "019f0000-0000-7000-8000-000000000064",
          skuId, title: "方形背景扩图", toolKey: "outpaint", status: "awaiting_review",
          parameterSnapshot: { aspectRatio: "1:1", direction: "all", outputFormat: "png", markGeneratedAreas: true },
          inputAssets: [{ assetId, ordinal: 0, version: 1, checksumSha256: "c".repeat(64), domain: "authorized", rightsStatus: "approved" }],
          qualityCheckSnapshot: {
            passed: true, toolKey: "outpaint", inputCoverageComplete: true, blankOutputsDetected: false,
            artifactDetected: false, generatedAreasMarked: true,
            outputChecks: [{
              fileName: "square.png", inputOrdinal: 0, operation: "outpaint", format: "png",
              width: 2400, height: 2400, dpi: 300, colorMode: "rgb", transparent: false,
              generatedRegions: [{ x: 0, y: 0, width: 2400, height: 320, reason: "crop_loss", confidence: 0.9, marked: true }],
              edgeQualityPassed: true, dimensionsMatched: true, formatMatched: true,
            }],
          },
          progressPercent: 100, attemptCount: 1, maxAttempts: 3,
          resultVersionId: "019f0000-0000-7000-8000-000000000065",
          createdAt: "2026-08-04T08:00:00.000Z", updatedAt: "2026-08-04T08:01:00.000Z",
        }]}
      />,
    );
    expect(html).toContain("新建扩图任务");
    expect(html).toContain('name="markGeneratedAreas"');
    expect(html).toContain("AI 延展区域会固定写入结果证据");
    expect(html).toContain("图案处理已校验");
    expect(html).toContain("扩图 · 1 张结果 · 1 个 AI 区域均已标记");
    expect(html).toContain("PNG · 2400×2400 · 300 DPI");
  });

  it("offers a completed immutable export only from an approved task", () => {
    const taskId = "019f0000-0000-7000-8000-000000000011";
    const versionId = "019f0000-0000-7000-8000-000000000012";
    const exportId = "019f0000-0000-7000-8000-000000000013";
    const html = renderToStaticMarkup(
      <PodWorkbench
        catalog={catalog}
        exportsByTask={{
          [taskId]: [{
            id: exportId,
            taskId,
            designVersionId: versionId,
            status: "completed",
            checksumSha256: "b".repeat(64),
            byteSize: 1024,
            createdAt: "2026-08-03T08:00:00.000Z",
            completedAt: "2026-08-03T08:01:00.000Z",
          }],
        }}
        tasks={[{
          id: taskId,
          designTaskId: "019f0000-0000-7000-8000-000000000014",
          skuId: "019f0000-0000-7000-8000-000000000015",
          title: "已审核图案裁剪",
          toolKey: "pattern_crop",
          status: "approved",
          parameterSnapshot: patternCropParameters(),
          inputAssets: [],
          progressPercent: 100,
          attemptCount: 1,
          maxAttempts: 3,
          resultVersionId: versionId,
          createdAt: "2026-08-03T07:00:00.000Z",
          updatedAt: "2026-08-03T08:01:00.000Z",
        }]}
      />,
    );
    expect(html).toContain("已锁定");
    expect(html).toContain("下载 ZIP");
    expect(html).toContain(`value="${exportId}"`);
  });

  it("renders template reuse, SKU binding, and production manifest review consoles", () => {
    const templateVersionId = "019f0000-0000-7000-8000-000000000021";
    const templateId = "019f0000-0000-7000-8000-000000000022";
    const skuId = "019f0000-0000-7000-8000-000000000023";
    const sourceAssetId = "019f0000-0000-7000-8000-000000000030";
    const inspectionId = "019f0000-0000-7000-8000-000000000031";
    const personalizationHtml = renderToStaticMarkup(
      <PodWorkbench
        catalog={catalog}
        personalizationOptions={{
          skus: [{ id: skuId, code: "PET-TAG-M", spuCode: "PET-TAG", productName: "宠物挂牌" }],
          sourceAssets: [{ id: sourceAssetId, version: 2, fileName: "pet-template.psd", mediaType: "image/vnd.adobe.photoshop" }],
        }}
        personalizationInspections={[{
          id: inspectionId,
          sourceAssetId,
          sourceAssetVersion: 2,
          checksumSha256: "c".repeat(64),
          source: "psd",
          status: "completed",
          parserKey: "yummyai-template-source",
          parserVersion: "1.0.0",
          canvas: { width: 3000, height: 3000, dpi: 300, colorMode: "rgb" },
          slots: [{
            stableKey: "image.customer",
            name: "顾客照片",
            kind: "image",
            psdGroup: "image",
            geometry: { x: 100, y: 100, width: 2800, height: 2500, rotationDegrees: 0 },
            fillMode: "cover",
            validationSnapshot: { sourceLayerIndex: 1 },
            replaceable: true,
            sourceLayerPath: ["image", "顾客照片"],
            confidencePermille: 950,
          }],
          warnings: [],
          createdAt: "2026-08-03T07:58:00.000Z",
          updatedAt: "2026-08-03T07:59:00.000Z",
          completedAt: "2026-08-03T07:59:00.000Z",
        }]}
        personalizationTemplates={[{
          id: templateVersionId,
          templateId,
          versionNumber: 1,
          name: "双面宠物模板",
          source: "blank",
          canvas: { width: 3000, height: 3000, dpi: 300, colorMode: "rgb" },
          status: "approved",
          slots: [
            templateSlot(templateVersionId, "front.photo", "019f0000-0000-7000-8000-000000000024"),
            templateSlot(templateVersionId, "back.photo", "019f0000-0000-7000-8000-000000000025"),
          ],
          createdAt: "2026-08-03T08:00:00.000Z",
        }]}
        requestedModule="personalization"
      />,
    );
    expect(personalizationHtml).toContain("来图定制模板控制台");
    expect(personalizationHtml).toContain("同名图片槽位自动复用顾客字段");
    expect(personalizationHtml.match(/customer_image_1/g)).toHaveLength(2);
    expect(personalizationHtml).toContain("创建显式绑定");
    expect(personalizationHtml).toContain("复制为组织草稿");
    expect(personalizationHtml).toContain("双面宠物模板 副本");
    expect(personalizationHtml).toContain("导入 PNG / PSD 模板");
    expect(personalizationHtml).toContain("确认四类槽位");
    expect(personalizationHtml).toContain("image / 顾客照片");

    const productionHtml = renderToStaticMarkup(
      <PodWorkbench
        catalog={catalog}
        productionManifests={[{
          id: "019f0000-0000-7000-8000-000000000026",
          designVersionId: "019f0000-0000-7000-8000-000000000027",
          inputSnapshot: [{ assetId: "019f0000-0000-7000-8000-000000000028", assetVersion: 1, checksumSha256: "a".repeat(64) }],
          files: [{
            assetId: "019f0000-0000-7000-8000-000000000029",
            assetVersion: 1,
            checksumSha256: "b".repeat(64),
            fileName: "front-piece.tiff",
            mediaType: "image/tiff",
            width: 300,
            height: 400,
            unit: "mm",
            dpi: 300,
            colorMode: "cmyk",
          }],
          qualityCheckSnapshot: { passed: true },
          status: "pending_review",
          createdAt: "2026-08-03T08:00:00.000Z",
        }]}
        orderPersonalizationRenderTasks={[{
          id: "019f0000-0000-7000-8000-000000000043",
          idempotencyKey: "019f0000-0000-7000-8000-000000000044",
          batchItemId: "019f0000-0000-7000-8000-000000000045",
          designTaskId: "019f0000-0000-7000-8000-000000000046",
          toolKey: "vector_fulfillment",
          status: "awaiting_review",
          parameterSnapshot: {
            outputFormat: "svg", fitMode: "template", autoComposition: "off", allowAiEnhancement: false,
            identityMode: "standard", customerAssetUsage: "mapped", referenceIdentityTransfer: "not_applicable",
            colorMode: "spot", transparent: true, vectorTemplateProfile: "laser-cut-v1",
            vectorWidth: 300, vectorHeight: 400, vectorUnit: "mm", vectorLayoutMode: "template",
            textToPath: true, hollowMode: true, bridgeWidthMm: 1.5, minimumLineWidthMm: 0.3, pathRepair: "safe",
          },
          progressPercent: 100,
          attemptCount: 1,
          maxAttempts: 3,
          resultVersionId: "019f0000-0000-7000-8000-000000000047",
          qualityCheckSnapshot: {
            passed: true, exportReady: true, templateProfileMatched: true, canvasMatched: true,
            textConvertedToPaths: true, authorizedFontsOnly: true, pathsClosed: true,
            selfIntersectionsDetected: false, duplicatePathsDetected: false, isolatedNodesDetected: false,
            holeDirectionsValid: true, minimumLineWidthPassed: true, minimumBridgeWidthPassed: true,
            outOfBoundsDetected: false, rasterImagesEmbedded: false, repairs: ["close_path"],
            outputChecks: [{ fileName: "production.svg", usedInputStableKeys: ["customer.name"], width: 300, height: 400, unit: "mm", viewBox: "0 0 300 400", pathCount: 24, minimumLineWidthMm: 0.3, minimumBridgeWidthMm: 1.5 }],
          },
          createdAt: "2026-08-03T08:02:00.000Z",
          completedAt: "2026-08-03T08:03:00.000Z",
          updatedAt: "2026-08-03T08:03:00.000Z",
        }]}
        requestedModule="production_artwork"
        tasks={[{
          id: "019f0000-0000-7000-8000-000000000032",
          designTaskId: "019f0000-0000-7000-8000-000000000033",
          skuId,
          title: "双面裁片自动排版",
          toolKey: "piece_compose",
          status: "awaiting_review",
          parameterSnapshot: {
            width: 600, height: 900, unit: "mm", dpi: 300, colorMode: "cmyk",
            positioningTemplate: "shirt-v3", fitMode: "contain", layoutMode: "automatic",
            pieceKeys: ["front", "back"], minimumDpi: 300, gapMm: 5, allowRotation: true, manualPlacements: [],
          },
          inputAssets: [
            { assetId: "019f0000-0000-7000-8000-000000000034", ordinal: 0, version: 1, checksumSha256: "c".repeat(64), domain: "authorized", rightsStatus: "approved" },
            { assetId: "019f0000-0000-7000-8000-000000000035", ordinal: 1, version: 1, checksumSha256: "d".repeat(64), domain: "authorized", rightsStatus: "approved" },
          ],
          qualityCheckSnapshot: {
            passed: true,
            layoutMode: "automatic",
            positioningTemplateMatched: true,
            dimensionsMatched: true,
            colorModeMatched: true,
            minimumDpiPassed: true,
            overlapDetected: false,
            outOfBoundsDetected: false,
            blankPieceKeys: [],
            placements: [
              { pieceKey: "front", inputOrdinal: 0, x: 10, y: 10, width: 280, height: 800, unit: "mm", rotationDegrees: 0, scaleX: 1, scaleY: 1, effectiveDpi: 300, insidePrintArea: true, seamLinePreserved: true },
              { pieceKey: "back", inputOrdinal: 1, x: 310, y: 10, width: 280, height: 800, unit: "mm", rotationDegrees: 0, scaleX: 1, scaleY: 1, effectiveDpi: 300, insidePrintArea: true, seamLinePreserved: true },
            ],
            outputChecks: [{ fileName: "layout.tiff", pieceKeys: ["front", "back"], dimensionsValid: true, colorModeValid: true }],
          },
          progressPercent: 100,
          attemptCount: 1,
          maxAttempts: 3,
          resultVersionId: "019f0000-0000-7000-8000-000000000036",
          createdAt: "2026-08-03T08:00:00.000Z",
          updatedAt: "2026-08-03T08:01:00.000Z",
        }, {
          id: "019f0000-0000-7000-8000-000000000037",
          designTaskId: "019f0000-0000-7000-8000-000000000038",
          skuId,
          title: "双面裁片分版提取",
          toolKey: "piece_extract",
          status: "awaiting_review",
          parameterSnapshot: {
            width: 600, height: 900, unit: "mm", dpi: 300, colorMode: "cmyk",
            extractionMode: "separate", boundarySource: "alpha",
            pieceDefinitions: ["front|前片|0|none", "back|后片|180|horizontal"],
            printArea: "裁片边界内缩缝份后为印刷区域", seamAllowanceMm: 10,
            outputFormat: "png", preserveTransparency: true, minimumConfidence: 0.9,
            templateDraftName: "双面上衣裁片草稿",
          },
          inputAssets: [{ assetId: "019f0000-0000-7000-8000-000000000034", ordinal: 0, version: 1, checksumSha256: "c".repeat(64), domain: "authorized", rightsStatus: "approved" }],
          qualityCheckSnapshot: {
            passed: true, extractionMode: "separate", canvasMatched: true, dpiMatched: true, colorModeMatched: true,
            blankPieceKeys: [], duplicatePieceKeys: [], unexpectedPieceKeys: [], lowConfidencePieceKeys: ["back"],
            regions: [
              { pieceKey: "front", displayName: "前片", inputOrdinal: 0, x: 0, y: 0, width: 280, height: 800, unit: "mm", rotationDegrees: 0, flipMode: "none", boundaryClosed: true, printAreaDetected: true, seamLineRecorded: true, confidence: 0.98, manualConfirmationRequired: false, outputFileName: "front.png" },
              { pieceKey: "back", displayName: "后片", inputOrdinal: 0, x: 310, y: 0, width: 280, height: 800, unit: "mm", rotationDegrees: 180, flipMode: "horizontal", boundaryClosed: true, printAreaDetected: true, seamLineRecorded: true, confidence: 0.84, manualConfirmationRequired: true, outputFileName: "back.png" },
            ],
            templateDraft: { name: "双面上衣裁片草稿", fileName: "template-draft.zip", status: "awaiting_confirmation", stableKeysComplete: true },
            outputChecks: [
              { fileName: "full-canvas.png", kind: "full_canvas", pieceKeys: ["front", "back"], dimensionsValid: true, colorModeValid: true, formatValid: true },
              { fileName: "front.png", kind: "piece", pieceKeys: ["front"], dimensionsValid: true, colorModeValid: true, formatValid: true },
              { fileName: "back.png", kind: "piece", pieceKeys: ["back"], dimensionsValid: true, colorModeValid: true, formatValid: true },
              { fileName: "template-draft.zip", kind: "template_package", pieceKeys: ["front", "back"], dimensionsValid: true, colorModeValid: true, formatValid: true },
            ],
          },
          progressPercent: 100,
          attemptCount: 1,
          maxAttempts: 3,
          resultVersionId: "019f0000-0000-7000-8000-000000000039",
          createdAt: "2026-08-03T07:00:00.000Z",
          updatedAt: "2026-08-03T07:01:00.000Z",
        }, {
          id: "019f0000-0000-7000-8000-000000000040",
          designTaskId: "019f0000-0000-7000-8000-000000000041",
          skuId,
          title: "UV 白墨与光油分层",
          toolKey: "uv_layers",
          status: "awaiting_review",
          parameterSnapshot: {
            width: 300, height: 400, unit: "mm", dpi: 300, colorMode: "cmyk",
            separationMode: "automatic", layerPrefix: "uv", supplierChannelProfile: "supplier-uv-v1",
            layerDefinitions: ["artwork|彩墨层|color|0|1", "white|白墨层|white_ink|1|1", "varnish|光油层|varnish|2|1"],
            outputFormat: "png", preserveTransparency: true, whiteInkLayer: true, varnishLayer: true,
            conflictPolicy: "manual_review", compositePreview: true,
          },
          inputAssets: [{ assetId: "019f0000-0000-7000-8000-000000000034", ordinal: 0, version: 1, checksumSha256: "c".repeat(64), domain: "authorized", rightsStatus: "approved" }],
          qualityCheckSnapshot: {
            passed: false, exportReady: false, manualReviewRequired: true,
            separationMode: "automatic", canvasMatched: true, dpiMatched: true, colorModeMatched: true, transparencyMatched: true,
            blankLayerKeys: [], unexpectedLayerKeys: [],
            layers: [
              { layerKey: "artwork", displayName: "彩墨层", channel: "color", order: 0, opacity: 1, sourceInputOrdinal: 0, sourcePixelCount: 1000, conflictPixelCount: 20, width: 300, height: 400, unit: "mm", transparent: true, outputFileName: "uv-artwork.png" },
              { layerKey: "white", displayName: "白墨层", channel: "white_ink", order: 1, opacity: 1, sourceInputOrdinal: 0, sourcePixelCount: 800, conflictPixelCount: 20, width: 300, height: 400, unit: "mm", transparent: true, outputFileName: "uv-white.png" },
              { layerKey: "varnish", displayName: "光油层", channel: "varnish", order: 2, opacity: 1, sourceInputOrdinal: 0, sourcePixelCount: 500, conflictPixelCount: 0, width: 300, height: 400, unit: "mm", transparent: true, outputFileName: "uv-varnish.png" },
            ],
            conflictRegions: [{ regionKey: "conflict-1", x: 10, y: 20, width: 5, height: 8, unit: "mm", reason: "ambiguous_overlap", candidateLayerKeys: ["artwork", "white"], confidence: 0.6 }],
            outputChecks: [
              { fileName: "uv-artwork.png", kind: "layer", layerKeys: ["artwork"], dimensionsValid: true, transparencyValid: true, channelProfileValid: true },
              { fileName: "uv-white.png", kind: "layer", layerKeys: ["white"], dimensionsValid: true, transparencyValid: true, channelProfileValid: true },
              { fileName: "uv-varnish.png", kind: "layer", layerKeys: ["varnish"], dimensionsValid: true, transparencyValid: true, channelProfileValid: true },
              { fileName: "uv-preview.png", kind: "composite_preview", layerKeys: ["artwork", "white", "varnish"], dimensionsValid: true, transparencyValid: true, channelProfileValid: true },
              { fileName: "uv-layers.zip", kind: "layer_package", layerKeys: ["artwork", "white", "varnish"], dimensionsValid: true, transparencyValid: true, channelProfileValid: true },
            ],
          },
          progressPercent: 100,
          attemptCount: 1,
          maxAttempts: 3,
          resultVersionId: "019f0000-0000-7000-8000-000000000042",
          createdAt: "2026-08-03T06:00:00.000Z",
          updatedAt: "2026-08-03T06:01:00.000Z",
        }]}
      />,
    );
    expect(productionHtml).toContain("不可变生产清单");
    expect(productionHtml).toContain("front-piece.tiff");
    expect(productionHtml).toContain("批准并锁定");
    expect(productionHtml).toContain("自动排版已校验");
    expect(productionHtml).toContain("front · 0° · 300 DPI");
    expect(productionHtml).toContain("分版裁片草稿待确认");
    expect(productionHtml).toContain("back · 84% · 需人工确认");
    expect(productionHtml).toContain("UV 冲突待人工处理");
    expect(productionHtml).toContain("3 个图层 · 1 个冲突区域 · 5 个文件 · 禁止导出");
    expect(productionHtml).toContain("01 · white · white_ink");
    expect(productionHtml).toContain("履约矢量合成");
    expect(productionHtml).toContain("SVG 已通过生产检查");
    expect(productionHtml).toContain("24 路径");
  });

  it("keeps visual similarity evidence separate from legal risk", () => {
    const html = renderToStaticMarkup(
      <PodWorkbench
        catalog={catalog}
        requestedModule="rights_risk"
        rightsOptions={{
          toolKey: "rights_risk_scan",
          enabled: true,
          requiresAssetInput: true,
          skus: [],
          assets: [{
            id: "019f0000-0000-7000-8000-000000000031",
            fileName: "competitor-reference.png",
            mediaType: "image/png",
            version: 1,
            checksumSha256: "c".repeat(64),
            domain: "research",
            rightsStatus: "unverified",
            rightsSourceKind: "competitor",
          }],
        }}
      />,
    );
    expect(html).toContain("视觉相似度检索");
    expect(html).toContain("法律风险");
    expect(html).toContain("不是侵权法律结论");
    expect(html).toContain("competitor-reference.png");
  });

  it("renders a scoped rights scan and blocks a high-risk report without calling similarity a legal conclusion", () => {
    const assetId = "019f0000-0000-7000-8000-000000000032";
    const skuId = "019f0000-0000-7000-8000-000000000033";
    const rightsCatalog: PodToolCatalogView = {
      ...catalog,
      tools: [{
        key: "rights_risk_scan", module: "rights_risk", label: "侵权风险检查",
        description: "分开输出法律风险和视觉相似度。", phase: "pod_1", availability: "enabled",
        assetPolicy: "risk_evidence_allowed", inputKinds: ["image", "text"], outputKinds: ["risk_report"],
        parameterSummary: ["基础/深度", "有效期", "非法律意见"],
      }],
    };
    const html = renderToStaticMarkup(
      <PodWorkbench
        catalog={rightsCatalog}
        inputOptions={{
          toolKey: "rights_risk_scan", enabled: true, requiresAssetInput: true,
          skus: [{ id: skuId, code: "PET-TAG-M", spuCode: "PET-TAG", productName: "宠物挂牌" }],
          assets: [{ id: assetId, fileName: "risk-reference.png", mediaType: "image/png", version: 1, checksumSha256: "d".repeat(64), domain: "research", rightsStatus: "unverified", rightsSourceKind: "competitor" }],
        }}
        requestedModule="rights_risk"
        requestedTool="rights_risk_scan"
        tasks={[{
          id: "019f0000-0000-7000-8000-000000000034",
          designTaskId: "019f0000-0000-7000-8000-000000000035",
          skuId, title: "热门角色风险检查", toolKey: "rights_risk_scan", status: "blocked",
          parameterSnapshot: { depth: "deep", visualSimilarity: true, marketplaces: ["amazon", "etsy"], searchTerms: ["character badge"], validityDays: 30 },
          inputAssets: [{ assetId, ordinal: 0, version: 1, checksumSha256: "d".repeat(64), domain: "research", rightsStatus: "unverified", rightsSourceKind: "competitor" }],
          modelKey: "rights-model", modelVersion: "2026-08-04", progressPercent: 100, attemptCount: 1, maxAttempts: 3,
          resultVersionId: "019f0000-0000-7000-8000-000000000036",
          qualityCheckSnapshot: {
            passed: true, depth: "deep", disclaimer: "auxiliary_non_legal_opinion",
            checkedAt: "2026-08-04T00:00:00.000Z", validUntil: "2026-09-03T00:00:00.000Z",
            ruleVersion: "rules-42", detectorModelKey: "rights-model", detectorModelVersion: "2026-08-04",
            sourceChecks: [{ sourceKey: "trademark_registry", sourceVersion: "2026-08-03", checkedAt: "2026-08-04T00:00:00.000Z", status: "complete" }],
            missingSourceKeys: [], inputCoverageComplete: true, highRiskDetected: true, unknownRiskDetected: false,
            outputChecks: [{
              fileName: "risk.json", inputOrdinal: 0, legalRisk: "high", confidence: 0.94,
              ruleHits: [{ ruleKey: "character-match", category: "hot_ip", label: "热门角色强匹配", severity: "high", evidenceIds: ["internal-hit"] }],
              evidence: [{ evidenceId: "internal-hit", kind: "internal", reference: "internal://risk/42", checkedAt: "2026-08-04T00:00:00.000Z", accessible: true }],
              visualSimilarityEvaluated: true, visualSimilarityPermille: 923, visualCandidateCount: 4,
              manualReviewRequired: true, downstreamBlocked: true,
            }],
          },
          createdAt: "2026-08-04T00:00:00.000Z", updatedAt: "2026-08-04T00:01:00.000Z",
        }]}
      />,
    );
    expect(html).toContain("新建侵权风险检查任务");
    expect(html).toContain('name="validityDays"');
    expect(html).toContain("报告只作辅助判断，不是法律意见");
    expect(html).toContain("侵权风险已阻断");
    expect(html).toContain("法律风险 高");
    expect(html).toContain("视觉相似 92.3%（非法律结论）");
    expect(html).toContain("规则 rules-42 · 模型 rights-model@2026-08-04");
  });

  it("renders only reviewed Listing candidate options and the immutable slot ledger", () => {
    const listingVersionId = "019f0000-0000-7000-8000-000000000041";
    const listingId = "019f0000-0000-7000-8000-000000000042";
    const assetId = "019f0000-0000-7000-8000-000000000043";
    const html = renderToStaticMarkup(
      <PodWorkbench
        catalog={catalog}
        listingOptions={{
          listingVersions: [{ id: listingVersionId, listingId, versionNumber: 2, platform: "amazon", locale: "en-US", status: "draft" }],
          assets: [{ id: assetId, version: 3, fileName: "approved-main.png", mediaType: "image/png" }],
          bindings: [{
            id: "019f0000-0000-7000-8000-000000000044",
            listingVersionId,
            assetId,
            assetVersion: 3,
            contentKind: "image",
            slotKey: "main",
            status: "candidate",
            createdAt: "2026-08-03T08:00:00.000Z",
          }],
        }}
        requestedModule="listing_assets"
      />,
    );
    expect(html).toContain("Listing 素材槽位");
    expect(html).toContain("双重准入");
    expect(html).toContain("approved-main.png");
    expect(html).toContain("图片 / main");
    expect(html).toContain("创建候选绑定");
  });

  it("operates order personalization from safe candidates through reviewable renders", () => {
    const orderId = "019f0000-0000-7000-8000-000000000051";
    const orderLineId = "019f0000-0000-7000-8000-000000000052";
    const customizationVersionId = "019f0000-0000-7000-8000-000000000053";
    const bindingId = "019f0000-0000-7000-8000-000000000054";
    const templateVersionId = "019f0000-0000-7000-8000-000000000055";
    const batchId = "019f0000-0000-7000-8000-000000000056";
    const batchItemId = "019f0000-0000-7000-8000-000000000057";
    const designTaskId = "019f0000-0000-7000-8000-000000000058";
    const resultVersionId = "019f0000-0000-7000-8000-000000000059";
    const personalizationCatalog: PodToolCatalogView = {
      ...catalog,
      tools: [{
        key: "image_composite",
        module: "personalization",
        label: "图片合成",
        description: "订单私有素材与模板合成。",
        phase: "pod_3",
        availability: "enabled",
        assetPolicy: "order_context_only",
        inputKinds: ["order_customization", "template"],
        outputKinds: ["image"],
        parameterSummary: ["格式", "适配", "DPI"],
      }, {
        key: "group_photo",
        module: "personalization",
        label: "合照",
        description: "订单私有多人合成。",
        phase: "pod_3",
        availability: "enabled",
        assetPolicy: "order_context_only",
        inputKinds: ["order_customization", "template"],
        outputKinds: ["image"],
        parameterSummary: ["身份保持", "全部输入"],
      }, {
        key: "pet_outfit",
        module: "personalization",
        label: "宠物换装",
        description: "订单私有宠物换装。",
        phase: "pod_3",
        availability: "enabled",
        assetPolicy: "order_context_only",
        inputKinds: ["order_customization", "template"],
        outputKinds: ["image"],
        parameterSummary: ["身份保持", "参考隔离"],
      }],
    };
    const html = renderToStaticMarkup(
      <PodWorkbench
        catalog={personalizationCatalog}
        orderPersonalizationBatches={[{
          id: batchId,
          idempotencyKey: "019f0000-0000-7000-8000-000000000060",
          status: "completed",
          itemCount: 1,
          preparedCount: 1,
          failedCount: 0,
          items: [{
            id: batchItemId,
            ordinal: 0,
            orderId,
            orderLineId,
            customizationVersionId,
            bindingId,
            templateVersionId,
            status: "prepared",
            resolvedSlotCount: 2,
            resolutionChecksum: "d".repeat(64),
            completedAt: "2026-08-04T00:02:00.000Z",
          }],
          createdAt: "2026-08-04T00:00:00.000Z",
          completedAt: "2026-08-04T00:02:00.000Z",
          updatedAt: "2026-08-04T00:02:00.000Z",
        }]}
        orderPersonalizationOptions={{ items: [{
          orderId,
          externalOrderId: "ETSY-1001",
          platform: "etsy",
          placedAt: "2026-08-04T00:00:00.000Z",
          orderLineId,
          externalLineId: "LINE-1",
          lineTitle: "Custom pet tag",
          quantity: 1,
          skuId: "019f0000-0000-7000-8000-000000000061",
          skuCode: "PET-TAG-M",
          customizationVersionId,
          customizationVersionNumber: 2,
          completeness: 100,
          requirementStatus: "ready",
          bindingId,
          templateVersionId,
          templateName: "Pet tag M",
          sizeLabel: "M",
          eligible: true,
          blockers: [],
        }] }}
        orderPersonalizationRenderTasks={[{
          id: "019f0000-0000-7000-8000-000000000062",
          idempotencyKey: "019f0000-0000-7000-8000-000000000063",
          batchItemId,
          designTaskId,
          toolKey: "group_photo",
          status: "awaiting_review",
          parameterSnapshot: { outputFormat: "png", fitMode: "template", autoComposition: "subject_focus", allowAiEnhancement: true, identityMode: "strict", customerAssetUsage: "all", referenceIdentityTransfer: "not_applicable" },
          progressPercent: 100,
          attemptCount: 1,
          maxAttempts: 3,
          resultVersionId,
          qualityCheckSnapshot: {
            passed: true,
            outputChecks: [{
              fileName: "creative.png",
              usedInputStableKeys: ["customer.person.1", "customer.person.2"],
              identityPreserved: true,
              subjectCountMatched: true,
              noAddedSubjects: true,
              duplicateSubjectsDetected: false,
            }],
          },
          createdAt: "2026-08-04T00:03:00.000Z",
          completedAt: "2026-08-04T00:04:00.000Z",
          updatedAt: "2026-08-04T00:04:00.000Z",
        }]}
        requestedModule="personalization"
      />,
    );
    expect(html).toContain("订单定制编排");
    expect(html).toContain("顾客数据留在订单私有域");
    expect(html).toContain("ETSY-1001");
    expect(html).toContain("Custom pet tag");
    expect(html).toContain("批量表格填充");
    expect(html).toContain("external_order_id");
    expect(html).toContain("下载模板");
    expect(html).toContain("创建预处理批次");
    expect(html).toContain("生成定制套图");
    expect(html).toContain("合照");
    expect(html).toContain("宠物换装");
    expect(html).toContain("已核对输入");
    expect(html).toContain("customer.person.1");
    expect(html).toContain("查看审核版本");
    expect(html).not.toMatch(/encryptedResolution|Private render value|provider-file/);
  });
});

function patternCropParameters() {
  return {
    mode: "general", multiCrop: false, maximumCropsPerInput: 1, outputFormat: "png",
    background: "preserved", perspectiveCorrection: true, cropPaddingPercent: 2,
  };
}

function templateSlot(templateVersionId: string, stableKey: string, id: string) {
  return {
    id,
    templateVersionId,
    stableKey,
    name: "顾客图片",
    kind: "image" as const,
    geometry: { x: 0, y: 0, width: 1400, height: 2200, rotationDegrees: 0 },
    fillMode: "cover" as const,
    validationSnapshot: { required: true },
    replaceable: true,
    reuseLabel: "same-name:顾客图片",
  };
}
