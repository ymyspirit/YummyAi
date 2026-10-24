import { Inject, Injectable, Optional } from "@nestjs/common";
import type { SecretVault } from "@yummyai/ai-core";
import type { TenantContext } from "@yummyai/contracts";
import type { DatabaseConnection } from "@yummyai/database";
import { LogisticsReadOwner } from "@yummyai/logistics";
import { SharedAgentFulfillmentGateway } from "@yummyai/workflow-core";
import { FactoryErpSourceReadOwner } from "@yummyai/order-core";
import { DATABASE_CONNECTION, ORDER_PII_VAULT } from "../platform.tokens.js";
import { OrderService } from "../orders/order.service.js";
import { OrderProductionService } from "../orders/order-production.service.js";
import { ProductionQuantityService } from "../orders/production-quantity.service.js";
import { OrderProductionDeliveryService } from "../orders/order-production-delivery.service.js";
import { OrderShipmentService } from "../orders/order-shipment.service.js";
import { originalOwnerOperation } from "../shared/original-owner-error.js";
export { agentFulfillmentHarness, agentFulfillmentSkill } from "@yummyai/workflow-core";
@Injectable()
export class AgentFulfillmentService extends SharedAgentFulfillmentGateway {
  constructor(@Inject(DATABASE_CONNECTION) database: DatabaseConnection,
    @Inject(OrderService) orders: OrderService, @Inject(OrderProductionService) production: OrderProductionService,
    @Inject(ProductionQuantityService) quantity: ProductionQuantityService, @Inject(OrderProductionDeliveryService) delivery: OrderProductionDeliveryService,
    @Inject(OrderShipmentService) shipments: OrderShipmentService, @Inject(LogisticsReadOwner) logistics: LogisticsReadOwner,
    @Optional() @Inject(ORDER_PII_VAULT) piiVault?: SecretVault) {
    super(database, orders, production, quantity, delivery, shipments, logistics, piiVault ? new FactoryErpSourceReadOwner(database, piiVault) : undefined);
  }
  override workspace(context: TenantContext) { return originalOwnerOperation(() => super.workspace(context)); }
  override definition(context: TenantContext, raw: unknown) { return originalOwnerOperation(() => super.definition(context, raw)); }
  override candidates(context: TenantContext, raw: unknown) { return originalOwnerOperation(() => super.candidates(context, raw)); }
  override call(context: TenantContext, raw: unknown) { return originalOwnerOperation(() => super.call(context, raw)); }
  override assertResultAccess(context: TenantContext, value: Parameters<SharedAgentFulfillmentGateway["assertResultAccess"]>[1]) {
    return originalOwnerOperation(() => super.assertResultAccess(context, value));
  }
  override assertBindingAccess(context: TenantContext, scope: Parameters<SharedAgentFulfillmentGateway["assertBindingAccess"]>[1], requireFactoryPrivate = false) {
    return originalOwnerOperation(() => super.assertBindingAccess(context, scope, requireFactoryPrivate));
  }
}
