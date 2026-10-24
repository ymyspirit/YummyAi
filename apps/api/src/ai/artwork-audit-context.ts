import { ConflictException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { ARTWORK_AUDIT_POLICY } from "@yummyai/contracts/ai/artwork-audit";
import type { CreateAssist } from "@yummyai/contracts/ai/assist";
import type { TenantContext } from "@yummyai/contracts";
import { orderProductionRequirements } from "@yummyai/contracts/order/production-requirements";
import type { AssistContext } from "@yummyai/ai-core";
import { auditPillowGeometry } from "@yummyai/production-editor";
import sharp from "sharp";
import type { OrderWorkspaceService } from "../orders/order-workspace.service.js";
import type { ProductionEditorService } from "../design/production-editor.service.js";

/** Pin buyer sources, the actual saved file, measured evidence and rule history
 * before queueing. Never use the newest report as the source of an older task. */
export async function prepareArtworkAudit(context: TenantContext, request: Extract<CreateAssist, {kind: "artwork_preflight"}>, orders: OrderWorkspaceService, editor: ProductionEditorService): Promise<AssistContext> {
  const detail = await orders.detail(context, request.orderLineId);
  if (detail.line.revision !== request.expectedRevision || detail.line.held || detail.line.archivedAt || detail.line.sourceChanged) throw new ConflictException("订单已暂停或资料发生变化，请先核对本次制作需求。");
  if (!detail.line.editorProjectId) throw new ConflictException("请先保存本单生产稿。");
  const file = await editor.get(context, detail.line.editorProjectId);
  const revision = detail.versions.find(v => v.revision === request.expectedRevision);
  if (file.version.id !== request.expectedEditorVersionId || file.project.workSource?.workItemId !== request.orderLineId || file.project.workSource.revisionId !== revision?.id) throw new ConflictException("稿件与制作需求版本不一致，请刷新后核对。");
  if (file.version.document.productType !== "shaped_pillow") throw new ConflictException("这组自动核对目前适用于异形抱枕。");
  const source = detail.sourceReport ?? null;
  const requirements = source ? orderProductionRequirements(source) : null;
  const input: AssistContext = { request, data: {}, sources: [{id: "order", label: `本次制作需求 V${request.expectedRevision}`, href: `/orders?line=${request.orderLineId}`}, {id: "document", label: `生产稿 V${file.version.versionNumber}`, href: null}], checks: [], diagnostics: [], images: [], allowedArtworkIds: [], allowedSpecificationIds: [], allowMatches: false, expiresAt: (await orders.analysisExpiresAt(context, request.orderLineId)).toISOString() };
  if (!source) input.diagnostics.push("本次制作没有可读取的固定顾客报告，不以最新导入资料替代。");
  async function image(sourceId: string, label: string, load: () => Promise<{body: Uint8Array}>) {
    try {
      const bytes = (await load()).body;
      const preview = await sharp(bytes, {limitInputPixels: 64_000_000}).rotate().resize(1600, 1600, {fit: "inside", withoutEnlargement: true}).flatten({background: "#ffffff"}).jpeg({quality: 90}).toBuffer();
      input.images.push({sourceId, dataUrl: `data:image/jpeg;base64,${preview.toString("base64")}`});
      input.sources.push({id: sourceId, label, href: null});
    } catch { input.diagnostics.push(`${label}读取失败，相关内容不能判定通过。`); }
  }
  for (const [i, selected] of detail.draft.images.slice(0, 6).entries()) {
    await image(`buyer-image:${i}`, `顾客原图 ${i + 1}`, () => selected.origin === "upload" ? orders.image(context, request.orderLineId, selected.key, true) : orders.sourceFile(context, request.orderLineId, selected.key, request.expectedRevision));
  }
  if (detail.draft.images.length > 6) input.diagnostics.push("原图超过 6 张，未发送的图片须补充核对。");
  const previews = source?.surfaces.filter(s => s.previewFileKey) ?? [];
  for (const [i, surface] of previews.slice(0, 2).entries()) {
    await image(`customer-preview:${i}`, `平台定制预览：${surface.label}`, () => orders.sourceFile(context, request.orderLineId, surface.previewFileKey!, request.expectedRevision));
  }
  if (previews.length > 2) input.diagnostics.push("平台定制预览超过 2 张，未发送的预览须补充核对。");
  const preview = await editor.analysisPreview(context, file.project.id, file.version.id, true);
  input.checks = preview.preflight.issues.map(i => ({...i, location: i.layerId ?? null}));
  if (preview.preview) await image("production-preview", `当前生产稿 V${file.version.versionNumber}`, async () => ({body: preview.preview!}));
  else input.diagnostics.push("当前生产稿无法渲染，视觉检查不能通过。");
  const visible = preview.document.layers.filter(l => l.visible && l.opacity > 0);
  let raster = null;
  if (visible.length === 1 && visible[0]?.kind === "image") {
    try {
      const bytes = await editor.image(context, file.project.id, visible[0].assetId, "original");
      const raw = await sharp(bytes.body, {limitInputPixels: 64_000_000}).rotate().toColourspace("srgb").ensureAlpha().raw().toBuffer({resolveWithObject: true});
      raster = {width: raw.info.width, height: raw.info.height, rgba: raw.data};
    } catch { input.diagnostics.push("完整透明素材读取失败，相关几何测量未完成。"); }
  }
  const rules = await editor.analysisRules(context, file.project.id);
  const basis = {policy: ARTWORK_AUDIT_POLICY, orderLineId: request.orderLineId, revision: request.expectedRevision, projectId: file.project.id, versionId: file.version.id, versionNumber: file.version.versionNumber,
    documentHash: createHash("sha256").update(JSON.stringify(preview.document)).digest("hex"), sourceVersionId: source?.versionId ?? null,
    factoryStandardId: file.version.document.spec.factoryStandardId ?? null, ruleBasis: rules ? "沿用本任务派发时固定的规则快照；本次新增裁线间距核对单独记录。" : "旧任务没有规则中心快照；本次按已确认工厂标准独立核对，不回写历史规则。",
    checks: auditPillowGeometry(file.version.document, requirements, raster)};
  input.artworkAudit = basis;
  input.data = {kind: request.kind, order: {sourceId: "order", fields: source?.surfaces.map(s => ({label: s.label, fields: s.fields})) ?? [], instructions: detail.draft.instructions, fieldsForProduction: detail.draft.fields}, document: preview.document, artworkAudit: basis, pinnedRuleSnapshot: rules,
    productionPreviewSha256: preview.preview ? createHash("sha256").update(preview.preview).digest("hex") : null};
  const after = await orders.detail(context, request.orderLineId);
  if (after.line.revision !== request.expectedRevision || after.line.held || after.line.sourceChanged || after.line.archivedAt || after.sourceReport?.versionId !== source?.versionId || (await editor.get(context, file.project.id)).version.id !== file.version.id) throw new ConflictException("读取过程中订单或稿件已变化，请重新核对。");
  return input;
}
