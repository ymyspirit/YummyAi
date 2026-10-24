import { Inject,Injectable } from "@nestjs/common";
import type { TenantContext } from "@yummyai/contracts";
import type { DatabaseConnection } from "@yummyai/database";
import { SharedAgentResourcesGateway } from "@yummyai/workflow-core";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { originalOwnerOperation } from "../shared/original-owner-error.js";
import { AgentResourceOwners } from "./agent-resource-owners.js";
export { agentResourcesHarness,agentResourcesSkill } from "@yummyai/workflow-core";
@Injectable()
export class AgentResourcesService {
private readonly gateway:SharedAgentResourcesGateway;
constructor(@Inject(DATABASE_CONNECTION) database:DatabaseConnection,@Inject(AgentResourceOwners) owners:AgentResourceOwners){this.gateway=new SharedAgentResourcesGateway(database,owners);}
workspace(context:TenantContext){return originalOwnerOperation(()=>this.gateway.workspace(context));}
definition(context:TenantContext,raw:unknown){return originalOwnerOperation(()=>this.gateway.definition(context,raw));}
candidates(context:TenantContext,raw:unknown){return originalOwnerOperation(()=>this.gateway.candidates(context,raw));}
call(context:TenantContext,raw:unknown){return originalOwnerOperation(()=>this.gateway.call(context,raw));}
assertBindingAccess(context:TenantContext,selection:Parameters<SharedAgentResourcesGateway['assertBindingAccess']>[1]){return originalOwnerOperation(()=>this.gateway.assertBindingAccess(context,selection));}
}
