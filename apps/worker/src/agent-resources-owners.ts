import { AdvertisingReadOwner } from "@yummyai/advertising-core";
import { DevelopmentReadOwner, DrizzleListingReadRepository, ListingReadOwner } from "@yummyai/catalog-core";
import type { DatabaseConnection } from "@yummyai/database";
import { FinanceProfitReadOwner } from "@yummyai/finance-core";
import { ResearchReadOwner } from "@yummyai/knowledge-core";
import { OrderReadOwner } from "@yummyai/order-core";
import { AgentResourceOwners, SharedAgentResourcesGateway } from "@yummyai/workflow-core";

/** Same domain queries and DTOs as API, using the caller's forced RLS. */
export function createWorkerAgentResources(database: DatabaseConnection) {
  const research = new ResearchReadOwner(database);
  const owners = new AgentResourceOwners(research, research, new DevelopmentReadOwner(database),
    new ListingReadOwner(new DrizzleListingReadRepository(database)), new OrderReadOwner(database),
    new FinanceProfitReadOwner(database), new AdvertisingReadOwner(database));
  return new SharedAgentResourcesGateway(database, owners);
}
