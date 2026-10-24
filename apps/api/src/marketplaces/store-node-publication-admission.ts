import {ConflictException} from "@nestjs/common";
import {createEntityId,type TenantContext} from "@yummyai/contracts";
import {PublicationPreviewNodeInputSchema,STORE_NODE_PUBLICATION_OPERATION,type PublicationPreviewTarget} from "@yummyai/contracts/marketplace/publication-preview";
import {marketplaceStoreNodeExecutions as jobs,type TenantTransaction} from "@yummyai/database";
import {eq} from "drizzle-orm";

/** Node coordination is born in the original Publication transaction. */
export async function admitPublicationNodeExecution(tx:TenantTransaction,input:{context:TenantContext;membershipId:string;requestId:string;requestKey:string;requestChecksum:string;target:PublicationPreviewTarget;payload:unknown;now:Date;scheduledFor?:Date|null}){
  const {context,target,now}=input;
  const [created]=await tx.insert(jobs).values({id:createEntityId(),tenantId:context.tenantId,accountId:target.accountId,
    nodeId:target.nodeId,certificateGeneration:target.certificateGeneration,authorizationGeneration:target.authorizationGeneration,bindingRevision:target.bindingRevision,
    requestId:input.requestKey,requestChecksum:input.requestChecksum,operation:STORE_NODE_PUBLICATION_OPERATION,
    input:PublicationPreviewNodeInputSchema.parse({publicationRequestId:input.requestId,target,payload:input.payload}),
    createdBy:context.userId,membershipId:input.membershipId,authorityCeiling:context,state:"waiting_node",phase:"queued",
    expiresAt:new Date(Math.max(now.getTime(),input.scheduledFor?.getTime()??0)+24*3_600_000),createdAt:now,updatedAt:now}).returning();
  return created!;
}
export async function cancelPublicationNodeExecution(tx:TenantTransaction,id:string,now:Date){
  const [row]=await tx.select().from(jobs).where(eq(jobs.id,id)).for("update").limit(1);
  if(!row||row.operation!==STORE_NODE_PUBLICATION_OPERATION)throw new ConflictException("Original preview execution is missing");
  if(row.state==="cancelled")return;
  if(row.state!=="waiting_node")throw new ConflictException("Only an unclaimed preview can be cancelled");
  await tx.update(jobs).set({state:"cancelled",phase:"finished",completedAt:now,updatedAt:now}).where(eq(jobs.id,id));
}
