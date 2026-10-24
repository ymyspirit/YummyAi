import type { SecretVault } from "@yummyai/ai-core";
import type { DatabaseConnection } from "@yummyai/database";
import { LogisticsReadOwner } from "@yummyai/logistics";
import { OrderReadOwner, FactoryDirectoryReadOwner, FactoryErpSourceReadOwner, ProductionReadOwner, ProductionQuantityReadOwner, ProductionDeliveryReadOwner, ShipmentReadOwner } from "@yummyai/order-core";
import { SharedAgentFulfillmentGateway } from "@yummyai/workflow-core";

/** API and Worker use the same original read owners, never HTTP or a synthetic projection. */
export function createWorkerAgentFulfillment(database: DatabaseConnection, piiVault: SecretVault) {
  const factories = new FactoryDirectoryReadOwner();
  return new SharedAgentFulfillmentGateway(database, new OrderReadOwner(database), new ProductionReadOwner(database, piiVault, factories),
    new ProductionQuantityReadOwner(database), new ProductionDeliveryReadOwner(database, piiVault, factories),
    new ShipmentReadOwner(database), new LogisticsReadOwner(database, piiVault), new FactoryErpSourceReadOwner(database, piiVault));
}
