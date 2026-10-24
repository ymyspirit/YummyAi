import {createHash} from "node:crypto";
import {ConflictException,HttpException,NotFoundException,ServiceUnavailableException} from "@nestjs/common";
import {authorize,erpPermissionContext,intersectPermissionContexts,Permission} from "@yummyai/authz";
import {assertCatalogListingAccess,currentPublicationObjectAuthority,readPublicationAuthority} from "@yummyai/catalog-core";
import {createEntityId,type CancelMarketplacePublicationInput,type CreateMarketplacePublicationInput,type TenantContext} from "@yummyai/contracts";
import {erpSessionAuthority} from "@yummyai/contracts/auth/session";
import {CreatePublicationPreviewInputSchema,PublicationPreviewLookupSchema,PublicationPreviewNodeInputSchema,PublicationPreviewReceiptSchema,
  PublicationPreviewRequestViewSchema,PublicationPreviewTargetSchema,PublicationPreviewWorkspaceInputSchema,PublicationPreviewWorkspaceSchema,PublicationPreviewReadCheckInputSchema,
  PUBLICATION_PREVIEW_PROTOCOL,STORE_NODE_PUBLICATION_OPERATION,publicationPreviewPayloadText,publicationPreviewRequestText,
  type CreatePublicationPreviewInput,type PublicationPreviewLookup,type PublicationPreviewTarget,type PublicationPreviewWorkspaceInput,type PublicationPreviewReadCheckInput,type StoreNodePublicationResult} from "@yummyai/contracts/marketplace/publication-preview";
import {listingVersions,loadCurrentMembershipContext,marketplaceAccounts,marketplacePublicationEvents as events,marketplacePublicationIntents as intents,
  marketplacePublicationRequests as requests,marketplaceQuotaSnapshots,marketplaceStoreNodeExecutions as jobs,withTenant,type DatabaseConnection,type TenantTransaction} from "@yummyai/database";
import {and,desc,eq,isNull,sql} from "drizzle-orm";
import type {AuditService} from "../audit/audit.service.js";
import {databaseNow} from "./marketplace-authority.js";
import type {MarketplacePublicationService,PreparedPublication} from "./marketplace-publication.service.js";
import {admitPublicationNodeExecution,cancelPublicationNodeExecution} from "./store-node-publication-admission.js";
import type {StoreNodeService} from "./store-node.service.js";
type Request=typeof requests.$inferSelect;type Job=typeof jobs.$inferSelect;
const protocol=PUBLICATION_PREVIEW_PROTOCOL;
const digest=(value:unknown)=>createHash("sha256").update(publicationPreviewPayloadText(value)).digest("hex");
const requestDigest=(value:PublicationPreviewTarget)=>createHash("sha256").update(publicationPreviewRequestText(value)).digest("hex");
const fail=():never=>{throw new ConflictException({code:"publication_source_changed"});};

/** Stateless operations of the original Publication owner; no duplicate business state. */
export class PublicationPreviewOperations{
  constructor(private readonly database:DatabaseConnection,private readonly audit:AuditService,private readonly owner:MarketplacePublicationService,private readonly identity?:StoreNodeService){}

  /** Recheck the current objects after a delayed body; no payload, mutation, provider or new execution. */
  async checkWorkspaceRead(context:TenantContext,raw:PublicationPreviewReadCheckInput):Promise<void>{
    const input=PublicationPreviewReadCheckInputSchema.parse(raw);
    await withTenant(this.database.db,context,async tx=>{
      const authority=intersectPermissionContexts(context,await loadCurrentMembershipContext(tx,context,{lock:true}));
      authorize(authority,Permission.StoreRead);
      await assertCatalogListingAccess(tx,authority,input.listingId,[Permission.ListingRead],"share");
      const [version]=await tx.select({id:listingVersions.id}).from(listingVersions).where(and(eq(listingVersions.id,input.listingVersionId),eq(listingVersions.listingId,input.listingId))).limit(1);
      if(!version)throw new NotFoundException("Original Listing version not found");
      for(const accountId of input.accountIds?input.accountIds.split(","):[])
        await currentPublicationObjectAuthority(tx,authority,input.listingId,accountId);
    });
  }
  async checkRequestRead(context:TenantContext,id:string):Promise<void>{
    await withTenant(this.database.db,context,async tx=>{
      const current=await readPublicationAuthority(tx,context,id);
      if(current.intent?.route==="node_preview"&&current.intent.createdBy!==current.authority.userId)throw new NotFoundException("Original preview not found");
    });
  }

  async workspace(context:TenantContext,raw:PublicationPreviewWorkspaceInput){
    const input=PublicationPreviewWorkspaceInputSchema.parse(raw);
    return withTenant(this.database.db,context,async tx=>{
      const authority=intersectPermissionContexts(context,await loadCurrentMembershipContext(tx,context,{lock:true}));
      authorize(authority,Permission.StoreRead);
      const listing=await assertCatalogListingAccess(tx,authority,input.listingId,[Permission.ListingRead],"share");
      const [version]=await tx.select().from(listingVersions).where(and(eq(listingVersions.id,input.listingVersionId),eq(listingVersions.listingId,listing.id))).limit(1);
      if(!version)throw new NotFoundException("Original Listing version not found");
      const accounts=await tx.select().from(marketplaceAccounts).where(and(eq(marketplaceAccounts.platform,"amazon"),isNull(marketplaceAccounts.deletedAt))).orderBy(marketplaceAccounts.id);
      const sources=[];
      for(const account of accounts){
        try{authorize(authority,Permission.StoreRead,{ownerId:account.createdBy});}catch{continue;}
        for(const marketplaceId of account.marketplaceIds){
          if(sources.length>=100)break;
          let target:PublicationPreviewTarget|null=null,reason:"ready"|"not_configured"|"not_supported"|"not_authorized"|"not_bound"|"node_offline"|"credential_unavailable"|"capability_unavailable"|"listing_not_approved"|"source_changed"="ready";
          try{authorize(authority,Permission.ListingPublish,{ownerId:listing.createdBy});}catch{reason="not_authorized";}
          if(reason==="ready"&&(listing.status!=="approved"||version.status!=="approved"||listing.primaryVersionId!==version.id))reason="listing_not_approved";
          if(reason==="ready")try{const prepared=await this.owner.prepareInTransaction(authority,{...input,accountId:account.id,marketplaceId},tx);target=await this.target(tx,account.id,input,marketplaceId,prepared,authority);}catch(error){
            reason=preparationFailureReason(error);
          }
          sources.push({accountId:account.id,accountName:account.displayName,marketplaceId,target,reason,canPrepare:reason==="ready"&&target!==null});
        }
      }
      const recentRows=await tx.select().from(requests).where(and(eq(requests.listingId,listing.id),eq(requests.listingVersionId,version.id),eq(requests.createdBy,authority.userId),eq(requests.action,"amazon_validation_preview"))).orderBy(desc(requests.id)).limit(20);
      const recent=[];
      for(const row of recentRows){try{await currentPublicationObjectAuthority(tx,authority,row.listingId,row.accountId);recent.push(await this.view(tx,authority,row));}catch(error){if(!authorizationError(error))throw error;}}
      const now=await databaseNow(tx);
      return PublicationPreviewWorkspaceSchema.parse({protocol,context:{actorId:authority.userId,tenantId:authority.tenantId,authority:createHash("sha256").update(erpSessionAuthority(erpPermissionContext(authority))).digest("hex")},
        listing:{id:listing.id,versionId:version.id,currentVersionId:listing.primaryVersionId,version:version.versionNumber,status:version.status,title:version.content.title,content:version.content},
        access:{canRead:true,canPrepare:sources.some(source=>source.canPrepare)},sources,recent,observedAt:now.toISOString()});
    });
  }

  async create(context:TenantContext,raw:CreatePublicationPreviewInput){
    const input=CreatePublicationPreviewInputSchema.parse(raw),target=PublicationPreviewTargetSchema.parse(stripIntent(input));
    if(requestDigest(target)!==input.requestChecksum)fail();
    return withTenant(this.database.db,context,async tx=>{
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${context.userId+":"+input.requestKey},0))`);
      const [existing]=await tx.select().from(intents).where(and(eq(intents.createdBy,context.userId),eq(intents.requestKey,input.requestKey))).limit(1);
      if(existing){if(existing.requestChecksum!==input.requestChecksum)fail();const current=await readPublicationAuthority(tx,context,existing.requestId,Permission.ListingPublish);return this.view(tx,current.authority,current.request);}
      const prepared=await this.owner.prepareInTransaction(context,input,tx);
      const currentTarget=await this.target(tx,input.accountId,input,input.marketplaceId,prepared,context);
      if(requestDigest(currentTarget)!==input.requestChecksum)fail();
      const now=await databaseNow(tx);
      const [request]=await tx.insert(requests).values({id:createEntityId(),tenantId:context.tenantId,accountId:input.accountId,listingId:input.listingId,listingVersionId:input.listingVersionId,
        capabilitySnapshotId:prepared.capabilitySnapshotId,platform:"amazon",marketplaceId:input.marketplaceId,action:"amazon_validation_preview",
        idempotencyKey:digest([protocol,context.userId,input.requestKey,input.requestChecksum]),payload:prepared.payload,payloadChecksum:digest(prepared.payload),assetManifest:prepared.assets,createdBy:context.userId,createdAt:now}).returning();
      await tx.insert(events).values({id:createEntityId(),tenantId:context.tenantId,requestId:request!.id,sequence:1,status:"queued",actorUserId:context.userId,occurredAt:now});
      await this.admit(tx,context,request!,prepared,input);
      await this.audit.recordInTransaction(tx,context,{action:"marketplace_publication.preview.prepare",resourceType:"marketplace_publication_request",resourceId:request!.id,result:"success",metadata:{requestKey:input.requestKey,requestChecksum:input.requestChecksum,nodeId:input.nodeId}});
      return this.view(tx,context,request!);
    });
  }

  async receipt(context:TenantContext,raw:PublicationPreviewLookup){
    const input=PublicationPreviewLookupSchema.parse(raw);
    return withTenant(this.database.db,context,async tx=>{
      const authority=intersectPermissionContexts(context,await loadCurrentMembershipContext(tx,context,{lock:true}));authorize(authority,Permission.ListingRead);authorize(authority,Permission.StoreRead);
      const [intent]=await tx.select().from(intents).where(and(eq(intents.createdBy,authority.userId),eq(intents.requestKey,input.requestKey))).limit(1);
      if(intent&&intent.requestChecksum!==input.requestChecksum)fail();
      const found=intent?await readPublicationAuthority(tx,authority,intent.requestId):null;
      return PublicationPreviewReceiptSchema.parse({protocol,...input,found:!!found,request:found?await this.view(tx,found.authority,found.request):null,observedAt:(await databaseNow(tx)).toISOString()});
    });
  }
  async get(context:TenantContext,id:string){return withTenant(this.database.db,context,async tx=>{const current=await readPublicationAuthority(tx,context,id);return this.view(tx,current.authority,current.request);});}
  async cancel(context:TenantContext,id:string,input:CancelMarketplacePublicationInput){
    await this.owner.cancel(context,id,input);return this.get(context,id);
  }

  async admit(tx:TenantTransaction,context:TenantContext,request:Request,prepared?:PreparedPublication,explicit?:CreatePublicationPreviewInput,source?:CreateMarketplacePublicationInput){
    const current=await currentPublicationObjectAuthority(tx,context,request.listingId,request.accountId,Permission.ListingPublish);
    const now=await databaseNow(tx);
    if(request.action!=="amazon_validation_preview"){
      await tx.insert(intents).values({id:createEntityId(),tenantId:context.tenantId,requestId:request.id,createdBy:current.authority.userId,membershipId:current.membershipId,authorityCeiling:current.authority,authorizationGeneration:current.account.authorizationGeneration,route:"central",createdAt:now});return;
    }
    const publication=prepared??await this.owner.prepareInTransaction(current.authority,{accountId:request.accountId,listingId:request.listingId,listingVersionId:request.listingVersionId,marketplaceId:request.marketplaceId},tx);
    const target=explicit?PublicationPreviewTargetSchema.parse(stripIntent(explicit)):await this.target(tx,request.accountId,{listingId:request.listingId,listingVersionId:request.listingVersionId,variantSkuId:source?.variantSkuId},request.marketplaceId,publication,current.authority);
    const requestKey=explicit?.requestKey??request.id,requestChecksum=explicit?.requestChecksum??requestDigest(target);
    if(target.payloadChecksum!==request.payloadChecksum||target.assetManifestChecksum!==digest(request.assetManifest)||target.capabilitySnapshotId!==request.capabilitySnapshotId)fail();
    const execution=await admitPublicationNodeExecution(tx,{context:current.authority,membershipId:current.membershipId,requestId:request.id,requestKey,requestChecksum,target,payload:request.payload,now,scheduledFor:request.scheduledFor});
    await tx.insert(intents).values({id:createEntityId(),tenantId:context.tenantId,requestId:request.id,createdBy:current.authority.userId,membershipId:current.membershipId,authorityCeiling:current.authority,
      authorizationGeneration:current.account.authorizationGeneration,route:"node_preview",requestKey,requestChecksum,target,nodeExecutionId:execution.id,createdAt:now});
  }

  async assertNode(tx:TenantTransaction,row:Job){
    const input=PublicationPreviewNodeInputSchema.parse(row.input);
    const current=await readPublicationAuthority(tx,row.authorityCeiling,input.publicationRequestId,Permission.ListingPublish,true);
    const intent=current.intent;
    if(row.operation!==STORE_NODE_PUBLICATION_OPERATION||!intent||intent.route!=="node_preview"||intent.nodeExecutionId!==row.id||intent.requestKey!==row.requestId||intent.requestChecksum!==row.requestChecksum
      ||digest(intent.target)!==digest(input.target)||digest(row.authorityCeiling)!==digest(intent.authorityCeiling)||current.membershipId!==row.membershipId||row.createdBy!==intent.createdBy)fail();
    const t=input.target;
    if(row.accountId!==t.accountId||row.nodeId!==t.nodeId||row.certificateGeneration!==t.certificateGeneration||row.authorizationGeneration!==t.authorizationGeneration||row.bindingRevision!==t.bindingRevision
      ||requestDigest(t)!==row.requestChecksum||current.request.payloadChecksum!==t.payloadChecksum||digest(input.payload)!==t.payloadChecksum||digest(current.request.payload)!==t.payloadChecksum||digest(current.request.assetManifest)!==t.assetManifestChecksum)fail();
    const prepared=await this.owner.prepareInTransaction(current.authority,t,tx);
    if(prepared.capabilitySnapshotId!==t.capabilitySnapshotId||digest(prepared.payload)!==t.payloadChecksum||digest(prepared.assets)!==t.assetManifestChecksum)fail();
    return current;
  }
  async due(tx:TenantTransaction,row:Job,now:Date){
    const input=PublicationPreviewNodeInputSchema.parse(row.input);
    const [request]=await tx.select().from(requests).where(eq(requests.id,input.publicationRequestId)).limit(1);
    if(!request)fail();
    if(request.scheduledFor&&request.scheduledFor>now)return false;
    const latest=await this.latest(tx,request.id);
    if(latest.status==="scheduled")await tx.insert(events).values({id:createEntityId(),tenantId:row.tenantId,requestId:request.id,sequence:latest.sequence+1,status:"queued",actorUserId:row.createdBy,occurredAt:now});
    else if(!["queued","processing"].includes(latest.status))fail();
    return true;
  }
  async adopt(tx:TenantTransaction,row:Job,result:StoreNodePublicationResult){
    const current=await this.assertNode(tx,row),now=await databaseNow(tx);
    if(result.publicationRequestId!==current.request.id||result.payloadChecksum!==current.request.payloadChecksum||Date.parse(result.submittedAt)<(row.startedAt?.getTime()??row.createdAt.getTime())-30_000||Date.parse(result.submittedAt)>now.getTime()+30_000)fail();
    const latest=await this.latest(tx,current.request.id);
    if(!["queued","processing"].includes(latest.status))fail();
    await tx.insert(events).values({id:createEntityId(),tenantId:row.tenantId,requestId:current.request.id,sequence:latest.sequence+1,status:result.status,
      issues:result.issues,externalListingId:result.externalListingId,externalSubmissionId:result.externalSubmissionId,externalState:result.externalState,retryable:false,actorUserId:row.createdBy,occurredAt:now});
    if(result.quota)await tx.insert(marketplaceQuotaSnapshots).values({id:createEntityId(),tenantId:row.tenantId,accountId:row.accountId,platform:"amazon",operation:"amazon_validation_preview",publicationRequestId:current.request.id,windows:result.quota.windows,observedAt:new Date(result.quota.observedAt)});
    await this.audit.recordInTransaction(tx,current.authority,{action:"marketplace_publication.preview.adopt",resourceType:"marketplace_publication_request",resourceId:current.request.id,result:"success",metadata:{nodeExecutionId:row.id,payloadChecksum:result.payloadChecksum,status:result.status}});
  }
  async failure(tx:TenantTransaction,row:Job,unknown:boolean,code:string){
    const [intent]=await tx.select().from(intents).where(eq(intents.nodeExecutionId,row.id)).limit(1);if(!intent)return;
    const latest=await this.latest(tx,intent.requestId);if(!["scheduled","queued","processing"].includes(latest.status))return;
    await tx.insert(events).values({id:createEntityId(),tenantId:row.tenantId,requestId:intent.requestId,sequence:latest.sequence+1,status:unknown?"reconciliation_required":"failed",code,message:"节点校验未取得可采用的结果 请核对原任务",retryable:false,actorUserId:row.createdBy});
  }
  async cancelCoordination(tx:TenantTransaction,requestId:string){
    const [intent]=await tx.select().from(intents).where(eq(intents.requestId,requestId)).limit(1);
    if(intent?.route==="node_preview")await cancelPublicationNodeExecution(tx,intent.nodeExecutionId!,await databaseNow(tx));
  }

  private async target(tx:TenantTransaction,accountId:string,input:PublicationPreviewWorkspaceInput,marketplaceId:string,prepared:PreparedPublication,context:TenantContext){
    if(!this.identity||process.env.STORE_NODE_RUNTIME_ENABLED!=="1"||process.env.STORE_NODE_EXECUTION_ENABLED!=="1")throw new ServiceUnavailableException("store_node_configuration_invalid");
    const {account}=await currentPublicationObjectAuthority(tx,context,input.listingId,accountId,Permission.ListingPublish);
    if(account.platform!=="amazon"||!["amazon_private","amazon_public"].includes(account.authorizationMode))throw new ConflictException("store_node_not_supported");
    if(account.authorizationMode==="amazon_public"&&!process.env.AMAZON_SPAPI_LWA_CLIENT_ID?.trim())throw new ServiceUnavailableException("store_node_configuration_invalid");
    const {node,binding}=await this.identity.executionBinding(tx,account,true);
    return PublicationPreviewTargetSchema.parse({accountId,listingId:input.listingId,listingVersionId:input.listingVersionId,marketplaceId,variantSkuId:input.variantSkuId,
      capabilitySnapshotId:prepared.capabilitySnapshotId,payloadChecksum:digest(prepared.payload),assetManifestChecksum:digest(prepared.assets),nodeId:node.id,certificateGeneration:node.certificateGeneration,authorizationGeneration:account.authorizationGeneration,bindingRevision:binding.revision});
  }
  private async view(tx:TenantTransaction,context:TenantContext,request:Request){
    if(request.action!=="amazon_validation_preview")throw new NotFoundException("Original preview not found");
    const [intent]=await tx.select().from(intents).where(eq(intents.requestId,request.id)).limit(1);
    if(intent?.route==="node_preview"&&intent.createdBy!==context.userId)throw new NotFoundException("Original preview not found");
    const [execution]=intent?.nodeExecutionId?await tx.select().from(jobs).where(eq(jobs.id,intent.nodeExecutionId)).limit(1):[];
    let canCancel=false;
    try{await currentPublicationObjectAuthority(tx,context,request.listingId,request.accountId,Permission.ListingPublish);canCancel=execution?.state==="waiting_node";}catch(error){if(!authorizationError(error))throw error;}
    return PublicationPreviewRequestViewSchema.parse({protocol,request:await this.owner.viewInTransaction(tx,request),intent:intent?.target?{requestKey:intent.requestKey,requestChecksum:intent.requestChecksum,target:intent.target}:null,
      execution:execution?{id:execution.id,nodeId:execution.nodeId,certificateGeneration:execution.certificateGeneration,authorizationGeneration:execution.authorizationGeneration,bindingRevision:execution.bindingRevision,
        state:execution.state,phase:execution.phase,errorCode:execution.errorCode,createdAt:execution.createdAt.toISOString(),updatedAt:execution.updatedAt.toISOString(),expiresAt:execution.expiresAt.toISOString(),completedAt:execution.completedAt?.toISOString()??null}:null,
      admission:intent?.route==="node_preview"?"node_preview":"legacy",access:{canCancel,canContinue:false}});
  }
  private async latest(tx:TenantTransaction,requestId:string){
    const [event]=await tx.select().from(events).where(eq(events.requestId,requestId)).orderBy(desc(events.sequence)).limit(1);if(!event)throw new NotFoundException("Original publication event missing");return event;
  }
}
function stripIntent(input:CreatePublicationPreviewInput){const {requestKey,requestChecksum,...target}=input;void requestKey;void requestChecksum;return target;}
function preparationFailureReason(error:unknown){
  if(error instanceof Error&&["ForbiddenError","ForbiddenException"].includes(error.constructor.name))return "not_authorized" as const;
  if(!(error instanceof HttpException)){
    if(authorizationError(error))return "source_changed" as const;
    throw error;
  }
  const response=error.getResponse();
  const code=typeof response==="object"&&response!==null&&"code" in response&&typeof response.code==="string"?response.code:error.message;
  if(code.includes("configuration")||code.includes("not_configured"))return "not_configured" as const;
  if(error.getStatus()>=500)throw error;
  return code.includes("not_supported")?"not_supported":code.includes("not_ready")?"node_offline":code.includes("binding")?"not_bound":code.includes("authorized")||code.includes("credential")?"credential_unavailable":code.includes("capabilit")||code.includes("listing_write")?"capability_unavailable":"source_changed";
}
function authorizationError(error:unknown){return error instanceof Error&&["ForbiddenError","ForbiddenException","CatalogAccessNotFoundError","PublicationAuthorityError","ConflictException","NotFoundException"].includes(error.constructor.name);}
