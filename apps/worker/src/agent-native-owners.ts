import { authorize, Permission } from "@yummyai/authz";
import type { SecretVault } from "@yummyai/ai-core";
import type { TenantContext } from "@yummyai/contracts";
import { recordAuditInTransaction, type DatabaseConnection } from "@yummyai/database";
import { KnowledgeSearchOwner } from "@yummyai/knowledge-core";
import { CreativeExecutionOperatorOwner } from "@yummyai/pod-core";
import { FactoryCapacityOwner } from "@yummyai/order-core";
import { SharedAgentReadGateway, SharedAgentToolsGateway, agentCommandCapabilities, type AgentToolOwnerPort } from "@yummyai/workflow-core";

/** Plain original domain owners. No API/Nest import or privileged HTTP bridge. */
export function createWorkerAgentTools(database:DatabaseConnection,integrationVault:SecretVault){
 const reads=new SharedAgentReadGateway(database,integrationVault),knowledge=new KnowledgeSearchOwner(database),
  creative=new CreativeExecutionOperatorOwner(database),factory=new FactoryCapacityOwner(database,{recordInTransaction:recordAuditInTransaction});
 const owners:AgentToolOwnerPort={legacyRead:(context,input)=>reads.call(context,input),knowledgeSearch:(context,input)=>knowledge.search(context,input),
  creativeHistory:(context,input)=>creative.history(context,input.scope,input.ownerId,input.after?{after:input.after}:{}),
  factoryCapacity:(context,input)=>factory.workspace(context,input.factoryId,input.query)};
 return new SharedAgentToolsGateway(database,integrationVault,owners,(context:TenantContext)=>{
  let allowed=true;try{authorize(context,Permission.WorkflowRead,{ownerId:context.userId});authorize(context,Permission.WorkflowRun,{ownerId:context.userId});}catch{allowed=false;}
  return agentCommandCapabilities(context).map(item=>({...item,available:allowed&&item.available,blockReason:allowed?item.blockReason:"workflow_run_required"}));
 });
}
