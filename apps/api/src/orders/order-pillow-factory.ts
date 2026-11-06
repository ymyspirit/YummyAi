import { ConflictException } from "@nestjs/common";
import type { SecretVault } from "@yummyai/ai-core";
import type { TenantContext } from "@yummyai/contracts";
import type { ProductionEditorDocument } from "@yummyai/contracts/pod/production-editor";
import { fulfillmentRoutes, logisticsDocumentProfiles, orderFulfillmentFlows, type TenantTransaction } from "@yummyai/database";
import { OrderDocumentSourceReader } from "@yummyai/order-core";
import { pinPillowProductionFactory } from "@yummyai/production-editor/products";
import { eq, sql } from "drizzle-orm";
import { documentProfileCoversOrder } from "./fulfillment-flow-planning.js";

/** Resolve the production adapter from the order's actual rule, including a manual design start before the coordinator. */
export async function orderPillowFactoryDocument(tx: TenantTransaction, context: TenantContext, vault: SecretVault,
  orderId: string, specificationVersionId: string | null | undefined, document: ProductionEditorDocument): Promise<ProductionEditorDocument> {
  if (document.productType !== "shaped_pillow" || !specificationVersionId) return document;
  const [flow] = await tx.select({ route: orderFulfillmentFlows.routeSnapshot }).from(orderFulfillmentFlows)
    .where(eq(orderFulfillmentFlows.orderId, orderId));
  let profile;
  if (flow?.route) {
    [profile] = await tx.select().from(logisticsDocumentProfiles)
      .where(eq(logisticsDocumentProfiles.id, flow.route.documentProfileVersionId));
    if (!profile) throw new ConflictException("订单固定的工厂规则版本不可用");
  } else {
    const routes = await tx.select({ profile: logisticsDocumentProfiles }).from(fulfillmentRoutes)
      .innerJoin(logisticsDocumentProfiles, sql`${logisticsDocumentProfiles.id} = (${fulfillmentRoutes.profile}->>'documentProfileVersionId')::uuid`)
      .where(sql`${fulfillmentRoutes.profile}->>'mode' <> 'disabled'
        and ${logisticsDocumentProfiles.profile}->'specifications' @> ${JSON.stringify([{ specificationVersionId }])}::jsonb
        and not exists (select 1 from logistics_document_profiles newer where newer.factory_id=${logisticsDocumentProfiles.factoryId}
          and newer.version_number>${logisticsDocumentProfiles.versionNumber})`);
    if (!routes.length) return document;
    const { source } = await new OrderDocumentSourceReader(vault).read(tx, context, orderId);
    if (!routes.some(({profile}) => profile.profile.destinationCountries.includes(source.address.countryCode))) return document;
    const matches = routes.filter(({ profile }) => documentProfileCoversOrder(source, profile.profile));
    if (matches.length !== 1) throw new ConflictException("整单规格和收货国家无法确定唯一的制作工厂，请核对发货规则");
    profile = matches[0]!.profile;
  }
  const spec = profile.profile.specifications.find(item => item.specificationVersionId === specificationVersionId);
  if (!spec) throw new ConflictException("本件规格与订单固定的工厂规则不一致");
  const adapter = profile.profile.productionAdapter;
  if (adapter === "none" || spec.productKind !== "shaped_pillow") return document;
  if (!spec.sizeIn) throw new ConflictException("工厂规则尚未确认本件抱枕规格的英寸数");
  try {
    return pinPillowProductionFactory(document, { factoryId: profile.factoryId, documentProfileVersionId: profile.id, adapter, sizeIn: spec.sizeIn });
  } catch (error) {
    throw new ConflictException(error instanceof Error ? error.message : "订单工厂与制作底稿不匹配");
  }
}
