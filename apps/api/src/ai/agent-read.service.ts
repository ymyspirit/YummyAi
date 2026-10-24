import { Inject, Injectable } from "@nestjs/common";
import type { TenantContext } from "@yummyai/contracts";
import type { SecretVault } from "@yummyai/ai-core";
import type { DatabaseConnection } from "@yummyai/database";
import { SharedAgentReadGateway } from "@yummyai/workflow-core";
import { rethrowAgentReadError } from "./agent-read-errors.js";
import { OrderService } from "../orders/order.service.js";
import { InventoryService } from "../inventory/inventory.service.js";
import { DATABASE_CONNECTION, INTEGRATION_SECRET_VAULT } from "../platform.tokens.js";
export { agentReadHarness } from "@yummyai/workflow-core";
/** Preserve the API owner's constructor and response ABI; Worker uses the same projections. */
@Injectable()
export class AgentReadService {
 private readonly shared:SharedAgentReadGateway;
 constructor(@Inject(DATABASE_CONNECTION) database:DatabaseConnection,@Inject(OrderService) orders:OrderService,
  @Inject(InventoryService) inventory:InventoryService,@Inject(INTEGRATION_SECRET_VAULT) vault:SecretVault){
  this.shared=new SharedAgentReadGateway(database,vault,{
   orderPage:(...args)=>orders.agentExceptionPage(...args),
   balancePage:(...args)=>inventory.agentBalancePage(...args),
  });
 }
 workspace(context:TenantContext){return this.adapt(()=>this.shared.workspace(context));}
 call(context:TenantContext,raw:unknown){return this.adapt(()=>this.shared.call(context,raw));}
 private async adapt<T>(action:()=>Promise<T>):Promise<T>{try{return await action();}catch(error){
  rethrowAgentReadError(error);
 }}
}
