import { readProductionManufacturingPins as sharedReadProductionManufacturingPins } from "@yummyai/order-core";
import { originalOwnerOperation } from "../shared/original-owner-error.js";
import { createHash } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import type { SecretVault } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { ProductionManufacturingSelectionSchema, ProductionProductConfirmationSchema, ProductionManufacturingFactoryBasisSchema, type ProductionManufacturingFactoryBasis, type ProductionManufacturingSelection, type ProductionProductConfirmation } from "@yummyai/contracts/order/production-manufacturing";
import { OrderWorkDraftSchema } from "@yummyai/contracts/order/workspace";
import type { ProductionEditorDocument } from "@yummyai/contracts/pod/production-editor";
import { orderLineCatalogLinks, orderWorkItems, orderWorkRevisions, productionManufacturingBindings as bindings, productionOrders, productionOrderVersions, productSpecificationVersions, orderLines, orders, orderProtectedDetails, type TenantTransaction } from "@yummyai/database";
import { decryptProductionBytes } from "@yummyai/production-editor";
import { currentOrderAuthority } from "@yummyai/order-core";
import { and, eq } from "drizzle-orm";
import { nativeProductionOrderSourceAvailable } from "./native-production-source.js";
import { approvedManufacturingForProduction, manufacturingSourceFromOrderDraft, manufacturingSku, productionFactorySource, productionManufacturingOptions, type ManufacturingProductionSource } from "../catalog/manufacturing-production.js";
import { approvedDesignProductionSource } from "../design/production-design-source.js";

type SourceChoice = { kind: "order_work_revision" } | { kind: "approved_product_confirmation"; confirmation: ProductionProductConfirmation }
  | { kind: "original_production_binding"; originalProductionVersionId: string };

/** Order owner: caller holds current order authority and the production/line locks in this transaction. */
export async function sealProductionManufacturing(tx: TenantTransaction, context: TenantContext, vault: SecretVault,
  productionVersionId: string, rawSelection: ProductionManufacturingSelection | undefined, choice: SourceChoice, document?: ProductionEditorDocument) {
  await currentOrderAuthority(tx, context, [Permission.OrderRead, Permission.OrderWrite,
    ...(choice.kind === "order_work_revision" ? [Permission.OrderPiiRead] : [])]);
  if (!rawSelection) throw new ConflictException("新生产须明确选择已批准制造版本并确认销售 SKU 数量单位");
  const selection = ProductionManufacturingSelectionSchema.parse(rawSelection);
  const [record] = await tx.select({ version: productionOrderVersions, order: productionOrders }).from(productionOrderVersions)
    .innerJoin(productionOrders, eq(productionOrders.id, productionOrderVersions.productionOrderId)).where(eq(productionOrderVersions.id, productionVersionId));
  if (!record || record.version.createdBy !== context.userId) throw new ConflictException("制造绑定须与本次生产版本一同创建");
  let source: ManufacturingProductionSource, originalBindingId: string | null = null, confirmationNote: string | null = null, skuId: string | null = null;
  let originalFactoryBasis: ProductionManufacturingFactoryBasis | null = null;
  if (choice.kind === "order_work_revision") {
    const pinned = await pinnedWorkManufacturingSource(tx, context, vault, record.order.orderLineId, record.version.sourceWorkRevisionId);
    source = pinned; skuId = pinned.skuId;
  } else if (choice.kind === "approved_product_confirmation") {
    const confirmation = ProductionProductConfirmationSchema.parse(choice.confirmation);
    const work = await tx.select({ id: orderWorkItems.id }).from(orderWorkItems).where(eq(orderWorkItems.id, record.order.orderLineId));
    if (record.version.sourceWorkRevisionId || record.order.sourceWorkItemId || work.length)
      throw new ConflictException("已有审单的商品须沿用原审核稿 不能用本次商品声明覆盖");
    source = { kind: choice.kind, specificationVersionId: confirmation.specificationVersionId };
    confirmationNote = confirmation.note;
  } else {
    const [original] = await tx.select({ binding: bindings, version: productSpecificationVersions }).from(bindings)
      .innerJoin(productSpecificationVersions, eq(productSpecificationVersions.id, bindings.specificationVersionId))
      .where(eq(bindings.productionVersionId, choice.originalProductionVersionId));
    if (!original?.version.processProfileVersionId || original.binding.productionOrderId !== record.order.parentProductionOrderId ||
        original.binding.orderLineId !== record.order.orderLineId || original.binding.sourceWorkRevisionId !== record.version.sourceWorkRevisionId)
      throw new ConflictException("原生产未固定可沿用的制造依据 请补齐并审核新的制作来源 不补写旧单");
    source = { kind: choice.kind, specificationVersionId: original.binding.specificationVersionId, processProfileVersionId: original.version.processProfileVersionId };
    originalBindingId = original.binding.id;
    skuId = original.binding.skuId;
    originalFactoryBasis = original.binding.factoryBasis;
  }
  const approved = await approvedManufacturingForProduction(tx, context, selection.versionId, source);
  if (record.version.sourceWorkRevisionId === null) {
    const [link] = choice.kind === "original_production_binding" ? [] : await tx.select({ skuId: orderLineCatalogLinks.skuId }).from(orderLineCatalogLinks).where(eq(orderLineCatalogLinks.orderLineId, record.order.orderLineId));
    skuId = skuId ?? link?.skuId ?? null;
    if (!skuId) throw new ConflictException("请先明确关联本单产品 SKU 再确认直接生产依据");
    await approvedDesignProductionSource(tx, context, { designVersionId: record.version.designVersionId, assetIds: record.version.productionAssetIds,
      skuId, spuId: approved.view.spuId, canvasPrintSpecVersionId: approved.canvasPrintSpecVersionId });
  }
  skuId = await manufacturingSku(tx, skuId, approved.view.spuId);
  const reviewedBasis = reviewedFactoryBasis(approved.factoryBasis, approved.dimensionBasis, skuId, document);
  const factoryBasis = ProductionManufacturingFactoryBasisSchema.parse(originalFactoryBasis ?? reviewedBasis);
  const contentCanonical = canonicalJson(approved.view.content);
  await tx.insert(bindings).values({ id: createEntityId(), tenantId: context.tenantId, productionOrderId: record.order.id,
    productionVersionId, orderLineId: record.order.orderLineId, recipeId: approved.view.recipeId, manufacturingVersionId: selection.versionId,
    reviewId: approved.reviewId, specificationVersionId: source.specificationVersionId, source: choice.kind,
    sourceWorkRevisionId: record.version.sourceWorkRevisionId, originalBindingId, skuId, factoryBasis, quantity: record.version.quantity,
    outputUnit: approved.view.content.outputUnit, orderUnitConfirmed: selection.orderUnitConfirmed, contentCanonical, contentChecksum: hash(contentCanonical),
    encryptedConfirmationNote: confirmationNote ? vault.encrypt(confirmationNote) : null,
    confirmationNoteChecksum: confirmationNote ? hash(confirmationNote) : null, createdBy: context.userId });
  return { processProfileVersionId: approved.processProfileVersionId, spuId: approved.view.spuId, ...factoryBasis };
}

export async function orderProductionFactorySource(tx: TenantTransaction, context: TenantContext, vault: SecretVault,
  lineId: string, revisionId: string | null, document: ProductionEditorDocument) {
  const pinned = await pinnedWorkManufacturingSource(tx, context, vault, lineId, revisionId);
  const source = await productionFactorySource(tx, context, pinned, pinned.skuId);
  return { processProfileVersionId: source.processProfileVersionId, spuId: source.spuId,
    ...reviewedFactoryBasis(source.factoryBasis, source.dimensionBasis, source.skuId, document) };
}

function reviewedFactoryBasis(basis: Omit<ProductionManufacturingFactoryBasis, "skuId" | "sideMode" | "factoryStandardId" | "longestMm"> & { longestMm: number | null },
  dimensionBasis: string | null, skuId: string | null, document?: ProductionEditorDocument) {
  if (document && document.productType !== basis.productType) throw new ConflictException("制造规格与实际审核稿的产品类型不一致");
  const actualLongest = document?.productType === "shaped_pillow" ? document.spec.declaredLongestMm : document?.productType === "tire_cover" ? document.spec.diameterMm : document ? Math.max(document.spec.widthMm, document.spec.heightMm) : null;
  const comparable = document?.productType === "shaped_pillow" && dimensionBasis === "artwork_longest" || document?.productType === "tire_cover" && dimensionBasis === "diameter" || document?.productType === "rectangular_print" && dimensionBasis === "finished_outer_2d";
  if (comparable && actualLongest !== null && basis.longestMm !== null && Math.abs(actualLongest - basis.longestMm) > 0.000001)
    throw new ConflictException("原规格的同口径尺寸与实际审核稿不一致 请先核对并审核新的制作依据");
  return ProductionManufacturingFactoryBasisSchema.parse({ ...basis, skuId,
    longestMm: actualLongest ?? basis.longestMm,
    sideMode: document?.productType === "shaped_pillow" ? document.spec.sideMode : null,
    factoryStandardId: document?.productType === "shaped_pillow" ? document.spec.factoryStandardId : null });
}

/** Minimal immutable task metadata. No BOM material costs, inventory quantities or private notes. */
export async function readProductionManufacturingPins(tx: TenantTransaction, productionVersionIds: string[]) { return originalOwnerOperation(() => sharedReadProductionManufacturingPins(tx, productionVersionIds)); }
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

async function pinnedWorkManufacturingSource(tx: TenantTransaction, context: TenantContext, vault: SecretVault, lineId: string, revisionId: string | null) {
  await currentOrderAuthority(tx, context, [Permission.OrderRead, Permission.OrderPiiRead]);
  const [work] = await tx.select().from(orderWorkItems).where(eq(orderWorkItems.id, lineId));
  const [revision] = revisionId ? await tx.select().from(orderWorkRevisions).where(and(eq(orderWorkRevisions.id, revisionId), eq(orderWorkRevisions.workItemId, lineId))) : [];
  if (!revision?.profileVersionId || !work?.encryptedDataKey || work.expiresAt <= new Date() || work.archivedAt || work.held)
    throw new ConflictException("原审单规格来源不可用 请先补齐、推送并审核生产稿");
  return manufacturingSourceFromOrderDraft(tx, originalWorkDraft(vault, work.encryptedDataKey, revision), revision.profileVersionId);
}

export async function orderProductionManufacturingOptions(tx: TenantTransaction, context: TenantContext, vault: SecretVault, lineId: string,
  query: { originalProductionOrderId?: string; nativeSpecificationVersionId?: string; after?: string }) {
  await currentOrderAuthority(tx, context, [Permission.OrderRead, Permission.OrderPiiRead]);
  let specificationVersionId: string | null = null;
  if (query.nativeSpecificationVersionId) {
    if (query.originalProductionOrderId) throw new ConflictException("直接生产规格不能覆盖原生产绑定");
    const [work] = await tx.select({ id: orderWorkItems.id }).from(orderWorkItems).where(eq(orderWorkItems.id, lineId));
    if (work) throw new ConflictException("已有审单的商品须沿用原审核稿 不能覆盖原制作来源");
    const [line] = await tx.select({ id: orderLines.id }).from(orderLines).innerJoin(orders, eq(orders.id, orderLines.orderId))
      .leftJoin(orderProtectedDetails, eq(orderProtectedDetails.orderId, orders.id)).where(and(eq(orderLines.id, lineId), nativeProductionOrderSourceAvailable));
    if (!line) throw new ConflictException("直接生产的原订单资料已不可用");
    const [link] = await tx.select({ skuId: orderLineCatalogLinks.skuId }).from(orderLineCatalogLinks).where(eq(orderLineCatalogLinks.orderLineId, lineId));
    if (!link?.skuId) throw new ConflictException("请先关联本商品实际产品 SKU");
    await productionFactorySource(tx, context, { kind: "approved_product_confirmation", specificationVersionId: query.nativeSpecificationVersionId }, link.skuId);
    specificationVersionId = query.nativeSpecificationVersionId;
  } else if (query.originalProductionOrderId) {
    const [parent] = await tx.select({ binding: bindings }).from(productionOrders)
      .innerJoin(productionOrderVersions, and(eq(productionOrderVersions.productionOrderId, productionOrders.id), eq(productionOrderVersions.versionNumber, productionOrders.currentVersionNumber)))
      .leftJoin(bindings, eq(bindings.productionVersionId, productionOrderVersions.id)).where(and(eq(productionOrders.id, query.originalProductionOrderId), eq(productionOrders.orderLineId, lineId)));
    if (!parent) throw new ConflictException("原生产来源不存在或不属于本单商品");
    specificationVersionId = parent.binding?.specificationVersionId ?? null;
  } else {
    const [work] = await tx.select().from(orderWorkItems).where(eq(orderWorkItems.id, lineId));
    if (work?.pushedRevisionId) specificationVersionId = (await pinnedWorkManufacturingSource(tx, context, vault, lineId, work.pushedRevisionId)).specificationVersionId;
  }
  return productionManufacturingOptions(tx, context, specificationVersionId, query.after);
}

function originalWorkDraft(vault: SecretVault, wrappedKey: string, revision: typeof orderWorkRevisions.$inferSelect) {
  try {
    return vault.withSecret(wrappedKey, secret => {
      const key = Buffer.from(secret, "base64");
      try {
        const plain = decryptProductionBytes(key, Buffer.from(revision.encryptedDraft, "base64"));
        try {
          const text = Buffer.from(plain).toString("utf8");
          if (hash(text) !== revision.checksum) throw new Error("Invalid original checksum");
          return OrderWorkDraftSchema.parse(JSON.parse(text));
        } finally { plain.fill(0); }
      } finally { key.fill(0); }
    });
  } catch { throw new ConflictException("原审单版本校验失败 请核对原制作来源"); }
}
