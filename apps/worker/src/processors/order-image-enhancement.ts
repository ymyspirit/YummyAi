import { createHash } from "node:crypto";
import { createEntityId, ProductionEditorDocumentSchema, type ProductionEditorDocument, type ProductionEditorPreflight, type RecordCustomizationFileScanInput, type TenantContext } from "@yummyai/contracts";
import { ORDER_IMAGE_ENHANCEMENT_INSTRUCTION } from "@yummyai/contracts/order/workspace";
import type { OrderImageEnhancementOptions, ProductionImageEditOptions } from "@yummyai/contracts/pod/production-editor-api";
import { productionEditorProjects as projects, productionEditorImages as images, productionEditorRenders as renders, productionEditorVersions as versions, orderWorkItems, withTenant, type DatabaseConnection } from "@yummyai/database";
import { encryptProductionBytes, decryptProductionBytes } from "@yummyai/production-editor";
import { and, eq, sql } from "drizzle-orm";
import type { Storage } from "@yummyai/storage";
import sharp from "sharp";

type Project = typeof projects.$inferSelect;
const checksum = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const seal = (key: Uint8Array, value: unknown) => encryptProductionBytes(key, Buffer.from(JSON.stringify(value))).toString("base64");

/** Enhances every selected original, then publishes all assets and one new draft atomically. */
export async function enhanceOrderImages(input: {
  database: DatabaseConnection; storage: Storage; context: TenantContext; project: Project;
  versionId: string; renderId: string; token: string; key: Buffer;
  options: OrderImageEnhancementOptions; document: ProductionEditorDocument; signal: AbortSignal;
  validate: () => Promise<void>;
  generate: (options: ProductionImageEditOptions, source: Buffer, requestId: string) => Promise<{ bytes: Buffer; preflight: ProductionEditorPreflight }>;
  scan: (bytes: Uint8Array, name: string) => Promise<RecordCustomizationFileScanInput>;
}) {
  const { database, storage, context, project, key, options } = input;
  if (!project.sourceWorkItemId) throw new Error("production_enhancement_requires_order");
  const sourceRows = await withTenant(database.db, context, tx => tx.select().from(images).where(eq(images.projectId, project.id)));
  const metadata = new Map(sourceRows.map(row => [row.id, JSON.parse(decryptProductionBytes(key, Buffer.from(row.encryptedMetadata, "base64")).toString("utf8")) as { name: string; kind: string; buyerOriginal?: boolean; modelEdit?: { sourceImageId: string; operation?: string; enhancementPolicy?: string }; cutout?: { sourceAssetId: string } }]));
  const prepared: Array<typeof images.$inferInsert & { width: number; height: number; sourceImageId: string }> = [];
  const files: Array<{ key: string; name: string; mediaType: string; byteSize: number; objectKey: string }> = [];
  const issues: ProductionEditorPreflight["issues"] = [{ code: "order_image_enhancement_review", severity: "manual", message: "所有选定顾客图片已完成保真美化。请对照原图核对外貌、特征和清晰度；图稿仍需运营审核。" }];
  for (const sourceImageId of options.sourceImageIds) {
    if (input.signal.aborted) throw new Error("production_render_aborted");
    await input.validate();
    const source = sourceRows.find(row => row.id === sourceImageId), info = metadata.get(sourceImageId);
    if (!source || info?.kind !== "image" || !info.buyerOriginal) throw new Error("production_enhancement_source_invalid");
    const bytes = decryptProductionBytes(key, await storage.readPrivate(context, { id: source.id, tenantId: context.tenantId, assetDomain: "order", objectKey: source.originalObjectKey }, { requiredDomain: "order" }));
    if (checksum(bytes) !== source.checksum) throw new Error("production_asset_checksum_mismatch");
    const sourceInfo = await sharp(bytes).rotate().toBuffer({ resolveWithObject: true });
    const ratio = sourceInfo.info.width / sourceInfo.info.height;
    const result = await input.generate({ purpose: "image_edit", modelId: options.modelId, providerConfigId: options.providerConfigId, model: options.model, sourceImageId,
      prompt: `${ORDER_IMAGE_ENHANCEMENT_INSTRUCTION}本步骤只做照片保真美化，保留整张画面的主体、背景和边缘；若输入含透明区域，必须保留真实 alpha 透明，不能填成白底。不抠图，不加描边、裁剪线、条码或装饰。`,
      size: ratio > 1.25 ? "1536x1024" : ratio < 0.8 ? "1024x1536" : "2048x2048",
    }, bytes, `${input.renderId}-${sourceImageId}`);
    if (input.signal.aborted) throw new Error("production_render_aborted");
    await input.validate();
    const scan = await input.scan(result.bytes, "enhanced.png");
    if (scan.result !== "clean" || scan.signatureVersion === "unavailable") throw new Error("production_enhancement_scan_failed");
    const output = await sharp(result.bytes).metadata();
    const stats = await sharp(result.bytes).ensureAlpha().stats();
    if (!output.width || !output.height) throw new Error("production_image_invalid_result");
    const imageId = createEntityId();
    const name = `保真美化 · ${info.name}`.slice(0, 200);
    const original = await storage.putPrivate(context, { body: encryptProductionBytes(key, result.bytes), domain: "order", fileName: `${imageId}-source.pe`, mediaType: "application/octet-stream" });
    const preview = await sharp(result.bytes).resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true }).png().toBuffer();
    const thumbnail = await storage.putPrivate(context, { body: encryptProductionBytes(key, preview), domain: "order", fileName: `${imageId}-preview.pe`, mediaType: "application/octet-stream" });
    prepared.push({ id: imageId, tenantId: context.tenantId, projectId: project.id,
      encryptedMetadata: seal(key, { kind: "image", name, mediaType: "image/png", width: output.width, height: output.height, hasAlpha: !!output.hasAlpha, actualAlpha: !!output.hasAlpha && (stats.channels[3]?.min ?? 255) < 255, scan,
        modelEdit: { renderId: input.renderId, sourceImageId, model: options.model, operation: "enhance", enhancementPolicy: options.policy } }),
      originalObjectKey: original.objectKey, previewObjectKey: thumbnail.objectKey, checksum: checksum(result.bytes), byteSize: result.bytes.byteLength,
      width: output.width, height: output.height, sourceImageId,
    });
    files.push({ key: sourceImageId, name: `enhanced-${imageId}.png`, mediaType: "image/png", byteSize: result.bytes.byteLength, objectKey: original.objectKey });
    issues.push(...result.preflight.issues.filter(issue => issue.code === "model_image_size_mismatch"));
  }
  // Replace only direct originals or previous enhancement results. Never silently undo a cutout.
  const document = ProductionEditorDocumentSchema.parse(structuredClone(input.document));
  document.layers = document.layers.map(layer => {
    if (layer.kind !== "image") return layer;
    const source = metadata.get(layer.assetId);
    const originalId = source?.buyerOriginal ? layer.assetId : source?.modelEdit?.sourceImageId;
    const replacement = prepared.find(asset => asset.sourceImageId === originalId);
    if (!replacement || source?.cutout || !source?.buyerOriginal && source?.modelEdit?.operation !== "enhance") return layer;
    const scale = Math.min(layer.widthMm / replacement.width, layer.heightMm / replacement.height);
    const widthMm = replacement.width * scale, heightMm = replacement.height * scale;
    return { ...layer, assetId: replacement.id!, assetVersion: 1, widthMm, heightMm, xMm: layer.xMm + (layer.widthMm - widthMm) / 2, yMm: layer.yMm + (layer.heightMm - heightMm) / 2 };
  });
  document.confirmations.visualReview = false;
  await input.validate();
  await withTenant(database.db, context, async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`order-work:${project.sourceWorkItemId}`}, 0))`);
    const [work] = await tx.select().from(orderWorkItems).where(eq(orderWorkItems.id, project.sourceWorkItemId!));
    if (!work?.encryptedDataKey || work.held || work.expiresAt <= new Date() || work.pushedRevisionId !== project.sourceWorkRevisionId || !["starting", "in_progress", "changes_requested"].includes(work.artwork)) throw new Error("production_work_changed");
    const [locked] = await tx.select().from(projects).where(eq(projects.id, project.id)).for("update");
    if (!locked?.encryptedDataKey || locked.status !== "active" || locked.expiresAt && locked.expiresAt <= new Date()) throw new Error("production_project_expired");
    if (locked.currentVersionId !== input.versionId) throw new Error("production_version_changed");
    const [claim] = await tx.select().from(renders).where(and(eq(renders.id, input.renderId), eq(renders.processingToken, input.token))).for("update");
    if (!claim) throw new Error("production_claim_lost");
    for (const { width, height, sourceImageId, ...asset } of prepared) {
      void width; void height; void sourceImageId;
      await tx.insert(images).values(asset);
    }
    const versionId = createEntityId(), versionNumber = locked.versionNumber + 1;
    await tx.insert(versions).values({ id: versionId, tenantId: context.tenantId, projectId: project.id, versionNumber, encryptedDocument: seal(key, document), checksum: checksum(JSON.stringify(document)), createdBy: context.userId });
    await tx.update(projects).set({ currentVersionId: versionId, versionNumber, reviewedVersionId: null, reviewedBy: null, reviewedAt: null, updatedAt: new Date() }).where(eq(projects.id, project.id));
    const preflight: ProductionEditorPreflight = { productionReady: false, widthPx: prepared[0]!.width, heightPx: prepared[0]!.height, issues };
    await tx.update(renders).set({ status: "completed", encryptedManifest: seal(key, { files, preflight, resultVersionId: versionId }), processingToken: null, leaseUntil: null, startedAt: null, errorCode: null, updatedAt: new Date() }).where(eq(renders.id, input.renderId));
  });
}
