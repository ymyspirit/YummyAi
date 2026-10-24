import {ConflictException,HttpException,NotFoundException,ServiceUnavailableException} from "@nestjs/common";
import {createHash} from "node:crypto";
import {and,desc,eq,inArray,sql} from "drizzle-orm";
import {Permission,erpPermissionContext,intersectPermissionContexts,type PermissionValue} from "@yummyai/authz";
import {erpSessionAuthority} from "@yummyai/contracts/auth/session";
import {currentPublicationObjectAuthority,readPublicationAuthority} from "@yummyai/catalog-core";
import {createEntityId,type TenantContext,CancelMarketplacePublicationInputSchema} from "@yummyai/contracts";
import {PublicationPreviewTargetSchema,PublicationPreviewRequestViewSchema,PublicationPreviewExecutionSchema} from "@yummyai/contracts/marketplace/publication-preview";
import {PUBLICATION_SUBMIT_PROTOCOL as protocol,STORE_NODE_PUBLICATION_SUBMIT_OPERATION as submitOperation,STORE_NODE_PUBLICATION_STATUS_OPERATION as statusOperation,
 CreatePublicationSubmitInputSchema,CreatePublicationStatusInputSchema,PublicationSubmitLookupSchema,PublicationSubmitTargetSchema,PublicationStatusTargetSchema,
 PublicationSubmitNodeInputSchema,PublicationStatusNodeInputSchema,PublicationSubmitWorkspaceSchema,PublicationSubmitRequestViewSchema,PublicationSubmitReceiptSchema,
 PublicationStatusReadViewSchema,PublicationStatusReceiptSchema,StoreNodeAmazonSubmissionResultSchema,StoreNodeAmazonStatusResultSchema,
 publicationSubmitRequestText,publicationStatusRequestText,publicationSubmitPayloadText,
 type CreatePublicationSubmitInput,type CreatePublicationStatusInput,type PublicationSubmitLookup,type PublicationSubmitWorkspaceInput,type PublicationSubmitTarget,
 type PublicationStatusTarget,type StoreNodeAmazonSubmissionResult,type StoreNodeAmazonStatusResult,type PublicationSubmitReason} from "@yummyai/contracts/marketplace/publication-submit";
import {marketplacePublicationRequests as requests,marketplacePublicationEvents as events,marketplacePublicationIntents as intents,marketplaceStoreNodeExecutions as jobs,
 marketplacePublicationNodeOperations as operations,marketplacePublicationNodeResults as results,marketplaceQuotaSnapshots,loadCurrentMembershipContext,withTenant,type DatabaseConnection,type TenantTransaction} from "@yummyai/database";
import type {AuditService} from "../audit/audit.service.js";
import type {MarketplacePublicationService} from "./marketplace-publication.service.js";
import type {StoreNodeService} from "./store-node.service.js";
import {databaseNow} from "./marketplace-authority.js";

type Request=typeof requests.$inferSelect;type Job=typeof jobs.$inferSelect;type Operation=typeof operations.$inferSelect;
const active=["waiting_node","claimed","running"] as const;
const hash=(value:string)=>createHash("sha256").update(value).digest("hex"),digest=(value:unknown)=>hash(publicationSubmitPayloadText(value));
function fail(code="publication_submit_source_changed"):never{throw new ConflictException({code});}
function same(left:unknown,right:unknown){return digest(left)===digest(right);}
function known(error:unknown){return error instanceof Error&&["ForbiddenError","ForbiddenException","CatalogAccessNotFoundError","PublicationAuthorityError","ConflictException","NotFoundException","ServiceUnavailableException"].includes(error.constructor.name);}
function reason(error:unknown):PublicationSubmitReason{
 if(error instanceof Error&&["ForbiddenError","ForbiddenException"].includes(error.constructor.name))return "not_authorized";
 const response=error instanceof HttpException?error.getResponse():null;
 const message=response&&typeof response==="object"&&"code" in response?String(response.code):error instanceof Error?error.message:"";
 if(message.includes("operation_pending"))return "operation_pending";
 if(message.includes("terminal"))return "terminal";
 if(error instanceof ServiceUnavailableException||message.includes("configuration"))return "not_configured";
 if(message.includes("binding")||message.includes("not_bound"))return "not_bound";
 if(message.includes("offline")||message.includes("not_ready"))return "node_offline";
 if(message.includes("drain"))return "draining";
 if(message.includes("credential"))return "credential_unavailable";
 if(message.includes("capabilit"))return "capability_unavailable";
 return "source_changed";
}
/** Original Publication facts, separate immutable operation intents and exact receipts. No provider call or queue fallback. */
export class PublicationSubmitOperations{
 constructor(private readonly owner:MarketplacePublicationService,private readonly database:DatabaseConnection,private readonly audit:AuditService,private readonly identity?:StoreNodeService){}
 async workspace(context:TenantContext,input:PublicationSubmitWorkspaceInput){
  return withTenant(this.database.db,context,async tx=>{
   const current=await this.authority(tx,context,input.previewRequestId,Permission.ListingRead),parent=current.request;
   if(parent.action!=="amazon_validation_preview")throw new NotFoundException("Original Amazon preview not found");
   const preview=await this.previewView(tx,parent),children=await tx.select().from(requests).where(eq(requests.parentRequestId,parent.id)).orderBy(desc(requests.id)).limit(20),recent=[];
   for(const child of children){const [intent]=await tx.select().from(intents).where(eq(intents.requestId,child.id)).limit(1);if(intent?.route==="node_submit"&&intent.createdBy===context.userId)recent.push(await this.view(tx,context,child.id));}
   let target:PublicationSubmitTarget|null=null,blocked:PublicationSubmitReason="ready";
   try{target=(await this.prepare(tx,current.authority,parent.id)).target;if(children.some(child=>child.action==="amazon_submit")){target=null;blocked="already_submitted";}}
   catch(error){if(!known(error))throw error;blocked=reason(error);}
   if(current.intent?.route!=="node_preview"){target=null;blocked="legacy_preview";}
   else if(preview.request.current.status!=="validation_passed"){target=null;blocked="preview_not_passed";}
   const observed=intersectPermissionContexts(context,await loadCurrentMembershipContext(tx,context,{lock:true}));
   return PublicationSubmitWorkspaceSchema.parse({protocol,context:{actorId:observed.userId,tenantId:observed.tenantId,authority:hash(erpSessionAuthority(erpPermissionContext(observed)))},preview,target,
    access:{canRead:true,canSubmit:target!==null},reason:blocked,recent,observedAt:(await databaseNow(tx)).toISOString()});
  });
 }
 async create(context:TenantContext,raw:CreatePublicationSubmitInput){
  const input=CreatePublicationSubmitInputSchema.parse(raw),target=PublicationSubmitTargetSchema.strip().parse(input);
  if(hash(publicationSubmitRequestText(target))!==input.requestChecksum)fail("publication_submit_request_changed");
  const request=await this.owner.continue(context,input.previewRequestId,input);
  return withTenant(this.database.db,context,async tx=>{const view=await this.view(tx,context,request.id);if(view.intent.requestKey!==input.requestKey||view.intent.requestChecksum!==input.requestChecksum||!same(view.intent.target,target))fail("publication_submit_existing_request");return view;});
 }
 async admit(tx:TenantTransaction,context:TenantContext,request:Request,raw:CreatePublicationSubmitInput){
  const input=CreatePublicationSubmitInputSchema.parse(raw),prepared=await this.prepare(tx,context,input.previewRequestId),target=PublicationSubmitTargetSchema.strip().parse(input);
  if(!same(target,prepared.target)||hash(publicationSubmitRequestText(target))!==input.requestChecksum||request.parentRequestId!==target.previewRequestId||request.action!=="amazon_submit"
   ||request.accountId!==target.accountId||request.listingId!==target.listingId||request.listingVersionId!==target.listingVersionId||request.payloadChecksum!==target.payloadChecksum
   ||digest(request.payload)!==target.payloadChecksum||digest(request.assetManifest)!==target.assetManifestChecksum)fail();
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${context.userId+":"+input.requestKey},0))`);
  const [prior]=await tx.select().from(operations).where(and(eq(operations.createdBy,context.userId),eq(operations.requestKey,input.requestKey))).limit(1);if(prior)fail("publication_submit_request_changed");
  const now=await databaseNow(tx),executionId=createEntityId(),operationId=createEntityId();
  await this.insertJob(tx,prepared.current,executionId,input.requestKey,input.requestChecksum,submitOperation,PublicationSubmitNodeInputSchema.parse({operationId,publicationRequestId:request.id,target,payload:request.payload}),target,now);
  await tx.insert(intents).values({id:createEntityId(),tenantId:context.tenantId,requestId:request.id,createdBy:context.userId,membershipId:prepared.current.membershipId,
   authorityCeiling:prepared.current.authority,authorizationGeneration:target.authorizationGeneration,route:"node_submit",requestKey:input.requestKey,requestChecksum:input.requestChecksum,target,nodeExecutionId:executionId,createdAt:now});
  await tx.insert(operations).values({id:operationId,tenantId:context.tenantId,requestId:request.id,kind:"submit",requestKey:input.requestKey,requestChecksum:input.requestChecksum,target,nodeExecutionId:executionId,
   createdBy:context.userId,membershipId:prepared.current.membershipId,authorityCeiling:prepared.current.authority,createdAt:now});
  await this.audit.recordInTransaction(tx,prepared.current.authority,{action:"marketplace_publication.submit.prepare",resourceType:"marketplace_publication_request",resourceId:request.id,result:"success",metadata:{previewRequestId:target.previewRequestId,nodeExecutionId:executionId,requestKey:input.requestKey,requestChecksum:input.requestChecksum}});
 }
 async receipt(context:TenantContext,raw:PublicationSubmitLookup){const input=PublicationSubmitLookupSchema.parse(raw);return withTenant(this.database.db,context,async tx=>{
  const [operation]=await tx.select().from(operations).where(and(eq(operations.createdBy,context.userId),eq(operations.requestKey,input.requestKey))).limit(1);
  if(operation&&(operation.kind!=="submit"||operation.requestChecksum!==input.requestChecksum))fail("publication_submit_request_changed");
  if(operation)await this.authority(tx,context,operation.requestId,Permission.ListingRead);else await this.emptyReceiptAuthority(tx,context);
  return PublicationSubmitReceiptSchema.parse({protocol,...input,found:!!operation,request:operation?await this.view(tx,context,operation.requestId):null,observedAt:(await databaseNow(tx)).toISOString()});
 });}
 async get(context:TenantContext,id:string){return withTenant(this.database.db,context,tx=>this.view(tx,context,id));}
 async cancel(context:TenantContext,id:string,input:unknown){await this.get(context,id);await this.owner.cancel(context,id,CancelMarketplacePublicationInputSchema.parse(input));return this.get(context,id);}
 async createStatus(context:TenantContext,id:string,raw:CreatePublicationStatusInput){const input=CreatePublicationStatusInputSchema.parse(raw),target=PublicationStatusTargetSchema.strip().parse(input);
  if(target.publicationRequestId!==id||hash(publicationStatusRequestText(target))!==input.requestChecksum)fail("publication_submit_request_changed");
  return withTenant(this.database.db,context,async tx=>{
   await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${id},0))`);
   const current=await this.authority(tx,context,id,Permission.ListingPublish);
   await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${context.userId+":"+input.requestKey},0))`);
   const [prior]=await tx.select().from(operations).where(and(eq(operations.createdBy,context.userId),eq(operations.requestKey,input.requestKey))).limit(1);
   if(prior){if(prior.kind!=="status"||prior.requestId!==id||prior.requestChecksum!==input.requestChecksum||!same(prior.target,target))fail("publication_submit_request_changed");return this.statusView(tx,prior,current.authority);}
   const fresh=await this.statusTarget(tx,current.authority,id);if(!same(fresh,target))fail();
   const now=await databaseNow(tx),operationId=createEntityId(),executionId=createEntityId();
   await this.insertJob(tx,current,executionId,input.requestKey,input.requestChecksum,statusOperation,PublicationStatusNodeInputSchema.parse({operationId,publicationRequestId:id,target,payload:current.request.payload}),target,now);
   const [operation]=await tx.insert(operations).values({id:operationId,tenantId:context.tenantId,requestId:id,kind:"status",requestKey:input.requestKey,requestChecksum:input.requestChecksum,target,nodeExecutionId:executionId,
    createdBy:context.userId,membershipId:current.membershipId,authorityCeiling:current.authority,createdAt:now}).returning();
   await this.audit.recordInTransaction(tx,current.authority,{action:"marketplace_publication.status.prepare",resourceType:"marketplace_publication_request",resourceId:id,result:"success",metadata:{nodeExecutionId:executionId,sourceEventId:target.sourceEventId,knownSubmission:target.sourceSubmissionId!==null}});
   return this.statusView(tx,operation!,current.authority);
  });
 }
 async statusReceipt(context:TenantContext,raw:PublicationSubmitLookup){const input=PublicationSubmitLookupSchema.parse(raw);return withTenant(this.database.db,context,async tx=>{
  const [operation]=await tx.select().from(operations).where(and(eq(operations.createdBy,context.userId),eq(operations.requestKey,input.requestKey))).limit(1);
  if(operation&&(operation.kind!=="status"||operation.requestChecksum!==input.requestChecksum))fail("publication_submit_request_changed");
  if(operation)await this.authority(tx,context,operation.requestId,Permission.ListingRead);else await this.emptyReceiptAuthority(tx,context);
  return PublicationStatusReceiptSchema.parse({protocol,...input,found:!!operation,operation:operation?await this.statusView(tx,operation,context):null,observedAt:(await databaseNow(tx)).toISOString()});
 });}
 async assertNode(tx:TenantTransaction,row:Job){
  const input=row.operation===submitOperation?PublicationSubmitNodeInputSchema.parse(row.input):PublicationStatusNodeInputSchema.parse(row.input);
  const [operation]=await tx.select().from(operations).where(eq(operations.id,input.operationId)).limit(1);if(!operation)fail();
  const current=await this.authority(tx,row.authorityCeiling,input.publicationRequestId,Permission.ListingPublish);
  if(!current.intent||current.intent.route!=="node_submit"||operation.requestId!==current.request.id||operation.nodeExecutionId!==row.id||operation.requestKey!==row.requestId||operation.requestChecksum!==row.requestChecksum
   ||operation.createdBy!==row.createdBy||operation.membershipId!==row.membershipId||current.membershipId!==row.membershipId||!same(operation.authorityCeiling,row.authorityCeiling)||!same(operation.target,input.target))fail();
  const t=input.target;
  if(row.accountId!==t.accountId||row.nodeId!==t.nodeId||row.certificateGeneration!==t.certificateGeneration||row.authorizationGeneration!==t.authorizationGeneration||row.bindingRevision!==t.bindingRevision
   ||current.request.payloadChecksum!==t.payloadChecksum||digest(current.request.payload)!==t.payloadChecksum||digest(input.payload)!==t.payloadChecksum||digest(current.request.assetManifest)!==t.assetManifestChecksum)fail();
  if(row.operation===submitOperation){if(operation.kind!=="submit"||current.intent.nodeExecutionId!==row.id||!same(current.intent.target,t)||hash(publicationSubmitRequestText(PublicationSubmitTargetSchema.parse(t)))!==row.requestChecksum)fail();
   if(!same((await this.prepare(tx,current.authority,current.request.parentRequestId!)).target,t))fail();
  }else{if(operation.kind!=="status"||hash(publicationStatusRequestText(PublicationStatusTargetSchema.parse(t)))!==row.requestChecksum)fail();
   const expected=await this.statusTarget(tx,current.authority,current.request.id,row.id);if(!same(expected,t))fail();
  }
  return {...current,operation};
 }
 async due(tx:TenantTransaction,row:Job){await this.assertNode(tx,row);return true;}
 async adopt(tx:TenantTransaction,row:Job,result:StoreNodeAmazonSubmissionResult|StoreNodeAmazonStatusResult){
  const current=await this.assertNode(tx,row),now=await databaseNow(tx),t=current.operation.target;
  if(result.publicationRequestId!==current.request.id||result.payloadChecksum!==t.payloadChecksum||result.externalListingId!==t.sku
   ||Date.parse(result.submittedAt)<(row.startedAt?.getTime()??row.createdAt.getTime())-30_000||Date.parse(result.submittedAt)>now.getTime()+30_000)fail();
  const latest=await this.latest(tx,current.request.id);let eventId:string|null=null,adopted=false;
  if(row.operation===submitOperation){const parsed=StoreNodeAmazonSubmissionResultSchema.parse(result);if(!["queued","processing"].includes(latest.status))fail();eventId=await this.append(tx,current.authority,current.request,latest,parsed);adopted=true;}
  else{const parsed=StoreNodeAmazonStatusResultSchema.parse(result),target=PublicationStatusTargetSchema.parse(t);if(parsed.sourceSubmissionId!==target.sourceSubmissionId)fail();
   if(target.sourceSubmissionId!==null){eventId=await this.append(tx,current.authority,current.request,latest,parsed);adopted=true;}}
  await tx.insert(results).values({id:createEntityId(),tenantId:row.tenantId,operationId:current.operation.id,requestId:current.request.id,eventId,result,adoptedAsRequestStatus:adopted,createdAt:now});
  if(result.quota)await tx.insert(marketplaceQuotaSnapshots).values({id:createEntityId(),tenantId:row.tenantId,accountId:row.accountId,platform:"amazon",operation:row.operation===submitOperation?"amazon_submit":"amazon_listing_status",publicationRequestId:current.request.id,windows:result.quota.windows,observedAt:new Date(result.quota.observedAt)});
  await this.audit.recordInTransaction(tx,current.authority,{action:row.operation===submitOperation?"marketplace_publication.submit.adopt":"marketplace_publication.status.observe",resourceType:"marketplace_publication_request",resourceId:current.request.id,result:"success",metadata:{nodeExecutionId:row.id,operationId:current.operation.id,adoptedAsRequestStatus:adopted,status:result.status}});
 }
 async failure(tx:TenantTransaction,row:Job,unknown:boolean,code:string){
  const [operation]=await tx.select().from(operations).where(eq(operations.nodeExecutionId,row.id)).limit(1);if(!operation||operation.kind==="status")return;
  const latest=await this.latest(tx,operation.requestId);if(!["queued","processing"].includes(latest.status))return;
  await tx.insert(events).values({id:createEntityId(),tenantId:row.tenantId,requestId:operation.requestId,sequence:latest.sequence+1,status:unknown?"reconciliation_required":"failed",code,message:"正式节点提交未取得可采用的结果 不会自动重发 请核对原请求",retryable:false,actorUserId:row.createdBy});
 }
 async cancelCoordination(tx:TenantTransaction,context:TenantContext,requestId:string){
  const [intent]=await tx.select().from(intents).where(eq(intents.requestId,requestId)).limit(1);if(intent?.route!=="node_submit")return;
  await this.authority(tx,context,requestId,Permission.ListingPublish);
  const [job]=await tx.select().from(jobs).where(eq(jobs.id,intent.nodeExecutionId!)).for("update").limit(1);if(!job||job.state!=="waiting_node")fail("publication_submit_already_claimed");
  const now=await databaseNow(tx);await tx.update(jobs).set({state:"cancelled",phase:"finished",completedAt:now,updatedAt:now}).where(eq(jobs.id,job.id));
 }
 private async prepare(tx:TenantTransaction,context:TenantContext,id:string){
  const current=await this.authority(tx,context,id,Permission.ListingPublish),parent=current.request;
  if(parent.action!=="amazon_validation_preview"||!current.intent||current.intent.route!=="node_preview"||!current.intent.nodeExecutionId)fail("publication_submit_legacy_preview");
  const base=PublicationPreviewTargetSchema.parse(current.intent.target),[execution]=await tx.select().from(jobs).where(eq(jobs.id,current.intent.nodeExecutionId)).limit(1),event=await this.latest(tx,id);
  if(!execution||execution.state!=="succeeded"||event.status!=="validation_passed")fail("publication_submit_preview_not_passed");
  const prepared=await this.owner.prepareInTransaction(current.authority,{accountId:parent.accountId,listingId:parent.listingId,listingVersionId:parent.listingVersionId,marketplaceId:parent.marketplaceId,...(base.variantSkuId?{variantSkuId:base.variantSkuId}:{})},tx);
  if(prepared.payload.platform!=="amazon")fail();const {node,binding}=await this.binding(tx,current.account);
  const fresh=PublicationPreviewTargetSchema.parse({...base,capabilitySnapshotId:prepared.capabilitySnapshotId,payloadChecksum:digest(prepared.payload),assetManifestChecksum:digest(prepared.assets),nodeId:node.id,certificateGeneration:node.certificateGeneration,authorizationGeneration:current.account.authorizationGeneration,bindingRevision:binding.revision});
  if(!same(base,fresh)||parent.payloadChecksum!==base.payloadChecksum||digest(parent.assetManifest)!==base.assetManifestChecksum)fail();
  return {current,target:PublicationSubmitTargetSchema.parse({...base,previewRequestId:id,previewEventId:event.id,previewEventSequence:event.sequence,previewExecutionId:execution.id,sku:prepared.payload.sku})};
 }
 private async statusTarget(tx:TenantTransaction,context:TenantContext,id:string,ownExecutionId?:string){
  const current=await this.authority(tx,context,id,Permission.ListingPublish),intent=current.intent;if(current.request.action!=="amazon_submit"||intent?.route!=="node_submit"||!intent.nodeExecutionId)fail();
  const target=PublicationSubmitTargetSchema.parse(intent.target),[write]=await tx.select().from(jobs).where(eq(jobs.id,intent.nodeExecutionId)).limit(1);
  if(!write||active.includes(write.state as typeof active[number]))fail("publication_submit_operation_pending");
  const latest=await this.latest(tx,id);if(!["submission_accepted","sync_pending","published","publication_failed","deactivated","reconciliation_required"].includes(latest.status))fail("publication_submit_terminal");
  const pending=await tx.select({id:jobs.id}).from(operations).innerJoin(jobs,eq(jobs.id,operations.nodeExecutionId)).where(and(eq(operations.requestId,id),eq(operations.kind,"status"),inArray(jobs.state,[...active])));
  if(pending.some(row=>row.id!==ownExecutionId))fail("publication_submit_operation_pending");
  const [submitted]=await tx.select({result:results.result}).from(operations).innerJoin(results,eq(results.operationId,operations.id)).where(and(eq(operations.requestId,id),eq(operations.kind,"submit"))).limit(1);
  const accepted=submitted?StoreNodeAmazonSubmissionResultSchema.parse(submitted.result):null,{node,binding}=await this.binding(tx,current.account);
  return PublicationStatusTargetSchema.parse({...PublicationPreviewTargetSchema.strip().parse(target),nodeId:node.id,certificateGeneration:node.certificateGeneration,bindingRevision:binding.revision,
   publicationRequestId:id,submissionExecutionId:write.id,submissionTargetChecksum:hash(publicationSubmitRequestText(target)),sourceEventId:latest.id,sourceEventSequence:latest.sequence,
   sourceSubmissionId:accepted?.status==="submission_accepted"?accepted.externalSubmissionId:null,sku:target.sku});
 }
 private async view(tx:TenantTransaction,context:TenantContext,id:string){
  const readable=await readPublicationAuthority(tx,context,id,Permission.ListingRead);
  if(readable.intent?.route!=="node_submit")throw new NotFoundException("Original node submission not found");
  const current=await this.authority(tx,context,id,Permission.ListingRead),intent=current.intent;if(intent?.route!=="node_submit"||!intent.nodeExecutionId||!intent.target||!intent.requestKey||!intent.requestChecksum)throw new NotFoundException("Original node submission not found");
  const [operation]=await tx.select().from(operations).where(and(eq(operations.requestId,id),eq(operations.kind,"submit"))).limit(1);if(!operation)fail();
  const execution=await this.execution(tx,operation.nodeExecutionId),[saved]=await tx.select().from(results).where(eq(results.operationId,operation.id)).limit(1),reads=await tx.select().from(operations).where(and(eq(operations.requestId,id),eq(operations.kind,"status"))).orderBy(desc(operations.id)).limit(20),statusReads=[];
  for(const read of reads)statusReads.push(await this.statusView(tx,read,current.authority));
  let statusTarget:PublicationStatusTarget|null=null,blocked:PublicationSubmitReason="ready",canCancel=false;
  try{await currentPublicationObjectAuthority(tx,context,current.request.listingId,current.request.accountId,Permission.ListingPublish);canCancel=execution.state==="waiting_node";}catch(error){if(!known(error))throw error;}
  try{statusTarget=await this.statusTarget(tx,context,id);}catch(error){if(!known(error))throw error;blocked=reason(error);}
  return PublicationSubmitRequestViewSchema.parse({protocol,request:await this.owner.viewInTransaction(tx,current.request),intent:{requestKey:intent.requestKey,requestChecksum:intent.requestChecksum,target:PublicationSubmitTargetSchema.parse(intent.target)},
   execution,result:saved?StoreNodeAmazonSubmissionResultSchema.parse(saved.result):null,statusTarget,statusReads,access:{canCancel,canReadStatus:statusTarget!==null},statusReason:blocked});
 }
 private async statusView(tx:TenantTransaction,operation:Operation,context:TenantContext){
  const current=await this.authority(tx,intersectPermissionContexts(context,operation.authorityCeiling),operation.requestId,Permission.ListingRead);
  if(operation.createdBy!==context.userId||operation.membershipId!==current.membershipId)fail();
  const [saved]=await tx.select().from(results).where(eq(results.operationId,operation.id)).limit(1);
  return PublicationStatusReadViewSchema.parse({protocol,id:operation.id,requestId:operation.requestId,requestKey:operation.requestKey,requestChecksum:operation.requestChecksum,target:PublicationStatusTargetSchema.parse(operation.target),
   execution:await this.execution(tx,operation.nodeExecutionId),result:saved?StoreNodeAmazonStatusResultSchema.parse(saved.result):null,adoptedAsRequestStatus:saved?.adoptedAsRequestStatus??false,createdAt:operation.createdAt.toISOString()});
 }
 private async previewView(tx:TenantTransaction,request:Request){
  const [intent]=await tx.select().from(intents).where(eq(intents.requestId,request.id)).limit(1),execution=intent?.nodeExecutionId?await this.execution(tx,intent.nodeExecutionId):null;
  return PublicationPreviewRequestViewSchema.parse({protocol:"erp-publication-preview-v1",request:await this.owner.viewInTransaction(tx,request),intent:intent?.route==="node_preview"?{requestKey:intent.requestKey,requestChecksum:intent.requestChecksum,target:intent.target}:null,
   execution:intent?.route==="node_preview"?execution:null,admission:intent?.route==="node_preview"?"node_preview":"legacy",access:{canCancel:false,canContinue:false}});
 }
 private async execution(tx:TenantTransaction,id:string){const [row]=await tx.select().from(jobs).where(eq(jobs.id,id)).limit(1);if(!row)fail();return PublicationPreviewExecutionSchema.parse({id:row.id,nodeId:row.nodeId,certificateGeneration:row.certificateGeneration,authorizationGeneration:row.authorizationGeneration,bindingRevision:row.bindingRevision,state:row.state,phase:row.phase,errorCode:row.errorCode,createdAt:row.createdAt.toISOString(),updatedAt:row.updatedAt.toISOString(),expiresAt:row.expiresAt.toISOString(),completedAt:row.completedAt?.toISOString()??null});}
 private async latest(tx:TenantTransaction,id:string){const [row]=await tx.select().from(events).where(eq(events.requestId,id)).orderBy(desc(events.sequence)).limit(1);if(!row)throw new NotFoundException("Original publication event missing");return row;}
 private async binding(tx:TenantTransaction,account:Awaited<ReturnType<typeof readPublicationAuthority>>["account"]){
  if(!this.identity||process.env.STORE_NODE_RUNTIME_ENABLED!=="1"||process.env.STORE_NODE_EXECUTION_ENABLED!=="1")throw new ServiceUnavailableException("store_node_configuration_invalid");
  if(account.platform!=="amazon"||!["amazon_private","amazon_public"].includes(account.authorizationMode))fail();
  if(account.authorizationMode==="amazon_public"&&!process.env.AMAZON_SPAPI_LWA_CLIENT_ID?.trim())throw new ServiceUnavailableException("store_node_configuration_invalid");
  return this.identity.executionBinding(tx,account,true);
 }
 private insertJob(tx:TenantTransaction,current:Awaited<ReturnType<typeof readPublicationAuthority>>,id:string,requestId:string,requestChecksum:string,operation:string,input:typeof jobs.$inferInsert["input"],target:PublicationSubmitTarget|PublicationStatusTarget,now:Date){
  return tx.insert(jobs).values({id,tenantId:current.authority.tenantId,accountId:target.accountId,nodeId:target.nodeId,certificateGeneration:target.certificateGeneration,authorizationGeneration:target.authorizationGeneration,bindingRevision:target.bindingRevision,
   requestId,requestChecksum,operation,input,createdBy:current.authority.userId,membershipId:current.membershipId,authorityCeiling:current.authority,state:"waiting_node",phase:"queued",expiresAt:new Date(now.getTime()+15*60_000),createdAt:now,updatedAt:now});
 }
 private async append(tx:TenantTransaction,context:TenantContext,request:Request,latest:typeof events.$inferSelect,result:StoreNodeAmazonSubmissionResult|StoreNodeAmazonStatusResult){const id=createEntityId();await tx.insert(events).values({id,tenantId:context.tenantId,requestId:request.id,sequence:latest.sequence+1,status:result.status,issues:result.issues,externalListingId:result.externalListingId,
  externalSubmissionId:"externalSubmissionId" in result?result.externalSubmissionId:undefined,externalState:result.externalState,retryable:false,actorUserId:context.userId,occurredAt:await databaseNow(tx)});return id;}
 private async emptyReceiptAuthority(tx:TenantTransaction,context:TenantContext){
  // Even an empty lookup must be checked against actual current membership; object reads are checked when found.
  const {loadCurrentMembershipContext}=await import("@yummyai/database"),{intersectPermissionContexts,authorize}=await import("@yummyai/authz");
  const current=intersectPermissionContexts(context,await loadCurrentMembershipContext(tx,context,{lock:true}));authorize(current,Permission.ListingRead);authorize(current,Permission.StoreRead);
 }
 private async authority(tx:TenantTransaction,context:TenantContext,id:string,permission:PermissionValue){
  const original=await readPublicationAuthority(tx,context,id,permission,true);
  // The individual operation's birth ceiling is independent of its parent's ceiling.
  const current=await currentPublicationObjectAuthority(tx,intersectPermissionContexts(context,original.authority),original.request.listingId,original.request.accountId,permission);
  if(current.membershipId!==original.membershipId)fail();return {...original,...current};
 }
}
