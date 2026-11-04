import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { Permission } from "@yummyai/authz";
import { OrderProtectedDetailsSchema, type TenantContext } from "@yummyai/contracts";
import { OrderWorkDraftSchema } from "@yummyai/contracts/order/workspace";
import { OriginalOwnerError } from "@yummyai/contracts/common/original-owner-error";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import type { DocumentOrderSource } from "@yummyai/contracts/logistics/documents";
import { orderLines, orders, orderProtectedDetails, orderWorkItems, orderWorkRevisions,
  productSpecificationVersions, productionOrders, orderPrivateSourceAvailable, type TenantTransaction } from "@yummyai/database";
import { currentOrderAuthority } from "./order-authority.js";
import { openWork, type OrderReadVault } from "./order-private-payload.js";

export class OrderDocumentSourceReader {
  constructor(private readonly vault: OrderReadVault) {}
  async read(tx: TenantTransaction, context: TenantContext, orderId: string) {
    await currentOrderAuthority(tx, context, [Permission.OrderRead, Permission.OrderPiiRead]);
    const [order] = await tx.select().from(orders).where(eq(orders.id,orderId)).for("share");
    if (!order) throw new OriginalOwnerError(404,"订单不存在或无权访问");
    const [privacy] = await tx.select().from(orderProtectedDetails).where(eq(orderProtectedDetails.orderId,orderId)).for("share");
    const [available] = await tx.select({ id: orders.id }).from(orders)
      .where(and(eq(orders.id,orderId),orderPrivateSourceAvailable(sql`${orders.id}`)));
    if (!available || privacy?.status !== "protected" || !privacy.encryptedEnvelope || privacy.retentionExpiresAt <= new Date())
      throw new OriginalOwnerError(409,"订单地址或定制资料已过期、清理 请重新核对来源");
    const details = this.vault.withSecret(privacy.encryptedEnvelope, value => OrderProtectedDetailsSchema.parse(JSON.parse(value)));
    const address = details.shippingAddress;
    const source: DocumentOrderSource = { id:order.id, orderNumber:order.externalOrderId, lines:[], address:{
      recipient:address.recipient ?? "", countryCode:address.countryCode ?? "", address1:address.lines[0] ?? "",
      address2:address.lines.slice(1).join(" "), city:address.city ?? "", region:address.region ?? "",
      postalCode:address.postalCode ?? "", phone:details.buyer.phone ?? "", email:details.buyer.email ?? "",
    } };
    const rows = await tx.select().from(orderLines).where(eq(orderLines.orderId,orderId)).orderBy(asc(orderLines.id));
    if (!rows.length || rows.length > 100) throw new OriginalOwnerError(409,"单个订单支持 1 至 100 个商品 请先核对订单");
    const work = await tx.select().from(orderWorkItems).where(inArray(orderWorkItems.id,rows.map(row => row.id))).for("share");
    const blockers: string[] = [];
    if (order.sideState) blockers.push(order.sideState === "cancelled" ? "订单已取消" : "订单已暂停 请先处理订单异常");
    let expiresAt = privacy.retentionExpiresAt;
    for (const line of rows) {
      const item = work.find(row => row.id === line.id);
      if (!item || !item.encryptedDataKey || item.expiresAt <= new Date() || item.archivedAt)
        throw new OriginalOwnerError(409,"订单商品制作资料尚未承接、已归档或到期");
      if (item.held) blockers.push(`商品 ${line.externalLineId} 已暂停`);
      expiresAt = new Date(Math.min(expiresAt.getTime(),item.expiresAt.getTime()));
      const [revision] = await tx.select().from(orderWorkRevisions)
        .where(and(eq(orderWorkRevisions.workItemId,line.id),eq(orderWorkRevisions.revision,item.revision)));
      let specificationVersionId: string | null = null;
      if (revision) {
        if (revision.sourceVersionId !== item.sourceVersionId) throw new OriginalOwnerError(409,"定制资料版本变化 请刷新审单");
        const key = this.vault.withSecret(item.encryptedDataKey, secret => Buffer.from(secret,"base64"));
        try { specificationVersionId = OrderWorkDraftSchema.parse(openWork(key,revision.encryptedDraft)).specificationVersionId ?? null; }
        finally { key.fill(0); }
      }
      if (!specificationVersionId) blockers.push(`商品 ${line.externalLineId} 请先在订单要求中确认并保存规格`);
      const [spec] = specificationVersionId ? await tx.select({ name:productSpecificationVersions.name })
        .from(productSpecificationVersions).where(eq(productSpecificationVersions.id,specificationVersionId)) : [];
      if (specificationVersionId && !spec) throw new OriginalOwnerError(409,"订单固定的规格版本不可用");
      source.lines.push({ id:line.id, externalLineId:line.externalLineId, skuCode:line.skuCode, quantity:line.quantity,
        specificationVersionId, specificationName:spec?.name ?? "待确认规格" });
    }
    const production = await tx.select({ id:productionOrders.id, lineId:productionOrders.orderLineId,
      factoryId:productionOrders.factoryId, version:productionOrders.currentVersionNumber, status:productionOrders.status })
      .from(productionOrders).where(eq(productionOrders.orderId,orderId)).orderBy(asc(productionOrders.id));
    // Re-importing unchanged order data must not invalidate a file merely because its event sequence advanced.
    // Production scheduling may follow label preparation. Only parcel/address content
    // changes invalidate a shipping file; factory and artwork gates are checked live.
    const fingerprint = createHash("sha256").update(canonicalJson({ source, sideState:order.sideState })).digest("hex");
    return { source, fingerprint, expiresAt, blockers, production, orderSequence:order.latestEventSequence };
  }
}
