import { ConflictException, Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { createEnvironmentSecretVault, type SecretVault } from "@yummyai/ai-core";
import { authorize, ForbiddenError, intersectPermissionContexts, Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { POD_MAX_RESPONSE_BYTES, type CreativeResponse } from "@yummyai/contracts/harness/creative-response";
import { CreativeResponseAdoptionCommandSchema, type CreativeResponseAdoptionCommand } from "@yummyai/contracts/harness/creative-response-adoption";
import { CREATIVE_OWNER_RESPONSE_ADOPTION_VERSION as VERSION, CreativeOwnerResponseAdoptionReceiptSchema,
  CreativeOwnerResponseAdoptionRequestSchema, CreativeOwnerResponseAdoptionWorkspaceSchema } from "@yummyai/contracts/harness/creative-owner-response-adoption";
import { assetFiles, auditEvents, creativeExecutions, creativeExecutionChecksum, creativeOwnerResponseAdoptions as adoptions,
  currentCreativeExecutionAuthority, withTenant, type CreativeOwnerResponseArtifactIntent, type CreativeOwnerResponseSourcePin,
  type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import { hashPodResponse } from "@yummyai/pod-core";
import { ClamAvScanner, objectKey, type Storage } from "@yummyai/storage";
import { and, eq, or, sql } from "drizzle-orm";
import { DATABASE_CONNECTION, PRIVATE_STORAGE, CREATIVE_RESPONSE_ADOPTION_OPTIONS } from "../platform.tokens.js";
import { authorizeCreativeResponseAdoptionOwner, commitCreativeResponseAdoptionOwner, creativeAdoptionOwnerAssetMetadata,
  creativeAdoptionOwnerScopePin, loadCreativeResponseAdoptionOwner, pinCreativeResponseAdoptionOwner,
  type CreativeAdoptionOwnerPlan, type CreativeAdoptionOwnerScope } from "./creative-response-adoption-owner.js";
import { inspectCreativeOwnerOriginal } from "./creative-owner-response-original.js";

type Row=typeof adoptions.$inferSelect;
type Options={vault?:Pick<SecretVault,"withSecret">;scanner?:Pick<ClamAvScanner,"scan">};
const writes=[Permission.DesignRead,Permission.DesignWrite,Permission.DesignReview,Permission.AssetRead,Permission.AssetWrite];
const extensions:Record<string,string>={"image/png":"png","image/jpeg":"jpg","image/webp":"webp","image/tiff":"tiff","application/json":"json"};
const digest=(v:unknown)=>creativeExecutionChecksum(JSON.parse(JSON.stringify(v)));
const messages={BLOCKED:"原任务当前不能采用 请核对权限 来源和任务状态",BASIS_CHANGED:"原任务或来源已变化 请保留原请求重新核对",
  ARCHIVE_UNAVAILABLE:"原归档暂时无法读取 请保留原请求核对",ARCHIVE_INVALID:"原归档未通过完整性或产物核对",
  SCAN_FAILED:"原产物未通过安全扫描",ARTIFACT_IO_FAILED:"本地保存结果尚未核对 请只读核对原请求",
  LEASE_LOST:"原本地处理租约已失效 请只读核对原请求",CONFLICT:"采用请求已存在 请继续核对原编号",
  PROCESSING_FAILED:"原响应采用未完成 请核对原请求"} as const;
type Failure=keyof typeof messages;
export class CreativeOwnerResponseAdoptionError extends ConflictException {
  readonly code:string;
  constructor(readonly reason:Failure){super({code:`CREATIVE_OWNER_ADOPTION_${reason}`,message:messages[reason]});this.code=`CREATIVE_OWNER_ADOPTION_${reason}`;}
}
const fail=(reason:Failure):never=>{throw new CreativeOwnerResponseAdoptionError(reason);};
const missing=():never=>{throw new NotFoundException({code:"CREATIVE_OWNER_ADOPTION_NOT_FOUND",message:"原采用记录不存在"});};

/** Separate local adoption, preserving the original terminal execution and ledger. */
@Injectable()
export class CreativeOwnerResponseAdoptionService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database:DatabaseConnection,
    @Inject(PRIVATE_STORAGE) private readonly storage:Storage,
    @Optional() @Inject(CREATIVE_RESPONSE_ADOPTION_OPTIONS) private readonly options:Options={}){}

  private async scope(tx:TenantTransaction,context:TenantContext,executionId:string,write=false){
    const [row]=await tx.select().from(creativeExecutions).where(eq(creativeExecutions.id,executionId));
    if(!row||row.kind==="creative_candidate")return missing();
    return loadCreativeResponseAdoptionOwner(tx,context,row,{lock:write?"update":"share"});
  }
  private async pin(tx:TenantTransaction,context:TenantContext,scope:CreativeAdoptionOwnerScope){
    const ownerBasis=await authorizeCreativeResponseAdoptionOwner(tx,context,scope),e=scope.execution;
    const [times]=await tx.execute<{submitted:string|null;expires:string}>(sql`select
      to_char(submitted_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as submitted,
      to_char(response_expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as expires from creative_executions where id=${e.id}::uuid`);
    if(!times?.expires||!e.responseObjectKey||!e.encryptedChecksum||!e.responseChecksum)return fail("BLOCKED");
    const pin:CreativeOwnerResponseSourcePin={version:1,executionId:e.id,kind:ownerBasis.kind,ownerId:ownerBasis.ownerId,parentId:ownerBasis.parentId,
      originalPhase:e.phase as "failed"|"uncertain",effect:e.effect,inputFingerprint:e.inputFingerprint,
      executionChecksum:digest({...e,updatedAt:null,responsePurgedAt:null}),
      authorityChecksum:e.authorityChecksum,contractChecksum:digest(e.executionContract),methodChecksum:digest(e.methodSelection),ownerBasis,
      responseObjectKey:e.responseObjectKey,encryptedChecksum:e.encryptedChecksum,responseChecksum:e.responseChecksum,responseExpiresAt:times.expires,
      submissionToken:e.submissionToken,submittedAt:times.submitted,receipt:e.receipt};
    const original=await currentCreativeExecutionAuthority(tx,context,e,writes);
    return {pin,basis:digest(pin),authority:intersectPermissionContexts(scope.authority,original)};
  }
  private async view(tx:TenantTransaction,row:Row){
    const [clock]=await tx.execute<{active:boolean}>(sql`select lease_expires_at>clock_timestamp() as active from creative_owner_response_adoptions where id=${row.id}::uuid`);
    return CreativeOwnerResponseAdoptionRequestSchema.parse({id:row.id,executionId:row.executionId,requestId:row.requestId,command:row.request,status:row.status,
      attempts:row.attemptCount,leaseActive:row.status==="processing"&&clock?.active===true,canRetry:row.status==="prepared"&&row.attemptCount<3,
      canCancel:row.status==="prepared"||row.status==="cancelled"&&!!row.artifactIntents&&!row.artifactDiscardedAt,errorCode:row.errorCode,
      artifactCleanup:row.status==="committed"?"registered":!row.artifactIntents?"not_required":row.artifactDiscardedAt?"complete":"pending",
      createdAt:row.createdAt.toISOString(),updatedAt:row.updatedAt.toISOString(),receipt:row.receipt});
  }
  async workspace(context:TenantContext,executionId:string){
    return withTenant(this.database.db,context,async tx=>{
      const scope=await this.scope(tx,context,executionId),e=scope.execution,owner=creativeAdoptionOwnerScopePin(scope);
      const rows=await tx.select().from(adoptions).where(and(eq(adoptions.executionId,executionId),eq(adoptions.requestedBy,context.userId)));
      let basis:string|null=null;const blockers:string[]=[];
      try{basis=(await this.pin(tx,context,scope)).basis;}catch(cause){
        if(cause instanceof Error&&("code" in cause||"status" in cause||"statusCode" in cause))blockers.push("原权限 来源或任务状态不满足采用条件");else throw cause;
      }
      if(rows.length)blockers.push(rows[0]!.status==="committed"?"原响应已有独立采用回执":"请继续核对原采用请求");
      const archiveState=e.responsePurgedAt?"purged":!e.responseObjectKey?"missing":!e.responseExpiresAt||e.responseExpiresAt.getTime()<=scope.checkedAt?"expired":"registered_unverified";
      return CreativeOwnerResponseAdoptionWorkspaceSchema.parse({version:VERSION,executionId,kind:e.kind,stepKey:e.stepKey,ownerId:owner.ownerId,
        parentId:owner.parentId,parentExecutionId:e.parentExecutionId,ownerStatus:owner.status,identityStamp:digest({version:VERSION,tenantId:context.tenantId,userId:context.userId}),
        originalPhase:e.phase,basis,canInspectOriginal:basis!==null,canAdopt:basis!==null&&!rows.some(r=>["committed","cancelled"].includes(r.status)),blockers,
        source:{inputFingerprint:e.inputFingerprint,responseChecksum:e.responseChecksum,encryptedChecksum:e.encryptedChecksum,archiveState,
          archiveExpiresAt:e.responseExpiresAt?.toISOString()??null,providerRequestId:e.receipt?.providerRequestId??null,receivedAt:e.receipt?.receivedAt??null,
          originalCostUsd:e.receipt?.costUsd??null,providerInvoiceVerified:false},requests:await Promise.all(rows.map(row=>this.view(tx,row))),
        noNewModelCall:true,resultRequiresReview:true});
    });
  }
  private async read(context:TenantContext,pin:CreativeOwnerResponseSourcePin,signal:AbortSignal){
    let bytes:Uint8Array;
    try{bytes=await this.storage.readPrivate(context,{id:pin.executionId,tenantId:context.tenantId,assetDomain:"quarantine",objectKey:pin.responseObjectKey},
      {requiredDomain:"quarantine",maxBytes:2*POD_MAX_RESPONSE_BYTES,signal});}catch{return fail("ARCHIVE_UNAVAILABLE");}
    try{return inspectCreativeOwnerOriginal({pin,tenantId:context.tenantId,encryptedBytes:bytes,signal,
      vault:this.options.vault??createEnvironmentSecretVault("POD_EXECUTION_ENCRYPTION_KEY","yummyai:pod-execution-v1")});}catch{return fail("ARCHIVE_INVALID");}
  }
  private async plan(context:TenantContext,executionId:string,basis:string,response:CreativeResponse){
    try{return await withTenant(this.database.db,context,async tx=>{
      const scope=await this.scope(tx,context,executionId),current=await this.pin(tx,context,scope);
      if(current.basis!==basis)return fail("BASIS_CHANGED");
      return pinCreativeResponseAdoptionOwner(tx,context,scope.execution,response);
    });}catch(cause){if(cause instanceof CreativeOwnerResponseAdoptionError||cause instanceof ForbiddenError)throw cause;return fail("ARCHIVE_INVALID");}
  }
  private async scan(plan:CreativeAdoptionOwnerPlan,signal:AbortSignal){
    const scanner=this.options.scanner??new ClamAvScanner();
    for(const output of plan.outputs){
      signal.throwIfAborted();
      try{const result=await scanner.scan({body:output.bytes,fileName:`original-${output.role}.${extensions[output.mediaType]}`,mediaType:output.mediaType});
        signal.throwIfAborted();if(result.result!=="clean")return fail("SCAN_FAILED");}catch{return fail("SCAN_FAILED");}
      if(hashPodResponse(output.bytes)!==output.checksumSha256)return fail("ARCHIVE_INVALID");
    }
  }
  private async recheck(context:TenantContext,executionId:string,basis:string){
    return withTenant(this.database.db,context,async tx=>{
      const scope=await this.scope(tx,context,executionId),current=await this.pin(tx,context,scope);
      if(current.basis!==basis)return fail("BASIS_CHANGED");return current;
    });
  }
  async preview(context:TenantContext,executionId:string,basis:string){
    const pinned=await this.recheck(context,executionId,basis),signal=AbortSignal.timeout(90_000),response=await this.read(pinned.authority,pinned.pin,signal);
    const plan=await this.plan(context,executionId,basis,response);await this.scan(plan,signal);await this.recheck(context,executionId,basis);
    const image=plan.outputs.find(v=>v.role==="preview")??plan.outputs.find(v=>v.mediaType.startsWith("image/"));
    if(!image||!image.mediaType.startsWith("image/"))return fail("ARCHIVE_INVALID");
    return {bytes:image.bytes,mediaType:image.mediaType,basis,responseChecksum:pinned.pin.responseChecksum,artifactChecksum:image.checksumSha256};
  }
  async lookup(context:TenantContext,executionId:string,requestId:string){
    return withTenant(this.database.db,context,async tx=>{
      await this.scope(tx,context,executionId);
      const [row]=await tx.select().from(adoptions).where(and(eq(adoptions.executionId,executionId),eq(adoptions.requestId,requestId),eq(adoptions.requestedBy,context.userId)));
      return row?this.view(tx,row):missing();
    });
  }
  private async leased(tx:TenantTransaction,id:string,token:string){
    const [value]=await tx.select({row:adoptions,active:sql<boolean>`${adoptions.leaseExpiresAt}>clock_timestamp()`})
      .from(adoptions).where(eq(adoptions.id,id)).for("update");
    if(!value||value.row.status!=="processing"||value.row.leaseToken!==token||!value.active)return fail("LEASE_LOST");return value.row;
  }
  private intents(context:TenantContext,row:Row,plan:CreativeAdoptionOwnerPlan):CreativeOwnerResponseArtifactIntent[]{
    return plan.outputs.map((output,index)=>{
      const ext=extensions[output.mediaType];if(!ext)return fail("ARCHIVE_INVALID");
      const fileName=`${row.id}-owner-${index}.${ext}`;
      return {assetId:row.artifactIntents?.[index]?.assetId??createEntityId(),role:output.role,fileName,
        objectKey:objectKey({tenantId:context.tenantId,domain:"authorized",sha256:output.checksumSha256,fileName}),
        checksumSha256:output.checksumSha256,byteSize:output.byteSize,mediaType:output.mediaType,width:output.width,height:output.height,
        aiGenerated:output.aiGenerated,rightsMetadata:creativeAdoptionOwnerAssetMetadata(plan,output,row.id)};
    });
  }
  async adopt(context:TenantContext,executionId:string,raw:unknown){
    const command=CreativeResponseAdoptionCommandSchema.parse(raw);
    const prepared=await withTenant(this.database.db,context,async tx=>{
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`creative-owner-adoption:${context.tenantId}:${context.userId}:${command.requestId}`},0))`);
      const scope=await this.scope(tx,context,executionId,true);if(scope.execution.requestedBy!==context.userId)return fail("BLOCKED");
      const [prior]=await tx.select().from(adoptions).where(or(eq(adoptions.executionId,executionId),and(eq(adoptions.requestedBy,context.userId),eq(adoptions.requestId,command.requestId)))).for("update");
      if(prior&&(prior.executionId!==executionId||prior.requestChecksum!==digest(command)))return fail("CONFLICT");
      if(prior?.status==="committed"||prior?.status==="processing")return {view:await this.view(tx,prior)};
      if(prior?.status==="cancelled")return fail("CONFLICT");
      const pinned=await this.pin(tx,context,scope);if(pinned.basis!==command.expectedBasis)return fail("BASIS_CHANGED");
      let row=prior;
      if(!row)[row]=await tx.insert(adoptions).values({id:createEntityId(),tenantId:context.tenantId,executionId,requestedBy:context.userId,
        kind:pinned.pin.kind,ownerId:pinned.pin.ownerId,parentId:pinned.pin.parentId,requestId:command.requestId,request:command,
        requestChecksum:digest(command),expectedBasis:command.expectedBasis,sourcePin:pinned.pin}).returning();
      if(!row||row.attemptCount>=3)return fail("BLOCKED");
      const token=createEntityId();const [claimed]=await tx.update(adoptions).set({status:"processing",attemptCount:row.attemptCount+1,leaseToken:token,
        leaseExpiresAt:sql`clock_timestamp()+interval '180 seconds'`,errorCode:null,updatedAt:sql`clock_timestamp()`}).where(eq(adoptions.id,row.id)).returning();
      return {row:claimed!,token,pinned};
    });
    if(prepared.view)return prepared.view;
    const {row,token,pinned}=prepared;let dispatched=0,confirmed=0;
    try{
      const signal=AbortSignal.timeout(90_000),response=await this.read(pinned.authority,row.sourcePin,signal),plan=await this.plan(context,executionId,command.expectedBasis,response);
      await this.scan(plan,signal);
      const intents=await withTenant(this.database.db,context,async tx=>{
        const current=await this.pin(tx,context,await this.scope(tx,context,executionId,true));if(current.basis!==command.expectedBasis)return fail("BASIS_CHANGED");
        const owned=await this.leased(tx,row.id,token),proposed=this.intents(context,owned,plan);
        if(owned.artifactIntents){if(digest(owned.artifactIntents)!==digest(proposed)||digest(owned.planPin)!==digest(plan.pin))return fail("ARCHIVE_INVALID");return owned.artifactIntents;}
        await tx.update(adoptions).set({artifactIntents:proposed,planPin:plan.pin,updatedAt:sql`clock_timestamp()`}).where(eq(adoptions.id,row.id));return proposed;
      });
      for(const [index,intent] of intents.entries()){
        await this.recheck(context,executionId,command.expectedBasis);signal.throwIfAborted();
        const output=plan.outputs[index]!;dispatched++;
        try{
          const stored=await this.storage.putPrivate(pinned.authority,{body:output.bytes,domain:"authorized",fileName:intent.fileName,mediaType:intent.mediaType});
          if(stored.objectKey!==intent.objectKey||stored.checksumSha256!==intent.checksumSha256)return fail("ARTIFACT_IO_FAILED");
        }catch{
          // A lost ACK can only be resolved by the exact persisted original bytes.
          if(!await this.confirmObject(pinned.authority,intent))return fail("ARTIFACT_IO_FAILED");
        }
        if(!await this.confirmObject(pinned.authority,intent))return fail("ARTIFACT_IO_FAILED");confirmed++;
      }
      return await this.commit(context,executionId,command,row.id,token,response,plan,intents);
    }catch(cause){
      const failure=cause instanceof CreativeOwnerResponseAdoptionError?cause:new CreativeOwnerResponseAdoptionError(cause instanceof ForbiddenError?"BLOCKED":"PROCESSING_FAILED");
      const quiescent=dispatched===confirmed;
      await withTenant(this.database.db,context,async tx=>{
        const [owned]=await tx.select().from(adoptions).where(eq(adoptions.id,row.id)).for("update");
        if(owned?.status==="processing"&&owned.leaseToken===token)await tx.update(adoptions).set({...(quiescent?{status:"prepared" as const,leaseToken:null,leaseExpiresAt:null}:{}),
          errorCode:quiescent?failure.code:"CREATIVE_OWNER_ADOPTION_ARTIFACT_IO_FAILED",updatedAt:sql`clock_timestamp()`}).where(eq(adoptions.id,row.id));
      });throw failure;
    }
  }
  private async confirmObject(context:TenantContext,intent:CreativeOwnerResponseArtifactIntent){
    try{const bytes=await this.storage.readPrivate(context,{id:intent.assetId,tenantId:context.tenantId,assetDomain:"authorized",objectKey:intent.objectKey},
      {requiredDomain:"authorized",maxBytes:intent.byteSize,signal:AbortSignal.timeout(15_000)});return bytes.byteLength===intent.byteSize&&hashPodResponse(bytes)===intent.checksumSha256;}catch{return false;}
  }
  private async commit(context:TenantContext,executionId:string,command:CreativeResponseAdoptionCommand,id:string,token:string,response:CreativeResponse,
    plan:CreativeAdoptionOwnerPlan,intents:CreativeOwnerResponseArtifactIntent[]){
    return withTenant(this.database.db,context,async tx=>{
      const scope=await this.scope(tx,context,executionId,true),current=await this.pin(tx,context,scope);if(current.basis!==command.expectedBasis)return fail("BASIS_CHANGED");
      const row=await this.leased(tx,id,token);if(digest(row.artifactIntents)!==digest(intents)||digest(row.planPin)!==digest(plan.pin))return fail("CONFLICT");
      for(const intent of intents)await tx.insert(assetFiles).values({id:intent.assetId,tenantId:context.tenantId,ownerUserId:context.userId,objectKey:intent.objectKey,
        assetDomain:"authorized",fileName:intent.fileName,mediaType:intent.mediaType,byteSize:intent.byteSize,checksumSha256:intent.checksumSha256,
        version:1,aiGenerated:intent.aiGenerated,rightsStatus:"unverified",rightsMetadata:intent.rightsMetadata});
      const owner=await commitCreativeResponseAdoptionOwner(tx,context,scope.execution,response,plan.pin,
        intents.map(v=>({role:v.role,id:v.assetId,version:1,checksumSha256:v.checksumSha256})),row.id);
      const [clock]=await tx.execute<{time:string}>(sql`select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as time`),now=new Date(clock!.time);
      const disposition=owner.saved.kind==="adaptation_spec"?"aspect_ready":owner.saved.kind==="adaptation_outpaint"?"outpaint_artifact_ready":
        owner.saved.kind==="template_compile"?"template_inspected":owner.saved.kind==="mockup_render"?"mockup_ready":"studio_image_ready";
      const receipt=CreativeOwnerResponseAdoptionReceiptSchema.parse({version:VERSION,id:row.id,executionId,requestId:command.requestId,basis:command.expectedBasis,
        kind:row.kind,stepKey:scope.execution.stepKey,ownerId:row.ownerId,parentId:row.parentId,ownerStatus:owner.status,ownerReceiptChecksum:owner.checksum,
        originalPhase:row.sourcePin.originalPhase,inputFingerprint:row.sourcePin.inputFingerprint,responseChecksum:row.sourcePin.responseChecksum,
        encryptedChecksum:row.sourcePin.encryptedChecksum,originalCostUsd:row.sourcePin.receipt?.costUsd??null,
        artifacts:intents.map(v=>({role:v.role,assetId:v.assetId,version:1,checksumSha256:v.checksumSha256,mediaType:v.mediaType,byteSize:v.byteSize,width:v.width,height:v.height})),
        disposition,rightsStatus:"unverified",approval:"review_required",noNewModelCall:true,committedAt:now.toISOString()});
      const [saved]=await tx.update(adoptions).set({status:"committed",ownerReceipt:owner,receipt,committedAt:now,leaseToken:null,leaseExpiresAt:null,updatedAt:now})
        .where(eq(adoptions.id,row.id)).returning();
      await tx.insert(auditEvents).values({id:createEntityId(),tenantId:context.tenantId,actorUserId:context.userId,action:"creative_owner_response.adopted",
        entityType:"creative_owner_response_adoption",entityId:row.id,result:"success",metadata:{executionId,kind:row.kind,ownerId:row.ownerId,requestId:row.requestId,
          basis:row.expectedBasis,artifacts:receipt.artifacts.map(v=>({role:v.role,assetId:v.assetId})),disposition,approval:"review_required",noNewModelCall:true}});
      return this.view(tx,saved!);
    });
  }
  private async cleanupAuthority(tx:TenantTransaction,context:TenantContext,executionId:string){
    const scope=await this.scope(tx,context,executionId,true);if(scope.execution.requestedBy!==context.userId)return fail("BLOCKED");
    const original=await currentCreativeExecutionAuthority(tx,context,scope.execution,writes),authority=intersectPermissionContexts(scope.authority,original);
    for(const permission of writes)authorize(authority,permission,{ownerId:scope.execution.requestedBy});return authority;
  }
  async cancel(context:TenantContext,executionId:string,adoptionId:string,raw:unknown){
    const command=CreativeResponseAdoptionCommandSchema.parse(raw);
    const row=await withTenant(this.database.db,context,async tx=>{
      await this.cleanupAuthority(tx,context,executionId);
      const [owned]=await tx.select().from(adoptions).where(and(eq(adoptions.id,adoptionId),eq(adoptions.executionId,executionId),eq(adoptions.requestId,command.requestId))).for("update");
      if(!owned)return missing();if(owned.requestChecksum!==digest(command))return fail("CONFLICT");
      if(owned.status==="committed"||owned.status==="cancelled")return owned;if(owned.status!=="prepared")return fail("BLOCKED");
      const [cancelled]=await tx.update(adoptions).set({status:"cancelled",cancelledAt:sql`clock_timestamp()`,updatedAt:sql`clock_timestamp()`}).where(eq(adoptions.id,owned.id)).returning();return cancelled!;
    });
    if(row.status==="cancelled"&&row.artifactIntents&&!row.artifactDiscardedAt)await withTenant(this.database.db,context,async tx=>{
      const authority=await this.cleanupAuthority(tx,context,executionId);
      const [owned]=await tx.select().from(adoptions).where(eq(adoptions.id,row.id)).for("update");
      if(!owned||owned.status!=="cancelled"||!owned.artifactIntents||owned.artifactDiscardedAt)return;
      const assertCurrent=async()=>{
        await this.cleanupAuthority(tx,context,executionId);
        for(const intent of owned.artifactIntents!){const [registered]=await tx.select({id:assetFiles.id}).from(assetFiles).where(eq(assetFiles.objectKey,intent.objectKey));if(registered)return fail("BLOCKED");}
      };
      await assertCurrent();
      for(const intent of owned.artifactIntents)await this.storage.discardCreativeOwnerResponseAdoptionArtifact(authority,owned.id,intent.objectKey,{signal:AbortSignal.timeout(30_000),assertCurrent});
      await tx.update(adoptions).set({artifactDiscardedAt:sql`clock_timestamp()`,updatedAt:sql`clock_timestamp()`}).where(eq(adoptions.id,owned.id));
    });
    return this.lookup(context,executionId,command.requestId);
  }
}
